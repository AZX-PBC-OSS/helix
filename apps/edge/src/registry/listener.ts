import pg from "pg";
import { RegistryProjection, type RegistryEntry, type RegistryReader } from "./projection.js";

/**
 * Keeps the registry projection fresh (architecture §7: refresh on change,
 * sub-second): a dedicated LISTEN connection reloads on every NOTIFY from the
 * portal-owned trigger, a periodic reconcile reload covers anything a dropped
 * connection missed, and reconnects back off exponentially.
 *
 * Must match the channel in the portal migration
 * `20260612183907_registry_notify_trigger` — keep the two in sync.
 */
export const REGISTRY_CHANNEL = "helix_registry_changed";

/** Collapse NOTIFY bursts (one per statement in a transaction) into one load. */
const NOTIFY_DEBOUNCE_MS = 100;

const BACKOFF_INITIAL_MS = 500;
const BACKOFF_MAX_MS = 30_000;

export interface RegistryLogger {
  info(msg: string): void;
  warn(obj: { err?: unknown }, msg: string): void;
}

export class LiveRegistry implements RegistryReader {
  #databaseUrl: string;
  #reconcileIntervalMs: number;
  #log: RegistryLogger;
  #pool: pg.Pool;
  #projection: RegistryProjection;

  #listenClient: pg.Client | null = null;
  #reconcileTimer: NodeJS.Timeout | null = null;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #notifyTimer: NodeJS.Timeout | null = null;
  #backoffMs = BACKOFF_INITIAL_MS;
  #stopped = false;

  constructor(opts: { databaseUrl: string; reconcileIntervalMs: number; log: RegistryLogger }) {
    this.#databaseUrl = opts.databaseUrl;
    this.#reconcileIntervalMs = opts.reconcileIntervalMs;
    this.#log = opts.log;
    // Read-only projection queries only — two connections is plenty.
    this.#pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 2 });
    this.#projection = new RegistryProjection(this.#pool, {
      onLoadError: (err) =>
        this.#log.warn({ err }, "registry projection load failed; serving stale"),
    });
  }

  getApp(slug: string): RegistryEntry | undefined {
    return this.#projection.getApp(slug);
  }

  isLoaded(): boolean {
    return this.#projection.isLoaded();
  }

  /**
   * Begin loading and listening. Resolves after the first load *attempt* —
   * boot must not hang on a down DB; the retry machinery takes over from here.
   */
  async start(): Promise<void> {
    await this.#projection.load();
    await this.#connectListener();

    this.#reconcileTimer = setInterval(() => {
      void this.#projection.load();
    }, this.#reconcileIntervalMs);
    this.#reconcileTimer.unref(); // never hold the process open
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const timer of [this.#reconcileTimer, this.#reconnectTimer, this.#notifyTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.#reconcileTimer = this.#reconnectTimer = this.#notifyTimer = null;
    await this.#teardownListener();
    await this.#pool.end().catch(() => {});
  }

  async #connectListener(): Promise<void> {
    if (this.#stopped) return;
    // Dedicated client, never a pool client: pool recycling silently drops
    // LISTEN registrations.
    const client = new pg.Client({ connectionString: this.#databaseUrl });
    try {
      client.on("notification", () => this.#onNotify());
      client.on("error", (err) => this.#onListenerDown(err));
      client.on("end", () => this.#onListenerDown());
      await client.connect();
      await client.query(`LISTEN ${REGISTRY_CHANNEL}`);
      this.#listenClient = client;
      this.#backoffMs = BACKOFF_INITIAL_MS;
      // Catch anything that changed while we weren't listening.
      void this.#projection.load();
    } catch (err) {
      await client.end().catch(() => {});
      this.#scheduleReconnect(err);
    }
  }

  #onNotify(): void {
    if (this.#stopped || this.#notifyTimer) return;
    this.#notifyTimer = setTimeout(() => {
      this.#notifyTimer = null;
      void this.#projection.load();
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
    const jitter = 0.8 + Math.random() * 0.4; // ±20%
    const delay = Math.round(this.#backoffMs * jitter);
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
