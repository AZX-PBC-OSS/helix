import type { FastifyInstance } from "fastify";
import { CollectionItemsPageSchema, type CollectionItem } from "@azx-pbc/shared";
import { authenticate } from "../plugins/auth.js";
import { AppError } from "../plugins/errors.js";

/**
 * Owner-facing drain/export for app-data collections (app-data design §3.2/§5).
 * This is the **read side** of the write-only collection: the app frontend can
 * only append (`POST /_api/data/collections/:name` on the edge), and the edge DB
 * role has INSERT-only — the SELECT/export/delete here run on the privileged
 * portal role. Bearer-gated like the usage routes; per-app RBAC is a v1 feature,
 * so for now any authenticated portal principal may read (matching usage.ts).
 *
 * The real containment is the database-role split, not this gate: a compromised
 * edge cannot reach these rows at all, regardless of what the app declares.
 */

const MAX_EXPORT_ROWS = 10_000;

function clampLimit(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.trunc(n), max);
}

interface ItemRow {
  id: string;
  collection: string;
  userOid: string | null;
  item: unknown;
  meta: unknown;
  createdAt: Date;
}

function toCollectionItem(r: ItemRow): CollectionItem {
  return {
    id: r.id,
    collection: r.collection,
    userOid: r.userOid,
    item: r.item,
    meta: r.meta ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Minimal RFC-4180 CSV cell quoting. */
function csvCell(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function dataRoutes(app: FastifyInstance): Promise<void> {
  /** Resolve a slug to its appId, 404ing an unknown app. */
  async function appIdFor(slug: string): Promise<string> {
    const row = await app.prisma.app.findUnique({ where: { slug }, select: { id: true } });
    if (!row) throw new AppError("not_found", `app "${slug}" not found`);
    return row.id;
  }

  // Paginate a collection newest-first; cursor on createdAt (?before=ISO).
  app.get<{
    Params: { slug: string; name: string };
    Querystring: { limit?: string; before?: string };
  }>("/api/v1/apps/:slug/collections/:name", { preHandler: authenticate }, async (req) => {
    const appId = await appIdFor(req.params.slug);
    const limit = clampLimit(req.query.limit, 50, 200);
    const before = req.query.before ? new Date(req.query.before) : undefined;
    if (before && Number.isNaN(before.getTime())) {
      throw new AppError("validation_failed", "`before` must be an ISO-8601 timestamp");
    }

    const rows = await app.prisma.appCollectionItem.findMany({
      where: {
        appId,
        collection: req.params.name,
        ...(before ? { createdAt: { lt: before } } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return CollectionItemsPageSchema.parse({
      rows: page.map((r) => toCollectionItem(r as ItemRow)),
      ...(hasMore && last ? { nextBefore: last.createdAt.toISOString() } : {}),
    });
  });

  // Export the whole collection (capped) as JSON or CSV.
  app.get<{ Params: { slug: string; name: string }; Querystring: { format?: string } }>(
    "/api/v1/apps/:slug/collections/:name/export",
    { preHandler: authenticate },
    async (req, reply) => {
      const appId = await appIdFor(req.params.slug);
      const format = req.query.format === "csv" ? "csv" : "json";
      const rows = (await app.prisma.appCollectionItem.findMany({
        where: { appId, collection: req.params.name },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: MAX_EXPORT_ROWS,
      })) as ItemRow[];
      // Surface truncation rather than silently capping (app-data design §7).
      if (rows.length === MAX_EXPORT_ROWS) {
        reply.header("x-helix-export-truncated", String(MAX_EXPORT_ROWS));
      }
      const items = rows.map(toCollectionItem);

      if (format === "csv") {
        const header = "id,createdAt,userOid,item,meta";
        const lines = items.map((it) =>
          [it.id, it.createdAt, it.userOid ?? "", it.item, it.meta].map(csvCell).join(","),
        );
        return reply
          .header("content-type", "text/csv; charset=utf-8")
          .header(
            "content-disposition",
            `attachment; filename="${req.params.slug}-${req.params.name}.csv"`,
          )
          .send([header, ...lines].join("\n"));
      }
      return reply.header("cache-control", "no-store").send({ items });
    },
  );

  // Owner deletion of one item (GDPR-style erasure — app-data design §9).
  app.delete<{ Params: { slug: string; name: string; id: string } }>(
    "/api/v1/apps/:slug/collections/:name/items/:id",
    { preHandler: authenticate },
    async (req, reply) => {
      const appId = await appIdFor(req.params.slug);
      const result = await app.prisma.appCollectionItem.deleteMany({
        where: { id: req.params.id, appId, collection: req.params.name },
      });
      if (result.count === 0) {
        throw new AppError("not_found", "item not found");
      }
      return reply.status(204).send();
    },
  );
}
