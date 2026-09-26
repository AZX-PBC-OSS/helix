import type { FastifyInstance } from "fastify";
import {
  ApprovalDecisionRequestSchema,
  applyDeltas,
  isProviderBindingEffective,
  snapshotConflicts,
  summarizePriorDecisions,
  type Delta,
  type PriorDecisionRow,
} from "@azx-pbc/shared";
import {
  actorIsAdmin,
  authenticate,
  canSelfApprove,
  requireActor,
  requireAdmin,
  type Actor,
} from "../plugins/auth.js";
import { AppError } from "../plugins/errors.js";
import { publicAppsAllowed } from "../policy/visibilityPolicy.js";
import { casPolicyWrite } from "../policy/policyWrite.js";
import { Prisma } from "../db/client.js";
import { capabilitiesFromRow, toApprovalRequest } from "../db/mappers.js";
import { alreadyDecided, claimPendingRequest } from "../approvals/service.js";

/**
 * Fetch the decided (non-pending) approval requests for a set of apps, newest
 * decision first, grouped by `appId`. Feeds {@link summarizePriorDecisions} so
 * the admin queue can flag a refiled grant that was already refused (issue #26).
 * One batched query over the `appId` index — no per-row N+1.
 */
async function priorDecisionsByApp(
  app: FastifyInstance,
  appIds: string[],
): Promise<Map<string, PriorDecisionRow[]>> {
  const byApp = new Map<string, PriorDecisionRow[]>();
  const ids = [...new Set(appIds)];
  if (ids.length === 0) return byApp;

  const decided = await app.prisma.approvalRequest.findMany({
    where: { appId: { in: ids }, status: { not: "pending" }, decidedAt: { not: null } },
    orderBy: { decidedAt: "desc" },
    select: {
      appId: true,
      status: true,
      deltas: true,
      decisionNote: true,
      decidedBy: true,
      decidedAt: true,
    },
  });

  for (const row of decided) {
    const list = byApp.get(row.appId) ?? [];
    list.push({
      status: row.status as PriorDecisionRow["status"],
      deltas: row.deltas as unknown as Delta[],
      decisionNote: row.decisionNote,
      decidedBy: row.decidedBy,
      // `decidedAt` is non-null here (filtered above); serialize to the wire shape.
      decidedAt: (row.decidedAt as Date).toISOString(),
    });
    byApp.set(row.appId, list);
  }
  return byApp;
}

/**
 * Approvals control-plane API (docs/design/approvals.md §5). Reads serve the
 * admin queue and the per-app "pending" banner; the decision endpoints apply or
 * close a request. Applying an approval is an `apps` UPDATE in one txn — the edge
 * picks the new effective state up via its registry projection and never learns
 * an approval happened (it has no grant on `approval_requests`).
 *
 * Every decision path compare-and-swaps the `pending → terminal` transition
 * (`claimPendingRequest`) rather than branching on a status it read earlier, and
 * the `apps` write is CAS'd on `policyVersion`. Both are load-bearing: see §5 and
 * the comments on those two helpers.
 */

/**
 * The statuses an approve call can legitimately have produced. `needs_changes` is
 * in here because the stale-snapshot branch below lands it and answers 200 — so a
 * replay of that same call must be a no-op, not a 409 blaming another actor for a
 * decision this caller made.
 */
const APPROVE_LANDED = ["approved", "needs_changes"] as const;

/**
 * Separation-of-duty gate for the decide paths (approve/deny/needs_changes,
 * §4): the deciding admin must not be the requester, unless the dev
 * self-approve flag is set.
 *
 * The comparison is on the **identity halves** — `actor.oid` vs
 * `requestedOid` (ADR-0048, review finding 3). The display halves (`sub`,
 * usually the email) are pairwise per client id under Entra, so comparing
 * them let an admin file a request from the CLI (`azx-cli`) and approve it
 * from the SPA (`azx-portal-web`): two different subs, one human, guard
 * silently disarmed.
 *
 * A pre-re-base row carries a null `requestedOid` and **fails closed** — it
 * cannot certify separation of duty at all. The cutover runbook's step-3
 * rewrite fills `requestedOid` from the same email→oid pairs as
 * `apps.ownerId`, which unfreezes these requests; an operator can also
 * simply wait them out (a pending request is inert).
 */
