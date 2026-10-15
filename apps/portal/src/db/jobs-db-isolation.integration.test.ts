import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { provisionTestDatabases } from "../test/provisionDatabases.js";

/**
 * Background-jobs design §8 — the private jobs database and its identities,
 * asserted against the real cluster through the real provisioning path.
 *
 * The jobs plane's isolation is an absent CONNECTION, not a list of REVOKEs:
 * `helix_jobs` (runtime) and `helix_jobs_migrate` (migration) each connect to
 * their own database and to nothing else — no platform runtime role reaches
 * the jobs database, no jobs identity reaches the platform database, and
 * PUBLIC's revoked CONNECT keeps a default-privileged stranger out of either.
 * On the jobs database itself the runtime role has reach-but-not-create
 * authority (USAGE on public, every table grant left to a jobs migration),
 * and only the migration identity can create schemas or tables — so a
 * compromised jobs runtime cannot migrate its own schema.
 *
 * Unlike the edge role-split suite, this suite does not skip when the roles
 * are missing: vitest's global setup applies the provisioning
 * (`.devcontainer/db-init/01-roles.sql`, parametrized to the test database
 * names) before any test runs, so a failure here means the provisioning
 * itself failed — an unprovisioned green run is not evidence.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

const JOBS_TEST_DB = "helix_jobs_test";
const RUNTIME_ROLE = "helix_jobs";
const MIGRATE_ROLE = "helix_jobs_migrate";
const PROBER_ROLE = "jobs_acl_prober";

/** A DSN as `role` connecting to `database`, derived from the owner test URL. */
function roleUrl(role: string, database: string): string {
  const u = new URL(TEST_DATABASE_URL);
  u.username = role;
  u.password = role;
  u.pathname = `/${database}`;
  return u.toString();
}

/** The owner (provisioning) connection to the platform test database. */
function ownerUrl(): string {
  return ownerUrlFor("helix_test");
}

async function connectRefused(url: string): Promise<Error> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query("SELECT 1");
    throw new Error(`connection unexpectedly succeeded for ${url}`);
  } catch (err) {
    if (!(err instanceof Error) || !/permission denied for database/i.test(err.message)) {
      throw err;
    }
    return err;
  } finally {
    await pool.end();
  }
}

beforeAll(async () => {
  // The migration identity proves its authority by creating the fixture table
  // every denial below is measured against. Fixed name + DROP first: a
  // crashed earlier run reaps itself instead of wedging the next one.
  const migrate = new Pool({ connectionString: roleUrl(MIGRATE_ROLE, JOBS_TEST_DB), max: 1 });
  try {
    await migrate.query("DROP TABLE IF EXISTS jobs_role_split_fixture");
    await migrate.query("CREATE TABLE jobs_role_split_fixture (id int)");
    await migrate.query("INSERT INTO jobs_role_split_fixture VALUES (7)");
  } finally {
    await migrate.end();
  }

  // A throwaway role with NO grants: the PUBLIC-CONNECT bypass probe. The
  // re-applied provisioning revokes PUBLIC on both databases; this role holds
  // nothing else.
  const owner = new Pool({ connectionString: ownerUrl(), max: 1 });
  try {
    await owner.query(`DROP ROLE IF EXISTS ${PROBER_ROLE}`);
    await owner.query(`CREATE ROLE ${PROBER_ROLE} LOGIN PASSWORD '${PROBER_ROLE}'`);
  } finally {
    await owner.end();
  }
});

afterAll(async () => {
  const migrate = new Pool({ connectionString: roleUrl(MIGRATE_ROLE, JOBS_TEST_DB), max: 1 });
  try {
    await migrate.query("DROP TABLE IF EXISTS jobs_role_split_fixture");
  } finally {
    await migrate.end();
  }
  const owner = new Pool({ connectionString: ownerUrl(), max: 1 });
  try {
    await owner.query(`DROP ROLE IF EXISTS ${PROBER_ROLE}`);
  } finally {
    await owner.end();
  }
});

