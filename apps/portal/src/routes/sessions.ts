import type { FastifyInstance } from "fastify";
import {
  SessionListResponseSchema,
  SessionRevokeRequestSchema,
  SessionRevokeResultSchema,
  type SessionListResponse,
  type SessionSummary,
} from "@azx-pbc/shared";
import { DirectoryError } from "@azx-pbc/directory";
import { authenticate, requireAdmin, type Actor } from "../plugins/auth.js";
import { AppError } from "../plugins/errors.js";
import { Prisma } from "../db/client.js";
import { bumpSearchLimit, RATE_BUCKETS } from "../directory/rateLimit.js";

/**
 * Admin-only listing and per-user revocation of live app sessions.
 * The edge looks up each session without caching, so deleting rows rejects the
 * next request: navigations return to login and API requests receive 401.
 *
 * Revocation ends access based on stale group snapshots. It does not block a
 * principal whose entitlement remains valid; that user can sign in again.
 * Disable the account or remove membership in the identity provider to block
 * future login. Both routes require admin because they expose identities and
 * operate across apps.
 *
 * The portal has only SELECT and DELETE on sessions (migration 20260921120000).
 * It cannot create sessions or alter handoff token hashes. The role-split
 * integration test verifies these grants.
 */

/** Default page of live sessions; the sweeper bounds the table (~32 h dwell). */
const DEFAULT_LIMIT = 200;
/** Hard cap — hygiene, like usage.ts's limits: response size is the route's. */
const MAX_LIMIT = 500;

/** Clamp a `?limit=` query value to a sane positive integer. */
function clampLimit(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.trunc(n), max);
}

/** Prisma returns `groups` as Json; read it back the way the edge wrote it. */
function toGroups(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((g): g is string => typeof g === "string") : [];
}

/**
 * Narrow the kind column rather than casting. The edge already parses on read
 * for the same reason ("an unrecognised value is treated as no kind recorded
 * rather than smuggled through as one"); the list must not fail a whole page
 * parse because a pre-column or future value is not one of the two kinds a
 * session can hold.
 */
function toSessionKind(value: string | null): "user" | "password" | null {
  return value === "user" || value === "password" ? value : null;
}

interface RemovedRow {
  appId: string;
  userName: string | null;
  userEmail: string | null;
  userKind: string | null;
}

/**
 * Resolve the union of the page's group ids to display names.
 *
 * Same primitive, same budget as my-groups (`getGroups`, the `resolve` bucket):
 * this route adds no directory capability — it names ids the admin is already
 * being shown. Two ways it differs from my-groups, both deliberate:
 *
 * - **Refused budget degrades instead of 429ing.** My-groups' entire purpose is
 *   the resolve, so a spent budget has nothing left to serve. Here the names
 *   are a courtesy on top of a security screen — the list and the revoke must
 *   stay available when the budget is spent, so the ids render bare and
 *   `groupsResolved` says why. The budget still protects the tenant's shared
 *   Graph throttle: the call is skipped, not made anyway.
 * - **Transient directory failure degrades too** (warn + bare ids), for the
 *   same reason. A Graph blip must not take down session revocation.
 *
 * Returns the empty map with `groupsResolved: true` when there is nothing to
 * resolve — "no groups anywhere on this page" is a resolution, not a gap.
 */
