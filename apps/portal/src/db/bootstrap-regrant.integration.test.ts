import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

/**
 * The bootstrap grants are not init-only in practice: create-roles.sh applies
 * every sql/*.sql on each invocation, and the operator docs describe the
 * re-run as the supported upgrade path for an install that predates a role or
 * the jobs database. On an upgraded install the carve-out migrations never run
 * again — they are once-only by definition — so the bootstrap re-run is the
 * last word on the carved-out tables' grants.
 *
 * That re-run must end in the migrated posture. `GRANT … ON ALL TABLES IN
 * SCHEMA public` is additive: applied over a migrated database it re-widens
 * helix_portal to full DML unless the bootstrap itself re-asserts every
 * carve-out the migrations apply. This suite reproduces the migrated state on
 * a throwaway database, applies the real bootstrap file, and holds the
 * complete carve-out inventory (20260721120000_gateway_calls_portal_readonly,
 * 20260721215912_shared_rate_counters_and_jti_burn,
 * 20260921120000_portal_sessions_least_privilege).
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

const PROBE_DB = "helix_bootstrap_regrant_probe";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const BOOTSTRAP_SQL = readFileSync(
  path.join(REPO_ROOT, ".devcontainer/db-init/02-portal-bootstrap-grants.sql"),
  "utf8",
);

/**
 * The portal carve-outs, keyed by table: the privileges the carve-out
 * migration revoked from the bootstrap's blanket, and the privileges it
 * deliberately keeps (SELECT everywhere; DELETE on sessions — the admin list
 * and the user-level revoke). The re-run must leave exactly this shape.
 */
const PORTAL_CARVE_OUTS: ReadonlyArray<{ table: string; revoked: string[]; kept: string[] }> = [
  { table: "gateway_calls", revoked: ["INSERT", "UPDATE", "DELETE"], kept: ["SELECT"] },
  { table: "rate_counters", revoked: ["INSERT", "UPDATE", "DELETE"], kept: ["SELECT"] },
  { table: "instruction_jti", revoked: ["INSERT", "UPDATE", "DELETE"], kept: ["SELECT"] },
  {
    table: "sessions",
    revoked: ["INSERT", "UPDATE"],
    kept: ["SELECT", "DELETE"],
  },
];

/** The owner (provisioning) connection to an arbitrary database on the cluster. */
function ownerUrlFor(database: string): string {
  const u = new URL(TEST_DATABASE_URL);
  u.pathname = `/${database}`;
  return u.toString();
}

async function portalPrivileges(table: string): Promise<Record<string, boolean>> {
  const probe = new Pool({ connectionString: ownerUrlFor(PROBE_DB), max: 1 });
  try {
    const result = await probe.query<Record<string, boolean>>(
      `SELECT has_table_privilege('helix_portal', $1, 'SELECT') AS can_select,
              has_table_privilege('helix_portal', $1, 'INSERT') AS can_insert,
              has_table_privilege('helix_portal', $1, 'UPDATE') AS can_update,
              has_table_privilege('helix_portal', $1, 'DELETE') AS can_delete`,
      [table],
    );
    return result.rows[0]!;
  } finally {
    await probe.end();
  }
}

beforeAll(async () => {
  const admin = new Pool({ connectionString: ownerUrlFor("helix_test"), max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${PROBE_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${PROBE_DB}`);
  } finally {
    await admin.end();
  }

  // The migrated state an upgrade re-runs over: the carved-out tables exist
  // and the carve-out migrations' REVOKEs are the last word on them.
  const probe = new Pool({ connectionString: ownerUrlFor(PROBE_DB), max: 1 });
  try {
    for (const { table, revoked } of PORTAL_CARVE_OUTS) {
      await probe.query(`CREATE TABLE ${table} (id int)`);
      await probe.query(`REVOKE ${revoked.join(", ")} ON ${table} FROM helix_portal`);
    }
  } finally {
    await probe.end();
  }
});

afterAll(async () => {
  const admin = new Pool({ connectionString: ownerUrlFor("helix_test"), max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${PROBE_DB} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

describe("re-running the bootstrap grants over a migrated database", () => {
  it("keeps the carve-out migrations' revokes on every carved-out table", async () => {
    // Sanity on the probe itself: the carve-outs must hold BEFORE the re-run,
    // so a failure below is the bootstrap's doing and not the setup's.
    for (const { table, revoked } of PORTAL_CARVE_OUTS) {
      const before = await portalPrivileges(table);
      for (const privilege of revoked) {
        expect(
          before[`can_${privilege.toLowerCase()}`],
          `${table} before the re-run: ${privilege}`,
        ).toBe(false);
      }
    }

    // The re-run: create-roles.sh applies every sql/*.sql on each invocation,
    // so the bootstrap file lands again over the migrated database.
    const probe = new Pool({ connectionString: ownerUrlFor(PROBE_DB), max: 1 });
    try {
      await probe.query(BOOTSTRAP_SQL);
    } finally {
      await probe.end();
    }

    // The migrated posture, exactly: everything a carve-out took away stays
    // taken away, and everything it deliberately keeps stays present — an
    // over-broad re-assertion would break the kept operations just as surely
    // as a missing one breaks the carve-out.
    for (const { table, revoked, kept } of PORTAL_CARVE_OUTS) {
      const after = await portalPrivileges(table);
      for (const privilege of revoked) {
        expect(
          after[`can_${privilege.toLowerCase()}`],
          `${table} after the re-run: ${privilege}`,
        ).toBe(false);
      }
      for (const privilege of kept) {
        expect(
          after[`can_${privilege.toLowerCase()}`],
          `${table} after the re-run: ${privilege}`,
        ).toBe(true);
      }
    }
  });
});
