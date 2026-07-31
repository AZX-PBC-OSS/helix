import { describe, expect, it } from "vitest";
import {
  FAILURES_DEGRADED,
  REGISTRY_CHECK_NAME,
  registryFreshnessCheck,
  STALE_DEGRADED_INTERVALS,
  STALE_ERROR_INTERVALS,
} from "./health.js";
import type { RegistryFreshness } from "./projection.js";

const INTERVAL = 60_000;

function freshness(overrides: Partial<RegistryFreshness> = {}): RegistryFreshness {
  return {
    loaded: true,
    lastSuccessfulLoadAt: "2026-07-30T12:00:00.000Z",
    staleForMs: 0,
    consecutiveLoadFailures: 0,
    lastLoadFailureAt: null,
    ...overrides,
  };
}

describe("registryFreshnessCheck", () => {
  it("is ok for a freshly loaded projection, carrying the counters", () => {
    const check = registryFreshnessCheck(freshness({ staleForMs: 12_000 }), INTERVAL);
    expect(check).toEqual({
      name: REGISTRY_CHECK_NAME,
      status: "ok",
      lastSuccessAt: "2026-07-30T12:00:00.000Z",
      metrics: { consecutiveLoadFailures: 0, staleForSeconds: 12 },
    });
  });

  it("errors when the projection has never loaded — app hosts are 503ing", () => {
    const check = registryFreshnessCheck(
      freshness({ loaded: false, lastSuccessfulLoadAt: null, staleForMs: null }),
      INTERVAL,
    );
    expect(check.status).toBe("error");
    expect(check.detail).toContain("never loaded");
    // No timestamp to report, and no age metric to invent.
    expect(check.lastSuccessAt).toBeUndefined();
    expect(check.metrics).toEqual({ consecutiveLoadFailures: 0 });
  });

  it("degrades past the staleness threshold and errors well past it", () => {
    const justUnder = STALE_DEGRADED_INTERVALS * INTERVAL;
    expect(registryFreshnessCheck(freshness({ staleForMs: justUnder }), INTERVAL).status).toBe(
      "ok",
    );
    expect(registryFreshnessCheck(freshness({ staleForMs: justUnder + 1 }), INTERVAL).status).toBe(
      "degraded",
    );

    const errorAt = STALE_ERROR_INTERVALS * INTERVAL;
    expect(registryFreshnessCheck(freshness({ staleForMs: errorAt }), INTERVAL).status).toBe(
      "degraded",
    );
    const errored = registryFreshnessCheck(freshness({ staleForMs: errorAt + 1 }), INTERVAL);
    expect(errored.status).toBe("error");
    expect(errored.detail).toBe(
      "projection last loaded 1200s ago (> 20× the 60s reconcile interval); serving stale",
    );
  });

  it("degrades on consecutive failures even while the copy is still young", () => {
    // The counter catches a failing DB faster than the age rule can: at the
    // 60 s default, 3 failures is ~3 min but 5× the interval is 5 min.
    const check = registryFreshnessCheck(
      freshness({ staleForMs: 3 * INTERVAL, consecutiveLoadFailures: FAILURES_DEGRADED }),
      INTERVAL,
    );
    expect(check.status).toBe("degraded");
    expect(check.detail).toContain(`${FAILURES_DEGRADED} consecutive`);
    expect(check.metrics?.consecutiveLoadFailures).toBe(FAILURES_DEGRADED);
  });

  it("stays ok below the failure threshold — one blip is not a degradation", () => {
    expect(
      registryFreshnessCheck(
        freshness({ consecutiveLoadFailures: FAILURES_DEGRADED - 1 }),
        INTERVAL,
      ).status,
    ).toBe("ok");
  });

  it("prefers the more severe verdict when both conditions trip", () => {
    const check = registryFreshnessCheck(
      freshness({ staleForMs: 21 * INTERVAL, consecutiveLoadFailures: 21 }),
      INTERVAL,
    );
    expect(check.status).toBe("error");
  });

  it("falls back to a 60s interval rather than silently disabling the age rule", () => {
    // config.ts parses EDGE_RECONCILE_INTERVAL_MS with a bare Number(), so all
    // of these are reachable — and NaN comparisons would grade everything ok.
    for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      const check = registryFreshnessCheck(freshness({ staleForMs: 21 * 60_000 }), bad);
      expect(check.status).toBe("error");
      expect(check.detail).toContain("60s reconcile interval");
    }
  });
});