describe("helix_jobs on its own database", () => {
  it("connects and holds reach (USAGE) but no create or ownership authority", async () => {
    const pool = new Pool({ connectionString: roleUrl(RUNTIME_ROLE, JOBS_TEST_DB), max: 1 });
    try {
      await expect(pool.query("SELECT 1")).resolves.toBeDefined();

      // USAGE on public is granted, so the planner reaches past the schema
      // boundary and reports the missing table — a denied USAGE would fail
      // earlier with "permission denied for schema public".
      await expect(
        pool.query("SELECT 1 FROM public.jobs_role_split_missing_table"),
      ).rejects.toThrow(/does not exist/i);

      // No CREATE on the database (schemas) nor on public (tables).
      await expect(pool.query("CREATE SCHEMA jobs_runtime_schema")).rejects.toThrow(
        /permission denied for database/i,
      );
      await expect(pool.query("CREATE TABLE public.jobs_runtime_table (id int)")).rejects.toThrow(
        /permission denied for schema public/i,
      );

      // Not the schema owner — DDL it inherits nothing of.
      await expect(pool.query("DROP SCHEMA public")).rejects.toThrow(/must be owner/i);
    } finally {
      await pool.end();
    }
  });

  it("cannot see or drop a table no jobs migration has granted it", async () => {
    // The fail-closed default the jobs migrations will bind writers by grant:
    // the fixture table exists in the runtime's own database, created by the
    // migration identity, and the runtime touches nothing.
    const pool = new Pool({ connectionString: roleUrl(RUNTIME_ROLE, JOBS_TEST_DB), max: 1 });
    try {
      await expect(pool.query("SELECT * FROM jobs_role_split_fixture")).rejects.toThrow(
        /permission denied for table/i,
      );
      await expect(pool.query("DROP TABLE jobs_role_split_fixture")).rejects.toThrow(
        /must be owner/i,
      );
    } finally {
      await pool.end();
    }
  });
});

describe("cross-database connections are refused", () => {
  it("neither jobs identity connects to the platform test database", async () => {
    for (const role of [RUNTIME_ROLE, MIGRATE_ROLE]) {
      await expect(connectRefused(roleUrl(role, "helix_test"))).resolves.toBeInstanceOf(Error);
    }
  });

  it("no platform runtime role connects to the jobs database", async () => {
    for (const role of ["helix_portal", "helix_edge", "helix_egress", "helix_dev"]) {
      await expect(connectRefused(roleUrl(role, JOBS_TEST_DB))).resolves.toBeInstanceOf(Error);
    }
  });

  it("a role with no explicit grant cannot connect to either database (PUBLIC revoked)", async () => {
    await expect(connectRefused(roleUrl(PROBER_ROLE, "helix_test"))).resolves.toBeInstanceOf(Error);
    await expect(connectRefused(roleUrl(PROBER_ROLE, JOBS_TEST_DB))).resolves.toBeInstanceOf(Error);
  });
});

describe("provisioned identity attributes", () => {
  it("both jobs identities are non-superuser NOINHERIT NOBYPASSRLS members of nothing", async () => {
    const owner = new Pool({ connectionString: ownerUrl(), max: 1 });
    try {
      const roles = await owner.query<{ rolname: string }>(
        `SELECT rolname, rolsuper, rolinherit, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
           FROM pg_roles
          WHERE rolname IN ($1, $2)`,
        [RUNTIME_ROLE, MIGRATE_ROLE],
      );
      expect(roles.rows).toHaveLength(2);
      for (const row of roles.rows) {
        expect(row).toMatchObject({
          rolsuper: false,
          rolinherit: false,
          rolbypassrls: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolreplication: false,
        });
      }

      // No membership: with NOINHERIT this is what keeps SET ROLE up to the
      // owner (or any other role) unreachable.
      const memberships = await owner.query(
        `SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
          WHERE r.rolname IN ($1, $2)`,
        [RUNTIME_ROLE, MIGRATE_ROLE],
      );
      expect(memberships.rows).toEqual([]);

      // The runtime role is not the database owner either — the provisioning
      // owner is. (The migration identity is granted CREATE, not custody.)
      const jobDbOwner = await owner.query<{ owner: string }>(
        `SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1`,
        [JOBS_TEST_DB],
      );
      expect(jobDbOwner.rows[0]?.owner).not.toBe(RUNTIME_ROLE);
    } finally {
      await owner.end();
    }
  });
});

describe("platform runtime access survives the hardening", () => {
  it("all four platform roles still connect to the platform test database", async () => {
    // The edge role-split suite skips fail-soft when a role cannot connect —
    // so a provisioning change that silently broke a platform grant would
    // turn those tests into silent skips. This positive check is the tripwire.
    for (const role of ["helix_portal", "helix_edge", "helix_egress", "helix_dev"]) {
      const pool = new Pool({ connectionString: roleUrl(role, "helix_test"), max: 1 });
      try {
        await expect(pool.query("SELECT 1")).resolves.toBeDefined();
      } finally {
        await pool.end();
      }
    }
  });
});

