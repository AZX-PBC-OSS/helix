import type { CounterStore } from "../gateway/counterStore.js";

/**
 * Brute-force throttle for the shared-password login (POST /_auth/login). A
 * shared passphrase is online-guessable, so attempts per (IP, app) are
 * rate-limited with a fixed window; a success clears the bucket.
 *
 * The count lives in a shared {@link CounterStore} (Postgres in prod), so the
 * limit — the economic defense in front of scrypt — holds across the
 * horizontally-scaled edge fleet rather than degrading to N×-per-replica
 * (issue #13). Keys are namespaced `login:` so this and the anon IP limiter can
 * share one store without colliding.
 *
 * The API is **reserve-first**: {@link reserve} atomically increments and
 * reports whether the attempt is over budget in one step, so the increment and
 * the limit test can't be split by a concurrent attempt (closes the
 * check-then-increment TOCTOU, issue #13). One consequence: *every* attempt in a
 * window counts toward the cap (not only failures) — a success then clears it,
 * so a legitimate user is unaffected, but repeated attempts are bounded whatever
 * their outcome.
 */

export interface LoginThrottleOptions {
  /** Attempts allowed within a window before blocking. */
  maxFailures?: number;
  /** Window length in ms; the bucket resets after it elapses. */
  windowMs?: number;
}

export class LoginThrottle {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #store: CounterStore;

  constructor(store: CounterStore, opts: LoginThrottleOptions = {}) {
    this.#max = opts.maxFailures ?? 10;
    this.#windowMs = opts.windowMs ?? 5 * 60 * 1000;
    this.#store = store;
  }

  /**
   * Reserve one attempt (atomic increment) and report whether it is over budget.
   * The caller must reserve BEFORE the expensive scrypt verify and bail on
   * `blocked` — so a flood costs one counter write, never a scrypt run, keeping
   * the per-window scrypt ceiling at `maxFailures`.
   */
  async reserve(key: string): Promise<{ blocked: boolean }> {
    const count = await this.#store.bump(`login:${key}`, this.#windowMs);
    return { blocked: count > this.#max };
  }

  /** Clear the bucket — call on a successful login. */
  async clear(key: string): Promise<void> {
    await this.#store.reset(`login:${key}`);
  }
}
