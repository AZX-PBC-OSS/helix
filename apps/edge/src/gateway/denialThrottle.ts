import type { CounterStore } from "./counterStore.js";

/**
 * Caps how many allowlist-denial rows the fetch-proxy writes to `gateway_calls`
 * per app, per window.
 *
 * **Why this exists.** A `forbidden` row is the only ledger write the platform
 * makes for a request that is entirely app-chosen and authorized against
 * nothing, and it sits outside all three gates that bound every other write:
 * `anonRateLimited` returns early for authenticated callers, the allowlist check
 * returns *before* the `requestsPerDay` gate, and `fetchRequestsToday` excludes
 * `forbidden` so reordering wouldn't help either. Under the platform's stance
 * that every hosted app is untrusted, an app with a typo'd or rotated hostname
 * in a retry loop writes rows at line rate — into a table with no `DELETE` grant
 * for any role and no pruning job. No malice required.
 *
 * **In-memory, deliberately.** The other two limiters are Postgres-backed
 * because per-replica counters would *weaken a security control* (the anon
 * budget, the scrypt shield in front of shared-password login). This is not a
 * security control — it is a write-amplification damper — and DB-backing it
 * would be self-defeating: `PgCounterStore.bump` is an awaited pool checkout
 * plus a statement, so it would put a DB round-trip on the abusive path even for
 * requests it drops, which is exactly what the un-awaited metering write exists
 * to avoid. N per window per replica (≤3) is still a bound.
 *
 * **This is a damper, not the fix.** A fixed-window limiter bounds the *rate* of
 * ledger growth, not the *total*: N per window forever is still unbounded on an
 * append-only table. Retention is the actual fix — ADR-0021's fast-follow and
 * the deferred item in `TODO.md`. Do not read this class as closing that.
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
