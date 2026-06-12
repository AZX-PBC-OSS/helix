import type { App as AppRow, PrismaClient } from "../db/client.js";

/** Audit actions that move the live pointer. */
export type PointerAction = "version.promote" | "version.rollback";

/**
 * Move an app's live pointer to `versionId` atomically: archive the current
 * live version, mark the target live, repoint `currentVersionId`, and audit.
 * Promote and rollback are the same operation differing only in how the target
 * is chosen (architecture §4.3: deploy/rollback = flip a pointer).
 */
export async function setLiveVersion(opts: {
  prisma: PrismaClient;
  appId: string;
  versionId: string;
  action: PointerAction;
  actor: string;
}): Promise<AppRow> {
  const { prisma, appId, versionId, action, actor } = opts;

  return prisma.$transaction(async (tx) => {
    const app = await tx.app.findUniqueOrThrow({ where: { id: appId } });

    if (app.currentVersionId && app.currentVersionId !== versionId) {
      await tx.version.update({
        where: { id: app.currentVersionId },
        data: { status: "archived" },
      });
    }

    await tx.version.update({ where: { id: versionId }, data: { status: "live" } });
    const updated = await tx.app.update({
      where: { id: appId },
      data: { currentVersionId: versionId },
    });

    await tx.auditEvent.create({ data: { appId, actor, action, metadata: { versionId } } });
    return updated;
  });
}
