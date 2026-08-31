import type { FastifyInstance } from "fastify";
import {
  CollectionItemsPageSchema,
  CollectionSummarySchema,
  collectionCsv,
  EnvSchema,
  MAX_DERIVED_COLUMNS,
  type CollectionItem,
  type Env,
} from "@azx-pbc/shared";
import type { Prisma, PrismaClient } from "../db/client.js";
import { authenticate, ownsApp, requireActor } from "../plugins/auth.js";
import { AppError } from "../plugins/errors.js";

/**
 * Owner-facing drain/export for app-data collections (app-data design §3.2/§5).
 * This is the **read side** of the write-only collection: the app frontend can
 * only append (`POST /_api/data/collections/:name` on the edge), and the edge DB
 * role has INSERT-only — the SELECT/export/delete here run on the privileged
 * portal role.
 *
 * Every route here is `ownsApp`-gated, reads included (ADR-0007, amended
 * 2026-08-10): these rows are visitor PII that the app which collected them
 * cannot itself read, so "any authenticated principal may read" — the v0 posture
 * inherited from usage.ts — would let one operator export another's contact list.
 * Aggregate metering can stay sign-in-gated; per-row personal data cannot.
 *
 * The real containment is the database-role split, not this gate: a compromised
 * edge cannot reach these rows at all, regardless of what the app declares.
 */

export const MAX_EXPORT_ROWS = 10_000;

function clampLimit(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.trunc(n), max);
}

/**
 * Pick the export window from a **newest-first** query result: keep the newest
 * `max`, then emit them oldest-first.
 *
 * The order the rows are *selected* in and the order they are *emitted* in are
 * two separate decisions, and conflating them is what made the first cut wrong —
 * it selected oldest-first and capped, which silently dropped every recent
 * submission from a drain while the UI reported the opposite. Selection has to be
 * newest-first: if a collection outgrows the cap, the rows an owner cannot afford
 * to lose are the ones that just arrived.
 *
 * Emission stays chronological for two reasons. A non-truncated export is then
 * byte-identical to what this route produced before, so the change is provably
 * "which rows" and not "what the file looks like". And `deriveCollectionColumns`
 * breaks equal-frequency ties by first appearance in array order, so holding the
 * scan oldest-first keeps the CSV's derived columns stable — not cosmetic, since
 * with more than `MAX_DERIVED_COLUMNS` eligible keys a tie at the last slot
 * decides which key gets a column at all.
 *
 * Note the whole window reverses, not just the truncated branch: reversing one
 * side only would leave short exports descending.
 */
export function exportWindow<T>(
  newestFirst: readonly T[],
  max: number,
): { rows: T[]; truncated: boolean } {
  const truncated = newestFirst.length > max;
  const kept = truncated ? newestFirst.slice(0, max) : newestFirst;
  return { rows: kept.toReversed(), truncated };
}

interface ItemRow {
  id: string;
  collection: string;
  env: string;
  userOid: string | null;
  userName: string | null;
  userEmail: string | null;
  item: unknown;
  meta: unknown;
  createdAt: Date;
}