/** The owner (provisioning) connection to an arbitrary test database. */
function ownerUrlFor(database: string): string {
  const u = new URL(TEST_DATABASE_URL);
  u.pathname = `/${database}`;
  return u.toString();
}

describe("the migration identity's authority", () => {
  it("creates schemas in the jobs database (the database-level CREATE grant)", async () => {
    // Table creation rides along in this file's fixture setup; schema creation
    // is the other half of the migration identity's stated authority and
    // nothing else exercises it. The runtime role's denial is pinned above.
    const migrate = new Pool({ connectionString: roleUrl(MIGRATE_ROLE, JOBS_TEST_DB), max: 1 });
    try {
      await migrate.query("DROP SCHEMA IF EXISTS jobs_migrate_schema_probe");
      await expect(migrate.query("CREATE SCHEMA jobs_migrate_schema_probe")).resolves.toBeDefined();
    } finally {
      await migrate.query("DROP SCHEMA IF EXISTS jobs_migrate_schema_probe");
      await migrate.end();
    }
  });

  it("cannot delegate schema ownership to the runtime role", async () => {
    // The escalation path: CREATE SCHEMA … AUTHORIZATION helix_jobs would hand
    // the runtime role a schema it owns, and a schema owner creates tables in
    // it — table-creation authority no jobs migration granted. The issuer must
    // be able to SET ROLE to the target, which the provisioning's NOINHERIT +
    // no-membership posture denies; this pins the composed denial behaviorally
    // rather than trusting the pg_auth_members attribute check above.
    const migrate = new Pool({ connectionString: roleUrl(MIGRATE_ROLE, JOBS_TEST_DB), max: 1 });
    try {
      await expect(
        migrate.query("CREATE SCHEMA jobs_runtime_delegated AUTHORIZATION helix_jobs"),
      ).rejects.toThrow(/set role|permission denied|member/i);

      const created = await migrate.query(
        "SELECT 1 FROM information_schema.schemata WHERE schema_name = 'jobs_runtime_delegated'",
      );
      expect(created.rows, "the delegated schema must not exist").toEqual([]);
    } finally {
      await migrate.end();
      // If the denial ever fails, the schema outlives the connection owned by
      // the runtime role; only the provisioning owner can reap it.
      const owner = new Pool({ connectionString: ownerUrl(), max: 1 });
      try {
        await owner.query("DROP SCHEMA IF EXISTS jobs_runtime_delegated");
      } finally {
        await owner.end();
      }
    }
  });
});

describe("the test databases carry no default privileges", () => {
  it("no ALTER DEFAULT PRIVILEGES exists on either test database", async () => {
    // The bootstrap-grants file (02) is the only source of default privileges
    // and is applied to the platform dev database only — the test databases
    // get 01 alone, and jobs migrations must grant every table explicitly.
    // Nothing else in the run would catch a widening: the per-table revokes
    // the other suites pin are re-issued by migrations on tables that already
    // exist, so a blanket or default grant reaching helix_test would stay
    // green while silently granting the portal DML on every future table.
    for (const database of ["helix_test", JOBS_TEST_DB]) {
      const owner = new Pool({ connectionString: ownerUrlFor(database), max: 1 });
      try {
        const defaults = await owner.query(
          "SELECT defaclrole::regrole::text AS role FROM pg_default_acl",
        );
        expect(defaults.rows, `${database} carries default privileges`).toEqual([]);
      } finally {
        await owner.end();
      }
    }
  });
});

describe("re-applying the provisioning (the upgrade path)", () => {
  it("preserves existing jobs state and keeps the boundary intact", async () => {
    // globalSetup already applied this file once this run; the fixture table
    // was created after that — so the re-apply runs over live jobs state,
    // exactly the existing-install upgrade shape.
    provisionTestDatabases();

    const migrate = new Pool({ connectionString: roleUrl(MIGRATE_ROLE, JOBS_TEST_DB), max: 1 });
    try {
      const kept = await migrate.query("SELECT count(*)::int AS n FROM jobs_role_split_fixture");
      expect(kept.rows[0]).toEqual({ n: 1 });
    } finally {
      await migrate.end();
    }

    await expect(connectRefused(roleUrl("helix_edge", JOBS_TEST_DB))).resolves.toBeInstanceOf(
      Error,
    );
    await expect(connectRefused(roleUrl(RUNTIME_ROLE, "helix_test"))).resolves.toBeInstanceOf(
      Error,
    );
  });
});
