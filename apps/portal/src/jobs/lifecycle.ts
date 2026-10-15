/**
 * The jobs lifecycle seam (background-jobs-plane design §5, ADR-0007): the
 * portal app model is the generation authority, and every lifecycle
 * transition — app creation, archive, unarchive — commits app state, the
 * generation and one delivery intent per configured target **in one
 * transaction**, so the intent exists exactly when the state does. The
 * delivery of those intents is the supervised sender's job (it clears a row
 * only on the target's applied-generation acknowledgement); nothing here
 * delivers anything or claims cancellation has run — archive stays
 * asynchronous by design, and the response must not imply otherwise.
 *
 * The targets are the deployment map's servers, serving and retiring alike: a
 * retiring server still retains work and must learn every change until its
 * records are gone. A fully disabled installation (the empty map) has no
 * targets and records no backlog — ordinary hosting never depends on jobs.
 */

import {
  ATTR_APP_ID,
  ATTR_JOBS_ARCHIVED,
  ATTR_JOBS_GENERATION,
  ATTR_JOBS_LIFECYCLE_TARGETS,
  SPAN_JOBS_LIFECYCLE_OUTBOX,
} from "@azx-pbc/shared/telemetry";
import { Prisma, type App as AppRow, type PrismaClient } from "../db/client.js";
import { resolveJobsCatalogueServers } from "../deployment.js";
import { AppError } from "../plugins/errors.js";
import { inChildSpan } from "../telemetry.js";

/** One lifecycle change, as the outbox rows carry it (`JobsLifecycleUpdate`'s halves, generation as the model's integer authority). */
export interface LifecycleUpdate {
  generation: number;
  archived: boolean;
}

/**
 * The lifecycle targets a transition must inform: every configured server in
 * the deployment map, both states. Read per call (the deployment source is
 * env-built, like every other portal resolver); a misconfigured source throws
 * the platform failure the resolver raises.
 */
export function lifecycleTargets(): string[] {
  return Object.keys(resolveJobsCatalogueServers().servers);
}

/**
 * Append one outbox intent per target, inside the caller's transaction. The
 * per-target row is what makes delivery independent: an acknowledgement
 * records against one `(appId, generation, server)` triple and can never
 * stand in for another server's. Returns the target ids (audit metadata).
 */
export async function recordLifecycleIntents(
  tx: Prisma.TransactionClient,
  appId: string,
  update: LifecycleUpdate,
): Promise<string[]> {
  const targets = lifecycleTargets();
  if (targets.length === 0) return [];
  return inChildSpan(
    SPAN_JOBS_LIFECYCLE_OUTBOX,
    async () => {
      await tx.jobsLifecycleOutbox.createMany({
        data: targets.map((server) => ({
          appId,
          generation: update.generation,
          server,
          archived: update.archived,
        })),
      });
      return targets;
    },
    {
      [ATTR_APP_ID]: appId,
      [ATTR_JOBS_GENERATION]: update.generation,
      [ATTR_JOBS_ARCHIVED]: update.archived,
      [ATTR_JOBS_LIFECYCLE_TARGETS]: targets.length,
    },
  );
}

/**
 * One archive/unarchive transition, all-or-nothing: the app-state write, the
 * generation increment and the per-target intents commit together or not at
 * all, with the audit event on the same boundary.
 *
 * The transition's guard is part of the UPDATE, not a check before it: the
 * WHERE names the `archivedAt` state being left, and Postgres re-evaluates it
 * after the row lock is released (the `claimPendingRequest` shape). Two
 * concurrent transitions serialize on the row lock; the loser matches zero
 * rows and returns the committed state as the idempotent no-op — so a
 * generation is born exactly once per real transition, and an
 * archive/unarchive burst can never overwrite its predecessor's generation
 * (which is what would lose a brief archive: the archive intent had to exist).
 * `count === 0` after the row was found is therefore "another transition got
 * there first", never a success to fabricate.
 *
 * Every transition — archive and unarchive alike — opens a new generation
 * (design §5: unarchive "opens a new one"; the archive's cancellation intent
 * for the generation it closed rides that generation's own rows, which stay
 * pending here no matter what follows).
 */
export async function transitionAppLifecycle(
  prisma: PrismaClient,
  opts: {
    appId: string;
    /** The slug, for the not-found message — the route's own wording. */
    slug: string;
    archive: boolean;
    /** The actor's display half (`actor.sub`) — audit attribution. */
    actor: string;
  },
): Promise<AppRow> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.app.updateMany({
      where: { id: opts.appId, archivedAt: opts.archive ? null : { not: null } },
      data: { archivedAt: opts.archive ? new Date() : null, jobsGeneration: { increment: 1 } },
    });
    // The row lock is held to commit, so this re-read cannot miss; the route's
    // pre-transaction lookup normally answers the 404 first — a null here is a
    // concurrent delete (no route does that today), refused loudly.
    const row = await tx.app.findUnique({ where: { id: opts.appId } });
    if (!row) throw new AppError("not_found", `app "${opts.slug}" not found`);
    if (count === 0) return row;
    const targets = await recordLifecycleIntents(tx, row.id, {
      generation: row.jobsGeneration,
      archived: opts.archive,
    });
    await tx.auditEvent.create({
      data: {
        appId: row.id,
        actor: opts.actor,
        action: opts.archive ? "app.archive" : "app.unarchive",
        // The generation the transition produced — the audit trail is where a
        // lifecycle change's place in the generation history is readable.
        metadata: { jobsGeneration: row.jobsGeneration, lifecycleTargets: targets },
      },
    });
    return row;
  });
}
