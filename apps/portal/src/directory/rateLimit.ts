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

/**
 * The purposes this table carries, and the limit each gets per actor per window.
 *
 * Two buckets rather than one, because the two surfaces cost differently. A
 * search is an operator typing; a resolve fires on every Access-tab render of a
 * group-scoped app, so sharing one budget would let ordinary navigation exhaust
 * the search allowance. The prefix is what keeps them separate in one table, and
 * what `sweepSearchLimits` scopes its DELETE to.
 */
export const RATE_BUCKETS = {
  /** `GET /api/v1/directory/groups` — tenant-wide search. */
  search: { prefix: "dirsearch", limit: 30 },
  /** The two id -> name resolves. Looser: this is page-render traffic. */
  resolve: { prefix: "dirresolve", limit: 120 },
} as const;

export type RateBucket = keyof typeof RATE_BUCKETS;

/** Kept for the log line and the tests that pin the search limit. */
export const SEARCH_LIMIT = RATE_BUCKETS.search.limit;

/** Window length, shared by both buckets. */
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
  bucket: RateBucket = "search",
  // Annotated: `as const` on RATE_BUCKETS would otherwise narrow this to the
  // literal union of the configured limits, so a test could not pass its own.
  limit: number = RATE_BUCKETS[bucket].limit,
  windowMs = SEARCH_WINDOW_MS,
): Promise<RateLimitVerdict> {
  // Namespaced by purpose so the table can carry other control-plane counters
  // later without key collisions, and so one purpose's flood cannot spend
  // another's budget.
  const key = `${RATE_BUCKETS[bucket].prefix}:${actorSub}`;
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
 * Wired to an interval in `plugins/directory.ts` — it had no caller at all for a
 * while, which made the sentence above an assertion about a bound that did not
 * exist, and left the migration's `resetAt` index and `DELETE` grant as dead
 * weight.
 *
 * Prefix-scoped, unlike the edge's sweep. The portal owns this whole table today,
 * but a sweep that deletes every elapsed row is the kind of thing that keeps
 * working after someone adds a counter with a longer window, and quietly resets
 * it. Scoping to the prefixes this module owns costs nothing now and removes that
 * trap.
 */
export async function sweepSearchLimits(prisma: PrismaClient): Promise<void> {
  const prefixes = Object.values(RATE_BUCKETS).map((b) => `${b.prefix}:%`);
  await prisma.$executeRaw`
    DELETE FROM portal_rate_counters
     WHERE "resetAt" < now() AND "bucketKey" LIKE ANY (${prefixes})`;
}
