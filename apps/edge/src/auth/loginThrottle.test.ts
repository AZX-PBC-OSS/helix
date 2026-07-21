import { describe, expect, it } from "vitest";
import { LoginThrottle } from "./loginThrottle.js";
import { InMemoryCounterStore } from "../gateway/counterStore.js";

/** A throttle over an in-memory counter with an injectable clock. */
function throttle(maxFailures: number, windowMs: number, clock?: () => number) {
  return new LoginThrottle(new InMemoryCounterStore(clock), { maxFailures, windowMs });
}

describe("LoginThrottle (reserve-first)", () => {
  it("blocks once the attempt budget is spent, within the window", async () => {
    const t = throttle(3, 1000, () => 0);
    expect((await t.reserve("k")).blocked).toBe(false); // 1
    expect((await t.reserve("k")).blocked).toBe(false); // 2
    expect((await t.reserve("k")).blocked).toBe(false); // 3 — last allowed
    expect((await t.reserve("k")).blocked).toBe(true); // 4 — over budget
  });

  it("resets after the window elapses", async () => {
    let now = 0;
    const t = throttle(1, 1000, () => now);
    expect((await t.reserve("k")).blocked).toBe(false); // 1 (last allowed)
    expect((await t.reserve("k")).blocked).toBe(true); // 2 blocked
    now = 1001;
    expect((await t.reserve("k")).blocked).toBe(false); // window reset
  });

  it("clear() resets the bucket immediately (called on a successful login)", async () => {
    const t = throttle(1, 1000, () => 0);
    expect((await t.reserve("k")).blocked).toBe(false);
    expect((await t.reserve("k")).blocked).toBe(true);
    await t.clear("k");
    expect((await t.reserve("k")).blocked).toBe(false);
  });

  it("scopes buckets per key", async () => {
    const t = throttle(1, 1000, () => 0);
    expect((await t.reserve("a")).blocked).toBe(false);
    expect((await t.reserve("a")).blocked).toBe(true);
    // A different key (different IP+app) has its own budget.
    expect((await t.reserve("b")).blocked).toBe(false);
  });

  it("counts every attempt (not only failures) — a success must clear()", async () => {
    // Reserve-first means the eventually-successful attempt also counts; the
    // caller clears on success so a legitimate user isn't penalised.
    const t = throttle(2, 1000, () => 0);
    await t.reserve("k"); // attempt 1 (would-be failure, no clear)
    await t.reserve("k"); // attempt 2
    expect((await t.reserve("k")).blocked).toBe(true); // attempt 3 blocked
  });
});
