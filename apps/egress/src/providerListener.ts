/**
 * Keeps the provider-config cache fresh (I-02 ADR-0011): a **dedicated**
 * LISTEN connection reloads the cache on every NOTIFY from the portal-owned
 * trigger (`PROVIDERS_CHANNEL`), a jittered reconcile reload covers anything a
 * dropped connection missed, and reconnects back off exponentially — the edge's
 * `LiveRegistry` pattern (apps/edge/src/registry/listener.ts) copied to its
 * second home.
 *
 * The LISTEN client is dedicated, never a pool client: pool recycling silently
 * drops LISTEN registrations. Its lifetime — graceful shutdown, reconnect, an
 * error listener — is part of the contract, because this is egress's first
 * long-lived DB connection that isn't a request-scoped pool borrow.
 *
 * Reconcile-on-startup **and** on reconnect is the PostgreSQL startup race
 * handled, not an optimization: commit LISTEN, inspect current state, then rely
 * on notifications. A notification missed while the listener was down self-heals
 * at the next reconcile — provider deletion or a sensitive edit therefore takes
 * effect on resolution no later than one reconcile after its NOTIFY.
 */
import pg from "pg";
import type { ObservableCallback, ObservableGauge } from "@opentelemetry/api";
import { PROVIDERS_CHANNEL, type ConnectionProvider, type Env } from "@azx-pbc/shared";

import { createEgressPool, DEFAULT_STATEMENT_TIMEOUT_MS } from "./pool.js";
import { ProviderCache, type ProviderCacheReader } from "./providerCache.js";
import { instruments } from "./telemetry.js";

/** Collapse NOTIFY bursts (one per statement in a transaction) into one load. */
export const NOTIFY_DEBOUNCE_MS = 100;

const BACKOFF_INITIAL_MS = 500;
const BACKOFF_MAX_MS = 30_000;

/** ±20% spread applied to every scheduled delay (see `jitteredDelayMs`). */
const JITTER_SPREAD = 0.2;

/** Fallback when a configured interval is unusable (`setTimeout(fn, NaN)` → ~0 ms). */
const FALLBACK_INTERVAL_MS = 60_000;

/**
 * Sanitize a scheduled delay: `Math.max(0, NaN)` is `NaN`, and `setTimeout(fn,
 * NaN)` coerces to ~0 ms — a hot reconcile loop, the exact opposite of what
 * this exists for. `config.ts` rejects such a value at boot; this is the
 * belt-and-braces half.
 */
function safeInterval(baseMs: number): number {
  return Number.isFinite(baseMs) && baseMs > 0 ? baseMs : FALLBACK_INTERVAL_MS;
}

/**
 * Spread a scheduled delay by ±20%. Both schedulers here use it, for the same
 * reason as the edge's copy: N replicas started together would otherwise hit
 * the DB on exactly the same tick — a synchronized reconcile herd and a
 * synchronized reconnect storm after a DB restart.
 *
 * Exported for its own test: `LiveProviders`' constructor opens a real pg pool,
 * so the arithmetic has to be reachable without one.
 */
export function jitteredDelayMs(baseMs: number, random: () => number = Math.random): number {
  const base = safeInterval(baseMs);
  const factor = 1 - JITTER_SPREAD + random() * (2 * JITTER_SPREAD);
  return Math.max(0, Math.round(base * factor));
}

export interface ProvidersLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export class LiveProviders implements ProviderCacheReader {
  #databaseUrl: string;
  #reconcileIntervalMs: number;
  #statementTimeoutMs: number;
  /** Stable `pg_stat_activity` label for the dedicated client (triage + tests). */
  #applicationName: string;
  #backoffInitialMs: number;
  #backoffMaxMs: number;
  #log: ProvidersLogger;
  #pool: pg.Pool;
  #cache: ProviderCache;

  #listenClient: pg.Client | null = null;
  #reconcileTimer: NodeJS.Timeout | null = null;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #notifyTimer: NodeJS.Timeout | null = null;
  #backoffMs: number;
  #stopped = false;
  /**
   * The attached gauge callback and the instrument it went on, so `stop()` can
   * detach exactly it from exactly that instrument (`instruments()` is memoized
   * on meter-provider identity — resolving the gauge again at `stop()` could
   * otherwise return a *different* `ObservableGauge` if a provider had been
   * swapped in between). Not reachable in production (one provider, and
   * `server.ts` stops the listener before shutting telemetry down), but it is
   * the kind of latent hazard that only shows up in a test doing something
   * reasonable — the edge's `LiveRegistry` carries the same hygiene.
   */
  #listenObserver: ObservableCallback | null = null;
  #listenGauge: ObservableGauge | null = null;
  /** The load `stop()` waits out, so a teardown can't race a live query. */
  #inFlightLoad: Promise<void> | null = null;

