import { describe, expect, it } from "vitest";
import { VERSION_STATUSES, VISIBILITY_MODES } from "@azx-pbc/shared";
import { VersionStatus, VisibilityMode } from "./generated/enums.js";
import {
  blobPrefixFor,
  capabilitiesFromRow,
  toApp,
  toGatewayCall,
  toManifest,
  toPlatformUsage,
  toUsageSummary,
  toVersion,
  visibilityFromColumns,
  visibilityToColumns,
} from "./mappers.js";
import type { App as AppRow, Version as VersionRow } from "./client.js";

// Guard against the DB enums drifting from the shared contract enums. If
// schema.prisma and @azx-pbc/shared disagree, this fails before any route does.
describe("enum drift guards", () => {
  it("VersionStatus matches VERSION_STATUSES", () => {
    expect(Object.values(VersionStatus).sort()).toEqual([...VERSION_STATUSES].sort());
  });

  it("VisibilityMode matches VISIBILITY_MODES", () => {
    expect(Object.values(VisibilityMode).sort()).toEqual([...VISIBILITY_MODES].sort());
  });
});

describe("visibility column mapping", () => {
  it("round-trips a multi-group visibility through columns", () => {
    const columns = visibilityToColumns({ mode: "group", groupIds: ["abc", "def"] });
    expect(columns).toEqual({ visibilityMode: "group", visibilityGroupIds: ["abc", "def"] });
    expect(visibilityFromColumns(columns.visibilityMode, columns.visibilityGroupIds)).toEqual({
      mode: "group",
      groupIds: ["abc", "def"],
    });
  });

  it("empties the group list for payload-less modes", () => {
    for (const mode of ["internal", "password", "public"] as const) {
      expect(visibilityToColumns({ mode })).toEqual({
        visibilityMode: mode,
        visibilityGroupIds: [],
      });
      expect(visibilityFromColumns(mode, [])).toEqual({ mode });
    }
  });

  // The read path has to be total. `toApp` validates its output through
  // `AppSchema`, so any column state this turns into a shape zod refuses is a
  // 500 on `GET /api/v1/apps` — the entire list, for one odd row. The
  // predecessor did exactly that: it coerced a NULL group id to `""`, which
  // fails `z.string().min(1)`, behind a comment asserting the state could not
  // arise. Safety comes from the edge's gate denying an empty set, not from this
  // function being strict.
  it("maps a zero-group `group` row rather than refusing it", () => {
    expect(visibilityFromColumns("group", [])).toEqual({ mode: "group", groupIds: [] });
  });
});

const NOW = new Date("2026-06-11T00:00:00.000Z");

