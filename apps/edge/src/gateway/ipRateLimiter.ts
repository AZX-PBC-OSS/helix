import type { FastifyRequest } from "fastify";
import type { Caller } from "../auth/gate.js";
import type { RegistryEntry } from "../registry/projection.js";

/**
 * Per-IP rate limit for the anonymous tier on `public` apps (app-data design
 * §7, threat map §8). A public app's `/_api/*` surface is an open write/read
 * surface — the anonymous visitor has no stable principal and no per-user
 * budget to charge — so requests are capped per (IP, app) with a fixed window.
 * The sibling control is `auth/loginThrottle.ts`; this one counts *every*
 * request (not just failures).
 *
 * Caveat (identical to loginThrottle): this is per-process in-memory state, and
 * the edge is stateless and horizontally scaled — the effective limit is
 * N×instances. That is adequate for v0's demo threat model alongside the per-app
 * `writesPerDay`/`dollarsPerDay` budgets; a shared (DB/Redis-backed) counter is a
 * future hardening. Client IP is Fastify's `req.ip`; the edge runs with the
 * default `trustProxy: false` (prod sits behind Azure ingress with the client IP
 * arriving directly), the same posture loginThrottle relies on.
 */

export interface IpRateLimiterOptions {
  /** Requests allowed within a window before blocking. `0` disables. */
  max: number;
  /** Window length in ms; the bucket resets after it elapses. */
  windowMs: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class IpRateLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(opts: IpRateLimiterOptions) {
    this.#max = opts.max;
    this.#windowMs = opts.windowMs;
    this.#now = opts.now ?? (() => Date.now());
  }

  /** A `max` of 0 (or less) means "no limit" — the knob is off. */
  get enabled(): boolean {
    return this.#max > 0;
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

  /**
   * Count one request and report whether it is within budget. Returns true when
   * the request is allowed, false once the window's budget is exhausted. A
   * disabled limiter (`max <= 0`) always allows.
   */
  allow(key: string): boolean {
    if (!this.enabled) return true;
    const b = this.#bucket(key);
    b.count += 1;
    return b.count <= this.#max;
  }

  /** Drop elapsed buckets so the map can't grow without bound under a flood. */
  sweep(): void {
    const t = this.#now();
    for (const [key, b] of this.#buckets) {
      if (b.resetAt <= t) this.#buckets.delete(key);
    }
  }
}

/**
 * The single rate-limit decision for a gateway call: block only the anonymous
 * tier (authenticated callers answer to per-app budgets), and only when a
 * limiter is configured and enabled. Returns true when the caller has exhausted
 * its per-IP budget and the handler should respond `429 rate_limited`.
 */
export function anonRateLimited(
  limiter: IpRateLimiter | null,
  req: FastifyRequest,
  entry: RegistryEntry,
  caller: Caller,
): boolean {
  if (caller.authenticated || !limiter || !limiter.enabled) return false;
  return !limiter.allow(`${req.ip}:${entry.appId}`);
}
