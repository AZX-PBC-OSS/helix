import type { Pool } from "pg";
import { createEdgePool, type EdgePoolOpts } from "../db/pool.js";

/**
 * Fixed-window counter seam behind the edge's abuse controls — the anonymous IP
 * rate limiter (`ipRateLimiter.ts`) and the shared-password login throttle
 * (`auth/loginThrottle.ts`). Both are the same primitive: an atomic
 * increment-within-a-window keyed by `<purpose>:<ip>:<appId>`.
 *
 * The prod implementation is Postgres-backed ({@link PgCounterStore}) so the
 * limit holds across the horizontally-scaled edge fleet instead of degrading to
 * N×-per-replica (issue #13). The in-memory implementation
 * ({@link InMemoryCounterStore}) keeps unit tests fast and single-process dev
 * working; it is NOT multi-replica safe.
 */
export interface CounterStore {
  /**
   * Increment the window counter for `key` and return the new count. If the
   * key's window has elapsed (or it never existed), the window restarts at 1.
   * `windowMs` sizes a freshly-started window, so different callers can share
   * one store with different windows.
   */
  bump(key: string, windowMs: number): Promise<number>;
  /** Drop the key entirely (a login success clears its throttle bucket). */
  reset(key: string): Promise<void>;
  /** GC elapsed windows so the store can't grow without bound under a flood. */
  sweep(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Postgres-backed counter under the `helix_edge` role (SELECT+INSERT+UPDATE+DELETE
 * on `rate_counters`). `bump` is a single atomic upsert: the `ON CONFLICT` branch
 * either restarts the window (once `resetAt` has passed) or increments it, and
 * `RETURNING count` reports the post-increment value. Because the read, the
 * increment, and the limit decision the caller makes off the return value all
 * hinge on one statement, there is no check-then-increment race (issue #13's
 * login-throttle TOCTOU is closed by construction).
 */
export class PgCounterStore implements CounterStore {
  readonly #pool: Pool;

  constructor(databaseUrl: string, opts: EdgePoolOpts = {}) {
    this.#pool = createEdgePool(databaseUrl, { ...opts, label: opts.label ?? "rate-counters" });
  }

  async bump(key: string, windowMs: number): Promise<number> {
    const res = await this.#pool.query<{ count: number }>(
      `INSERT INTO rate_counters ("bucketKey", count, "resetAt")
         VALUES ($1, 1, now() + ($2 || ' milliseconds')::interval)
       ON CONFLICT ("bucketKey") DO UPDATE
         SET count = CASE WHEN rate_counters."resetAt" <= now() THEN 1
                          ELSE rate_counters.count + 1 END,
             "resetAt" = CASE WHEN rate_counters."resetAt" <= now()
                              THEN now() + ($2 || ' milliseconds')::interval
                              ELSE rate_counters."resetAt" END
       RETURNING count`,
      [key, windowMs],
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  async reset(key: string): Promise<void> {
    await this.#pool.query(`DELETE FROM rate_counters WHERE "bucketKey" = $1`, [key]);
  }

  async sweep(): Promise<void> {
    await this.#pool.query(`DELETE FROM rate_counters WHERE "resetAt" < now()`);
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * In-memory counter — the extracted `Map` logic the two limiters used to hold
 * privately. NOT multi-replica safe (the whole point of {@link PgCounterStore}
 * is a shared fleet-wide count), so `server.ts` overrides it for the anon IP
 * limiter and the login throttle, whose budgets are security controls.
 *
 * It is not unused in prod, though: `DenialThrottle` (`denialThrottle.ts`) runs
 * on this deliberately, because it damps ledger write amplification rather than
 * defending a limit — see that class's docblock.
 */
export class InMemoryCounterStore implements CounterStore {
  readonly #buckets = new Map<string, Bucket>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async bump(key: string, windowMs: number): Promise<number> {
    const t = this.#now();
    let b = this.#buckets.get(key);
    if (!b || b.resetAt <= t) {
      b = { count: 0, resetAt: t + windowMs };
      this.#buckets.set(key, b);
    }
    b.count += 1;
    return b.count;
  }

  async reset(key: string): Promise<void> {
    this.#buckets.delete(key);
  }

  async sweep(): Promise<void> {
    const t = this.#now();
    for (const [key, b] of this.#buckets) {
      if (b.resetAt <= t) this.#buckets.delete(key);
    }
  }

  async close(): Promise<void> {}
}
