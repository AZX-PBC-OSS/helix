import { describe, expect, it } from "vitest";
import { jitteredDelayMs } from "./listener.js";

// The timer chains themselves ride the real trigger→NOTIFY→reload loop in
// registry.integration.test.ts; `LiveRegistry`'s constructor opens a pg pool, so
// only the arithmetic is unit-testable here.
describe("jitteredDelayMs", () => {
  it("spreads the delay ±20% across the random range", () => {
    expect(jitteredDelayMs(60_000, () => 0)).toBe(48_000); // 0.8×
    expect(jitteredDelayMs(60_000, () => 0.5)).toBe(60_000); // 1.0×
    expect(jitteredDelayMs(60_000, () => 1)).toBe(72_000); // 1.2×
  });

  it("never returns a negative delay", () => {
    for (const random of [() => 0, () => 0.5, () => 1]) {
      expect(jitteredDelayMs(0, random)).toBe(0);
      expect(jitteredDelayMs(1, random)).toBeGreaterThanOrEqual(0);
    }
  });

  it("stays inside the band for real randomness, so no replica drifts away", () => {
    for (let i = 0; i < 200; i++) {
      const delay = jitteredDelayMs(60_000);
      expect(delay).toBeGreaterThanOrEqual(48_000);
      expect(delay).toBeLessThanOrEqual(72_000);
    }
  });
});
