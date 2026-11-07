import type { FastifyInstance } from "fastify";
import { PrincipalKindSchema } from "@azx-pbc/shared";
import {
  CollectionSummarySchema,
  collectionCsv,
  EnvSchema,
  MAX_DERIVED_COLUMNS,
  type CollectionItem,
  type Env,
} from "@azx-pbc/shared";
import { parseRequest, portal, responseBody } from "@azx-pbc/shared/contracts";
import type { Prisma, PrismaClient } from "../db/client.js";
import { requireActor } from "../plugins/auth.js";
import { contractRoute } from "../plugins/contractRoute.js";
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

/**
 * Select the newest max rows from a newest-first query, then emit oldest-first.
 * This preserves recent submissions when the collection exceeds the export cap.
 * Reverse the full selected window, including non-truncated results.
 *
 * Chronological output also keeps derived CSV columns stable: equal-frequency
 * keys are ordered by first appearance, which can decide the last column when
 * MAX_DERIVED_COLUMNS is reached.
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
  userKind: string | null;
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
    userKind: PrincipalKindSchema.nullable().parse(r.userKind),
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
 * choice, not an API one. The contract treats an empty value as absent.
 */
function envFilter(env: Env | undefined): { env?: Env } {
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
  contractRoute(app, portal.listAppCollections, async (req) => {
    const { params } = parseRequest(portal.listAppCollections, req);
    const appId = await appIdFor(params.slug);
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
      .sort((a, b) => (a.name === b.name ? a.env.localeCompare(b.env) : a.name < b.name ? -1 : 1));
  });

  // Paginate a collection newest-first; cursor on createdAt (?before=ISO).
  contractRoute(app, portal.listAppCollectionItems, async (req) => {
    const { params, query } = parseRequest(portal.listAppCollectionItems, req);
    const appId = await appIdFor(params.slug);
    const limit = query.limit;
    const before = query.before ? new Date(query.before) : undefined;
    if (before && Number.isNaN(before.getTime())) {
      throw new AppError("validation_failed", "`before` must be an ISO-8601 timestamp");
    }

    const rows = await app.prisma.appCollectionItem.findMany({
      where: {
        appId,
        collection: params.name,
        ...envFilter(query.env),
        ...(before ? { createdAt: { lt: before } } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return responseBody(portal.listAppCollectionItems, 200, {
      rows: page.map((r) => toCollectionItem(r as ItemRow)),
      ...(hasMore && last ? { nextBefore: last.createdAt.toISOString() } : {}),
    });
  });

  // Export the whole collection (capped) as JSON or CSV.
  contractRoute(app, portal.exportAppCollection, async (req, reply) => {
    const actor = requireActor(req);
    const { params, query } = parseRequest(portal.exportAppCollection, req);
    const appId = await appIdFor(params.slug);
    const format = query.format;
    const env = envFilter(query.env);
    // Newest-first so the cap drops the OLDEST rows; `exportWindow` reverses the
    // kept slice back to chronological. One extra row distinguishes "exactly at
    // the cap" from "over it", so a collection of precisely MAX_EXPORT_ROWS
    // isn't reported as truncated.
    const rows = (await app.prisma.appCollectionItem.findMany({
      where: { appId, collection: params.name, ...env },
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
      collection: params.name,
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
          `attachment; filename="${safeFilename(params.slug)}-${safeFilename(params.name)}.csv"`,
        )
        .send(csvOut.csv);
    }
    return reply
      .header("cache-control", "no-store")
      .send(responseBody(portal.exportAppCollection, 200, { items }));
  });

  // Owner deletion of one item (GDPR-style erasure — app-data design §9).
  contractRoute(app, portal.deleteAppCollectionItem, async (req, reply) => {
    const actor = requireActor(req);
    const { params } = parseRequest(portal.deleteAppCollectionItem, req);
    // Resolved before the transaction so the interactive-transaction budget
    // covers only the two writes.
    const appId = await appIdFor(params.slug);

    // One transaction, because an erasure that leaves no trace is
    // indistinguishable from data loss — and this is the route a
    // subject-access request is answered with, where "we erased it" has to be
    // provable afterwards. Interactive rather than batched: the 404 has to be
    // able to roll the delete back, and a batched `$transaction([...])` would
    // commit both statements before the count check could throw, leaving a
    // `collection.item_deleted` row asserting an erasure that never happened.
    await app.prisma.$transaction(async (tx) => {
      const result = await tx.appCollectionItem.deleteMany({
        where: { id: params.id, appId, collection: params.name },
      });
      if (result.count === 0) {
        throw new AppError("not_found", "item not found");
      }
      await audit(tx, appId, actor.sub, "collection.item_deleted", {
        collection: params.name,
        id: params.id,
      });
    });
    return reply.status(204).send();
  });
}
