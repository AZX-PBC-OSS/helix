import { createPrismaClient } from "../src/db/client.js";

/**
 * Recover a display half for collection rows written before the
 * `userName`/`userEmail` columns existed.
 *
 * Those rows carry only `userOid` — Entra's pairwise `sub`, which resolves to
 * nobody — so the portal renders them as an opaque string. The only id→name map
 * the platform has ever held is the `sessions` table, and this copies what is
 * left of it onto the rows it can reach.
 *
 * **`gateway_calls` is deliberately NOT covered, and cannot be.** The ledger is
 * append-only *by grant*: `helix_edge` holds INSERT (plus SELECT for budget
 * sums) and `helix_portal` was explicitly REVOKEd from INSERT/UPDATE/DELETE
 * (migration 20260721120000, ADR-0021), so this script gets `permission denied`
 * there — as it should. Integrity resting on the grant set is the property that
 * makes an audit row trustworthy; a maintenance script that could retroactively
 * edit attributions on the audit log would be the thing that destroys it. Old
 * ledger rows keep rendering their raw `userOid`, which is the honest outcome:
 * nobody captured a label at the time, and inventing one later is not a repair.
 *
 * Collections are different in kind — an owner's own submitted data, which the
 * portal already lets them export and delete — so `helix_portal` holds UPDATE
 * there and filling a null label is ordinary maintenance.
 *
 * **It still reaches very little, by design, and that is why this is a script and
 * not a migration.** `session_sweep()` deletes sessions at `expiresAt < now() -
 * 1 day` against an 8 h TTL, so the table holds at most ~32 hours of principals:
 * this can name users active since yesterday, and no one else. Run it by hand if
 * recent history matters; skip it happily.
 *
 * Three rules in the SQL below are load-bearing, and each is a way an earlier
 * version of this script got it wrong:
 *
 *  1. **Read `sessions.userName`/`userEmail` first.** Inverting `displayName` is
 *     what the first version did, because it was written before those columns
 *     existed — one file over, on the same branch. `displayName` is
 *     `name ?? email ?? sub`, so for a tenant that sends no `name` it IS the
 *     address: the script copied `dana@azx.dev` into `userName` and left
 *     `userEmail` null, *with the address sitting in the session row beside it*.
 *     The `position('@' ...)` test keeps a non-claim out of the name column,
 *     preserving on the maintenance path the invariant `captureEmail` protects
 *     on the capture path.
 *  2. **Fill both halves, guarded on either being null.** Guarding on `userName`
 *     alone meant that once a row was named, a later run skipped it entirely and
 *     the email could never be recovered — permanent, after one run.
 *  3. **Exclude password principals by `userKind`, not by a `pw_` prefix.** Entra
 *     subjects share base64url's alphabet with that prefix, so a shape test also
 *     excludes roughly one real principal in 262,144 from recovery.
 *
 * A `displayName` equal to the `userOid` is still skipped: that is the old
 * capture-time fallback to `claims.sub`, and copying it forward would write the
 * opaque subject into a label column — the exact defect the columns exist to fix.
 *
 * Only ever fills nulls, so it is safe to re-run and can never overwrite a label
 * captured properly at write time.
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