function assertSeparationOfDuty(
  request: { requestedOid: string | null; requestedBy: string },
  actor: Actor,
  canSelfApprove: boolean,
): void {
  if (request.requestedOid === null) {
    throw new AppError(
      "forbidden",
      "this pre-re-base request cannot be decided: separation of duty cannot be " +
        "certified without the requester's oid — run the principal-rebase cutover " +
        "rewrite (docs/runbooks/principal-rebase-cutover.md, step 3) to unfreeze it",
    );
  }
  if (request.requestedOid === actor.oid && !canSelfApprove) {
    throw new AppError(
      "forbidden",
      "deciding your own request is not permitted (separation of duty)",
    );
  }
}

/**
 * The apply-time provider conflict (T-0009, ADR-0004): a provider-bound
 * request's stamps were recorded at filing, and approving after the provider
 * moved on — a sensitive edit advanced the revision, or the row was deleted —
 * would approve access to a configuration nobody reviewed. The rule itself is
 * {@link isProviderBindingEffective}, the one definition the manifest read and
 * the consult also consume.
 *
 * Throws a conflict the caller surfaces as a 409; throwing inside the
 * transaction approves nothing and leaves the request pending for the owner to
 * withdraw or resubmit (a fresh manifest save files a fresh stamp).
 */
