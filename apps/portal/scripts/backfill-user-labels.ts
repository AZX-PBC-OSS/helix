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
 * this can name users active since yesterday, and no one else. It also recovers
 * only the *name* half — `sessions.userEmail` is null on every row that predates
 * the same migration. Run it by hand if recent history matters; skip it happily.
 *
 * Two exclusions are load-bearing (see the WHERE below): a `displayName` equal to
 * the `userOid` is the old capture-time fallback to `claims.sub` — copying it
 * forward would poison the new column with the exact bug the column exists to
 * fix — and `pw_*` principals carry the platform-minted label "Guest", which
 * would render as though it named someone.
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
    const [{ count: recoverable }] = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(DISTINCT "userOid") AS count FROM sessions
       WHERE "displayName" <> "userOid" AND "userOid" NOT LIKE 'pw\\_%'`;
    console.log(`${recoverable} principal(s) nameable from surviving sessions.`);

    for (const table of TABLES) {
      const [{ count: pending }] = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*) AS count FROM "${table}"
          WHERE "userName" IS NULL AND "userOid" IS NOT NULL`,
      );

      if (dryRun) {
        console.log(`  ${table}: ${pending} unlabelled row(s) — no writes made (--dry-run).`);
        continue;
      }

      // DISTINCT ON takes the newest capture per principal. `userName IS NULL`
      // in the outer WHERE means a label written at call time always wins.
      const updated = await prisma.$executeRawUnsafe(
        `UPDATE "${table}" t
            SET "userName" = s."displayName"
           FROM (SELECT DISTINCT ON ("userOid") "userOid", "displayName"
                   FROM sessions
                  WHERE "displayName" <> "userOid"
                    AND "userOid" NOT LIKE 'pw\\_%'
                  ORDER BY "userOid", "createdAt" DESC) s
          WHERE t."userOid" = s."userOid" AND t."userName" IS NULL`,
      );
      console.log(`  ${table}: labelled ${updated} of ${pending} unlabelled row(s).`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
