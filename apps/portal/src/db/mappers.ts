import {
  AppManifestSchema,
  AppSchema,
  ApprovalRequestSchema,
  CapabilitiesSchema,
  CspViolationSchema,
  DeployReportSchema,
  GatewayCallSchema,
  PlatformUsageSchema,
  UsageSummarySchema,
  VersionSchema,
  type AppManifest,
  type App,
  type ApprovalRequest,
  type Capabilities,
  type CspViolation,
  type GatewayCall,
  type PlatformRange,
  type PlatformUsage,
  type UsageRange,
  type UsageSeriesPoint,
  type UsageSummary,
  type Version,
  type Visibility,
  type VisibilityMode,
} from "@azx-pbc/shared";
import { appPublicUrl } from "../deployment.js";
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
 *
 * `url` is computed here rather than templated client-side: this is the one
 * chokepoint every app-shaped response goes through, so every client gets the
 * deployment's real apps domain without knowing how the host is composed.
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
    url: appPublicUrl(row.slug),
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
  /** The joined app's `capabilities` JSON; null when the LEFT JOIN finds no app row. */
  capabilities: unknown;
  directive: string;
  blockedUri: string;
  count: SqlNum;
  lastSeen: Date | string;
}

/**
 * Is this historical violation already permitted by the app's *current* manifest?
 * An `externalOrigins` grant only widens `connect-src`/`img-src` (edge
 * `buildAppCsp`, apps/edge/src/serving/csp.ts) — a `script-src`/`style-src`
 * violation is never resolved by an origin grant, so the match is directive-aware.
 * Origins are reduced to scheme+host+port (the same `new URL().origin` reduction
 * the edge and the Violations UI use); a non-URL `blockedUri` (`inline`, `eval`,
 * …) is never resolved.
 */
function isResolved(capabilities: unknown, directive: string, blockedUri: string): boolean {
  if (directive !== "connect-src" && directive !== "img-src") return false;
  let blocked: string;
  try {
    blocked = new URL(blockedUri).origin;
  } catch {
    return false;
  }
  const { externalOrigins } = CapabilitiesSchema.parse(capabilities ?? {});
  return externalOrigins.some((o) => {
    try {
      return new URL(o).origin === blocked;
    } catch {
      return false;
    }
  });
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
    resolved: isResolved(row.capabilities, row.directive, row.blockedUri),
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
    // Client-asserted (ADR-0038) and unverifiable, so a malformed stored blob is
    // dropped rather than allowed to break the whole version response.
    deployReport: DeployReportSchema.safeParse(row.deployReport).data,
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
 *
 * Dollars come straight from the **frozen `costMicroUsd` ledger column** (priced
 * by the edge at write time), summed in SQL and divided here — so every figure
 * shown matches exactly what the edge's spend gate enforced. No read-time
 * re-pricing; a later rate change does not restate historical spend.
 * ------------------------------------------------------------------------- */

/** Coerce a SQL numeric (number | bigint | string) to a JS number. */
function num(v: number | bigint | string | null | undefined): number {
  return v == null ? 0 : Number(v);
}

/** Frozen micro-USD (1e-6 USD) → USD. */
function microToUsd(v: SqlNum): number {
  return num(v) / 1_000_000;
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
  costMicroUsd: SqlNum;
}
/** Assemble a per-app {@link UsageSummary} from the aggregate queries. */
export function toUsageSummary(input: {
  appId: string;
  range: UsageRange;
  outcomes: UsageOutcomeRow[];
  models: UsageModelRow[];
  /** (bucket, model) rows over the range — dense via generate_series. */
  series: SeriesModelRow[];
  /** Today-since-midnight (bucket, model) rows for the daily-cap gauge. */
  today: ModelTokenRow[];
  /** 95th-percentile durationMs over the range; null when no timed calls. */
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
    costUsd: microToUsd(m.costMicroUsd),
  }));
  return UsageSummarySchema.parse({
    appId: input.appId,
    range: input.range,
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
    series: collapseSeries(input.series),
    today: {
      tokens: input.today.reduce((s, r) => s + rowTokens(r), 0),
      costUsd: input.today.reduce((s, r) => s + rowCost(r), 0),
    },
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
  costMicroUsd: SqlNum;
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
    costUsd: microToUsd(row.costMicroUsd),
    durationMs: num(row.durationMs),
    statusCode: row.statusCode,
    stopReason: row.stopReason,
    errorDetail: row.errorDetail,
    outcome: row.outcome,
    createdAt: iso(row.createdAt),
  });
}

/**
 * Aggregate row carrying both token sums (for display) and the frozen
 * `costMicroUsd` sum (for dollars). Still grouped by model so token displays and
 * per-model breakdowns stay intact, but cost no longer depends on the model —
 * it's read straight from the column.
 */
export interface ModelTokenRow {
  model: string | null;
  inputTokens: SqlNum;
  outputTokens: SqlNum;
  cacheReadInputTokens: SqlNum;
  cacheCreationInputTokens: SqlNum;
  costMicroUsd: SqlNum;
}

function rowCost(r: ModelTokenRow): number {
  return microToUsd(r.costMicroUsd);
}

/** Display "tokens" stays input+output (cache classes are 0 today, priced separately). */
function rowTokens(r: ModelTokenRow): number {
  return num(r.inputTokens) + num(r.outputTokens);
}

/** A dense (bucket, model) aggregate row from a generate_series trend query. */
export interface SeriesModelRow extends ModelTokenRow {
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

/**
 * Collapse (bucket, model) rows back to one priced {@link UsageSeriesPoint} per
 * bucket, preserving the oldest-first order the generate_series query emits.
 * Shared by the per-app and platform trends.
 */
function collapseSeries(rows: SeriesModelRow[]): UsageSeriesPoint[] {
  const order: string[] = [];
  const byBucket = new Map<string, { tokens: number; requests: number; cost: number }>();
  for (const r of rows) {
    const key = iso(r.bucket);
    let acc = byBucket.get(key);
    if (!acc) {
      acc = { tokens: 0, requests: 0, cost: 0 };
      byBucket.set(key, acc);
      order.push(key);
    }
    acc.tokens += rowTokens(r);
    acc.requests += num(r.requests);
    acc.cost += rowCost(r);
  }
  return order.map((k) => {
    const a = byBucket.get(k)!;
    return { bucket: k, tokens: a.tokens, requests: a.requests, costUsd: a.cost };
  });
}

/** Assemble the platform-wide {@link PlatformUsage} rollup from model-grouped rows. */
export function toPlatformUsage(input: {
  range: PlatformRange;
  series: SeriesModelRow[];
  byApp: PlatformAppRow[];
  totals: { tokens: SqlNum; requests: SqlNum; activeUsers: SqlNum };
  totalsByModel: PlatformTotalsModelRow[];
  capabilityMix: PlatformCapabilityRow[];
}): PlatformUsage {
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
    range: input.range,
    series: collapseSeries(input.series),
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
