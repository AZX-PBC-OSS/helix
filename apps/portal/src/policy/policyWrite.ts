import { Prisma, type App as AppRow } from "../db/client.js";
import { AppError } from "../plugins/errors.js";

/**
 * Compare-and-swap over an app's **effective policy state** — the `capabilities`
 * blob plus `visibilityMode`/`visibilityGroupId` (docs/design/approvals.md §5).
 *
 * Those columns are read-modify-written, and `capabilities` is replaced whole. A
 * plain `update` by id therefore makes concurrent policy writes last-write-wins:
 * a manifest PUT, a one-click origin grant, and an apply-on-approve that each
 * computed from the same pre-image silently discard each other's deltas, and the
 * loser is told 200 for a value that is not what is stored. Under READ COMMITTED
 * re-reading inside the transaction is not enough on its own — the other writer
 * can still commit between the read and the write — so the version read has to be
 * part of the WHERE. Postgres re-evaluates it after the row lock is released, so
 * exactly one writer matches.
 *
 * The invariant, and it is the whole point of the column: **every path that reads
 * any of those three columns and writes them back goes through here, inside the
 * same transaction as the read.**
 */
export async function casPolicyWrite(
  tx: Prisma.TransactionClient,
  row: { id: string; policyVersion: number },
  data: Prisma.AppUpdateManyMutationInput,
  conflictMessage = "this app's policy changed while you were editing it — reload and try again",
): Promise<AppRow> {
  const { count } = await tx.app.updateMany({
    where: { id: row.id, policyVersion: row.policyVersion },
    data: { ...data, policyVersion: { increment: 1 } },
  });
  if (count === 0) throw new AppError("conflict", conflictMessage);
  // updateMany returns a count, not the row (same shape as the secret-rotation
  // CAS in routes/secrets.ts). We hold the row lock, so this cannot miss.
  return tx.app.findUniqueOrThrow({ where: { id: row.id } });
}
