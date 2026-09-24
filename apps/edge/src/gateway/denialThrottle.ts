import type { CounterStore } from "./counterStore.js";

/**
 * Limit fetch allowlist-denial ledger rows per app and time window.
 * Authenticated callers bypass the anonymous limiter; denied origins return
 * before the daily request budget, which also excludes forbidden outcomes.
 * A retry loop could therefore write denial rows continuously.
 *
 * Use memory to avoid a database round-trip for each dropped row. The bound is
 * per replica, unlike the shared counters used for security rate limits.
 * This limits write rate only. Total ledger size still needs retention
 * (ADR-0021 and TODO.md).
 */

export interface DenialThrottleOptions {
  /** Denial rows metered per (app, env) within a window. */
  max?: number;
  /** Window length in ms; the bucket resets after it elapses. */
  windowMs?: number;
}

/** How many suppressed attempts between magnitude summaries. */
const SUMMARY_EVERY = 1000;

export interface DenialDecision {
  /** Write the ledger row? False once the window's budget is spent. */
  meter: boolean;
  /**
   * Set only on the lines worth logging: the attempt count for this window so
   * far. Present on the first suppressed attempt and then every
   * {@link SUMMARY_EVERY} after it, so a flood reports its magnitude without
   * one log line per request. Absent means "say nothing".
   */
  suppressedAt?: number;
}

export class DenialThrottle {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #store: CounterStore;

  constructor(store: CounterStore, opts: DenialThrottleOptions = {}) {
    this.#max = opts.max ?? 20;
    this.#windowMs = opts.windowMs ?? 60 * 1000;
    this.#store = store;
  }

  /**
   * Reserve one denial against the (app, env) budget.
   *
   * Keyed on **both** app and env: everything else in this ledger partitions on
   * `caller.env`, so a dev-token loop must not consume the prod app's budget.
   */
  async admit(appId: string, env: string): Promise<DenialDecision> {
    const count = await this.#store.bump(`denial:${env}:${appId}`, this.#windowMs);
    if (count <= this.#max) return { meter: true };
    const suppressed = count - this.#max;
    return suppressed === 1 || suppressed % SUMMARY_EVERY === 0
      ? { meter: false, suppressedAt: count }
      : { meter: false };
  }
}
