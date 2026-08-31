import type { FastifyInstance } from "fastify";
import {
  GATEWAY_OUTCOMES,
  GatewayAuditPageSchema,
  PLATFORM_RANGES,
  USAGE_RANGES,
  type PlatformRange,
  type UsageRange,
} from "@azx-pbc/shared";
import { authenticate } from "../plugins/auth.js";
import { AppError } from "../plugins/errors.js";
import { Prisma } from "../db/client.js";
import {
  toGatewayCall,
  toPlatformUsage,
  toUsageSummary,
  type GatewayCallRow,
  type PlatformAppRow,
  type PlatformCapabilityRow,
  type SeriesRow,
  type TokenCostRow,
  type UsageModelRow,
  type UsageOutcomeRow,
} from "../db/mappers.js";

/**
 * Read-side metering routes over the `gateway_calls` ledger (M4, architecture
 * §6.1/§8). The **edge writes** the ledger; these endpoints only **read** it for
 * display. Unlike the other portal reads they require a bearer token — usage and
 * audit data is "who called what, on whose behalf" (per-app RBAC is a v1
 * feature; for now any authenticated portal principal may read).
 *
 * Trends use a selectable rolling `range`: a `generate_series` grid (hourly for
 * `24h`, daily otherwise) left-joined to the ledger so buckets are dense and
 * zero-filled. They are **not** grouped by model: cost is summed from the frozen
 * `costMicroUsd` column the edge writes at call time, so there is nothing
 * per-model left to do at read time — only the per-app `byModel` breakdown still
 * needs the key. The per-app daily-cap gauge stays calendar-day scoped (`today`).
 */

/**
 * Cap on the per-app model breakdown. The group key is low-cardinality by
 * construction (curated LLM ids, app-data verbs, manifest-approved fetch
 * origins), so this should never bind — it is here so the response size is a
 * property of this route rather than of whatever manifest someone approves.
 * `ORDER BY tokens DESC` makes the truncation point meaningful.
 */
const MODEL_BREAKDOWN_LIMIT = 100;

/** Clamp a `?limit=` query value to a sane positive integer. */
function clampLimit(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.trunc(n), max);
}

interface RangePlan {
  grain: "hour" | "day";
  stepDays: number;
  stepHours: number;
  offsetDays: number;
  offsetHours: number;
}

/** Per-app ranges: 24 hourly buckets, or 7/30 daily. */
const PER_APP_PLANS: Record<UsageRange, RangePlan> = {
  "24h": { grain: "hour", stepDays: 0, stepHours: 1, offsetDays: 0, offsetHours: 23 },
  "7d": { grain: "day", stepDays: 1, stepHours: 0, offsetDays: 6, offsetHours: 0 },
  "30d": { grain: "day", stepDays: 1, stepHours: 0, offsetDays: 29, offsetHours: 0 },
};

/** Platform ranges: daily buckets over 7/30/90 days. */
const PLATFORM_PLANS: Record<PlatformRange, RangePlan> = {
  "7d": { grain: "day", stepDays: 1, stepHours: 0, offsetDays: 6, offsetHours: 0 },
  "30d": { grain: "day", stepDays: 1, stepHours: 0, offsetDays: 29, offsetHours: 0 },
  "90d": { grain: "day", stepDays: 1, stepHours: 0, offsetDays: 89, offsetHours: 0 },
};

/** Start of the oldest bucket — both the series floor and the totals window. */
function windowStart(p: RangePlan): Prisma.Sql {
  return Prisma.sql`date_trunc(${p.grain}::text, now()) - make_interval(days => ${p.offsetDays}, hours => ${p.offsetHours})`;
}

/** The dense bucket grid (oldest-first), all in the DB session timezone. */
function seriesGrid(p: RangePlan): Prisma.Sql {
  return Prisma.sql`generate_series(${windowStart(p)}, date_trunc(${p.grain}::text, now()), make_interval(days => ${p.stepDays}, hours => ${p.stepHours}))`;
}

function pickRange<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : fallback;
}

