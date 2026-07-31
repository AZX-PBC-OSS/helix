import pg from "pg";
import { createEdgePool, DEFAULT_STATEMENT_TIMEOUT_MS } from "../db/pool.js";
import { safeInterval, STALE_ERROR_INTERVALS } from "./health.js";
import {
  RegistryProjection,
  type RegistryEntry,
  type RegistryFreshness,
  type RegistryFreshnessReader,
  type RegistryLoadFailure,
  type RegistryReader,
} from "./projection.js";

/**
 * Keeps the registry projection fresh (architecture §7: refresh on change,
 * sub-second): a dedicated LISTEN connection reloads on every NOTIFY from the
 * portal-owned trigger, a jittered reconcile reload covers anything a dropped
 * connection missed, and reconnects back off exponentially.
 *
 * It also owns the *reporting* half of the serve-stale stance (ADR-0025): the
 * projection tracks freshness, and this class decides how loudly to say so —
 * see `#onLoadFailure`.
 *
 * Must match the channel in the portal migration
 * `20260612183907_registry_notify_trigger` — keep the two in sync.
 */
export const REGISTRY_CHANNEL = "helix_registry_changed";

/** Collapse NOTIFY bursts (one per statement in a transaction) into one load. */
const NOTIFY_DEBOUNCE_MS = 100;

const BACKOFF_INITIAL_MS = 500;
const BACKOFF_MAX_MS = 30_000;

/** ±20% spread applied to every scheduled delay (see `jitteredDelayMs`). */
const JITTER_SPREAD = 0.2;

/**
 * Spread a scheduled delay by ±20%. Both schedulers here use it, for the same
 * reason: N replicas started together would otherwise hit the DB on exactly the
 * same tick — a synchronized herd on the reconcile poll (ADR-0025 item 2) and a
 * synchronized reconnect storm after a DB restart.
 *
 * Exported for its own test: `LiveRegistry`'s constructor opens a real pg pool,
 * so the arithmetic has to be reachable without one.
 */
export function jitteredDelayMs(baseMs: number, random: () => number = Math.random): number {
  // Sanitize the base: `Math.max(0, NaN)` is `NaN`, and `setTimeout(fn, NaN)`
  // coerces to ~0 ms — a hot reconcile loop from every replica, the exact
  // opposite of what this function is for. `config.ts` rejects such a value at
  // boot; this is the belt-and-braces half.
  const base = safeInterval(baseMs);
  const factor = 1 - JITTER_SPREAD + random() * (2 * JITTER_SPREAD);
  return Math.max(0, Math.round(base * factor));
}

export interface RegistryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export class LiveRegistry implements RegistryReader, RegistryFreshnessReader {
  #databaseUrl: string;
  #reconcileIntervalMs: number;
  #statementTimeoutMs: number;
  #log: RegistryLogger;
  #pool: pg.Pool;
  #projection: RegistryProjection;

  #listenClient: pg.Client | null = null;
  #reconcileTimer: NodeJS.Timeout | null = null;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #notifyTimer: NodeJS.Timeout | null = null;
  #backoffMs = BACKOFF_INITIAL_MS;
  #stopped = false;
  /** The load `stop()` waits out, so a teardown can't race a live query. */
  #inFlightLoad: Promise<void> | null = null;
  /** Whether the "crossed the /health error line" escalation has already fired. */
  #staleErrorLogged = false;

