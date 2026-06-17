/**
 * Brute-force throttle for the shared-password login (POST /_auth/login). A
 * shared passphrase is online-guessable, so failed attempts per (IP, app) are
 * rate-limited with a fixed window; a success clears the bucket.
 *
 * Caveat: this is per-process in-memory state, and the edge is stateless and
 * horizontally scaled — the effective limit is N×instances. Combined with
 * scrypt's per-attempt cost (password.ts) that is adequate for v0's demo
 * threat model; a shared (DB/Redis-backed) counter is a future hardening.
 */

export interface LoginThrottleOptions {
  /** Failures allowed within a window before blocking. */
  maxFailures?: number;
  /** Window length in ms; the bucket resets after it elapses. */
  windowMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class LoginThrottle {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(opts: LoginThrottleOptions = {}) {
    this.#max = opts.maxFailures ?? 10;
    this.#windowMs = opts.windowMs ?? 5 * 60 * 1000;
    this.#now = opts.now ?? (() => Date.now());
  }

  #bucket(key: string): Bucket {
    const t = this.#now();
    let b = this.#buckets.get(key);
    if (!b || b.resetAt <= t) {
      b = { count: 0, resetAt: t + this.#windowMs };
      this.#buckets.set(key, b);
    }
    return b;
  }

  /** True when the key has exhausted its failure budget for the window. */
  isBlocked(key: string): boolean {
    return this.#bucket(key).count >= this.#max;
  }

  /** Count one failed attempt. */
  recordFailure(key: string): void {
    this.#bucket(key).count += 1;
  }

  /** Clear the bucket — call on a successful login. */
  clear(key: string): void {
    this.#buckets.delete(key);
  }

  /** Drop elapsed buckets so the map can't grow without bound. */
  sweep(): void {
    const t = this.#now();
    for (const [key, b] of this.#buckets) {
      if (b.resetAt <= t) this.#buckets.delete(key);
    }
  }
}
