import type { FastifyInstance } from "fastify";
import {
  VISIT_IDLE_MINUTES,
  VISITOR_LOCATION_LIMIT,
  VISITOR_RANGES,
  VisitorSummarySchema,
  type VisitorLocation,
  type VisitorRange,
  type VisitorSummary,
  type VisitorTotals,
} from "@azx-pbc/shared";
import { authenticate, ownsApp } from "../plugins/auth.js";
import { AppError } from "../plugins/errors.js";
import { Prisma } from "../db/client.js";
import type { GeoResolver } from "../geo/resolver.js";

/**
 * The owner's Visitors view over `app_visits` (ADR-0050). Owner-or-admin, like
 * the per-call feed: the counts describe who opens the app, which is the owner's
 * business, not every portal principal's.
 *
 * Windows are calendar days in the DB session timezone, the same convention as
 * the gateway usage routes. A visit is a run of loads by one `visitorHash` with
 * no gap longer than {@link VISIT_IDLE_MINUTES}; a load with no hash is its own
 * visit and counts toward no visitor. The attribution rule is documented on
 * `VisitorSummarySchema`.
 */

const RANGE_DAYS: Record<VisitorRange, number> = { "7d": 7, "30d": 30, "90d": 90 };

interface TotalsRow {
  current: boolean;
  visits: bigint;
  visitors: bigint;
}
interface SeriesRow {
  bucket: Date;
  visits: bigint;
  visitors: bigint;
}
interface PrefixRow {
  ipPrefix: string | null;
  visits: bigint;
  visitors: bigint;
}

export async function visitorRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { slug: string }; Querystring: { range?: string } }>(
    "/api/v1/apps/:slug/visitors",
    { preHandler: [authenticate, ownsApp] },
    async (req) => {
      const range: VisitorRange = (VISITOR_RANGES as readonly string[]).includes(
        req.query.range ?? "",
      )
        ? (req.query.range as VisitorRange)
        : "30d";
      const days = RANGE_DAYS[range];
      const row = await app.prisma.app.findUnique({
        where: { slug: req.params.slug },
        select: { id: true },
      });
      if (!row) throw new AppError("not_found", `app "${req.params.slug}" not found`);
      const id = row.id;

      const currentStart = Prisma.sql`(date_trunc('day', now()) - make_interval(days => ${days - 1}))`;
      const priorStart = Prisma.sql`(${currentStart} - make_interval(days => ${days}))`;

      // Every load in both windows, flagged with whether it starts a visit. The
      // inner scan reaches one idle gap further back, so `LAG` sees the load
      // that a window's first load may be continuing; the outer filter then
      // drops those lead-in rows. Without it, a visit already in progress at
      // `priorStart` would be counted as starting there.
      const loads = Prisma.sql`
        SELECT * FROM (
          SELECT "createdAt", "visitorHash", "ipPrefix",
                 "createdAt" >= ${currentStart} AS current,
                 CASE WHEN "visitorHash" IS NULL THEN true
                      ELSE COALESCE(
                        "createdAt" - LAG("createdAt") OVER (
                          PARTITION BY "visitorHash" ORDER BY "createdAt"
                        ) > make_interval(mins => ${VISIT_IDLE_MINUTES}),
                        true)
                 END AS starts
          FROM app_visits
          WHERE "appId" = ${id}::uuid AND env = 'prod'
            AND "createdAt" >= ${priorStart} - make_interval(mins => ${VISIT_IDLE_MINUTES})
        ) scanned
        WHERE "createdAt" >= ${priorStart}`;

      const totals = await app.prisma.$queryRaw<TotalsRow[]>(Prisma.sql`
        WITH loads AS (${loads})
        SELECT current,
               COUNT(*) FILTER (WHERE starts) AS visits,
               COUNT(DISTINCT "visitorHash")  AS visitors
        FROM loads
        GROUP BY current`);

      // `COUNT(l."createdAt")`, not `COUNT(*)`, so an empty day reads 0 on the LEFT JOIN.
      const series = await app.prisma.$queryRaw<SeriesRow[]>(Prisma.sql`
        WITH loads AS (${loads})
        SELECT d AS bucket,
               COUNT(l."createdAt") FILTER (WHERE l.starts) AS visits,
               COUNT(DISTINCT l."visitorHash")              AS visitors
        FROM generate_series(${currentStart}, date_trunc('day', now()), interval '1 day') AS d
        LEFT JOIN loads l ON l.current AND date_trunc('day', l."createdAt") = d
        GROUP BY d
        ORDER BY d ASC`);

      // A hash is derived from one IP, so it maps to exactly one prefix: summing
      // distinct visitors per prefix into a location is exact, not an estimate.
      const prefixes = await app.prisma.$queryRaw<PrefixRow[]>(Prisma.sql`
        WITH loads AS (${loads})
        SELECT "ipPrefix",
               COUNT(*) FILTER (WHERE starts) AS visits,
               COUNT(DISTINCT "visitorHash")  AS visitors
        FROM loads
        WHERE current
        GROUP BY "ipPrefix"`);

      const pick = (current: boolean): VisitorTotals => {
        const r = totals.find((t) => t.current === current);
        return { visits: Number(r?.visits ?? 0), uniqueVisitors: Number(r?.visitors ?? 0) };
      };

      const summary: VisitorSummary = {
        appId: id,
        range,
        current: pick(true),
        prior: pick(false),
        series: series.map((s) => ({
          bucket: s.bucket.toISOString(),
          visits: Number(s.visits),
          uniqueVisitors: Number(s.visitors),
        })),
        ...rollUpLocations(prefixes, app.geo),
        geo: app.geo.status,
      };
      return VisitorSummarySchema.parse(summary);
    },
  );
}

/** Resolve each prefix and group by (country, region); top N, then the rest. */
export function rollUpLocations(
  prefixes: PrefixRow[],
  geo: GeoResolver,
): Pick<VisitorSummary, "locations" | "otherLocations" | "unresolved"> {
  const unresolved: VisitorTotals = { visits: 0, uniqueVisitors: 0 };
  const byPlace = new Map<string, VisitorLocation>();
  for (const p of prefixes) {
    const visits = Number(p.visits);
    const visitors = Number(p.visitors);
    const place = p.ipPrefix ? geo.lookup(p.ipPrefix) : null;
    if (!place) {
      unresolved.visits += visits;
      unresolved.uniqueVisitors += visitors;
      continue;
    }
    const key = `${place.country}\u0000${place.region ?? ""}`;
    const entry = byPlace.get(key) ?? {
      country: place.country,
      countryName: place.countryName,
      region: place.region,
      visitors: 0,
      visits: 0,
    };
    entry.visits += visits;
    entry.visitors += visitors;
    byPlace.set(key, entry);
  }
  const ranked = [...byPlace.values()].sort(
    (a, b) => b.visitors - a.visitors || b.visits - a.visits,
  );
  const otherLocations: VisitorTotals = { visits: 0, uniqueVisitors: 0 };
  for (const rest of ranked.slice(VISITOR_LOCATION_LIMIT)) {
    otherLocations.visits += rest.visits;
    otherLocations.uniqueVisitors += rest.visitors;
  }
  return { locations: ranked.slice(0, VISITOR_LOCATION_LIMIT), otherLocations, unresolved };
}
