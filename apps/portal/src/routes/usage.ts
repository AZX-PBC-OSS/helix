import type { FastifyInstance } from "fastify";
import { GatewayAuditPageSchema } from "@helix/shared";
import { authenticate } from "../plugins/auth.js";
import { AppError } from "../plugins/errors.js";
import {
  toGatewayCall,
  toPlatformUsage,
  toUsageSummary,
  type GatewayCallRow,
  type PlatformAppRow,
  type PlatformCapabilityRow,
  type PlatformSeriesRow,
  type UsageModelRow,
  type UsageOutcomeRow,
  type UsageSeriesRow,
} from "../db/mappers.js";

/**
 * Read-side metering routes over the `gateway_calls` ledger (M4, architecture
 * §6.1/§8). The **edge writes** the ledger; these endpoints only **read** it for
 * display. Unlike the other portal reads they require a bearer token — usage and
 * audit data is "who called what, on whose behalf" (per-app RBAC is a v1
 * feature; for now any authenticated portal principal may read).
 *
 * Day boundaries use `date_trunc('day', now())` to match the edge's per-app
 * quota window (apps/edge/src/gateway/usage.ts), so "today" lines up.
 */

/** Clamp a `?window=`/`?days=` query value to a sane positive integer. */
function clampWindow(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.trunc(n), max);
}

export async function usageRoutes(app: FastifyInstance): Promise<void> {
  // Per-app usage summary over a rolling day window. Bearer-gated read.
  app.get<{ Params: { slug: string }; Querystring: { window?: string } }>(
    "/api/v1/apps/:slug/usage",
    { preHandler: authenticate },
    async (req) => {
      const windowDays = clampWindow(req.query.window, 1, 90);
      const row = await app.prisma.app.findUnique({ where: { slug: req.params.slug } });
      if (!row) {
        throw new AppError("not_found", `app "${req.params.slug}" not found`);
      }
      // Window start: midnight `windowDays - 1` days ago, so window=1 is "today
      // since midnight" — the same boundary the edge enforces the budget on.
      const offset = windowDays - 1;

      const outcomes = await app.prisma.$queryRaw<UsageOutcomeRow[]>`
        SELECT outcome,
               COUNT(*)::int                              AS requests,
               COALESCE(SUM("inputTokens"), 0)::bigint    AS "inputTokens",
               COALESCE(SUM("outputTokens"), 0)::bigint   AS "outputTokens"
        FROM gateway_calls
        WHERE "appId" = ${row.id}::uuid
          AND "createdAt" >= date_trunc('day', now()) - make_interval(days => ${offset})
        GROUP BY outcome`;

      const models = await app.prisma.$queryRaw<UsageModelRow[]>`
        SELECT model,
               COUNT(*)::int                                       AS requests,
               COALESCE(SUM("inputTokens" + "outputTokens"), 0)::bigint AS tokens
        FROM gateway_calls
        WHERE "appId" = ${row.id}::uuid
          AND "createdAt" >= date_trunc('day', now()) - make_interval(days => ${offset})
        GROUP BY model
        ORDER BY tokens DESC`;

      const series = await app.prisma.$queryRaw<UsageSeriesRow[]>`
        SELECT date_trunc('hour', "createdAt")                     AS bucket,
               COALESCE(SUM("inputTokens" + "outputTokens"), 0)::bigint AS tokens,
               COUNT(*)::int                                       AS requests
        FROM gateway_calls
        WHERE "appId" = ${row.id}::uuid
          AND "createdAt" >= date_trunc('day', now()) - make_interval(days => ${offset})
        GROUP BY bucket
        ORDER BY bucket ASC`;

      return toUsageSummary({ appId: row.id, windowDays, outcomes, models, series });
    },
  );

  // Gateway audit log: recent calls newest-first, cursor-paginated on createdAt.
  // Cross-app (admin); optional ?app= (slug) and ?outcome= filters. Bearer-gated.
  app.get<{
    Querystring: { app?: string; outcome?: string; limit?: string; before?: string };
  }>("/api/v1/gateway/audit", { preHandler: authenticate }, async (req) => {
    const limit = clampWindow(req.query.limit, 50, 200);

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

    // Fetch one extra row to compute the next cursor without a count query.
    const rows = await app.prisma.gatewayCall.findMany({
      where: {
        ...(appId ? { appId } : {}),
        ...(req.query.outcome ? { outcome: req.query.outcome } : {}),
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
        capability: r.capability,
        model: r.model,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        outcome: r.outcome,
        createdAt: r.createdAt,
      }),
    );

    const last = page.at(-1);
    return GatewayAuditPageSchema.parse({
      rows: mapped.map(toGatewayCall),
      ...(hasMore && last ? { nextBefore: last.createdAt.toISOString() } : {}),
    });
  });

  // Platform-wide rollup: 14-day trend + month-to-date totals/breakdowns.
  // Bearer-gated. Backs the admin Platform page and the workspace /usage page.
  app.get<{ Querystring: { days?: string } }>(
    "/api/v1/gateway/usage",
    { preHandler: authenticate },
    async (req) => {
      const days = clampWindow(req.query.days, 14, 90);

      // Dense daily series (zero-filled) via generate_series so the chart always
      // has exactly `days` buckets oldest-first.
      const daily = await app.prisma.$queryRaw<PlatformSeriesRow[]>`
        SELECT COALESCE(SUM(gc."inputTokens" + gc."outputTokens"), 0)::bigint AS tokens,
               COUNT(gc.id)::int                                             AS requests
        FROM generate_series(
               date_trunc('day', now()) - make_interval(days => ${days - 1}),
               date_trunc('day', now()),
               interval '1 day'
             ) AS d
        LEFT JOIN gateway_calls gc ON date_trunc('day', gc."createdAt") = d
        GROUP BY d
        ORDER BY d ASC`;

      const byApp = await app.prisma.$queryRaw<PlatformAppRow[]>`
        SELECT a.slug                                                       AS slug,
               COALESCE(SUM(gc."inputTokens" + gc."outputTokens"), 0)::bigint AS tokens,
               COUNT(*)::int                                                AS requests
        FROM gateway_calls gc
        LEFT JOIN apps a ON a.id = gc."appId"
        WHERE gc."createdAt" >= date_trunc('month', now())
        GROUP BY gc."appId", a.slug
        ORDER BY tokens DESC`;

      const totalsRows = await app.prisma.$queryRaw<
        Array<{ tokens: bigint | number; requests: number; activeUsers: number }>
      >`
        SELECT COALESCE(SUM("inputTokens" + "outputTokens"), 0)::bigint AS tokens,
               COUNT(*)::int                                            AS requests,
               COUNT(DISTINCT "userOid")::int                           AS "activeUsers"
        FROM gateway_calls
        WHERE "createdAt" >= date_trunc('month', now())`;
      const totals = totalsRows[0] ?? { tokens: 0, requests: 0, activeUsers: 0 };

      const capabilityMix = await app.prisma.$queryRaw<PlatformCapabilityRow[]>`
        SELECT capability,
               COALESCE(SUM("inputTokens" + "outputTokens"), 0)::bigint AS tokens
        FROM gateway_calls
        WHERE "createdAt" >= date_trunc('month', now())
        GROUP BY capability
        ORDER BY tokens DESC`;

      return toPlatformUsage({ daily, byApp, totals, capabilityMix });
    },
  );
}
