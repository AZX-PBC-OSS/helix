import {
  AppManifestSchema,
  AppSchema,
  ApprovalRequestSchema,
  CapabilitiesSchema,
  CspViolationSchema,
  GatewayCallSchema,
  PlatformUsageSchema,
  UsageSummarySchema,
  VersionSchema,
  costUsd,
  type AppManifest,
  type App,
  type ApprovalRequest,
  type Capabilities,
  type CspViolation,
  type GatewayCall,
  type PlatformUsage,
  type UsageSummary,
  type Version,
  type Visibility,
  type VisibilityMode,
} from "@helix/shared";
import type {
  App as AppRow,
  ApprovalRequest as ApprovalRequestRow,
  Version as VersionRow,
} from "./client.js";

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

/**
 * Map an `approval_requests` row to the wire {@link ApprovalRequest}, validated
 * through the shared schema (deltas/status/risk shape fails loudly on drift).
 * `app` is the joined registry row for the queue's slug/owner columns.
 */
export function toApprovalRequest(
  row: ApprovalRequestRow,
  app?: { slug: string; displayName: string },
): ApprovalRequest {
  return ApprovalRequestSchema.parse({
    id: row.id,
    appId: row.appId,
    ...(app ? { appSlug: app.slug, appDisplayName: app.displayName } : {}),
    status: row.status,
    risk: row.risk,
    deltas: row.deltas,
    baseSnapshot: row.baseSnapshot,
    requestedBy: row.requestedBy,
    reason: row.reason,
    decidedBy: row.decidedBy,
    decisionNote: row.decisionNote,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  });
}

export interface CspViolationRow {
  appId: string;
  slug: string | null;
  directive: string;
  blockedUri: string;
  count: SqlNum;
  lastSeen: Date | string;
}

