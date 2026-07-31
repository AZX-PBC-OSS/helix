import { describe, expect, it } from "vitest";
import { HealthStatusSchema, worstHealthState } from "./health.js";

describe("HealthStatusSchema", () => {
  it("accepts a liveness-only response with no checks (portal, egress)", () => {
    const parsed = HealthStatusSchema.parse({ status: "ok", service: "helix-portal", uptime: 12 });
    expect(parsed.checks).toBeUndefined();
  });

  it("accepts all three states", () => {
    for (const status of ["ok", "degraded", "error"] as const) {
      expect(HealthStatusSchema.parse({ status, service: "s", uptime: 0 }).status).toBe(status);
    }
  });

  it("rejects a status outside the enum", () => {
    expect(() => HealthStatusSchema.parse({ status: "fine", service: "s", uptime: 0 })).toThrow();
  });

  it("round-trips a check with detail, timestamp and metrics", () => {
    const parsed = HealthStatusSchema.parse({
      status: "degraded",
      service: "helix-edge",
      uptime: 812,
      checks: [
        {
          name: "registry-projection",
          status: "degraded",
          detail: "4 consecutive projection load failures; serving stale",
          lastSuccessAt: "2026-07-30T12:00:00.000Z",
          metrics: { consecutiveLoadFailures: 4, staleForSeconds: 412 },
        },
      ],
    });
    expect(parsed.checks?.[0]?.metrics?.consecutiveLoadFailures).toBe(4);
  });

  it("rejects a non-ISO lastSuccessAt", () => {
    expect(() =>
      HealthStatusSchema.parse({
        status: "ok",
        service: "s",
        uptime: 0,
        checks: [{ name: "n", status: "ok", lastSuccessAt: "yesterday" }],
      }),
    ).toThrow();
  });

  it("rejects a non-numeric metric (metrics must stay chartable)", () => {
    expect(() =>
      HealthStatusSchema.parse({
        status: "ok",
        service: "s",
        uptime: 0,
        checks: [{ name: "n", status: "ok", metrics: { failures: "many" } }],
      }),
    ).toThrow();
  });
});

describe("worstHealthState", () => {
  it("is ok for no checks — a service with nothing to report is healthy", () => {
    expect(worstHealthState([])).toBe("ok");
  });

  it("returns the worst state regardless of order", () => {
    expect(worstHealthState(["ok", "ok"])).toBe("ok");
    expect(worstHealthState(["ok", "degraded"])).toBe("degraded");
    expect(worstHealthState(["degraded", "ok"])).toBe("degraded");
    expect(worstHealthState(["degraded", "error", "ok"])).toBe("error");
    expect(worstHealthState(["error", "degraded"])).toBe("error");
  });
});