async function resolveGroupNames(
  app: FastifyInstance,
  actor: Actor,
  ids: string[],
): Promise<Pick<SessionListResponse, "groupNames" | "groupsResolved">> {
  if (ids.length === 0) return { groupNames: {}, groupsResolved: true };
  const verdict = await bumpSearchLimit(app.prisma, actor.sub, "resolve");
  if (!verdict.allowed) {
    app.log.warn(
      { actor: actor.sub, count: verdict.count, limit: RATE_BUCKETS.resolve.limit },
      "session list: directory resolve budget spent — rendering raw group ids",
    );
    return { groupNames: {}, groupsResolved: false };
  }
  try {
    const outcome = await app.directory.getGroups(ids);
    if (!outcome.available) {
      // Structural (no-consent / no-credential / not-configured): expected on
      // some deployments, not worth a warn — the SPA states it once.
      app.log.info({ reason: outcome.reason }, "session list: group names unavailable");
      return { groupNames: {}, groupsResolved: false };
    }
    // Unresolved ids are omitted by the provider, not errors — a stale or
    // deleted group id is an ordinary state, and the raw id is always correct.
    const groupNames: Record<string, string | null> = {};
    for (const g of outcome.value) groupNames[g.id] = g.displayName;
    return { groupNames, groupsResolved: true };
  } catch (err) {
    if (err instanceof DirectoryError) {
      app.log.warn({ err, what: "getGroups" }, "session list: directory call failed");
      return { groupNames: {}, groupsResolved: false };
    }
    throw err;
  }
}

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  // Live sessions, newest-expiry-first within a user. Flat on purpose: the SPA
  // groups by userOid (the revoke is user-level), and a flat row list is the
  // same shape the gateway audit serves — nothing for the client to trust a
  // server-side grouping for.
  //
  // "Live" = activated (tokenHash bound — a pending row is not yet a
  // credential, and dies on its own in ~10 min) and unexpired (the lookup the
  // gate runs filters the same way, so this is exactly what the edge would
  // still admit). Expired-but-unswept rows are deliberately absent: listing
  // them would render a kill affordance that does nothing.
  app.get<{ Querystring: { limit?: string } }>(
    "/api/v1/sessions",
    { preHandler: authenticate },
    async (req): Promise<SessionListResponse> => {
      // First statement, ahead of any parse or DB read — the idiom approvals.ts,
      // csp.ts, secrets.ts and usage.ts use, and what the admin-gate sweep in
      // sessions.test.ts pins.
      const actor = requireAdmin(req);
      const limit = clampLimit(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);

      const rows = await app.prisma.session.findMany({
        where: { tokenHash: { not: null }, expiresAt: { gt: new Date() } },
        include: { app: { select: { slug: true } } },
        orderBy: [{ userOid: "asc" }, { expiresAt: "desc" }],
        take: limit,
      });

      const summaries: SessionSummary[] = rows.map((r) => ({
        id: r.id,
        appId: r.appId,
        slug: r.app.slug,
        userOid: r.userOid,
        // The display half, read as stored — rendered, never compared.
        userName: r.userName,
        userEmail: r.userEmail,
        userKind: toSessionKind(r.userKind),
        groups: toGroups(r.groups),
        createdAt: r.createdAt.toISOString(),
        activatedAt: r.activatedAt?.toISOString() ?? null,
        refreshDueAt: r.refreshDueAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
      }));

      const union = [...new Set(summaries.flatMap((s) => s.groups))];
      const names = await resolveGroupNames(app, actor, union);
      return SessionListResponseSchema.parse({ rows: summaries, ...names });
    },
  );

  // Kill every session of one user, across all apps. Idempotent: a user whose
  // last session expired between list and click is already in the desired end
  // state, so `{ removed: 0 }` — not a 404 the SPA would have to special-case
  // and a script would have to race.
  app.post<{ Body: unknown }>(
    "/api/v1/sessions/revoke",
    { preHandler: authenticate },
    async (req) => {
      const actor = requireAdmin(req);
      const parsed = SessionRevokeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          "validation_failed",
          "`userOid` is required: the subject of a session row, as the list returned it",
        );
      }

      // One statement, RETURNING what it removed. Not SELECT-then-DELETE: the
      // audit metadata must describe exactly the rows the kill took, with no
      // window in which a minted session is deleted but unreported (or
      // reported but alive). `DELETE` as helix_portal rides the
      // `sessions_portal_all` RLS policy; the grant (SELECT+DELETE only) is
      // what migration 20260921120000 tightened.
      //
      // No `expiresAt` predicate, on purpose: a never-redeemed pending of the
      // same user dies too. A pending row is a login in flight, and an
      // in-flight login for a user being killed is precisely the thing to kill.
      const removed = await app.prisma.$queryRaw<RemovedRow[]>(Prisma.sql`
        DELETE FROM sessions
         WHERE "userOid" = ${parsed.data.userOid}
         RETURNING "appId", "userName", "userEmail", "userKind"`);

      const appIds = [...new Set(removed.map((r) => r.appId))];
      const appRows = appIds.length
        ? await app.prisma.app.findMany({ where: { id: { in: appIds } }, select: { slug: true } })
        : [];
      const apps = appRows.map((a) => a.slug);

      // Capture-at-write (ADR-0021's amendment): the session rows themselves
      // are about to be swept, so the audit row carries the display half now
      // or never. First non-null wins — all rows of one subject hold the same
      // captured claims.
      const firstNamed = removed.find((r) => r.userName !== null || r.userEmail !== null);
      const metadata = {
        userOid: parsed.data.userOid,
        userName: firstNamed?.userName ?? null,
        userEmail: firstNamed?.userEmail ?? null,
        userKind: toSessionKind(removed[0]?.userKind ?? null),
        apps,
        removed: removed.length,
      };
      // appId: null — the kill is platform-level, spanning apps by design; the
      // same expressiveness the directory routes use. Audited even when
      // removed = 0: "who tried to kill whose sessions, when" is the record,
      // and a repeated 0-removals revoke is itself a fact worth reading.
      await app.prisma.auditEvent.create({
        data: { appId: null, actor: actor.sub, action: "session.revoke", metadata },
      });

      return SessionRevokeResultSchema.parse({ removed: removed.length, apps });
    },
  );
}