async function assertProviderStampsCurrent(
  tx: Prisma.TransactionClient,
  request: { deltas: unknown },
): Promise<void> {
  const stamps = (request.deltas as unknown as Delta[]).flatMap((d) => d.providerStamps ?? []);
  if (stamps.length === 0) return;
  const rows = await tx.connectionProvider.findMany({
    where: { id: { in: stamps.map((s) => s.providerId) } },
    select: { id: true, ref: true, revision: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const stamp of stamps) {
    if (!isProviderBindingEffective(stamp, byId.get(stamp.providerId))) {
      throw new AppError(
        "conflict",
        "the provider changed after this request was filed — the app owner must resubmit",
        { ref: stamp.ref, env: stamp.env },
      );
    }
  }
}

export async function approvalRoutes(app: FastifyInstance): Promise<void> {
  // List requests. `?app=<slug>` scopes to one app (owner or admin); without it
  // the global admin queue (admin only). `?status=` filters by lifecycle state.
  app.get<{ Querystring: { app?: string; status?: string } }>(
    "/api/v1/approvals",
    { preHandler: authenticate },
    async (req) => {
      const actor = requireActor(req);
      const status = req.query.status;
      const where: Prisma.ApprovalRequestWhereInput = {};
      if (status) where.status = status;

      if (req.query.app) {
        const row = await app.prisma.app.findUnique({ where: { slug: req.query.app } });
        if (!row) throw new AppError("not_found", `app "${req.query.app}" not found`);
        // Owners see their own app's requests; admins see any.
        if (row.ownerId !== actor.oid && !actorIsAdmin(actor)) {
          throw new AppError("forbidden", "not the app owner");
        }
        where.appId = row.id;
        const rows = await app.prisma.approvalRequest.findMany({
          where,
          orderBy: { createdAt: "desc" },
        });
        return rows.map((r) =>
          toApprovalRequest(r, { slug: row.slug, displayName: row.displayName }),
        );
      }

      // Global queue.
      requireAdmin(req);
      const rows = await app.prisma.approvalRequest.findMany({
        where,
        orderBy: { createdAt: "desc" },
        include: { app: { select: { slug: true, displayName: true } } },
      });

      // Enrich each row with prior-decision context on its app (issue #26): a
      // refiled request is otherwise indistinguishable from a first-time one.
      // One batched query over the queue's apps (uses the `appId` index), grouped
      // in memory — read-side only, nothing stored. See summarizePriorDecisions.
      const priorByApp = await priorDecisionsByApp(
        app,
        rows.map((r) => r.appId),
      );
      return rows.map((r) =>
        toApprovalRequest(
          r,
          r.app,
          summarizePriorDecisions(r.deltas as unknown as Delta[], priorByApp.get(r.appId) ?? []),
        ),
      );
    },
  );

  // Approve: re-check conflicts, apply the elevated deltas to the `apps` row, and
  // close the request — all in one transaction (§2 apply-on-approve).
  app.post<{ Params: { id: string } }>(
    "/api/v1/approvals/:id/approve",
    { preHandler: authenticate },
    async (req) => {
      const actor = requireAdmin(req);

      const result = await app.prisma.$transaction(async (tx) => {
        const request = await tx.approvalRequest.findUnique({ where: { id: req.params.id } });
        if (!request)
          throw new AppError("not_found", `approval request "${req.params.id}" not found`);
        // A second click on an already-approved request is the documented no-op;
        // any other landed status is a 409 (§5). This read is only a fast path —
        // `status` is the one mutable field the branches below depend on, and the
        // claim below is what actually gates the write. Every other field they
        // read (`requestedBy`, `deltas`, `baseSnapshot`) is immutable once filed.
        if (request.status !== "pending") return { row: alreadyDecided(request, APPROVE_LANDED) };

        // Separation of duty: an admin may not decide their own request unless
        // the dev self-approve flag is set (§4). Identity halves, per
        // assertSeparationOfDuty.
        assertSeparationOfDuty(request, actor, canSelfApprove());

        // A provider-bound request filed against a configuration that has since
        // moved (sensitive edit or delete) approves nothing — checked before the
        // snapshot bounce, which would otherwise close a request that must
        // resubmit against the provider, not the manifest state.
        await assertProviderStampsCurrent(tx, request);

        const appRow = await tx.app.findUniqueOrThrow({ where: { id: request.appId } });
        const effective = capabilitiesFromRow(appRow);
        const deltas = request.deltas as unknown as Delta[];

        // Optimistic concurrency: if a touched value moved since the request was
        // filed, bounce to needs_changes rather than clobber it (§5).
        if (
          snapshotConflicts(request.baseSnapshot, effective, {
            mode: appRow.visibilityMode,
            groupIds: appRow.visibilityGroupIds,
          })
        ) {
          const claim = await claimPendingRequest(tx, request.id, {
            status: "needs_changes",
            decidedBy: actor.sub,
            decidedAt: new Date(),
            decisionNote: "auto: effective state changed since this request was filed",
          });
          if (!claim.claimed) return { row: alreadyDecided(claim.row, APPROVE_LANDED) };
          const row = claim.row;
          await tx.auditEvent.create({
            data: {
              appId: request.appId,
              actor: actor.sub,
              action: "approval.needs_changes",
              metadata: { requestId: request.id, reason: "stale_snapshot" },
            },
          });
          return { row };
        }

        // Claim the transition BEFORE touching the `apps` row. A withdraw or deny
        // that landed while this transaction was reading takes the request out of
        // `pending`, and the elevated deltas must not be applied to an app whose
        // request was closed by someone else (issue #24). The status transition is
        // what gates the effective-state write — not the read above it.
        const claim = await claimPendingRequest(tx, request.id, {
          status: "approved",
          decidedBy: actor.sub,
          decidedAt: new Date(),
        });
        if (!claim.claimed) return { row: alreadyDecided(claim.row, APPROVE_LANDED) };
        const row = claim.row;

        // Apply: capability deltas → capabilities JSON; a visibility delta (only
        // → public reaches here) → the flat columns.
        const capDeltas = deltas.filter((d) => d.path !== "visibility");
        const visDelta = deltas.find((d) => d.path === "visibility");
        const data: Prisma.AppUpdateManyMutationInput = {};
        if (capDeltas.length > 0) {
          data.capabilities = applyDeltas(effective, capDeltas) as unknown as Prisma.InputJsonValue;
        }
        if (visDelta && visDelta.to === "public") {
          // Defense in depth: an approval filed before public was disabled must
          // not commit now. Throwing rolls back the transaction (no partial apply).
          if (!publicAppsAllowed()) {
            throw new AppError("forbidden", "public apps are disabled on this deployment");
          }
          data.visibilityMode = "public";
          data.visibilityGroupIds = [];
        }
        // CAS on the version read above: a baseline write that commits between
        // that read and this one would otherwise be clobbered by this full-blob
        // write. `baseSnapshot` does not cover it — it compares only the areas the
        // request touched, and it was captured when the request was filed.
        //
        // Guarded on there being something to write, like the sibling path in
        // approvals/service.ts. No delta shape reaches here empty today, but an
        // empty CAS would bump `policyVersion`, force a full projection reload for
        // nothing, and 409 an unrelated writer.
        if (Object.keys(data).length > 0) {
          await casPolicyWrite(
            tx,
            appRow,
            data,
            "the app's policy changed while this approval was being applied — retry",
          );
        }

        // Two audit events: the effective mutation(s) + the approval decision.
        if (capDeltas.length > 0) {
          await tx.auditEvent.create({
            data: {
              appId: appRow.id,
              actor: actor.sub,
              action: "app.manifest.set",
              metadata: { applied: capDeltas as unknown as Prisma.InputJsonValue },
            },
          });
        }
        if (visDelta) {
          await tx.auditEvent.create({
            data: {
              appId: appRow.id,
              actor: actor.sub,
              action: "app.visibility.set",
              metadata: { applied: [visDelta] as unknown as Prisma.InputJsonValue },
            },
          });
        }
        await tx.auditEvent.create({
          data: {
            appId: appRow.id,
            actor: actor.sub,
            action: "approval.approve",
            metadata: { requestId: request.id },
          },
        });
        return { row };
      });

      return toApprovalRequest(result.row);
    },
  );

  // Deny / request-changes: close (or bounce) a pending request. A note is
  // required (§5). Admin + separation-of-duty.
  for (const [suffix, status, action] of [
    ["deny", "denied", "approval.deny"],
    ["needs_changes", "needs_changes", "approval.needs_changes"],
  ] as const) {
    app.post<{ Params: { id: string } }>(
      `/api/v1/approvals/:id/${suffix}`,
      { preHandler: authenticate },
      async (req) => {
        const actor = requireAdmin(req);
        const { note } = ApprovalDecisionRequestSchema.parse(req.body ?? {});
        if (!note) throw new AppError("validation_failed", `a note is required to ${suffix}`);

        const row = await app.prisma.$transaction(async (tx) => {
          const request = await tx.approvalRequest.findUnique({ where: { id: req.params.id } });
          if (!request)
            throw new AppError("not_found", `approval request "${req.params.id}" not found`);
          if (request.status !== "pending") return alreadyDecided(request, [status]);
          // Identity halves, per assertSeparationOfDuty.
          assertSeparationOfDuty(request, actor, canSelfApprove());
          const claim = await claimPendingRequest(tx, request.id, {
            status,
            decidedBy: actor.sub,
            decidedAt: new Date(),
            decisionNote: note,
          });
          if (!claim.claimed) return alreadyDecided(claim.row, [status]);
          const updated = claim.row;
          await tx.auditEvent.create({
            data: {
              appId: request.appId,
              actor: actor.sub,
              action,
              metadata: { requestId: request.id },
            },
          });
          return updated;
        });
        return toApprovalRequest(row);
      },
    );
  }

  // Withdraw: the requester cancels their own pending request (§5).
  app.post<{ Params: { id: string } }>(
    "/api/v1/approvals/:id/withdraw",
    { preHandler: authenticate },
    async (req) => {
      const actor = requireActor(req);
      const row = await app.prisma.$transaction(async (tx) => {
        const request = await tx.approvalRequest.findUnique({ where: { id: req.params.id } });
        if (!request)
          throw new AppError("not_found", `approval request "${req.params.id}" not found`);
        // `requestedOid` never changes, so gating on this read is sound. The
        // identity halves (ADR-0048, review finding 3): under Entra the
        // display `sub` is pairwise per client, so a requester who filed from
        // the CLI and opens the SPA would otherwise be refused the withdraw
        // of their own request. Null (a pre-re-base row) fails closed with
        // the same unfreeze pointer as the decide paths.
        if (request.requestedOid === null) {
          throw new AppError(
            "forbidden",
            "this pre-re-base request cannot be withdrawn: the requester cannot be " +
              "certified without their oid — run the principal-rebase cutover " +
              "rewrite (docs/runbooks/principal-rebase-cutover.md, step 3) to unfreeze it",
          );
        }
        if (request.requestedOid !== actor.oid) {
          throw new AppError("forbidden", "only the requester may withdraw a request");
        }
        if (request.status !== "pending") return alreadyDecided(request, ["withdrawn"]);
        const claim = await claimPendingRequest(tx, request.id, {
          status: "withdrawn",
          decidedBy: actor.sub,
          decidedAt: new Date(),
        });
        // The case issue #24 is about: an approve that committed while this
        // transaction was reading has already applied the deltas, so overwriting
        // the status here would advertise a withdrawal that did not happen.
        if (!claim.claimed) return alreadyDecided(claim.row, ["withdrawn"]);
        const updated = claim.row;
        await tx.auditEvent.create({
          data: {
            appId: request.appId,
            actor: actor.sub,
            action: "approval.withdraw",
            metadata: { requestId: request.id },
          },
        });
        return updated;
      });
      return toApprovalRequest(row);
    },
  );
}
