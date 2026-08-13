import { describe, expect, it } from "vitest";
import { daysSince, timeAgo } from "./format";

/** Offsets are taken from the real clock, so these need no timer mocking. */
const DAY = 86_400_000;
const agoIso = (ms: number) => new Date(Date.now() - ms).toISOString();

describe("timeAgo", () => {
  it("renders the sub-day units", () => {
    expect(timeAgo(agoIso(5_000))).toBe("just now");
    expect(timeAgo(agoIso(7 * 60_000))).toBe("7m ago");
    expect(timeAgo(agoIso(5 * 3_600_000))).toBe("5h ago");
    expect(timeAgo(agoIso(3 * DAY))).toBe("3d ago");
  });

  /**
   * The regression this guards: `timeAgo` used to fall back to a bare
   * `toLocaleDateString()` past 30 days, so the oldest thing on a screen was the
   * only one without a relative age — precisely where staleness matters most
   * (a 45-day-old approval read as "7/1/2026"). See ADR-0038.
   */
  it("stays relative past 30 days", () => {
    expect(timeAgo(agoIso(45 * DAY))).toBe("45d ago");
    expect(timeAgo(agoIso(400 * DAY))).toBe("400d ago");
  });
});

describe("daysSince", () => {
  it("floors to whole days", () => {
    expect(daysSince(agoIso(0))).toBe(0);
    expect(daysSince(agoIso(23 * 3_600_000))).toBe(0);
    expect(daysSince(agoIso(34 * DAY))).toBe(34);
  });

  it("clamps a future timestamp to zero rather than going negative", () => {
    expect(daysSince(new Date(Date.now() + 5 * DAY).toISOString())).toBe(0);
  });
});
