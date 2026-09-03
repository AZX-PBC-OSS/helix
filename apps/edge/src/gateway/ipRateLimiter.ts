import type { FastifyRequest } from "fastify";
import type { Caller } from "../auth/gate.js";
import type { RegistryEntry } from "../registry/projection.js";
import type { CounterStore } from "./counterStore.js";

/**
 * Per-IP rate limit for the anonymous tier on `public` apps (app-data design
 * §7, threat map §8). A public app's `/_api/*` surface is an open write/read
 * surface — the anonymous visitor has no stable principal and no per-user
 * budget to charge — so requests are capped per (IP, app) with a fixed window.
 * The sibling control is `auth/loginThrottle.ts`; this one counts *every*
 * request (not just failures).
 *
 * The count lives in a shared {@link CounterStore} (Postgres in prod), so the
 * limit holds across the horizontally-scaled edge fleet rather than degrading to
 * N×-per-replica (issue #13). Keys are namespaced `anon:` so the anon limiter
 * and the login throttle can share one store without colliding.
 *
 * Client IP is Fastify's `req.ip`; behind Container Apps' ingress that is the
 * real client only when `EDGE_TRUST_PROXY` names the ingress address (else it
 * may collapse to the ingress address) — see `config.ts` and issue #13.
 */

export interface IpRateLimiterOptions {
  /** Requests allowed within a window before blocking. `0` disables. */
  max: number;
  /** Window length in ms; the bucket resets after it elapses. */
  windowMs: number;
}

export class IpRateLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #store: CounterStore;

  constructor(opts: IpRateLimiterOptions, store: CounterStore) {
    this.#max = opts.max;
    this.#windowMs = opts.windowMs;
    this.#store = store;
  }

  /** A `max` of 0 (or less) means "no limit" — the knob is off. */
  get enabled(): boolean {
    return this.#max > 0;
  }

  /**
   * Count one request and report whether it is within budget. Returns true when
   * the request is allowed, false once the window's budget is exhausted. A
   * disabled limiter (`max <= 0`) always allows (no store round-trip).
   */
  async allow(key: string): Promise<boolean> {
    if (!this.enabled) return true;
    const count = await this.#store.bump(`anon:${key}`, this.#windowMs);
    return count <= this.#max;
  }
}

/**
 * The single rate-limit decision for a gateway call: block only the anonymous
 * tier (authenticated callers answer to per-app budgets), and only when a
 * limiter is configured and enabled. Returns true when the caller has exhausted
 * its per-IP budget and the handler should respond `429 rate_limited`.
 */
export async function anonRateLimited(
  limiter: IpRateLimiter | null,
  req: FastifyRequest,
  entry: RegistryEntry,
  caller: Caller,
): Promise<boolean> {
  if (caller.authenticated || !limiter || !limiter.enabled) return false;
  return !(await limiter.allow(`${req.ip}:${entry.appId}`));
}