function toCollectionItem(r: ItemRow): CollectionItem {
  return {
    id: r.id,
    collection: r.collection,
    env: EnvSchema.parse(r.env),
    userOid: r.userOid,
    userName: r.userName,
    userEmail: r.userEmail,
    item: r.item,
    meta: r.meta ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * `?env=prod|dev` — **absent means both tiers**, which is deliberate: the portal
 * policy on `app_collection_items` is cross-env by design (the runtime roles are
 * the ones pinned to a single tier), and an owner draining their data should be
 * able to see everything they collected. The SPA narrows to `prod` by default so
 * dev-mode test rows don't masquerade as real leads; that is a presentation
 * choice, not an API one.
 *
 * An empty value counts as absent. A caller that builds its query string
 * unconditionally sends `?env=`, and 400ing that would contradict the documented
 * "absent means both tiers" — every other param on this route already treats
 * empty as absent (`before` by a falsy check, `limit` by `clampLimit`'s fallback,
 * `format` by not matching `csv`). An unrecognised *value* still 400s.
 */
function envFilter(raw: unknown): { env?: Env } {
  const env = EnvSchema.optional().parse(raw === "" ? undefined : raw);
  return env ? { env } : {};
}

/**
 * A collection name is owner-declared (`DataCapabilitySchema`, only control chars
 * rejected at the edge), so it cannot be interpolated raw into a header value — a
 * `"` alone would terminate the quoted filename.
 */
function safeFilename(part: string): string {
  return part.replace(/[^A-Za-z0-9._-]/g, "_");
}

export async function dataRoutes(app: FastifyInstance): Promise<void> {
  /** Resolve a slug to its appId, 404ing an unknown app. */
  async function appIdFor(slug: string): Promise<string> {
    const row = await app.prisma.app.findUnique({ where: { slug }, select: { id: true } });
    if (!row) throw new AppError("not_found", `app "${slug}" not found`);
    return row.id;
  }

  /**
   * Takes its client so it can run inside a transaction — the erasure audits
   * atomically with the delete, while the export audits on the plain client.
   */
  const audit = (
    db: Pick<PrismaClient, "auditEvent"> | Prisma.TransactionClient,
    appId: string,
    actor: string,
    action: string,
    metadata: object,
  ) => db.auditEvent.create({ data: { appId, actor, action, metadata } });

  /**
   * What this app has actually collected, per (collection, env).
   *
   * Grouped by env as well as name so the SPA — which shows `prod` by default —
   * can say "340 rows in dev mode" instead of silently hiding them.
   */
  app.get<{ Params: { slug: string } }>(
    "/api/v1/apps/:slug/collections",
    { preHandler: [authenticate, ownsApp] },
    async (req) => {
      const appId = await appIdFor(req.params.slug);
      const groups = await app.prisma.appCollectionItem.groupBy({
        by: ["collection", "env"],
        where: { appId },
        _count: { _all: true },
        _max: { createdAt: true },
      });
      return groups
        .map((g) =>
          CollectionSummarySchema.parse({
            name: g.collection,
            env: g.env,
            count: g._count._all,
            lastAt: g._max.createdAt?.toISOString() ?? null,
          }),
        )
        .sort((a, b) =>
          a.name === b.name ? a.env.localeCompare(b.env) : a.name < b.name ? -1 : 1,
        );
    },
  );

  // Paginate a collection newest-first; cursor on createdAt (?before=ISO).
  app.get<{
    Params: { slug: string; name: string };
    Querystring: { limit?: string; before?: string; env?: string };
  }>(
    "/api/v1/apps/:slug/collections/:name",
    { preHandler: [authenticate, ownsApp] },
    async (req) => {
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
          ...envFilter(req.query.env),
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
    },
  );

  // Export the whole collection (capped) as JSON or CSV.
  app.get<{
    Params: { slug: string; name: string };
    Querystring: { format?: string; env?: string };
  }>(
    "/api/v1/apps/:slug/collections/:name/export",
    { preHandler: [authenticate, ownsApp] },
    async (req, reply) => {
      const actor = requireActor(req);
      const appId = await appIdFor(req.params.slug);
      const format = req.query.format === "csv" ? "csv" : "json";
      const env = envFilter(req.query.env);
      // Newest-first so the cap drops the OLDEST rows; `exportWindow` reverses the
      // kept slice back to chronological. One extra row distinguishes "exactly at
      // the cap" from "over it", so a collection of precisely MAX_EXPORT_ROWS
      // isn't reported as truncated.
      const rows = (await app.prisma.appCollectionItem.findMany({
        where: { appId, collection: req.params.name, ...env },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: MAX_EXPORT_ROWS + 1,
      })) as ItemRow[];
      const window = exportWindow(rows, MAX_EXPORT_ROWS);
      // Surface truncation rather than silently capping (app-data design §7).
      const truncated = window.truncated;
      if (truncated) reply.header("x-helix-export-truncated", String(MAX_EXPORT_ROWS));
      const items = window.rows.map(toCollectionItem);
      // Rendered before the audit so the column cap can be recorded with the rest
      // of the export, and only once — deriving columns twice over 10,000 rows to
      // answer the same question would be pure waste.
      const csvOut = format === "csv" ? collectionCsv(items) : null;

      // A bulk pull of visitor PII is at least as consequential as rotating a
      // secret, which is audited — and platform-admins pass `ownsApp`, so this row
      // is what makes a cross-owner read reviewable after the fact. The paginated
      // list is deliberately not audited: too chatty to be worth reading.
      await audit(app.prisma, appId, actor.sub, "collection.exported", {
        collection: req.params.name,
        ...env,
        format,
        rows: items.length,
        truncated,
        // Only meaningful for CSV: the JSON export has no columns to cap.
        ...(csvOut ? { columnsTruncated: csvOut.columns.truncated } : {}),
      });

      if (csvOut) {
        // Two independent caps, so two headers. Row truncation loses data; column
        // truncation does not (the raw `item` column carries every key), but the
        // owner still gets told rather than quietly handed a narrower file.
        if (csvOut.columns.truncated) {
          reply.header("x-helix-export-columns-truncated", String(MAX_DERIVED_COLUMNS));
        }
        return reply
          .header("content-type", "text/csv; charset=utf-8")
          .header("cache-control", "no-store")
          .header(
            "content-disposition",
            `attachment; filename="${safeFilename(req.params.slug)}-${safeFilename(req.params.name)}.csv"`,
          )
          .send(csvOut.csv);
      }
      return reply.header("cache-control", "no-store").send({ items });
    },
  );

  // Owner deletion of one item (GDPR-style erasure — app-data design §9).
  app.delete<{ Params: { slug: string; name: string; id: string } }>(
    "/api/v1/apps/:slug/collections/:name/items/:id",
    { preHandler: [authenticate, ownsApp] },
    async (req, reply) => {
      const actor = requireActor(req);
      // Resolved before the transaction so the interactive-transaction budget
      // covers only the two writes.
      const appId = await appIdFor(req.params.slug);

      // One transaction, because an erasure that leaves no trace is
      // indistinguishable from data loss — and this is the route a
      // subject-access request is answered with, where "we erased it" has to be
      // provable afterwards. Interactive rather than batched: the 404 has to be
      // able to roll the delete back, and a batched `$transaction([...])` would
      // commit both statements before the count check could throw, leaving a
      // `collection.item_deleted` row asserting an erasure that never happened.
      await app.prisma.$transaction(async (tx) => {
        const result = await tx.appCollectionItem.deleteMany({
          where: { id: req.params.id, appId, collection: req.params.name },
        });
        if (result.count === 0) {
          throw new AppError("not_found", "item not found");
        }
        await audit(tx, appId, actor.sub, "collection.item_deleted", {
          collection: req.params.name,
          id: req.params.id,
        });
      });
      return reply.status(204).send();
    },
  );
}
