import { createPrismaClient } from "../src/db/client.js";

/**
 * Fill missing collection user labels from retained sessions. Only null fields
 * are updated, so reruns preserve labels captured at write time.
 *
 * This excludes `gateway_calls`: the ledger is append-only by database grant
 * (ADR-0021), and the portal cannot update it. Old ledger rows retain their
 * original attribution. The portal does have UPDATE permission on collections.
 *
 * Recovery is limited to retained sessions: with an 8-hour TTL and deletion one
 * day after expiry, this usually covers at most about 32 hours of activity.
 * This is an optional maintenance script, not a migration.
 *
 * Prefer `sessions.userName` and `userEmail`. Use `displayName` only if it is
 * neither the principal id nor an email address. Fill name and email separately
 * so a recovered name does not prevent a later email recovery. Exclude password
 * sessions by `userKind`; a real directory principal can also start with `pw_`.
 *
 * Usage (from repo root):
 *   pnpm --filter @azx-pbc/portal db:backfill-user-labels -- --dry-run
 *   pnpm --filter @azx-pbc/portal db:backfill-user-labels
 */

/** Collections only — see the note above on why the ledger is excluded. */
const TABLES = ["app_collection_items"] as const;

function parseArgs(argv: string[]): { dryRun: boolean } {
  let dryRun = false;
  for (const arg of argv) {
    // pnpm forwards its own `--` separator into argv; it is not an argument.
    if (arg === "--") continue;
    if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}`);
  }
  return { dryRun };
}

async function main(): Promise<void> {
  const { dryRun } = parseArgs(process.argv.slice(2));
  const prisma = createPrismaClient();

  try {
    // ONE candidate set, shared by the preview and the write, so `--dry-run`
    // cannot claim work the real run will not do — the previous version counted
    // every unlabelled row rather than the ones that actually join to a session.
    const candidates = `
      SELECT DISTINCT ON ("userOid")
             "userOid",
             -- The captured claim first; displayName only as a fallback, and
             -- only when it is not an address (rule 1 in the header).
             COALESCE("userName",
                      CASE WHEN position('@' in "displayName") = 0 THEN "displayName" END) AS name,
             "userEmail" AS email,
             "userKind"  AS kind
        FROM sessions
       WHERE "displayName" <> "userOid"
         AND "userKind" IS DISTINCT FROM 'password'
       ORDER BY "userOid", "createdAt" DESC`;

    for (const table of TABLES) {
      // A row is recoverable when the session can supply something it lacks —
      // any of the three columns, not just the name.
      const fillable = `
             (t."userName"  IS NULL AND s.name  IS NOT NULL)
          OR (t."userEmail" IS NULL AND s.email IS NOT NULL)
          OR (t."userKind"  IS NULL AND s.kind  IS NOT NULL)`;

      const [{ count: matches }] = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*) AS count
           FROM "${table}" t
           JOIN (${candidates}) s ON t."userOid" = s."userOid"
          WHERE ${fillable}`,
      );

      if (dryRun) {
        console.log(`  ${table}: ${matches} row(s) recoverable — no writes made (--dry-run).`);
        continue;
      }

      const updated = await prisma.$executeRawUnsafe(
        `UPDATE "${table}" t
            SET "userName"  = COALESCE(t."userName",  s.name),
                "userEmail" = COALESCE(t."userEmail", s.email),
                "userKind"  = COALESCE(t."userKind",  s.kind)
           FROM (${candidates}) s
          WHERE t."userOid" = s."userOid"
            AND (${fillable})`,
      );
      console.log(`  ${table}: filled ${updated} of ${matches} recoverable row(s).`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