/** Map an aggregated `csp_reports` row to the wire {@link CspViolation}. */
export function toCspViolation(row: CspViolationRow): CspViolation {
  return CspViolationSchema.parse({
    appId: row.appId,
    appSlug: row.slug,
    directive: row.directive,
    blockedUri: row.blockedUri,
    count: num(row.count),
    lastSeen: iso(row.lastSeen),
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
  cacheReadInputTokens: SqlNum;
  cacheCreationInputTokens: SqlNum;
}
export interface UsageModelRow {
  model: string;
  requests: SqlNum;
  tokens: SqlNum;
  inputTokens: SqlNum;
  outputTokens: SqlNum;
  cacheReadInputTokens: SqlNum;
  cacheCreationInputTokens: SqlNum;
}
export interface UsageSeriesRow {
  bucket: Date | string;
  tokens: SqlNum;
  requests: SqlNum;
}

/** Assemble a per-app {@link UsageSummary} from the aggregate queries. */
export function toUsageSummary(input: {
  appId: string;
  windowDays: number;
  outcomes: UsageOutcomeRow[];
  models: UsageModelRow[];
  series: UsageSeriesRow[];
  /** 95th-percentile durationMs over the window; null when no timed calls. */
  latencyP95: SqlNum;
}): UsageSummary {
  let requests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let okRequests = 0;
  const byOutcome: Record<string, number> = {};
  for (const row of input.outcomes) {
    const n = num(row.requests);
    requests += n;
    inputTokens += num(row.inputTokens);
    outputTokens += num(row.outputTokens);
    cacheReadInputTokens += num(row.cacheReadInputTokens);
    cacheCreationInputTokens += num(row.cacheCreationInputTokens);
    byOutcome[row.outcome] = (byOutcome[row.outcome] ?? 0) + n;
    if (row.outcome === "ok") okRequests += n;
  }
  const byModel = input.models.map((m) => ({
    model: m.model,
    tokens: num(m.tokens),
    requests: num(m.requests),
    costUsd: costUsd({
      model: m.model,
      inputTokens: num(m.inputTokens),
      outputTokens: num(m.outputTokens),
      cacheReadInputTokens: num(m.cacheReadInputTokens),
      cacheCreationInputTokens: num(m.cacheCreationInputTokens),
    }),
  }));
  return UsageSummarySchema.parse({
    appId: input.appId,
    windowDays: input.windowDays,
    requests,
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    costUsd: byModel.reduce((sum, m) => sum + m.costUsd, 0),
    latencyP95Ms: input.latencyP95 == null ? null : num(input.latencyP95),
    errorRate: requests === 0 ? 0 : (requests - okRequests) / requests,
    byOutcome,
    byModel,
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
  cacheReadInputTokens: SqlNum;
  cacheCreationInputTokens: SqlNum;
  outcome: string;
  durationMs: SqlNum;
  statusCode: number | null;
  stopReason: string | null;
  errorDetail: string | null;
  createdAt: Date | string;
}

/** Map a joined `gateway_calls` row to the wire {@link GatewayCall}. */
export function toGatewayCall(row: GatewayCallRow): GatewayCall {
  const inputTokens = num(row.inputTokens);
  const outputTokens = num(row.outputTokens);
  const cacheReadInputTokens = num(row.cacheReadInputTokens);
  const cacheCreationInputTokens = num(row.cacheCreationInputTokens);
  return GatewayCallSchema.parse({
    id: row.id,
    appId: row.appId,
    slug: row.slug,
    userOid: row.userOid,
    capability: row.capability,
    model: row.model,
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    costUsd: costUsd({
      model: row.model,
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
    }),
    durationMs: num(row.durationMs),
    statusCode: row.statusCode,
    stopReason: row.stopReason,
    errorDetail: row.errorDetail,
    outcome: row.outcome,
    createdAt: iso(row.createdAt),
  });
}

/**
 * Class-bearing aggregate row. Dollars vary by model, so the platform rollups
 * group by model and we sum {@link costUsd} per row in the reducers below.
 */
interface ModelTokenRow {
  model: string | null;
  inputTokens: SqlNum;
  outputTokens: SqlNum;
  cacheReadInputTokens: SqlNum;
  cacheCreationInputTokens: SqlNum;
}

function rowCost(r: ModelTokenRow): number {
  return costUsd({
    model: r.model ?? "",
    inputTokens: num(r.inputTokens),
    outputTokens: num(r.outputTokens),
    cacheReadInputTokens: num(r.cacheReadInputTokens),
    cacheCreationInputTokens: num(r.cacheCreationInputTokens),
  });
}

/** Display "tokens" stays input+output (cache classes are 0 today, priced separately). */
function rowTokens(r: ModelTokenRow): number {
  return num(r.inputTokens) + num(r.outputTokens);
}

export interface PlatformSeriesRow extends ModelTokenRow {
  bucket: Date | string;
  requests: SqlNum;
}
export interface PlatformAppRow extends ModelTokenRow {
  appId: string;
  slug: string | null;
  requests: SqlNum;
}
export interface PlatformCapabilityRow extends ModelTokenRow {
  capability: string;
}
export type PlatformTotalsModelRow = ModelTokenRow;

/** Assemble the platform-wide {@link PlatformUsage} rollup from model-grouped rows. */
export function toPlatformUsage(input: {
  daily: PlatformSeriesRow[];
  byApp: PlatformAppRow[];
  totals: { tokens: SqlNum; requests: SqlNum; activeUsers: SqlNum };
  totalsByModel: PlatformTotalsModelRow[];
  capabilityMix: PlatformCapabilityRow[];
}): PlatformUsage {
  // Daily series: collapse (day, model) rows back to one bucket per day,
  // preserving the oldest-first order the generate_series query emits.
  const dayOrder: string[] = [];
  const byDay = new Map<string, { tokens: number; requests: number; cost: number }>();
  for (const r of input.daily) {
    const key = iso(r.bucket);
    let acc = byDay.get(key);
    if (!acc) {
      acc = { tokens: 0, requests: 0, cost: 0 };
      byDay.set(key, acc);
      dayOrder.push(key);
    }
    acc.tokens += rowTokens(r);
    acc.requests += num(r.requests);
    acc.cost += rowCost(r);
  }

  // Per-app rollup: collapse (appId, model) rows by appId, then sort busiest-first.
  const byAppId = new Map<
    string,
    { slug: string | null; tokens: number; requests: number; cost: number }
  >();
  for (const r of input.byApp) {
    let acc = byAppId.get(r.appId);
    if (!acc) {
      acc = { slug: r.slug, tokens: 0, requests: 0, cost: 0 };
      byAppId.set(r.appId, acc);
    }
    acc.tokens += rowTokens(r);
    acc.requests += num(r.requests);
    acc.cost += rowCost(r);
  }
  const byApp = [...byAppId.values()]
    .map((a) => ({ slug: a.slug, tokens: a.tokens, requests: a.requests, costUsd: a.cost }))
    .sort((a, b) => b.tokens - a.tokens);

  // Capability mix: collapse (capability, model) rows by capability.
  const byCapability = new Map<string, { tokens: number; cost: number }>();
  for (const r of input.capabilityMix) {
    let acc = byCapability.get(r.capability);
    if (!acc) {
      acc = { tokens: 0, cost: 0 };
      byCapability.set(r.capability, acc);
    }
    acc.tokens += rowTokens(r);
    acc.cost += rowCost(r);
  }
  const capabilityMix = [...byCapability.entries()]
    .map(([capability, c]) => ({ capability, tokens: c.tokens, costUsd: c.cost }))
    .sort((a, b) => b.tokens - a.tokens);

  return PlatformUsageSchema.parse({
    tokens14d: dayOrder.map((k) => byDay.get(k)?.tokens ?? 0),
    requests14d: dayOrder.map((k) => byDay.get(k)?.requests ?? 0),
    cost14d: dayOrder.map((k) => byDay.get(k)?.cost ?? 0),
    byApp,
    totals: {
      tokensMTD: num(input.totals.tokens),
      requestsMTD: num(input.totals.requests),
      costMTD: input.totalsByModel.reduce((sum, r) => sum + rowCost(r), 0),
      activeUsers: num(input.totals.activeUsers),
    },
    capabilityMix,
  });
}
