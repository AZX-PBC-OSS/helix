import { describe, expect, it } from "vitest";
import { VERSION_STATUSES, VISIBILITY_MODES } from "@helix/shared";
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
// schema.prisma and @helix/shared disagree, this fails before any route does.
describe("enum drift guards", () => {
  it("VersionStatus matches VERSION_STATUSES", () => {
    expect(Object.values(VersionStatus).sort()).toEqual([...VERSION_STATUSES].sort());
  });

  it("VisibilityMode matches VISIBILITY_MODES", () => {
    expect(Object.values(VisibilityMode).sort()).toEqual([...VISIBILITY_MODES].sort());
  });
});

describe("visibility column mapping", () => {
  it("round-trips a group visibility through columns", () => {
    const columns = visibilityToColumns({ mode: "group", groupId: "abc" });
    expect(columns).toEqual({ visibilityMode: "group", visibilityGroupId: "abc" });
    expect(visibilityFromColumns(columns.visibilityMode, columns.visibilityGroupId)).toEqual({
      mode: "group",
      groupId: "abc",
    });
  });

  it("nulls the group id for payload-less modes", () => {
    expect(visibilityToColumns({ mode: "private" })).toEqual({
      visibilityMode: "private",
      visibilityGroupId: null,
    });
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
      visibilityMode: "private",
      visibilityGroupId: null,
      currentVersionId: null,
      passwordHash: null,
      passwordSalt: null,
      passwordEnc: null,
      passwordSetAt: null,
      capabilities: {},
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(toApp(row)).toEqual({
      id: APP_ID,
      slug: "cost-explorer",
      displayName: "Cost Explorer",
      visibility: { mode: "private" },
      currentVersionId: null,
      archivedAt: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
  });

  it("maps an archived apps row with an ISO archivedAt", () => {
    const row: AppRow = {
      id: APP_ID,
      slug: "cost-explorer",
      displayName: "Cost Explorer",
      visibilityMode: "private",
      visibilityGroupId: null,
      currentVersionId: null,
      passwordHash: null,
      passwordSalt: null,
      passwordEnc: null,
      passwordSetAt: null,
      capabilities: {},
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
      visibilityGroupId: "eng-team",
      currentVersionId: null,
      passwordHash: null,
      passwordSalt: null,
      passwordEnc: null,
      passwordSetAt: null,
      capabilities: { llm: { models: ["claude-opus-4-8"], tokensPerDay: 1000 } },
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const manifest = toManifest(row);
    expect(manifest).toEqual({
      app: "cost-explorer",
      visibility: { mode: "group", groupId: "eng-team" },
      capabilities: {
        llm: { models: ["claude-opus-4-8"], tokensPerDay: 1000 },
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
      visibilityMode: "private",
      visibilityGroupId: null,
      currentVersionId: null,
      passwordHash: null,
      passwordSalt: null,
      passwordEnc: null,
      passwordSetAt: null,
      capabilities: {},
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(capabilitiesFromRow(row)).toEqual({ mcp: [], externalOrigins: [] });
  });

  // Read-side gateway_calls mappers (M4 metering). Aggregates arrive off raw
  // SQL as number | bigint | string; assert they normalize and validate.
  it("assembles a per-app UsageSummary, summing outcomes and computing the error rate", () => {
    const summary = toUsageSummary({
      appId: APP_ID,
      windowDays: 1,
      outcomes: [
        { outcome: "ok", requests: 8, inputTokens: 1000n, outputTokens: "2000" },
        { outcome: "error", requests: 1, inputTokens: 0, outputTokens: 0 },
        { outcome: "quota_blocked", requests: 1, inputTokens: 0, outputTokens: 0 },
      ],
      models: [{ model: "claude-opus-4-8", requests: 9, tokens: 3000n }],
      series: [{ bucket: NOW, tokens: 3000, requests: 10 }],
    });
    expect(summary).toEqual({
      appId: APP_ID,
      windowDays: 1,
      requests: 10,
      inputTokens: 1000,
      outputTokens: 2000,
      errorRate: 0.2,
      byOutcome: { ok: 8, error: 1, quota_blocked: 1 },
      byModel: [{ model: "claude-opus-4-8", tokens: 3000, requests: 9 }],
      series: [{ bucket: NOW.toISOString(), tokens: 3000, requests: 10 }],
    });
  });

  it("reports a zero error rate for an empty window", () => {
    const summary = toUsageSummary({
      appId: APP_ID,
      windowDays: 7,
      outcomes: [],
      models: [],
      series: [],
    });
    expect(summary.requests).toBe(0);
    expect(summary.errorRate).toBe(0);
  });

  it("maps a joined gateway_calls row to a wire GatewayCall", () => {
    const call = toGatewayCall({
      id: "33333333-3333-4333-8333-333333333333",
      appId: APP_ID,
      slug: "cost-explorer",
      userOid: "user-oid-1",
      capability: "llm",
      model: "claude-opus-4-8",
      inputTokens: "1200",
      outputTokens: 800n,
      outcome: "ok",
      createdAt: NOW,
    });
    expect(call).toEqual({
      id: "33333333-3333-4333-8333-333333333333",
      appId: APP_ID,
      slug: "cost-explorer",
      userOid: "user-oid-1",
      capability: "llm",
      model: "claude-opus-4-8",
      inputTokens: 1200,
      outputTokens: 800,
      outcome: "ok",
      createdAt: NOW.toISOString(),
    });
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
      outcome: "refusal",
      createdAt: NOW,
    });
    expect(call.slug).toBeNull();
  });

  it("assembles the platform-wide PlatformUsage rollup", () => {
    const platform = toPlatformUsage({
      daily: [
        { tokens: 100n, requests: 2 },
        { tokens: 0, requests: 0 },
      ],
      byApp: [{ slug: "cost-explorer", tokens: "100", requests: 2 }],
      totals: { tokens: 100n, requests: 2, activeUsers: 1 },
      capabilityMix: [{ capability: "llm", tokens: 100n }],
    });
    expect(platform).toEqual({
      tokens14d: [100, 0],
      requests14d: [2, 0],
      byApp: [{ slug: "cost-explorer", tokens: 100, requests: 2 }],
      totals: { tokensMTD: 100, requestsMTD: 2, activeUsers: 1 },
      capabilityMix: [{ capability: "llm", tokens: 100 }],
    });
  });

  it("maps a versions row to a wire Version", () => {
    const row: VersionRow = {
      id: VERSION_ID,
      appId: APP_ID,
      number: 1,
      blobPrefix: blobPrefixFor(APP_ID, 1),
      status: "preview",
      createdAt: NOW,
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
});
