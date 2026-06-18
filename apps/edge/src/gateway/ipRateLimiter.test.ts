import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import type { Caller } from "../auth/gate.js";
import type { RegistryEntry } from "../registry/projection.js";
import { anonRateLimited, IpRateLimiter } from "./ipRateLimiter.js";

const req = (ip: string) => ({ ip }) as FastifyRequest;
const entry = (appId: string) => ({ appId }) as RegistryEntry;
const ANON: Caller = { authenticated: false };
const AUTHED: Caller = { authenticated: true, oid: "u1", displayName: "U", groups: [] };

describe("IpRateLimiter", () => {
  it("allows up to max requests, then blocks within the window", () => {
    const now = 0;
    const t = new IpRateLimiter({ max: 3, windowMs: 1000, now: () => now });
    expect(t.allow("k")).toBe(true); // 1
    expect(t.allow("k")).toBe(true); // 2
    expect(t.allow("k")).toBe(true); // 3
    expect(t.allow("k")).toBe(false); // 4 — over budget
    expect(t.allow("k")).toBe(false);
  });

  it("resets after the window elapses", () => {
    let now = 0;
    const t = new IpRateLimiter({ max: 1, windowMs: 1000, now: () => now });
    expect(t.allow("k")).toBe(true);
    expect(t.allow("k")).toBe(false);
    now = 1001;
    expect(t.allow("k")).toBe(true);
  });

  it("scopes buckets per key", () => {
    const t = new IpRateLimiter({ max: 1, windowMs: 1000 });
    expect(t.allow("a")).toBe(true);
    expect(t.allow("a")).toBe(false);
    // A different key (different IP+app) has its own budget.
    expect(t.allow("b")).toBe(true);
  });

  it("is disabled when max <= 0 — always allows, never reports enabled", () => {
    const off = new IpRateLimiter({ max: 0, windowMs: 1000 });
    expect(off.enabled).toBe(false);
    for (let i = 0; i < 100; i++) expect(off.allow("k")).toBe(true);
  });

  it("sweep() drops elapsed buckets so the map can't grow without bound", () => {
    let now = 0;
    const t = new IpRateLimiter({ max: 1, windowMs: 1000, now: () => now });
    expect(t.allow("k")).toBe(true);
    expect(t.allow("k")).toBe(false);
    now = 2000;
    t.sweep();
    // A fresh bucket after sweep starts at zero — the next request is allowed.
    expect(t.allow("k")).toBe(true);
  });
});

describe("anonRateLimited (gateway decision)", () => {
  it("blocks an anonymous caller once its IP+app budget is spent", () => {
    const t = new IpRateLimiter({ max: 1, windowMs: 1000 });
    expect(anonRateLimited(t, req("1.1.1.1"), entry("app"), ANON)).toBe(false); // 1st allowed
    expect(anonRateLimited(t, req("1.1.1.1"), entry("app"), ANON)).toBe(true); // 2nd blocked
  });

  it("never limits an authenticated caller, even when the limiter is enabled", () => {
    const t = new IpRateLimiter({ max: 1, windowMs: 1000 });
    for (let i = 0; i < 10; i++) {
      expect(anonRateLimited(t, req("1.1.1.1"), entry("app"), AUTHED)).toBe(false);
    }
  });

  it("keys per IP+app — a second IP (or app) has its own budget", () => {
    const t = new IpRateLimiter({ max: 1, windowMs: 1000 });
    expect(anonRateLimited(t, req("1.1.1.1"), entry("app"), ANON)).toBe(false);
    expect(anonRateLimited(t, req("1.1.1.1"), entry("app"), ANON)).toBe(true);
    expect(anonRateLimited(t, req("2.2.2.2"), entry("app"), ANON)).toBe(false); // other IP
    expect(anonRateLimited(t, req("1.1.1.1"), entry("other"), ANON)).toBe(false); // other app
  });

  it("never limits when no limiter is configured (null) or it is disabled", () => {
    expect(anonRateLimited(null, req("1.1.1.1"), entry("app"), ANON)).toBe(false);
    const off = new IpRateLimiter({ max: 0, windowMs: 1000 });
    for (let i = 0; i < 10; i++) {
      expect(anonRateLimited(off, req("1.1.1.1"), entry("app"), ANON)).toBe(false);
    }
  });
});
