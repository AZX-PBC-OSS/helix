import {
  applyDeltas,
  captureSnapshot,
  classifyChange,
  touchedAreas,
  type Capabilities,
  type Delta,
  type ManifestUpdateResult,
  type Risk,
} from "@azx-pbc/shared";
import {
  Prisma,
  type ApprovalRequest as ApprovalRequestRow,
  type PrismaClient,
} from "../db/client.js";
import { capabilitiesFromRow, toManifest } from "../db/mappers.js";
import { AppError } from "../plugins/errors.js";
import { casPolicyWrite } from "../policy/policyWrite.js";

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
 * Compare-and-swap the `pending → terminal` transition (docs/design/approvals.md §5).
 *
 * The status check has to *be* the write. Read-then-branch inside a READ COMMITTED
 * transaction is not a guard: two decisions both read `pending`, and `update` by id
 * re-checks only `id`, so the later one overwrites the earlier's status. On approve
 * that left the request `withdrawn` while the capability it granted stayed live on
 * the `apps` row — the request row said the grant was pulled and the edge served it
 * anyway (issue #24). Guarding on `status` here means the loser matches zero rows:
 * Postgres re-evaluates the WHERE after the row lock is released.
 *
 * `claimed === false` means another decision landed first, and the caller must apply
 * nothing. Callers pass that row to {@link alreadyDecided}.
 */
export type Claim =
  | { claimed: true; row: ApprovalRequestRow }
  | { claimed: false; row: ApprovalRequestRow | null };

export async function claimPendingRequest(
  tx: Tx,
  id: string,
  data: Prisma.ApprovalRequestUpdateManyMutationInput,
): Promise<Claim> {
  const { count } = await tx.approvalRequest.updateMany({
    where: { id, status: "pending" },
    data,
  });
  // updateMany returns a count, not the row — same shape as the secret-rotation
  // CAS in routes/secrets.ts. On the winning path the row lock is held, so the
  // re-read cannot miss; on the losing path it returns whoever won.
  const row = await tx.approvalRequest.findUnique({ where: { id } });
  if (count === 1) {
    if (!row) throw new AppError("not_found", `approval request "${id}" not found`);
    return { claimed: true, row };
  }
  return { claimed: false, row };
}

/**
 * Resolve a request that is already decided. Repeating a decision that already
 * landed stays the documented idempotent no-op (§5) — a second click must not be
 * an error. A *different* outcome is a 409: the caller asked for a transition that
 * did not happen, and answering 200 would tell them the opposite of what is stored.
 *
 * `landed` is every status the calling route can legitimately have produced, not
 * just the one it asked for. Approve is the reason it is a set: a stale request
 * bounces to `needs_changes` and answers 200, so replaying that same call — a
 * client timeout, a double-click — has to be a no-op too. Answering 409 there
 * would report a conflict against a decision the caller itself made.
 */
export function alreadyDecided(
  row: ApprovalRequestRow | null,
  landed: readonly string[],
): ApprovalRequestRow {
  if (!row) throw new AppError("not_found", "approval request not found");
  if (landed.includes(row.status)) return row;
  throw new AppError(
    "conflict",
    `approval request "${row.id}" was already ${row.status} — re-read it and retry`,
    { status: row.status },
  );
}

/**
 * The capability write-gate (docs/design/approvals.md §3): split a requested
 * capability change into baseline deltas (committed now) and elevated deltas
 * (bundled into one pending request), in a single transaction. Shared by the
 * manifest PUT and the one-click origin-grant route.
 *
 * `mutate` receives the effective capabilities **as read inside the transaction**,
 * which is what makes a relative change (the origin grant's array append) land on
 * the committed value rather than on a pre-image the route read earlier. A write
 * that does change the blob then CASes on `policyVersion`, so a concurrent writer
 * cannot be clobbered; an elevated-only change writes nothing at all.
 */
export async function applyCapabilityChange(
  prisma: PrismaClient,
  opts: {
    appId: string;
    mutate: (effective: Capabilities) => Capabilities;
    actor: string;
    reason?: string;
  },
): Promise<ManifestUpdateResult> {
  const { updated, pending, baselineDeltas } = await prisma.$transaction(async (tx) => {
    const row = await tx.app.findUniqueOrThrow({ where: { id: opts.appId } });
    const effective = capabilitiesFromRow(row);
    const { baselineDeltas, elevatedDeltas, risk } = classifyChange(
      effective,
      opts.mutate(effective),
    );
    // Apply only the baseline deltas now; elevated ones wait for approval.
    const applied = applyDeltas(effective, baselineDeltas);

    // Only write when something actually changes. With no baseline deltas `applied`
    // *is* `effective`, and writing it back would CAS — turning two elevated-only
    // requests (say two origin grants filed off the Violations screen) into a
    // conflict over a value neither of them is changing.
    let updated = row;
    if (baselineDeltas.length > 0) {
      updated = await casPolicyWrite(tx, row, {
        capabilities: applied as unknown as Prisma.InputJsonValue,
      });
      await tx.auditEvent.create({
        data: {
          appId: row.id,
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
        row.visibilityMode,
        touchedAreas(elevatedDeltas),
      );
      pending = await createApprovalRequest(tx, {
        appId: row.id,
        deltas: elevatedDeltas,
        risk,
        baseSnapshot,
        requestedBy: opts.actor,
        reason: opts.reason,
      });
    }
    return { updated, pending, baselineDeltas };
  });

  return { manifest: toManifest(updated), applied: baselineDeltas, pending };
}
