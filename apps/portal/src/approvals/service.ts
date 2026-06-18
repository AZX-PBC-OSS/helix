import {
  applyDeltas,
  captureSnapshot,
  classifyChange,
  touchedAreas,
  type Capabilities,
  type Delta,
  type ManifestUpdateResult,
  type Risk,
} from "@helix/shared";
import { Prisma, type App as AppRow, type PrismaClient } from "../db/client.js";
import { capabilitiesFromRow, toManifest } from "../db/mappers.js";

/**
 * Shared approvals plumbing (docs/design/approvals.md §2). The write-gate routes
 * (manifest, visibility, origin-grant) open requests; the approvals route
 * applies them. Both go through this module so the row shape and the paired
 * audit events stay in lockstep.
 *
 * Every function takes a Prisma transaction client so the request row and its
 * audit event commit atomically with the surrounding effective-state write.
 */
export type Tx = Prisma.TransactionClient;

export interface OpenRequestArgs {
  appId: string;
  /** The elevated subset of a change (baseline deltas commit separately). */
  deltas: Delta[];
  risk: Risk;
  /** Effective values of the touched areas at request time (conflict detect). */
  baseSnapshot: Record<string, unknown>;
  requestedBy: string;
  reason?: string;
}

/** Insert a pending request + its `approval.request` audit event. Returns the id. */
export async function createApprovalRequest(tx: Tx, args: OpenRequestArgs): Promise<string> {
  const created = await tx.approvalRequest.create({
    data: {
      appId: args.appId,
      status: "pending",
      risk: args.risk,
      deltas: args.deltas as unknown as Prisma.InputJsonValue,
      baseSnapshot: args.baseSnapshot as Prisma.InputJsonValue,
      requestedBy: args.requestedBy,
      reason: args.reason ?? null,
    },
  });
  await tx.auditEvent.create({
    data: {
      appId: args.appId,
      actor: args.requestedBy,
      action: "approval.request",
      metadata: {
        requestId: created.id,
        risk: args.risk,
        deltas: args.deltas as unknown as Prisma.InputJsonValue,
      },
    },
  });
  return created.id;
}

/**
 * The capability write-gate (docs/design/approvals.md §3): split a requested
 * capability change into baseline deltas (committed now) and elevated deltas
 * (bundled into one pending request), in a single transaction. Shared by the
 * manifest PUT and the one-click origin-grant route.
 */
export async function applyCapabilityChange(
  prisma: PrismaClient,
  opts: { row: AppRow; requested: Capabilities; actor: string; reason?: string },
): Promise<ManifestUpdateResult> {
  const effective = capabilitiesFromRow(opts.row);
  const { baselineDeltas, elevatedDeltas, risk } = classifyChange(effective, opts.requested);
  // Apply only the baseline deltas now; elevated ones wait for approval.
  const applied = applyDeltas(effective, baselineDeltas);

  const { updated, pending } = await prisma.$transaction(async (tx) => {
    const updated = await tx.app.update({
      where: { id: opts.row.id },
      data: { capabilities: applied as unknown as Prisma.InputJsonValue },
    });
    if (baselineDeltas.length > 0) {
      await tx.auditEvent.create({
        data: {
          appId: opts.row.id,
          actor: opts.actor,
          action: "app.manifest.set",
          metadata: { applied: baselineDeltas as unknown as Prisma.InputJsonValue },
        },
      });
    }
    let pending: string | null = null;
    if (elevatedDeltas.length > 0) {
      // Snapshot the post-baseline state of the touched areas so a later approve
      // can detect a value that moved underneath the request.
      const baseSnapshot = captureSnapshot(
        applied,
        opts.row.visibilityMode,
        touchedAreas(elevatedDeltas),
      );
      pending = await createApprovalRequest(tx, {
        appId: opts.row.id,
        deltas: elevatedDeltas,
        risk,
        baseSnapshot,
        requestedBy: opts.actor,
        reason: opts.reason,
      });
    }
    return { updated, pending };
  });

  return { manifest: toManifest(updated), applied: baselineDeltas, pending };
}
