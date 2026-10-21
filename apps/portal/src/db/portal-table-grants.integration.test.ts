import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

/**
 * Every platform table the control plane works on must be reachable by
 * `helix_portal` from the migrations alone. The dev `helix` database also
 * carries a blanket default-privilege grant (02-portal-bootstrap-grants.sql),
 * which hides a migration that forgot its portal grant; a resolved local stack
 * and the test databases are prepared from the roles file and the migrations
 * only, so a missing grant there is a `permission denied` on a route that
 * passes every owner-connected test.
 *
 * The test database is provisioned exactly that way (vitest.globalSetup.ts),
 * so it is the honest place to read the grants. The exclusions are the tables
 * the portal must not read at all — the abuse-control ledgers and Prisma's own
 * bookkeeping — and the list is closed: a new table without a portal grant
 * fails here until it is either granted or added with a reason.
 */

const OWNER_URL = process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

/** Tables helix_portal holds no SELECT on, by design. */
const PORTAL_UNREADABLE = new Set([
  // Prisma's migration ledger: owner-only.
  "_prisma_migrations",
  // Edge/egress abuse-control and nonce-burn ledgers (ADR-0021 carve-outs).
  "rate_counters",
  "instruction_jti",
  "jobs_callback_jti",
]);

const owner = new Pool({ connectionString: OWNER_URL, max: 1 });

afterAll(async () => {
  await owner.end();
});

describe("helix_portal's table grants come from the migrations", () => {
  it("reads every platform table except the closed set of ledgers it must not read", async () => {
    const { rows } = await owner.query<{ table: string; readable: boolean }>(
      `SELECT c.relname AS table,
              has_table_privilege('helix_portal', c.oid, 'SELECT') AS readable
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        ORDER BY 1`,
    );
    expect(rows.length).toBeGreaterThan(PORTAL_UNREADABLE.size);
    const unreadable = rows.filter((row) => !row.readable).map((row) => row.table);
    expect(unreadable.sort()).toEqual([...PORTAL_UNREADABLE].sort());
  });

  it("can mint, rotate and revoke dev tokens (app_dev_token full DML)", async () => {
    const { rows } = await owner.query<{ privilege: string; held: boolean }>(
      `SELECT p AS privilege, has_table_privilege('helix_portal', 'app_dev_token', p) AS held
         FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p`,
    );
    expect(rows).toEqual([
      { privilege: "SELECT", held: true },
      { privilege: "INSERT", held: true },
      { privilege: "UPDATE", held: true },
      { privilege: "DELETE", held: true },
    ]);
  });
});
