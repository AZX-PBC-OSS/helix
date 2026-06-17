import { describe, expect, it } from "vitest";
import { LoginThrottle } from "./loginThrottle.js";

describe("LoginThrottle", () => {
  it("blocks once the failure budget is spent, within the window", () => {
    const now = 0;
    const t = new LoginThrottle({ maxFailures: 3, windowMs: 1000, now: () => now });
    expect(t.isBlocked("k")).toBe(false);
    t.recordFailure("k");
    t.recordFailure("k");
    expect(t.isBlocked("k")).toBe(false);
    t.recordFailure("k");
    expect(t.isBlocked("k")).toBe(true);
  });

  it("resets after the window elapses", () => {
    let now = 0;
    const t = new LoginThrottle({ maxFailures: 1, windowMs: 1000, now: () => now });
    t.recordFailure("k");
    expect(t.isBlocked("k")).toBe(true);
    now = 1001;
    expect(t.isBlocked("k")).toBe(false);
  });

  it("clear() unblocks immediately (called on a successful login)", () => {
    const t = new LoginThrottle({ maxFailures: 1, windowMs: 1000 });
    t.recordFailure("k");
    expect(t.isBlocked("k")).toBe(true);
    t.clear("k");
    expect(t.isBlocked("k")).toBe(false);
  });

  it("scopes buckets per key", () => {
    const t = new LoginThrottle({ maxFailures: 1, windowMs: 1000 });
    t.recordFailure("a");
    expect(t.isBlocked("a")).toBe(true);
    expect(t.isBlocked("b")).toBe(false);
  });

  it("sweep() drops elapsed buckets", () => {
    let now = 0;
    const t = new LoginThrottle({ maxFailures: 5, windowMs: 1000, now: () => now });
    t.recordFailure("k");
    now = 2000;
    t.sweep();
    // A fresh bucket after sweep starts at zero failures.
    expect(t.isBlocked("k")).toBe(false);
  });
});
