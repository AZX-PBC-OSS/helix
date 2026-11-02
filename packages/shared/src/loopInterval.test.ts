import { describe, expect, it } from "vitest";
import { MIN_LOOP_INTERVAL_MS, resolveLoopIntervalMs } from "./loopInterval.js";

describe("resolveLoopIntervalMs", () => {
  it("uses the default when the variable is absent or blank", () => {
    expect(resolveLoopIntervalMs(undefined, 60_000, "X")).toBe(60_000);
    expect(resolveLoopIntervalMs("  ", 60_000, "X")).toBe(60_000);
  });

  it("accepts a shorter cadence down to the floor, and the default itself", () => {
    expect(resolveLoopIntervalMs("1000", 60_000, "X")).toBe(1_000);
    expect(resolveLoopIntervalMs(String(MIN_LOOP_INTERVAL_MS), 60_000, "X")).toBe(
      MIN_LOOP_INTERVAL_MS,
    );
    expect(resolveLoopIntervalMs("60000", 60_000, "X")).toBe(60_000);
  });

  it("refuses a cadence longer than the default — the platform's bounds assume it", () => {
    expect(() => resolveLoopIntervalMs("60001", 60_000, "JOBS_CLEANUP_INTERVAL_MS")).toThrow(
      /JOBS_CLEANUP_INTERVAL_MS/,
    );
  });

  it("refuses a busy-poll, a fraction, and anything that is not a number", () => {
    for (const raw of [String(MIN_LOOP_INTERVAL_MS - 1), "0", "-5", "1500.5", "1e3x", "fast"]) {
      expect(() => resolveLoopIntervalMs(raw, 60_000, "X"), raw).toThrow(/X must be/);
    }
  });
});
