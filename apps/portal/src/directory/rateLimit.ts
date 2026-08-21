import type { PrismaClient } from "../db/client.js";

/**
 * Fixed-window per-actor rate limit for the directory search endpoint
 * (ADR-0040 §4).
 *
 * Postgres-backed rather than an in-process Map, for the reason issue #13 gave
 * for the edge's limiter: the portal runs up to `maxReplicas` (3, per
 * `infra/azure/modules/containerapp.bicep`) and a per-replica counter silently
 * multiplies the configured limit by the replica count. ADR-0040 commits to this
 * surface shipping restrictive, and "restrictive, times three, depending on load"
 * is not a limit anyone can reason about.
 *
 * The mechanics are `PgCounterStore.bump` (`apps/edge/src/gateway/counterStore.ts`),
 * duplicated rather than imported: the edge is a separate deployable, so there is
 * no shared module to reach for, and pulling the edge's counter into the portal
 * would also pull its pool factory and its table. ~30 lines is the cheaper side
 * of that trade.
 *
 * **Not a security boundary.** What bounds this surface is the minimum query
 * length, the `$top` cap, `authenticate`, and the audit row. This is an abuse
 * control on top — and Graph throttles us independently with a 429 we surface
 * either way.
 */

/** Requests per actor per window. */
export const SEARCH_LIMIT = 30;

/** Window length. */
export const SEARCH_WINDOW_MS = 60_000;

export interface RateLimitVerdict {
  allowed: boolean;
  /** Post-increment count, for the log line and the `retry-after` hint. */
  count: number;
}

/**
 * Increment this actor's window and report whether the request may proceed.
 *
 * One statement, so there is no check-then-increment race: the `ON CONFLICT`
 * branch either restarts an elapsed window or increments a live one, and
 * `RETURNING count` hands back the post-increment value the decision is made on.
 * (The edge's login throttle had exactly that TOCTOU before issue #13; closing it
 * by construction is free here, so there is no reason to reintroduce it.)
 */
export async function bumpSearchLimit(
  prisma: PrismaClient,
  actorSub: string,
  limit = SEARCH_LIMIT,
  windowMs = SEARCH_WINDOW_MS,
): Promise<RateLimitVerdict> {
  // Namespaced by purpose so the table can carry other control-plane counters
  // later without key collisions.
  const key = `dirsearch:${actorSub}`;
  const rows = await prisma.$queryRaw<Array<{ count: number }>>`
    INSERT INTO portal_rate_counters ("bucketKey", count, "resetAt")
      VALUES (${key}, 1, now() + (${windowMs} || ' milliseconds')::interval)
    ON CONFLICT ("bucketKey") DO UPDATE
      SET count = CASE WHEN portal_rate_counters."resetAt" <= now() THEN 1
                       ELSE portal_rate_counters.count + 1 END,
          "resetAt" = CASE WHEN portal_rate_counters."resetAt" <= now()
                           THEN now() + (${windowMs} || ' milliseconds')::interval
                           ELSE portal_rate_counters."resetAt" END
    RETURNING count`;
  const count = Number(rows[0]?.count ?? 0);
  return { allowed: count <= limit, count };
}

/**
 * Drop elapsed windows so a flood can't grow the table without bound.
 *
 * Prefix-scoped, unlike the edge's sweep. The portal owns this whole table today,
 * but a sweep that deletes every elapsed row is the kind of thing that keeps
 * working after someone adds a second counter with a longer window, and quietly
 * resets it. Scoping to the keys this module owns costs nothing now and removes
 * that trap.
 */
export async function sweepSearchLimits(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM portal_rate_counters
     WHERE "resetAt" < now() AND "bucketKey" LIKE 'dirsearch:%'`;
}
