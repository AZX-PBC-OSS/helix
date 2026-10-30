import type { CounterStore } from "./counterStore.js";

/**
 * Limit refusal ledger rows per app and time window, for refusals no other
 * gate bounds: the fetch allowlist denial, the fetch size refusal decided
 * before minting, the jobs callback's policy refusals, and the jobs
 * submission throttle's refusals. Authenticated callers bypass the anonymous
 * limiter, and these refusals either return before the daily request budget
 * or are excluded from it. A retry loop could therefore write rows
 * continuously.
 *
 * Each category gets its own instance under its own key prefix (below), so a
 * flood in one category cannot use up another's budget and hide its audit
 * rows.
 *
 * Use memory to avoid a database round-trip for each dropped row. The bound is
 * per replica, unlike the shared counters used for security rate limits.
 * This limits write rate only. Total ledger size still needs retention
 * (ADR-0021 and TODO.md).
 */

/** Browser fetch allowlist denials (`forbidden`). The class default. */
export const DENIAL_PREFIX_FETCH_ALLOWLIST = "denial:";
/** Browser fetch size refusals decided before minting (`too_large`). */
export const DENIAL_PREFIX_FETCH_SIZE = "fetch-size-denial:";
/** The jobs callback's fetch-policy refusals (unattended authority). */
export const DENIAL_PREFIX_JOBS_CALLBACK = "jobs-callback-denial:";
/** The jobs submission throttle's refusal rows (`gateway/jobs.ts`). */
export const DENIAL_PREFIX_JOBS_SUBMIT = "jobs-denial:";

export interface DenialThrottleOptions {
  /** Denial rows metered per (app, env) within a window. */
  max?: number;
  /** Window length in ms; the bucket resets after it elapses. */
  windowMs?: number;
  /**
   * The key namespace inside the shared counter store. Distinct denial
   * categories must not share a window — a flood in one would otherwise blind
   * the other's audit rows. Defaults to {@link DENIAL_PREFIX_FETCH_ALLOWLIST}.
   */
  keyPrefix?: string;
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
  readonly #keyPrefix: string;
  readonly #store: CounterStore;

  constructor(store: CounterStore, opts: DenialThrottleOptions = {}) {
    this.#max = opts.max ?? 20;
    this.#windowMs = opts.windowMs ?? 60 * 1000;
    this.#keyPrefix = opts.keyPrefix ?? DENIAL_PREFIX_FETCH_ALLOWLIST;
    this.#store = store;
  }

  /**
   * Reserve one denial against the (app, env) budget.
   *
   * Keyed on **both** app and env: everything else in this ledger partitions on
   * `caller.env`, so a dev-token loop must not consume the prod app's budget.
   */
  async admit(appId: string, env: string): Promise<DenialDecision> {
    const count = await this.#store.bump(`${this.#keyPrefix}${env}:${appId}`, this.#windowMs);
    if (count <= this.#max) return { meter: true };
    const suppressed = count - this.#max;
    return suppressed === 1 || suppressed % SUMMARY_EVERY === 0
      ? { meter: false, suppressedAt: count }
      : { meter: false };
  }
}
