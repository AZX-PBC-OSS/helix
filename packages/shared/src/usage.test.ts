import { describe, expect, it } from "vitest";
import { PlatformUsageSchema, UsageSeriesPointSchema, UsageSummarySchema } from "./usage.js";

describe("usage schemas", () => {
  it("round-trips a usage series point", () => {
    const pt = { bucket: "2026-06-23T10:00:00.000Z", costUsd: 0.07, tokens: 4000, requests: 3 };
    expect(UsageSeriesPointSchema.parse(pt)).toEqual(pt);
  });

  it("parses a per-app summary with range, series, and the today block", () => {
    const summary = UsageSummarySchema.parse({
      appId: "11111111-1111-4111-8111-111111111111",
      range: "24h",
      requests: 3,
      inputTokens: 1500,
      outputTokens: 2500,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0.07,
      latencyP95Ms: null,
      errorRate: 0,
      byOutcome: { ok: 3 },
      byModel: [{ model: "claude-opus-4-8", tokens: 4000, requests: 3, costUsd: 0.07 }],
      series: [{ bucket: "2026-06-23T10:00:00.000Z", costUsd: 0.07, tokens: 4000, requests: 3 }],
      today: { tokens: 4000, costUsd: 0.07 },
    });
    expect(summary.range).toBe("24h");
    expect(summary.today.tokens).toBe(4000);
    expect(UsageSummarySchema.safeParse({ range: "nope" }).success).toBe(false);
  });

  it("parses a range-based platform rollup (series replaces the fixed arrays)", () => {
    const platform = PlatformUsageSchema.parse({
      range: "30d",
      series: [{ bucket: "2026-06-23T00:00:00.000Z", costUsd: 0.003, tokens: 200, requests: 1 }],
      byApp: [{ slug: "demo", tokens: 200, requests: 1, costUsd: 0.003 }],
      totals: { tokensMTD: 200, requestsMTD: 1, costMTD: 0.003, activeUsers: 1 },
      capabilityMix: [{ capability: "llm", tokens: 200, costUsd: 0.003 }],
    });
    expect(platform.range).toBe("30d");
    expect(platform.series).toHaveLength(1);
    // Old fixed-array shape is gone.
    expect("tokens14d" in platform).toBe(false);
  });
});
