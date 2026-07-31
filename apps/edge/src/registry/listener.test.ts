import { describe, expect, it } from "vitest";
import { jitteredDelayMs, LiveRegistry, type RegistryLogger } from "./listener.js";
import { STALE_ERROR_INTERVALS } from "./health.js";

// The happy-path timer chain rides the real trigger→NOTIFY→reload loop in
// registry.integration.test.ts. Here: the jitter arithmetic, and the failure
// ladder driven against a DSN that can't connect (port 1 → ECONNREFUSED, fast and
// deterministic), so no successful load ever happens — the cold-start state.
const UNREACHABLE_DSN = "postgresql://helix:helix@127.0.0.1:1/helix";

interface Line {
  level: "info" | "warn" | "error";
  fields: Record<string, unknown>;
  msg: string;
}

function recorder(): { lines: Line[]; log: RegistryLogger } {
  const lines: Line[] = [];
  return {
    lines,
    log: {
      info: (fields, msg) => lines.push({ level: "info", fields, msg }),
      warn: (fields, msg) => lines.push({ level: "warn", fields, msg }),
      error: (fields, msg) => lines.push({ level: "error", fields, msg }),
    },
  };
}

const eventsOf = (lines: Line[], event: string): Line[] =>
  lines.filter((l) => l.fields.event === event);

/** Poll until `predicate` holds or the budget runs out. */
async function eventually(predicate: () => boolean, budgetMs = 4000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("jitteredDelayMs", () => {
  it("spreads the delay ±20% across the random range", () => {
    expect(jitteredDelayMs(60_000, () => 0)).toBe(48_000); // 0.8×
    expect(jitteredDelayMs(60_000, () => 0.5)).toBe(60_000); // 1.0×
    expect(jitteredDelayMs(60_000, () => 1)).toBe(72_000); // 1.2×
  });

  // The gap this test used to have: it only covered finite inputs, so `NaN`
  // slipped through — and `Math.max(0, NaN)` is `NaN`, which `setTimeout` coerces
  // to ~0 ms. That turns the anti-herd reconcile chain into a DB hot loop on
  // every replica, while /health reads `ok` because the loads keep succeeding.
  it("falls back to a sane interval rather than hot-looping on an unusable input", () => {
    for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      const delay = jitteredDelayMs(bad, () => 0.5);
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBe(60_000); // the shared safeInterval fallback
    }
  });

  it("never returns a negative or non-finite delay", () => {
    for (const random of [() => 0, () => 0.5, () => 1]) {
      for (const base of [1, 500, 60_000, Number.NaN, -1]) {
        const delay = jitteredDelayMs(base, random);
        expect(Number.isFinite(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(0);
      }
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

describe("LiveRegistry against a DB it can never reach", () => {
  it("escalates the never-loaded state instead of going quiet after one line", async () => {
    const { lines, log } = recorder();
    // 1 ms so the reconcile chain ticks fast enough to test in-process. Loads
    // arrive ~1 per tick, which is what makes the failure count stand in for
    // elapsed intervals while `staleForMs` is null.
    const registry = new LiveRegistry({
      databaseUrl: UNREACHABLE_DSN,
      reconcileIntervalMs: 1,
      log,
    });
    try {
      await registry.start();
      expect(registry.isLoaded()).toBe(false);

      // The cold-start state gets its own event, so an alert can key on it.
      const first = eventsOf(lines, "registry.never_loaded")[0];
      expect(first?.level).toBe("error");
      expect(first?.msg).toContain("app hosts are serving 503");
      expect(first?.fields.consecutiveLoadFailures).toBe(1);

      // Pre-fix this could never happen: `staleForMs` is null forever with no
      // successful load, and the age-only escalation was gated on it being
      // non-null — so the worst state logged the least, exactly once, during the
      // noisiest moment of a rolling deploy.
      await eventually(
        () =>
          eventsOf(lines, "registry.never_loaded").filter((l) => l.level === "error").length >= 2,
      );
      const errors = eventsOf(lines, "registry.never_loaded").filter((l) => l.level === "error");
      expect(errors.length).toBe(2);
      expect(errors[1]?.fields.consecutiveLoadFailures).toBeGreaterThanOrEqual(
        STALE_ERROR_INTERVALS,
      );
      // And it re-escalates once, not on every tick.
      await eventually(() => false, 200);
      expect(
        eventsOf(lines, "registry.never_loaded").filter((l) => l.level === "error").length,
      ).toBe(2);
    } finally {
      await registry.stop();
    }
  });

  it("stays silent about load failures caused by its own shutdown", async () => {
    const { lines, log } = recorder();
    const registry = new LiveRegistry({
      databaseUrl: UNREACHABLE_DSN,
      reconcileIntervalMs: 1,
      log,
    });
    await registry.start();
    await eventually(() => eventsOf(lines, "registry.never_loaded").length >= 3);

    await registry.stop();
    const after = lines.length;
    // A load in flight when the pool ends rejects with "Cannot use a pool after
    // calling end". Reporting that would emit the error-level first-failure line
    // — the one a page is wired to — on every rolling deploy.
    await eventually(() => false, 300);
    expect(lines.slice(after)).toEqual([]);
  });
});