  constructor(opts: {
    databaseUrl: string;
    reconcileIntervalMs: number;
    statementTimeoutMs?: number;
    log: RegistryLogger;
    /**
     * Whether the projection reads the `apps` password columns. Default true (the
     * edge serves the password login). The dev-gateway passes false — under its
     * column-scoped `helix_dev` grant it has no access to those columns and must
     * not read a prod credential (dev-mode §5.3).
     */
    includePasswords?: boolean;
  }) {
    this.#databaseUrl = opts.databaseUrl;
    this.#reconcileIntervalMs = opts.reconcileIntervalMs;
    this.#statementTimeoutMs = opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
    this.#log = opts.log;
    // Read-only projection queries only — two connections is plenty.
    this.#pool = createEdgePool(opts.databaseUrl, {
      max: 2,
      statementTimeoutMs: this.#statementTimeoutMs,
      label: "registry",
      // A projection connection dropping is the normal shape of a DB restart.
      // It is not itself a load failure — the next reload reconnects, and if
      // that fails too, `#onLoadFailure` is what escalates. Reported under the
      // same `db.pool_client_error` event as every other pool, so one alert rule
      // covers the fleet rather than one per pool.
      onClientError: (err, ctx) =>
        this.#log.warn(
          { event: "db.pool_client_error", pool: ctx.label, phase: ctx.phase, err },
          `pooled DB client dropped (${ctx.label}, ${ctx.phase})`,
        ),
    });
    this.#projection = new RegistryProjection(this.#pool, {
      includePasswords: opts.includePasswords,
      onLoadFailure: (info) => this.#onLoadFailure(info),
      onLoadRecovered: ({ failures, staleForMs }) => {
        this.#staleErrorLogged = false;
        // The line that closes an alert. Nothing else says "it's fine now".
        this.#log.info(
          { event: "registry.load_recovered", failures, staleForMs },
          `registry projection reloaded after ${failures} failed attempt(s)`,
        );
      },
    });
  }

  getApp(slug: string): RegistryEntry | undefined {
    return this.#projection.getApp(slug);
  }

  isLoaded(): boolean {
    return this.#projection.isLoaded();
  }

  freshness(): RegistryFreshness {
    return this.#projection.freshness();
  }

  /**
   * Load-failure logging (ADR-0025 item 1). The level ladder matters because
   * serve-stale means nothing else surfaces the fault:
   *  - **first** failure → `error`: the only line that is genuinely news;
   *  - crossing the `/health` error threshold → `error`, exactly once, so a long
   *    outage re-announces itself when it stops being merely degraded;
   *  - everything between → `warn` (~1 per reconcile interval; bounded).
   *
   * `event` is the stable field a log-based metric / alert rule keys on — the
   * platform has no metrics pipeline, so the log IS the metric channel.
   */
  #onLoadFailure(info: RegistryLoadFailure): void {
    // A load already in flight when `stop()` ran will fail against the ended
    // pool ("Cannot use a pool after calling end"). That carries no operational
    // information, and without this guard it would emit the `error`-level
    // first-failure line — the one a page is wired to — on every graceful
    // shutdown, i.e. on every rolling deploy.
    if (this.#stopped) return;

    const neverLoaded = info.staleForMs === null;
    const fields = {
      event: neverLoaded ? "registry.never_loaded" : "registry.load_failed",
      err: info.err,
      consecutiveLoadFailures: info.consecutiveLoadFailures,
      staleForMs: info.staleForMs,
      lastSuccessfulLoadAt: info.lastSuccessfulLoadAt,
      reconcileIntervalMs: this.#reconcileIntervalMs,
    };
    const msg = neverLoaded
      ? "registry projection has never loaded; app hosts are serving 503"
      : "registry projection load failed; serving stale";

    if (info.consecutiveLoadFailures === 1) {
      this.#log.error(fields, msg);
      return;
    }
    if (!this.#staleErrorLogged && this.#crossedErrorLine(info)) {
      this.#staleErrorLogged = true;
      this.#log.error(fields, `${msg} (past ${STALE_ERROR_INTERVALS}× the reconcile interval)`);
      return;
    }
    this.#log.warn(fields, msg);
  }

  /**
   * Whether this failure crosses the same line `/health` grades as `error`, so
   * the log ladder and the health body agree by construction (both go through
   * `safeInterval`).
   *
   * Two arms, because a cold start has no age to measure: with no successful load
   * ever, `staleForMs` is `null` **forever**, so an age-only test can never fire
   * and the worst state — every app host 503ing — would log the least. Failures
   * arrive roughly one per reconcile tick when nothing succeeds, so the failure
   * count stands in for elapsed intervals there.
   */
  #crossedErrorLine(info: RegistryLoadFailure): boolean {
    if (info.staleForMs === null) return info.consecutiveLoadFailures >= STALE_ERROR_INTERVALS;
    return info.staleForMs > STALE_ERROR_INTERVALS * safeInterval(this.#reconcileIntervalMs);
  }

  /**
   * Begin loading and listening. Resolves after the first load *attempt* —
   * boot must not hang on a down DB; the retry machinery takes over from here.
   */
  async start(): Promise<void> {
    await this.#load();
    await this.#connectListener();
    this.#scheduleReconcile();
  }

  /**
   * Every load goes through here so `stop()` can await one that is already in
   * flight before ending the pool. `RegistryProjection.load()` never rejects, so
   * this promise is always safe to await and never needs a `.catch`.
   */
  #load(): Promise<void> {
    const load = this.#projection.load();
    this.#inFlightLoad = load;
    return load.finally(() => {
      if (this.#inFlightLoad === load) this.#inFlightLoad = null;
    });
  }

  /**
   * The reconcile poll: a self-rescheduling jittered `setTimeout` chain rather
   * than a fixed `setInterval`, so replicas don't query in a synchronized herd
   * (ADR-0025 item 2). Rescheduling happens *after* the load settles, so a slow
   * load can't stack overlapping reconciles.
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
    for (const timer of [this.#reconcileTimer, this.#reconnectTimer, this.#notifyTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.#reconcileTimer = this.#reconnectTimer = this.#notifyTimer = null;
    await this.#teardownListener();
    // Wait out a load that was already running: `pool.end()` under it would make
    // its query reject with "Cannot use a pool after calling end", which the
    // `#stopped` guard in `#onLoadFailure` already refuses to report — but there
    // is no reason to provoke it, and the counter would still be bumped.
    await this.#inFlightLoad;
    await this.#pool.end().catch(() => {});
  }

  async #connectListener(): Promise<void> {
    if (this.#stopped) return;
    // Dedicated client, never a pool client: pool recycling silently drops
    // LISTEN registrations.
    const client = new pg.Client({
      connectionString: this.#databaseUrl,
      statement_timeout: this.#statementTimeoutMs,
    });
    try {
      client.on("notification", () => this.#onNotify());
      client.on("error", (err) => this.#onListenerDown(err));
      client.on("end", () => this.#onListenerDown());
      await client.connect();
      await client.query(`LISTEN ${REGISTRY_CHANNEL}`);
      this.#listenClient = client;
      this.#backoffMs = BACKOFF_INITIAL_MS;
      // Catch anything that changed while we weren't listening.
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
    this.#log.warn({ err }, `registry LISTEN connection down; reconnecting in ${delay}ms`);
    this.#backoffMs = Math.min(this.#backoffMs * 2, BACKOFF_MAX_MS);
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
