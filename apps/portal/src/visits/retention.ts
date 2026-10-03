import type { PrismaClient } from "../db/client.js";

/**
 * How long a visit row lives (ADR-0050): the longest selectable range (90 days)
 * plus the prior window it is compared against.
 */
export const VISIT_RETENTION_DAYS = 180;

/** How often the sweep runs. Hourly keeps each delete small. */
export const VISIT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Delete visits older than the retention window; returns the rows removed. */
export async function sweepExpiredVisits(
  prisma: PrismaClient,
  retentionDays = VISIT_RETENTION_DAYS,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const { count } = await prisma.appVisit.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return count;
}