describe("row mappers validate against the shared schema", () => {
  const APP_ID = "11111111-1111-4111-8111-111111111111";
  const VERSION_ID = "22222222-2222-4222-8222-222222222222";

  it("maps an apps row to a wire App", () => {
    const row: AppRow = {
      id: APP_ID,
      slug: "cost-explorer",
      displayName: "Cost Explorer",
      visibilityMode: "internal",
      visibilityGroupIds: [],
      currentVersionId: null,
      passwordHash: null,
      passwordSalt: null,
      passwordEnc: null,
      passwordSetAt: null,
      ownerId: null,
      ownerName: null,
      ownerEmail: null,
      capabilities: {},
      policyVersion: 0,
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(toApp(row)).toEqual({
      id: APP_ID,
      slug: "cost-explorer",
      displayName: "Cost Explorer",
      visibility: { mode: "internal" },
      currentVersionId: null,
      archivedAt: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      // Composed from the deployment's apps base so clients never template it.
      url: "https://cost-explorer.local.helix.azxlabs.io:8080",
    });
  });

  // The end-to-end version of the same property: `toApp` runs its output through
  // `AppSchema`, so a zero-group row must not throw *here* either — this is the
  // call `GET /api/v1/apps` makes for every row it returns, and one bad row used
  // to take the whole list down with a 500.
  it("maps a zero-group `group` row through toApp without throwing", () => {
    const row: AppRow = {
      id: APP_ID,
      slug: "orphan-group",
      displayName: "Orphan Group",
      visibilityMode: "group",
      visibilityGroupIds: [],
      currentVersionId: null,
      passwordHash: null,
      passwordSalt: null,
      passwordEnc: null,
      passwordSetAt: null,
      ownerId: null,
      ownerName: null,
      ownerEmail: null,
      capabilities: {},
      policyVersion: 0,
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(() => toApp(row)).not.toThrow();
    expect(toApp(row).visibility).toEqual({ mode: "group", groupIds: [] });
    expect(toApp({ ...row, visibilityGroupIds: ["eng", "product"] }).visibility).toEqual({
      mode: "group",
      groupIds: ["eng", "product"],
    });
  });

  it("maps an archived apps row with an ISO archivedAt", () => {
    const row: AppRow = {
      id: APP_ID,
      slug: "cost-explorer",
      displayName: "Cost Explorer",
      visibilityMode: "internal",
      visibilityGroupIds: [],
      currentVersionId: null,
      passwordHash: null,
      passwordSalt: null,
      passwordEnc: null,
      passwordSetAt: null,
      ownerId: null,
      ownerName: null,
      ownerEmail: null,
      capabilities: {},
      policyVersion: 0,
      archivedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(toApp(row).archivedAt).toBe(NOW.toISOString());
  });

  it("maps the capabilities column into a wire manifest, filling defaults", () => {
    const row: AppRow = {
      id: APP_ID,
      slug: "cost-explorer",
      displayName: "Cost Explorer",
      visibilityMode: "group",
      visibilityGroupIds: ["eng-team"],
      currentVersionId: null,
      passwordHash: null,
      passwordSalt: null,
      passwordEnc: null,
      passwordSetAt: null,
      ownerId: null,
      ownerName: null,
      ownerEmail: null,
      capabilities: { llm: { models: ["claude-opus-4-8"], dollarsPerDay: 10 } },
      policyVersion: 0,
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const manifest = toManifest(row);
    expect(manifest).toEqual({
      app: "cost-explorer",
      visibility: { mode: "group", groupIds: ["eng-team"] },
      capabilities: {
        llm: { models: ["claude-opus-4-8"], dollarsPerDay: 10 },
        mcp: [],
        externalOrigins: [],
      },
    });
  });

  it("treats an empty capabilities column as the baseline grant set", () => {
    const row: AppRow = {
      id: APP_ID,
      slug: "x",
      displayName: "X",
      visibilityMode: "internal",
      visibilityGroupIds: [],
      currentVersionId: null,
      passwordHash: null,
      passwordSalt: null,
      passwordEnc: null,
      passwordSetAt: null,
      ownerId: null,
      ownerName: null,
      ownerEmail: null,
      capabilities: {},
      policyVersion: 0,
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(capabilitiesFromRow(row)).toEqual({ mcp: [], externalOrigins: [] });
  });

  // Read-side gateway_calls mappers (M4 metering). Aggregates arrive off raw
  // SQL as number | bigint | string; assert they normalize and validate.
  // Dollars now come from the frozen costMicroUsd column, not re-priced tokens.
  // 1000 in + 2000 out @ opus-4-8 froze as 55_000 micro-USD = $0.055.
  const COST_MICRO = 55_000;
  const EXPECTED_COST = COST_MICRO / 1_000_000;

  it("assembles a per-app UsageSummary, summing outcomes, cost, and the error rate", () => {
    const summary = toUsageSummary({
      appId: APP_ID,
      range: "24h",
      outcomes: [
        {
          outcome: "ok",
          requests: 8,
          inputTokens: 1000n,
          outputTokens: "2000",
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        {
          outcome: "error",
          requests: 1,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        {
          outcome: "quota_blocked",
          requests: 1,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      ],
      models: [
        {
          model: "claude-opus-4-8",
          requests: 9,
          tokens: 3000n,
          costMicroUsd: COST_MICRO,
        },
      ],
      series: [
        {
          bucket: NOW,
          model: "claude-opus-4-8",
          inputTokens: 1000n,
          outputTokens: 2000n,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costMicroUsd: COST_MICRO,
          requests: 10,
        },
      ],
      today: [
        {
          model: "claude-opus-4-8",
          inputTokens: 1000n,
          outputTokens: 2000n,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costMicroUsd: COST_MICRO,
        },
      ],
      latencyP95: 1500,
    });
    expect(summary).toMatchObject({
      appId: APP_ID,
      range: "24h",
      requests: 10,
      inputTokens: 1000,
      outputTokens: 2000,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      latencyP95Ms: 1500,
      errorRate: 0.2,
      byOutcome: { ok: 8, error: 1, quota_blocked: 1 },
      series: [{ bucket: NOW.toISOString(), tokens: 3000, requests: 10 }],
      today: { tokens: 3000 },
    });
    expect(summary.costUsd).toBeCloseTo(EXPECTED_COST, 9);
    expect(summary.byModel[0]?.costUsd).toBeCloseTo(EXPECTED_COST, 9);
    expect(summary.series[0]?.costUsd).toBeCloseTo(EXPECTED_COST, 9);
    expect(summary.today.costUsd).toBeCloseTo(EXPECTED_COST, 9);
  });

  it("reports a zero error rate and null p95 for an empty window", () => {
    const summary = toUsageSummary({
      appId: APP_ID,
      range: "7d",
      outcomes: [],
      models: [],
      series: [],
      today: [],
      latencyP95: null,
    });
    expect(summary.requests).toBe(0);
    expect(summary.errorRate).toBe(0);
    expect(summary.costUsd).toBe(0);
    expect(summary.latencyP95Ms).toBeNull();
    expect(summary.today).toEqual({ tokens: 0, costUsd: 0 });
  });

  it("maps a joined gateway_calls row to a wire GatewayCall with cost + telemetry", () => {
    const call = toGatewayCall({
      id: "33333333-3333-4333-8333-333333333333",
      appId: APP_ID,
      slug: "cost-explorer",
      userOid: "user-oid-1",
      capability: "llm",
      model: "claude-opus-4-8",
      inputTokens: "1200",
      outputTokens: 800n,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costMicroUsd: 26_000n,
      outcome: "ok",
      durationMs: 1500,
      statusCode: null,
      stopReason: "end_turn",
      errorDetail: null,
      createdAt: NOW,
    });
    expect(call).toMatchObject({
      id: "33333333-3333-4333-8333-333333333333",
      appId: APP_ID,
      slug: "cost-explorer",
      model: "claude-opus-4-8",
      inputTokens: 1200,
      outputTokens: 800,
      durationMs: 1500,
      statusCode: null,
      stopReason: "end_turn",
      errorDetail: null,
      outcome: "ok",
      createdAt: NOW.toISOString(),
    });
    // Frozen at write time: 1200 in + 800 out @ opus-4-8 = 26_000 micro-USD = $0.026.
    expect(call.costUsd).toBeCloseTo(0.026, 9);
  });

  it("tolerates a null slug (the ledger outlives deleted apps)", () => {
    const call = toGatewayCall({
      id: "33333333-3333-4333-8333-333333333333",
      appId: APP_ID,
      slug: null,
      userOid: "u",
      capability: "llm",
      model: "claude-opus-4-8",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costMicroUsd: 0,
      outcome: "refusal",
      durationMs: 0,
      statusCode: null,
      stopReason: "refusal",
      errorDetail: null,
      createdAt: NOW,
    });
    expect(call.slug).toBeNull();
  });

  it("assembles the platform-wide PlatformUsage rollup, collapsing model rows", () => {
    const DAY2 = new Date(NOW.getTime() - 86_400_000);
    const platform = toPlatformUsage({
      range: "30d",
      series: [
        {
          bucket: DAY2,
          model: "claude-opus-4-8",
          inputTokens: 1000n,
          outputTokens: 2000n,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costMicroUsd: COST_MICRO,
          requests: 2,
        },
        {
          bucket: NOW,
          model: null,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costMicroUsd: 0,
          requests: 0,
        },
      ],
      byApp: [
        {
          appId: APP_ID,
          slug: "cost-explorer",
          model: "claude-opus-4-8",
          inputTokens: 1000n,
          outputTokens: 2000n,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costMicroUsd: COST_MICRO,
          requests: 2,
        },
      ],
      totals: { tokens: 3000n, requests: 2, activeUsers: 1 },
      totalsByModel: [
        {
          model: "claude-opus-4-8",
          inputTokens: 1000n,
          outputTokens: 2000n,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costMicroUsd: COST_MICRO,
        },
      ],
      capabilityMix: [
        {
          capability: "llm",
          model: "claude-opus-4-8",
          inputTokens: 1000n,
          outputTokens: 2000n,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costMicroUsd: COST_MICRO,
        },
      ],
    });
    expect(platform.range).toBe("30d");
    expect(platform.series.map((s) => s.tokens)).toEqual([3000, 0]);
    expect(platform.series.map((s) => s.requests)).toEqual([2, 0]);
    expect(platform.series[0]?.costUsd).toBeCloseTo(EXPECTED_COST, 9);
    expect(platform.series[1]?.costUsd).toBe(0);
    expect(platform.byApp).toMatchObject([{ slug: "cost-explorer", tokens: 3000, requests: 2 }]);
    expect(platform.byApp[0]?.costUsd).toBeCloseTo(EXPECTED_COST, 9);
    expect(platform.totals).toMatchObject({ tokensMTD: 3000, requestsMTD: 2, activeUsers: 1 });
    expect(platform.totals.costMTD).toBeCloseTo(EXPECTED_COST, 9);
    expect(platform.capabilityMix).toMatchObject([{ capability: "llm", tokens: 3000 }]);
    expect(platform.capabilityMix[0]?.costUsd).toBeCloseTo(EXPECTED_COST, 9);
  });

  it("maps a versions row to a wire Version", () => {
    const row: VersionRow = {
      id: VERSION_ID,
      appId: APP_ID,
      number: 1,
      blobPrefix: blobPrefixFor(APP_ID, 1),
      status: "preview",
      createdAt: NOW,
      deployReport: null,
    };
    expect(toVersion(row)).toEqual({
      id: VERSION_ID,
      appId: APP_ID,
      number: 1,
      blobPrefix: `apps/${APP_ID}/1/`,
      status: "preview",
      createdAt: NOW.toISOString(),
    });
  });

  it("carries a valid stored deploy report through, and drops a malformed one", () => {
    const base: VersionRow = {
      id: VERSION_ID,
      appId: APP_ID,
      number: 1,
      blobPrefix: blobPrefixFor(APP_ID, 1),
      status: "preview",
      createdAt: NOW,
      deployReport: null,
    };
    const report = {
      plannerVersion: 1,
      outcome: "rerooted",
      root: "dist/",
      fileCount: 3,
      drops: { junk: 2 },
      problems: [],
      candidates: ["dist/", "src/"],
    };
    expect(toVersion({ ...base, deployReport: report }).deployReport).toEqual(report);
    // Client-asserted and unverifiable: a malformed blob is dropped, not thrown.
    expect(toVersion({ ...base, deployReport: { outcome: "bogus" } }).deployReport).toBeUndefined();
  });
});
