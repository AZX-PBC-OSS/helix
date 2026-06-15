import {
  AppManifestSchema,
  AppSchema,
  CapabilitiesSchema,
  GatewayCallSchema,
  PlatformUsageSchema,
  UsageSummarySchema,
  VersionSchema,
  type AppManifest,
  type App,
  type Capabilities,
  type GatewayCall,
  type PlatformUsage,
  type UsageSummary,
  type Version,
  type Visibility,
  type VisibilityMode,
} from "@helix/shared";
import type { App as AppRow, Version as VersionRow } from "./client.js";

/** Flattened visibility columns as stored on the `apps` row. */
export interface VisibilityColumns {
  visibilityMode: VisibilityMode;
  visibilityGroupId: string | null;
}

/** Reassemble the discriminated-union Visibility from its flattened columns. */
export function visibilityFromColumns(mode: VisibilityMode, groupId: string | null): Visibility {
  if (mode === "group") {
    // groupId is non-null whenever mode is `group` (enforced on write below).
    return { mode, groupId: groupId ?? "" };
  }
  return { mode };
}

/** Flatten a Visibility union into columns for an `apps` insert/update. */
export function visibilityToColumns(visibility: Visibility): VisibilityColumns {
  return visibility.mode === "group"
    ? { visibilityMode: "group", visibilityGroupId: visibility.groupId }
    : { visibilityMode: visibility.mode, visibilityGroupId: null };
}

/**
 * Map an `apps` row to the wire `App`, validating through the shared schema so
 * any drift between the DB shape and the contract fails loudly at the boundary.
 */
export function toApp(row: AppRow): App {
  return AppSchema.parse({
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    visibility: visibilityFromColumns(row.visibilityMode, row.visibilityGroupId),
    currentVersionId: row.currentVersionId,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/**
 * Parse the `capabilities` JSON column into the shared `Capabilities` shape,
 * filling baseline defaults. Validated so DB/contract drift fails at the
 * boundary; the gateway depends on this shape (architecture §6.3).
 */
export function capabilitiesFromRow(row: AppRow): Capabilities {
  return CapabilitiesSchema.parse(row.capabilities ?? {});
}

/** Map an `apps` row to the wire `AppManifest` (§6.3) — slug, visibility, grants. */
export function toManifest(row: AppRow): AppManifest {
  return AppManifestSchema.parse({
    app: row.slug,
    visibility: visibilityFromColumns(row.visibilityMode, row.visibilityGroupId),
    capabilities: capabilitiesFromRow(row),
  });
}

/** Map a `versions` row to the wire `Version`, validated through the schema. */
export function toVersion(row: VersionRow): Version {
  return VersionSchema.parse({
    id: row.id,
    appId: row.appId,
    number: row.number,
    blobPrefix: row.blobPrefix,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  });
}

/** Blob key prefix for a version's assets: `apps/<appId>/<number>/`. */
export function blobPrefixFor(appId: string, number: number): string {
  return `apps/${appId}/${number}/`;
}

/* ------------------------------------------------------------------------- *
 * Read-side `gateway_calls` mappers (M4 metering).
 *
 * The edge writes the ledger; the portal only reads it for display. Aggregates
 * come off raw SQL (`$queryRaw`), where SUM/COUNT land as number | bigint |
 * string depending on the cast and driver — `num()` normalizes them, and every
 * mapper validates through the shared schema so DB/contract drift fails loudly.
 * ------------------------------------------------------------------------- */

/** Coerce a SQL numeric (number | bigint | string) to a JS number. */
function num(v: number | bigint | string | null | undefined): number {
  return v == null ? 0 : Number(v);
}

/** Coerce a SQL timestamp (Date | string) to an ISO-8601 string. */
function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

type SqlNum = number | bigint | string | null;

export interface UsageOutcomeRow {
  outcome: string;
  requests: SqlNum;
  inputTokens: SqlNum;
  outputTokens: SqlNum;
}
export interface UsageModelRow {
  model: string;
  requests: SqlNum;
  tokens: SqlNum;
}
export interface UsageSeriesRow {
  bucket: Date | string;
  tokens: SqlNum;
  requests: SqlNum;
}

/** Assemble a per-app {@link UsageSummary} from the three aggregate queries. */
export function toUsageSummary(input: {
  appId: string;
  windowDays: number;
  outcomes: UsageOutcomeRow[];
  models: UsageModelRow[];
  series: UsageSeriesRow[];
}): UsageSummary {
  let requests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let okRequests = 0;
  const byOutcome: Record<string, number> = {};
  for (const row of input.outcomes) {
    const n = num(row.requests);
    requests += n;
    inputTokens += num(row.inputTokens);
    outputTokens += num(row.outputTokens);
    byOutcome[row.outcome] = (byOutcome[row.outcome] ?? 0) + n;
    if (row.outcome === "ok") okRequests += n;
  }
  return UsageSummarySchema.parse({
    appId: input.appId,
    windowDays: input.windowDays,
    requests,
    inputTokens,
    outputTokens,
    errorRate: requests === 0 ? 0 : (requests - okRequests) / requests,
    byOutcome,
    byModel: input.models.map((m) => ({
      model: m.model,
      tokens: num(m.tokens),
      requests: num(m.requests),
    })),
    series: input.series.map((s) => ({
      bucket: iso(s.bucket),
      tokens: num(s.tokens),
      requests: num(s.requests),
    })),
  });
}

export interface GatewayCallRow {
  id: string;
  appId: string;
  slug: string | null;
  userOid: string;
  capability: string;
  model: string;
  inputTokens: SqlNum;
  outputTokens: SqlNum;
  outcome: string;
  createdAt: Date | string;
}

/** Map a joined `gateway_calls` row to the wire {@link GatewayCall}. */
export function toGatewayCall(row: GatewayCallRow): GatewayCall {
  return GatewayCallSchema.parse({
    id: row.id,
    appId: row.appId,
    slug: row.slug,
    userOid: row.userOid,
    capability: row.capability,
    model: row.model,
    inputTokens: num(row.inputTokens),
    outputTokens: num(row.outputTokens),
    outcome: row.outcome,
    createdAt: iso(row.createdAt),
  });
}

export interface PlatformSeriesRow {
  tokens: SqlNum;
  requests: SqlNum;
}
export interface PlatformAppRow {
  slug: string | null;
  tokens: SqlNum;
  requests: SqlNum;
}
export interface PlatformCapabilityRow {
  capability: string;
  tokens: SqlNum;
}

/** Assemble the platform-wide {@link PlatformUsage} rollup. */
export function toPlatformUsage(input: {
  daily: PlatformSeriesRow[];
  byApp: PlatformAppRow[];
  totals: { tokens: SqlNum; requests: SqlNum; activeUsers: SqlNum };
  capabilityMix: PlatformCapabilityRow[];
}): PlatformUsage {
  return PlatformUsageSchema.parse({
    tokens14d: input.daily.map((d) => num(d.tokens)),
    requests14d: input.daily.map((d) => num(d.requests)),
    byApp: input.byApp.map((a) => ({
      slug: a.slug,
      tokens: num(a.tokens),
      requests: num(a.requests),
    })),
    totals: {
      tokensMTD: num(input.totals.tokens),
      requestsMTD: num(input.totals.requests),
      activeUsers: num(input.totals.activeUsers),
    },
    capabilityMix: input.capabilityMix.map((c) => ({
      capability: c.capability,
      tokens: num(c.tokens),
    })),
  });
}