  constructor(opts: {
    databaseUrl: string;
    reconcileIntervalMs: number;
    statementTimeoutMs?: number;
    log: ProvidersLogger;
    /** `pg_stat_activity.application_name` for the dedicated client. */
    applicationName?: string;
    /** Test seams for the reconnect ladder; production uses the defaults. */
    backoffInitialMs?: number;
    backoffMaxMs?: number;
  }) {
    this.#databaseUrl = opts.databaseUrl;
    this.#reconcileIntervalMs = opts.reconcileIntervalMs;
    this.#statementTimeoutMs = opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
    this.#applicationName = opts.applicationName ?? "helix-egress-providers";
    this.#backoffInitialMs = opts.backoffInitialMs ?? BACKOFF_INITIAL_MS;
    this.#backoffMaxMs = opts.backoffMaxMs ?? BACKOFF_MAX_MS;
    this.#backoffMs = this.#backoffInitialMs;
    this.#log = opts.log;
    // Read-only reconcile queries only — one connection is plenty.
    this.#pool = createEgressPool(this.#databaseUrl, {
      max: 1,
      statementTimeoutMs: this.#statementTimeoutMs,
      onIdleError: (err) =>
        this.#log.warn(
          { event: "db.pool_client_error", pool: "providers", phase: "idle", err },
          "pooled DB client dropped (providers, idle)",
        ),
    });
    this.#cache = new ProviderCache(this.#pool, {
      onLoadFailure: (info) => this.#onLoadFailure(info),
      onLoadRecovered: ({ failures }) => {
        // The line that closes an alert. Nothing else says "it's fine now".
        this.#log.info(
          { event: "providers.load_recovered", failures },
          `provider cache reloaded after ${failures} failed attempt(s)`,
        );
      },
      onRowDropped: ({ reason }) =>
        this.#log.warn(
          { event: "providers.row_dropped", reason },
          "provider row failed its schema parse; dropped from the cache (fail closed)",
        ),
    });
  }

  get(providerId: string): ConnectionProvider | undefined {
    return this.#cache.get(providerId);
  }

  getByRef(ref: string, env: Env): ConnectionProvider | undefined {
    return this.#cache.getByRef(ref, env);
  }

  isLoaded(): boolean {
    return this.#cache.isLoaded();
  }

  /**
   * Load-failure logging. The ladder is the edge's, minus the `/health` half
   * (egress reports liveness only — there is no check to agree with):
   *   - **first** failure → `error`: the only line that is genuinely news. The
   *     never-loaded variant says what it means for callers — every provider
   *     lookup now fails closed;
   *   - everything after → `warn` (~1 per reconcile interval; bounded).
   *
   * `event` is the stable field a log-based alert rule keys on; the counter
   * (`helix.providers.reconciles{outcome}`) rides alongside, never replacing
   * the log (ADR-0037 decision 9).
   */
  #onLoadFailure(info: {
    err: unknown;
    consecutiveLoadFailures: number;
    neverLoaded: boolean;
  }): void {
    // A load already in flight when `stop()` ran will fail against the ended
    // pool ("Cannot use a pool after calling end"). That carries no operational
    // information, and without this guard every graceful shutdown would emit
    // the `error`-level first-failure line — the one a page is wired to.
    if (this.#stopped) return;

    const fields = {
      event: "providers.load_failed",
      err: info.err,
      consecutiveLoadFailures: info.consecutiveLoadFailures,
    };
    if (info.consecutiveLoadFailures === 1) {
      this.#log.error(
        fields,
        info.neverLoaded
          ? "provider cache has never loaded; provider lookups fail closed"
          : "provider cache load failed; serving the previous snapshot",
      );
      return;
    }
    this.#log.warn(fields, "provider cache load failed; serving the previous snapshot");
  }

  /**
   * Begin loading and listening. Resolves after the first load *attempt* —
   * boot must not hang on a down DB; the retry machinery takes over from here.
   * Never throws.
   */
  async start(): Promise<void> {
    this.#observeListenStatus();
    await this.#load();
    await this.#connectListener();
    this.#scheduleReconcile();
  }

  /**
   * Attach the `helix.providers.listen_status` callback. **Observable, not a
   * value pushed at each connect** — a gauge written once at connect time would
   * keep saying "connected" after the connection died, and 1/0-at-collection is
   * the honest signal (absent before `start()` and after `stop()`, when nothing
   * is measured).
   */
  #observeListenStatus(): void {
    if (this.#listenObserver) return;
    this.#listenObserver = (result) => {
      result.observe(this.#listenClient ? 1 : 0);
    };
    this.#listenGauge = instruments().providersListenStatus;
    this.#listenGauge.addCallback(this.#listenObserver);
  }

  /**
   * Every load goes through here so `stop()` can await one that is already in
   * flight before ending the pool. `ProviderCache.load()` never rejects, so
   * this promise is always safe to await and never needs a `.catch`.
   */
  #load(): Promise<void> {
    const load = this.#cache.load();
    this.#inFlightLoad = load;
    return load.finally(() => {
      if (this.#inFlightLoad === load) this.#inFlightLoad = null;
    });
  }

  /**
   * The reconcile poll: a self-rescheduling jittered `setTimeout` chain rather
   * than a fixed `setInterval`, so replicas don't query in a synchronized herd.
   * Rescheduling happens *after* the load settles, so a slow load can't stack
   * overlapping reconciles.
   */
  #scheduleReconcile(): void {
    if (this.#stopped || this.#reconcileTimer) return;
    this.#reconcileTimer = setTimeout(() => {
      this.#reconcileTimer = null;
      void this.#load().finally(() => this.#scheduleReconcile());
    }, jitteredDelayMs(this.#reconcileIntervalMs));
    this.#reconcileTimer.unref(); // never hold the process open
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#listenObserver) {
      // Detach before the pool goes: a callback left attached would keep this
      // instance (and its pool-backed cache) alive on the meter provider, and
      // in tests it would observe a torn-down listener on the next collection.
      this.#listenGauge?.removeCallback(this.#listenObserver);
      this.#listenObserver = null;
      this.#listenGauge = null;
    }
    for (const timer of [this.#reconcileTimer, this.#reconnectTimer, this.#notifyTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.#reconcileTimer = this.#reconnectTimer = this.#notifyTimer = null;
    await this.#teardownListener();
    // Wait out a load that was already running: `pool.end()` under it would
    // make its query reject with "Cannot use a pool after calling end", which
    // the `#stopped` guard in `#onLoadFailure` already refuses to report — but
    // there is no reason to provoke it, and the counter would still be bumped.
    await this.#inFlightLoad;
    await this.#pool.end().catch(() => {});
  }

  async #connectListener(): Promise<void> {
    if (this.#stopped) return;
    // Dedicated client, never a pool client: pool recycling silently drops
    // LISTEN registrations (ADR-0011 §Decision).
    const client = new pg.Client({
      connectionString: this.#databaseUrl,
      statement_timeout: this.#statementTimeoutMs,
      application_name: this.#applicationName,
    });
    try {
      client.on("notification", () => this.#onNotify());
      client.on("error", (err) => this.#onListenerDown(err));
      client.on("end", () => this.#onListenerDown());
      await client.connect();
      await client.query(`LISTEN ${PROVIDERS_CHANNEL}`);
      this.#listenClient = client;
      this.#backoffMs = this.#backoffInitialMs;
      // The startup race (ADR-0011 §Context): notifications committed before
      // this LISTEN are gone, so inspect current state before relying on
      // notifications. This is also the reconnect reconcile — the self-heal
      // for anything missed while the connection was down.
      void this.#load();
    } catch (err) {
      await client.end().catch(() => {});
      this.#scheduleReconnect(err);
    }
  }

  #onNotify(): void {
    if (this.#stopped || this.#notifyTimer) return;
    this.#notifyTimer = setTimeout(() => {
      this.#notifyTimer = null;
      void this.#load();
    }, NOTIFY_DEBOUNCE_MS);
    this.#notifyTimer.unref();
  }

  #onListenerDown(err?: unknown): void {
    if (this.#stopped || !this.#listenClient) return;
    const client = this.#listenClient;
    this.#listenClient = null;
    client.removeAllListeners();
    void client.end().catch(() => {});
    this.#scheduleReconnect(err);
  }

  #scheduleReconnect(err?: unknown): void {
    if (this.#stopped || this.#reconnectTimer) return;
    const delay = jitteredDelayMs(this.#backoffMs);
    this.#log.warn(
      { event: "providers.listen_down", err, delayMs: delay },
      `provider LISTEN connection down; reconnecting in ${delay}ms`,
    );
    this.#backoffMs = Math.min(this.#backoffMs * 2, this.#backoffMaxMs);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#connectListener();
    }, delay);
    this.#reconnectTimer.unref();
  }

  async #teardownListener(): Promise<void> {
    const client = this.#listenClient;
    this.#listenClient = null;
    if (client) {
      client.removeAllListeners();
      await client.end().catch(() => {});
    }
  }
}
