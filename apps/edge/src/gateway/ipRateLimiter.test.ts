import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import type { Caller } from "../auth/gate.js";
import type { RegistryEntry } from "../registry/projection.js";
import { anonRateLimited, IpRateLimiter } from "./ipRateLimiter.js";
import { InMemoryCounterStore } from "./counterStore.js";

const req = (ip: string) => ({ ip }) as FastifyRequest;
const entry = (appId: string) => ({ appId }) as RegistryEntry;
const ANON: Caller = { authenticated: false, env: "prod" };
const AUTHED: Caller = {
  authenticated: true,
  oid: "u1",
  displayName: "U",
  name: null,
  email: null,
  kind: "user",
  groups: [],
  env: "prod",
};

/** A limiter over an in-memory counter with an injectable clock. */
function limiter(max: number, windowMs: number, clock?: () => number) {
  return new IpRateLimiter({ max, windowMs }, new InMemoryCounterStore(clock));
}

describe("IpRateLimiter", () => {
  it("allows up to max requests, then blocks within the window", async () => {
    const t = limiter(3, 1000, () => 0);
    expect(await t.allow("k")).toBe(true); // 1
    expect(await t.allow("k")).toBe(true); // 2
    expect(await t.allow("k")).toBe(true); // 3
    expect(await t.allow("k")).toBe(false); // 4 — over budget
    expect(await t.allow("k")).toBe(false);
  });

  it("resets after the window elapses", async () => {
    let now = 0;
    const t = limiter(1, 1000, () => now);
    expect(await t.allow("k")).toBe(true);
    expect(await t.allow("k")).toBe(false);
    now = 1001;
    expect(await t.allow("k")).toBe(true);
  });

  it("scopes buckets per key", async () => {
    const t = limiter(1, 1000);
    expect(await t.allow("a")).toBe(true);
    expect(await t.allow("a")).toBe(false);
    // A different key (different IP+app) has its own budget.
    expect(await t.allow("b")).toBe(true);
  });

  it("is disabled when max <= 0 — always allows, never reports enabled", async () => {
    const off = limiter(0, 1000);
    expect(off.enabled).toBe(false);
    for (let i = 0; i < 100; i++) expect(await off.allow("k")).toBe(true);
  });

  it("namespaces its keys so it can share a store with the login throttle", async () => {
    // Two limiters over ONE store, same raw key: distinct `anon:`/`login:`
    // prefixes mean they don't share a bucket. (The login throttle uses `login:`;
    // here we just prove the anon prefix isolates a colliding raw key.)
    const store = new InMemoryCounterStore(() => 0);
    const a = new IpRateLimiter({ max: 1, windowMs: 1000 }, store);
    // The store also holds an unrelated `login:` bucket for the same raw key.
    await store.bump("login:k", 1000);
    await store.bump("login:k", 1000);
    // The anon limiter is unaffected — its first hit is still allowed.
    expect(await a.allow("k")).toBe(true);
  });
});

describe("anonRateLimited (gateway decision)", () => {
  it("blocks an anonymous caller once its IP+app budget is spent", async () => {
    const t = limiter(1, 1000);
    expect(await anonRateLimited(t, req("1.1.1.1"), entry("app"), ANON)).toBe(false); // 1st allowed
    expect(await anonRateLimited(t, req("1.1.1.1"), entry("app"), ANON)).toBe(true); // 2nd blocked
  });

  it("never limits an authenticated caller, even when the limiter is enabled", async () => {
    const t = limiter(1, 1000);
    for (let i = 0; i < 10; i++) {
      expect(await anonRateLimited(t, req("1.1.1.1"), entry("app"), AUTHED)).toBe(false);
    }
  });

  it("keys per IP+app — a second IP (or app) has its own budget", async () => {
    const t = limiter(1, 1000);
    expect(await anonRateLimited(t, req("1.1.1.1"), entry("app"), ANON)).toBe(false);
    expect(await anonRateLimited(t, req("1.1.1.1"), entry("app"), ANON)).toBe(true);
    expect(await anonRateLimited(t, req("2.2.2.2"), entry("app"), ANON)).toBe(false); // other IP
    expect(await anonRateLimited(t, req("1.1.1.1"), entry("other"), ANON)).toBe(false); // other app
  });

  it("never limits when no limiter is configured (null) or it is disabled", async () => {
    expect(await anonRateLimited(null, req("1.1.1.1"), entry("app"), ANON)).toBe(false);
    const off = limiter(0, 1000);
    for (let i = 0; i < 10; i++) {
      expect(await anonRateLimited(off, req("1.1.1.1"), entry("app"), ANON)).toBe(false);
    }
  });
});