export async function usageRoutes(app: FastifyInstance): Promise<void> {
  // Per-app usage summary over a selectable rolling range. Bearer-gated read.
  app.get<{ Params: { slug: string }; Querystring: { range?: string } }>(
    "/api/v1/apps/:slug/usage",
    { preHandler: authenticate },
    async (req) => {
      const range = pickRange(req.query.range, USAGE_RANGES, "24h");
      const plan = PER_APP_PLANS[range];
      const row = await app.prisma.app.findUnique({ where: { slug: req.params.slug } });
      if (!row) {
        throw new AppError("not_found", `app "${req.params.slug}" not found`);
      }
      const id = row.id;
      const since = windowStart(plan);

      const outcomes = await app.prisma.$queryRaw<UsageOutcomeRow[]>(Prisma.sql`
        SELECT outcome,
               COUNT(*)::int                                       AS requests,
               COALESCE(SUM("inputTokens"), 0)::bigint             AS "inputTokens",
               COALESCE(SUM("outputTokens"), 0)::bigint            AS "outputTokens",
               COALESCE(SUM("cacheReadInputTokens"), 0)::bigint     AS "cacheReadInputTokens",
               COALESCE(SUM("cacheCreationInputTokens"), 0)::bigint AS "cacheCreationInputTokens"
        FROM gateway_calls
        WHERE "appId" = ${id}::uuid AND "createdAt" >= ${since}
        GROUP BY outcome`);

      // The one query that still groups by `model` — everything else that used to
      // was summing the frozen cost column and threw the key away.
      //
      // `outcome <> 'forbidden'` is what keeps this key low-cardinality, and the
      // rollup meaningful. Every other fetch outcome is recorded downstream of
      // the allowlist check, so its `model` is an origin that arrived through an
      // approved manifest revision; a `forbidden` row's origin is whatever the
      // app put in the URL and cleared no bar at all. It also has nothing to
      // report here — a denial spends no tokens, no dollars and never reaches
      // egress — so it would render as an `unpriced` 0% row. `byOutcome` still
      // counts it, in the header of this very card.
      //
      // Keep this predicate OUTCOME-based. The top-level `costUsd` is a reduce
      // over these rows (`toUsageSummary`), so a predicate that could drop a
      // charged row would silently understate spend.
      const models = await app.prisma.$queryRaw<UsageModelRow[]>(Prisma.sql`
        SELECT model,
               COUNT(*)::int                                       AS requests,
               COALESCE(SUM("inputTokens" + "outputTokens"), 0)::bigint AS tokens,
               COALESCE(SUM("costMicroUsd"), 0)::bigint            AS "costMicroUsd"
        FROM gateway_calls
        WHERE "appId" = ${id}::uuid AND "createdAt" >= ${since}
          AND outcome <> 'forbidden'
        GROUP BY model
        ORDER BY tokens DESC
        LIMIT ${MODEL_BREAKDOWN_LIMIT}`);

      // p95 upstream latency over the range (only timed calls — durationMs > 0).
      const latency = await app.prisma.$queryRaw<Array<{ p95: number | null }>>(Prisma.sql`
        SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY "durationMs")::float AS p95
        FROM gateway_calls
        WHERE "appId" = ${id}::uuid AND "durationMs" > 0 AND "createdAt" >= ${since}`);

      // `COUNT(gc.id)`, not `COUNT(*)`: that is what makes an empty bucket read 0
      // rather than 1 on the LEFT JOIN, i.e. what makes the grid dense.
      const series = await app.prisma.$queryRaw<SeriesRow[]>(Prisma.sql`
        SELECT d                                                            AS bucket,
               COALESCE(SUM(gc."inputTokens"), 0)::bigint                   AS "inputTokens",
               COALESCE(SUM(gc."outputTokens"), 0)::bigint                  AS "outputTokens",
               COALESCE(SUM(gc."costMicroUsd"), 0)::bigint                  AS "costMicroUsd",
               COUNT(gc.id)::int                                            AS requests
        FROM ${seriesGrid(plan)} AS d
        LEFT JOIN gateway_calls gc
          ON date_trunc(${plan.grain}::text, gc."createdAt") = d
         AND gc."appId" = ${id}::uuid
        GROUP BY d
        ORDER BY d ASC`);

      // Today-since-midnight — backs the daily-cap gauge (calendar-day). No
      // GROUP BY, so this always returns exactly one (COALESCE'd) row.
      const today = await app.prisma.$queryRaw<TokenCostRow[]>(Prisma.sql`
        SELECT COALESCE(SUM("inputTokens"), 0)::bigint             AS "inputTokens",
               COALESCE(SUM("outputTokens"), 0)::bigint            AS "outputTokens",
               COALESCE(SUM("costMicroUsd"), 0)::bigint            AS "costMicroUsd"
        FROM gateway_calls
        WHERE "appId" = ${id}::uuid AND "createdAt" >= date_trunc('day', now())`);

      return toUsageSummary({
        appId: id,
        range,
        outcomes,
        models,
        series,
        today,
        latencyP95: latency[0]?.p95 ?? null,
      });
    },
  );

  // Gateway audit log: recent calls newest-first, cursor-paginated on createdAt.
  // Cross-app (admin); optional ?app= (slug) and ?outcome= filters. Bearer-gated.
  app.get<{
    Querystring: { app?: string; outcome?: string; limit?: string; before?: string };
  }>("/api/v1/gateway/audit", { preHandler: authenticate }, async (req) => {
    const limit = clampLimit(req.query.limit, 50, 200);

    // Resolve an optional slug filter to its appId (the ledger keys on appId).
    let appId: string | undefined;
    if (req.query.app) {
      const appRow = await app.prisma.app.findUnique({ where: { slug: req.query.app } });
      if (!appRow) {
        throw new AppError("not_found", `app "${req.query.app}" not found`);
      }
      appId = appRow.id;
    }

    const before = req.query.before ? new Date(req.query.before) : undefined;
    if (before && Number.isNaN(before.getTime())) {
      throw new AppError("validation_failed", "`before` must be an ISO-8601 timestamp");
    }

    // Reject an unknown outcome rather than passing it to Prisma, where it
    // matches nothing and renders as an empty audit log — indistinguishable
    // from "no such calls" for anyone who mistypes a filter.
    // `|| undefined`, not `!== undefined`: Fastify parses both `?outcome=` and a
    // bare `?outcome` to the empty string, which used to mean "no filter" under
    // the previous truthiness check. Rejecting that would break a scripted client
    // that always appends the param.
    const outcome = req.query.outcome || undefined;
    if (outcome !== undefined && !(GATEWAY_OUTCOMES as readonly string[]).includes(outcome)) {
      throw new AppError(
        "validation_failed",
        `\`outcome\` must be one of: ${GATEWAY_OUTCOMES.join(", ")}`,
      );
    }

    // Fetch one extra row to compute the next cursor without a count query.
    const rows = await app.prisma.gatewayCall.findMany({
      where: {
        ...(appId ? { appId } : {}),
        ...(outcome ? { outcome } : {}),
        ...(before ? { createdAt: { lt: before } } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    // Left-join slugs in one batched lookup (no FK — the ledger outlives apps).
    const ids = [...new Set(page.map((r) => r.appId))];
    const apps = await app.prisma.app.findMany({
      where: { id: { in: ids } },
      select: { id: true, slug: true },
    });
    const slugById = new Map(apps.map((a) => [a.id, a.slug]));

    const mapped = page.map(
      (r): GatewayCallRow => ({
        id: r.id,
        appId: r.appId,
        slug: slugById.get(r.appId) ?? null,
        userOid: r.userOid,
        userName: r.userName,
        userEmail: r.userEmail,
        capability: r.capability,
        model: r.model,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadInputTokens: r.cacheReadInputTokens,
        cacheCreationInputTokens: r.cacheCreationInputTokens,
        costMicroUsd: r.costMicroUsd,
        outcome: r.outcome,
        durationMs: r.durationMs,
        statusCode: r.statusCode,
        stopReason: r.stopReason,
        errorDetail: r.errorDetail,
        path: r.path,
        method: r.method,
        createdAt: r.createdAt,
      }),
    );

    const last = page.at(-1);
    return GatewayAuditPageSchema.parse({
      rows: mapped.map(toGatewayCall),
      ...(hasMore && last ? { nextBefore: last.createdAt.toISOString() } : {}),
    });
  });

  // Platform-wide rollup: a range-controlled trend + breakdowns, plus MTD KPIs.
  // Bearer-gated. Backs the admin Platform page and the workspace /usage page.
  app.get<{ Querystring: { range?: string } }>(
    "/api/v1/gateway/usage",
    { preHandler: authenticate },
    async (req) => {
      const range = pickRange(req.query.range, PLATFORM_RANGES, "30d");
      const plan = PLATFORM_PLANS[range];
      const since = windowStart(plan);

      const series = await app.prisma.$queryRaw<SeriesRow[]>(Prisma.sql`
        SELECT d                                                            AS bucket,
               COALESCE(SUM(gc."inputTokens"), 0)::bigint                   AS "inputTokens",
               COALESCE(SUM(gc."outputTokens"), 0)::bigint                  AS "outputTokens",
               COALESCE(SUM(gc."costMicroUsd"), 0)::bigint                  AS "costMicroUsd",
               COUNT(gc.id)::int                                            AS requests
        FROM ${seriesGrid(plan)} AS d
        LEFT JOIN gateway_calls gc ON date_trunc(${plan.grain}::text, gc."createdAt") = d
        GROUP BY d
        ORDER BY d ASC`);

      const byApp = await app.prisma.$queryRaw<PlatformAppRow[]>(Prisma.sql`
        SELECT gc."appId"                                                   AS "appId",
               a.slug                                                       AS slug,
               COALESCE(SUM(gc."inputTokens"), 0)::bigint                   AS "inputTokens",
               COALESCE(SUM(gc."outputTokens"), 0)::bigint                  AS "outputTokens",
               COALESCE(SUM(gc."costMicroUsd"), 0)::bigint                  AS "costMicroUsd",
               COUNT(*)::int                                                AS requests
        FROM gateway_calls gc
        LEFT JOIN apps a ON a.id = gc."appId"
        WHERE gc."createdAt" >= ${since}
        GROUP BY gc."appId", a.slug`);

      // MTD headline KPIs — independent of the selected range. Cost folds in here
      // rather than into a second model-grouped query: it is summed straight from
      // the frozen `costMicroUsd` column, so there was never anything per-model
      // to do with it.
      const totalsRows = await app.prisma.$queryRaw<
        Array<{
          tokens: bigint | number;
          requests: number;
          activeUsers: number;
          costMicroUsd: bigint | number;
        }>
      >`
        SELECT COALESCE(SUM("inputTokens" + "outputTokens"), 0)::bigint AS tokens,
               COUNT(*)::int                                            AS requests,
               COUNT(DISTINCT "userOid")::int                           AS "activeUsers",
               COALESCE(SUM("costMicroUsd"), 0)::bigint                 AS "costMicroUsd"
        FROM gateway_calls
        WHERE "createdAt" >= date_trunc('month', now())`;
      const totals = totalsRows[0] ?? {
        tokens: 0,
        requests: 0,
        activeUsers: 0,
        costMicroUsd: 0,
      };

      const capabilityMix = await app.prisma.$queryRaw<PlatformCapabilityRow[]>(Prisma.sql`
        SELECT capability,
               COALESCE(SUM("inputTokens"), 0)::bigint                AS "inputTokens",
               COALESCE(SUM("outputTokens"), 0)::bigint               AS "outputTokens",
               COALESCE(SUM("costMicroUsd"), 0)::bigint               AS "costMicroUsd"
        FROM gateway_calls
        WHERE "createdAt" >= ${since}
        GROUP BY capability`);

      return toPlatformUsage({ range, series, byApp, totals, capabilityMix });
    },
  );
}
