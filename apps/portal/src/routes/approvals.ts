import type { FastifyInstance } from "fastify";
import {
  ApprovalDecisionRequestSchema,
  applyDeltas,
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
} from "../plugins/auth.js";
import { AppError } from "../plugins/errors.js";
import { publicAppsAllowed } from "../policy/visibilityPolicy.js";
import { Prisma } from "../db/client.js";
import { capabilitiesFromRow, toApprovalRequest } from "../db/mappers.js";

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
 */
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
        if (row.ownerId !== actor.sub && !actorIsAdmin(actor)) {
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
        // Idempotent: a second click on an already-decided request is a no-op.
        if (request.status !== "pending") return { row: request };

        // Separation of duty: an admin may not decide their own request unless
        // the dev self-approve flag is set (§4).
        if (request.requestedBy === actor.sub && !canSelfApprove()) {
          throw new AppError("forbidden", "self-approval is not permitted (separation of duty)");
        }

        const appRow = await tx.app.findUniqueOrThrow({ where: { id: request.appId } });
        const effective = capabilitiesFromRow(appRow);
        const deltas = request.deltas as unknown as Delta[];

        // Optimistic concurrency: if a touched value moved since the request was
        // filed, bounce to needs_changes rather than clobber it (§5).
        if (snapshotConflicts(request.baseSnapshot, effective, appRow.visibilityMode)) {
          const row = await tx.approvalRequest.update({
            where: { id: request.id },
            data: {
              status: "needs_changes",
              decidedBy: actor.sub,
              decidedAt: new Date(),
              decisionNote: "auto: effective state changed since this request was filed",
            },
          });
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

        // Apply: capability deltas → capabilities JSON; a visibility delta (only
        // → public reaches here) → the flat columns.
        const capDeltas = deltas.filter((d) => d.path !== "visibility");
        const visDelta = deltas.find((d) => d.path === "visibility");
        const data: Prisma.AppUpdateInput = {};
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
          data.visibilityGroupId = null;
        }
        await tx.app.update({ where: { id: appRow.id }, data });

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
        const row = await tx.approvalRequest.update({
          where: { id: request.id },
          data: { status: "approved", decidedBy: actor.sub, decidedAt: new Date() },
        });
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
          if (request.status !== "pending") return request;
          if (request.requestedBy === actor.sub && !canSelfApprove()) {
            throw new AppError(
              "forbidden",
              "deciding your own request is not permitted (separation of duty)",
            );
          }
          const updated = await tx.approvalRequest.update({
            where: { id: request.id },
            data: { status, decidedBy: actor.sub, decidedAt: new Date(), decisionNote: note },
          });
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
        if (request.requestedBy !== actor.sub) {
          throw new AppError("forbidden", "only the requester may withdraw a request");
        }
        if (request.status !== "pending") return request;
        const updated = await tx.approvalRequest.update({
          where: { id: request.id },
          data: { status: "withdrawn", decidedBy: actor.sub, decidedAt: new Date() },
        });
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
