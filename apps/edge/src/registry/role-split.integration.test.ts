import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { TEST_DATABASE_URL } from "../test/seed.js";

/**
 * App-data design §2.1 — the database-role split, asserted against the real
 * cluster. The edge runtime role (`helix_edge`) holds a tight union of the
 * data-plane verbs and nothing more: it reads the registry but cannot write it,
 * and it is not the table owner (no DDL). The containment that survives an edge
 * RCE is exactly the GRANTs that are absent. The companion §3.2 assertion —
 * `helix_edge` cannot SELECT collection items — lands with that table (Phase 5).
 *
 * The runtime roles are created by db-init/01-roles.sql (or Terraform), not by
 * migrations, so on a cluster without them this whole suite skips rather than
 * failing — same fail-soft stance as the guarded grants migration.
 */

/** The edge role's URL, derived from the owner test URL by swapping creds. */
function edgeUrl(): string {
  const u = new URL(TEST_DATABASE_URL);
  u.username = "helix_edge";
  u.password = "helix_edge";
  return u.toString();
}

async function edgeRoleAvailable(): Promise<boolean> {
  const pool = new Pool({ connectionString: edgeUrl(), max: 1 });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

describe("helix_edge least-privilege grants", () => {
  it("reads the registry but cannot write it, and cannot drop tables", async () => {
    if (!(await edgeRoleAvailable())) {
      // Roles not provisioned on this cluster (e.g. CI without db-init) — the
      // grants migration was a no-op too, so there is nothing to assert.
      return;
    }
    const pool = new Pool({ connectionString: edgeUrl(), max: 1 });
    try {
      // Read-only registry projection: SELECT is granted.
      await expect(pool.query("SELECT count(*) FROM apps")).resolves.toBeDefined();
      await expect(pool.query("SELECT count(*) FROM versions")).resolves.toBeDefined();

      // The meter: SELECT + INSERT on gateway_calls. The grant is present, so
      // this resolves; RLS (ADR-0002 ISSUE-12) makes it count 0 with no partition
      // GUC set — the isolation itself is asserted in usage.rls.integration.test.ts.
      await expect(pool.query("SELECT count(*) FROM gateway_calls")).resolves.toBeDefined();

      // Registry is read-only — no INSERT grant on apps.
      await expect(
        pool.query(
          `INSERT INTO apps (id, slug, "displayName", "visibilityMode")
           VALUES (gen_random_uuid(), 'rolesplit', 'x', 'internal')`,
        ),
      ).rejects.toThrow(/permission denied/i);

      // CSP reports (§6.2): INSERT-only, write-from-edge. Append is granted…
      await expect(
        pool.query(
          `INSERT INTO csp_reports (id, "appId", directive, "blockedUri")
           VALUES (gen_random_uuid(), gen_random_uuid(), 'connect-src', 'https://x')`,
        ),
      ).resolves.toBeDefined();
      // …but the edge can NEVER enumerate them (no SELECT grant).
      await expect(pool.query("SELECT count(*) FROM csp_reports")).rejects.toThrow(
        /permission denied/i,
      );

      // The approvals queue is portal-only — the edge has no grant at all.
      await expect(pool.query("SELECT count(*) FROM approval_requests")).rejects.toThrow(
        /permission denied/i,
      );

      // Connection secrets (secrets design §4): read ONLY by helix_egress. The
      // policy edge has no grant — that absence is the secret-custody boundary,
      // and it is table-wide, so it covers `platform`-scoped rows (the LLM vendor
      // key) too: an edge RCE cannot read the vendor key any more than an app key.
      await expect(pool.query("SELECT count(*) FROM app_secrets")).rejects.toThrow(
        /permission denied/i,
      );
      await expect(
        pool.query("SELECT material FROM app_secrets WHERE scope = 'platform'"),
      ).rejects.toThrow(/permission denied/i);

      // Abuse-control counters (issue #13): the edge OWNS rate_counters — full
      // CRUD for the atomic upsert / clear / sweep.
      await expect(pool.query("SELECT count(*) FROM rate_counters")).resolves.toBeDefined();
      await expect(
        pool.query(
          `INSERT INTO rate_counters ("bucketKey", count, "resetAt") VALUES ('rs-edge', 1, now())`,
        ),
      ).resolves.toBeDefined();
      await expect(
        pool.query(`DELETE FROM rate_counters WHERE "bucketKey" = 'rs-edge'`),
      ).resolves.toBeDefined();
      // …but the egress-owned jti burn set is off-limits (no grant at all).
      await expect(pool.query("SELECT count(*) FROM instruction_jti")).rejects.toThrow(
        /permission denied/i,
      );

      // Not the owner — no DDL.
      await expect(pool.query("DROP TABLE apps")).rejects.toThrow(/must be owner/i);
    } finally {
      await pool.end();
    }
  });
});

/** The egress role's URL, derived from the owner test URL by swapping creds. */
function egressUrl(): string {
  const u = new URL(TEST_DATABASE_URL);
  u.username = "helix_egress";
  u.password = "helix_egress";
  return u.toString();
}

async function egressRoleAvailable(): Promise<boolean> {
  const pool = new Pool({ connectionString: egressUrl(), max: 1 });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

describe("helix_egress least-privilege grants", () => {
  it("resolves secrets but cannot read the registry, sessions, or the ledger", async () => {
    if (!(await egressRoleAvailable())) return; // not provisioned on this cluster

    const pool = new Pool({ connectionString: egressUrl(), max: 1 });
    try {
      // The mechanism plane's job: read connection secrets + their grants.
      await expect(pool.query("SELECT count(*) FROM app_secrets")).resolves.toBeDefined();
      await expect(pool.query("SELECT count(*) FROM app_secret_grants")).resolves.toBeDefined();
      // …and stamp last-used (the only column it may write).
      await expect(
        pool.query(
          `UPDATE app_secrets SET "lastUsedAt" = now()
           WHERE id = '00000000-0000-0000-0000-000000000000'`,
        ),
      ).resolves.toBeDefined();

      // It must NOT be able to alter the credential material…
      await expect(
        pool.query(
          `UPDATE app_secrets SET material = 'x'
           WHERE id = '00000000-0000-0000-0000-000000000000'`,
        ),
      ).rejects.toThrow(/permission denied/i);

      // …nor touch anything the policy plane owns: registry, sessions, ledger.
      await expect(pool.query("SELECT count(*) FROM apps")).rejects.toThrow(/permission denied/i);
      await expect(pool.query("SELECT count(*) FROM sessions")).rejects.toThrow(
        /permission denied/i,
      );
      await expect(pool.query("SELECT count(*) FROM gateway_calls")).rejects.toThrow(
        /permission denied/i,
      );

      // The replay burn (issue #3): egress fully manages instruction_jti —
      // SELECT+INSERT+DELETE (its first write grants), enough for the ON CONFLICT
      // burn and the WHERE-filtered sweep.
      await expect(pool.query("SELECT count(*) FROM instruction_jti")).resolves.toBeDefined();
      await expect(
        pool.query(
          `INSERT INTO instruction_jti (jti, "expiresAt")
           VALUES ('rs-egress', now() + interval '1 minute') ON CONFLICT (jti) DO NOTHING`,
        ),
      ).resolves.toBeDefined();
      await expect(
        pool.query(`DELETE FROM instruction_jti WHERE jti = 'rs-egress'`),
      ).resolves.toBeDefined();
      // …but no grant at all on the edge's abuse-control counters.
      await expect(pool.query("SELECT count(*) FROM rate_counters")).rejects.toThrow(
        /permission denied/i,
      );

      // Not the owner — no DDL.
      await expect(pool.query("DROP TABLE app_secrets")).rejects.toThrow(/must be owner/i);
    } finally {
      await pool.end();
    }
  });
});

/** The dev data-plane role's URL, derived from the owner test URL by swapping creds. */
function devUrl(): string {
  const u = new URL(TEST_DATABASE_URL);
  u.username = "helix_dev";
  u.password = "helix_dev";
  return u.toString();
}

async function devRoleAvailable(): Promise<boolean> {
  const pool = new Pool({ connectionString: devUrl(), max: 1 });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

/**
 * Dev-mode design §5.3 — the load-bearing security thesis: the database itself
 * refuses to cross the env boundary. `helix_edge`'s RLS policy hardcodes
 * env='prod' and `helix_dev`'s hardcodes env='dev', so neither can read or write
 * the other tier's rows — independent of the `app.env` GUC, any header, or a
 * WHERE clause. The two isolation reads below (dev can't see a prod row; edge
 * can't see a dev row) and the forged-GUC read are the whole feature's proof that
 * dev mode is not a relaxation of the production APIs but a separate partition.
 *
 * That neither role is BYPASSRLS is proven implicitly: a BYPASSRLS role would see
 * BOTH seeded rows in the reads below. Skips fail-soft when helix_dev isn't
 * provisioned (CI without db-init), same as the suites above.
 */
describe("env partition isolation: helix_dev vs helix_edge (dev-mode §5.3)", () => {
  const APP = randomUUID();
  const USER = "env-user";

  beforeAll(async () => {
    if (!(await devRoleAvailable())) return;
    // Seed one prod row and one dev row for the same (app, user, key) as the
    // superuser owner (bypasses RLS). Distinct values so a leak is observable.
    const owner = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    try {
      await owner.query(
        `INSERT INTO app_data (id, "appId", env, "userOid", key, value, "updatedAt") VALUES
           (gen_random_uuid(), $1, 'prod', $2, 'k', '"PROD"'::jsonb, now()),
           (gen_random_uuid(), $1, 'dev',  $2, 'k', '"DEV"'::jsonb,  now())`,
        [APP, USER],
      );
    } finally {
      await owner.end();
    }
  });

  afterAll(async () => {
    const owner = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    try {
      await owner.query(`DELETE FROM app_data WHERE "appId" = $1`, [APP]);
    } finally {
      await owner.end();
    }
  });

  /** Read the seeded key as `url`'s role, with the partition GUCs set (env = `gucEnv`). */
  async function readAs(url: string, gucEnv: "prod" | "dev"): Promise<unknown[]> {
    const pool = new Pool({ connectionString: url, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.app_id', $1, true), set_config('app.env', $2, true), set_config('app.user_oid', $3, true)",
        [APP, gucEnv, USER],
      );
      const r = await client.query(`SELECT value FROM app_data WHERE key = 'k'`);
      await client.query("ROLLBACK");
      return (r.rows as { value: unknown }[]).map((row) => row.value);
    } finally {
      client.release();
      await pool.end();
    }
  }

  /** Attempt to INSERT an `rowEnv`-tier row as `url`'s role; the WITH CHECK governs. */
  async function writeAs(url: string, rowEnv: "prod" | "dev"): Promise<void> {
    const pool = new Pool({ connectionString: url, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.app_id', $1, true), set_config('app.env', $2, true), set_config('app.user_oid', $3, true)",
        [APP, rowEnv, USER],
      );
      try {
        await client.query(
          `INSERT INTO app_data (id, "appId", env, "userOid", key, value, "updatedAt")
             VALUES (gen_random_uuid(), $1, $2, $3, 'w', '"x"'::jsonb, now())`,
          [APP, rowEnv, USER],
        );
      } finally {
        await client.query("ROLLBACK");
      }
    } finally {
      client.release();
      await pool.end();
    }
  }

  it("helix_dev reads ONLY the dev row (its policy hardcodes env='dev')", async () => {
    if (!(await devRoleAvailable())) return;
    expect(await readAs(devUrl(), "dev")).toEqual(["DEV"]);
  });

  it("helix_edge reads ONLY the prod row (its policy hardcodes env='prod')", async () => {
    if (!(await devRoleAvailable())) return;
    expect(await readAs(edgeUrl(), "prod")).toEqual(["PROD"]);
  });

  it("a forged app.env GUC cannot cross the boundary — the role literal wins", async () => {
    if (!(await devRoleAvailable())) return;
    // helix_dev forging env=prod still sees only its dev row…
    expect(await readAs(devUrl(), "prod")).toEqual(["DEV"]);
    // …and helix_edge forging env=dev still sees only its prod row.
    expect(await readAs(edgeUrl(), "dev")).toEqual(["PROD"]);
  });

  it("write containment: each role's WITH CHECK refuses the other tier's env", async () => {
    if (!(await devRoleAvailable())) return;
    // helix_dev cannot write a prod row…
    await expect(writeAs(devUrl(), "prod")).rejects.toThrow(/row-level security/i);
    // …and helix_edge cannot write a dev row.
    await expect(writeAs(edgeUrl(), "dev")).rejects.toThrow(/row-level security/i);
  });

  it("helix_dev holds the least-privilege data-plane grant set and nothing more", async () => {
    if (!(await devRoleAvailable())) return;
    const pool = new Pool({ connectionString: devUrl(), max: 1 });
    try {
      // Owns its data-plane verbs — the grant is present; RLS scopes the rows.
      await expect(pool.query("SELECT count(*) FROM app_data")).resolves.toBeDefined();
      await expect(pool.query("SELECT count(*) FROM gateway_calls")).resolves.toBeDefined();
      // Collections are write-only in dev too (§3.2): INSERT grant, no SELECT.
      await expect(pool.query("SELECT count(*) FROM app_collection_items")).rejects.toThrow(
        /permission denied/i,
      );
      // Reads the registry projection to route (dev-mode §5.4, dev_registry_grant
      // _columns) — but ONLY the non-secret columns, under a column-scoped grant.
      await expect(
        pool.query(`SELECT slug, "visibilityMode", capabilities FROM apps LIMIT 1`),
      ).resolves.toBeDefined();
      await expect(pool.query("SELECT count(*) FROM versions")).resolves.toBeDefined();
      // The prod password columns are OFF-LIMITS — a compromised dev-gateway can't
      // read a `password`-app credential for any prod app (the isolation thesis).
      await expect(pool.query(`SELECT "passwordHash" FROM apps LIMIT 1`)).rejects.toThrow(
        /permission denied/i,
      );
      await expect(pool.query(`SELECT "passwordSalt" FROM apps LIMIT 1`)).rejects.toThrow(
        /permission denied/i,
      );
      await expect(pool.query(`SELECT "passwordEnc" FROM apps LIMIT 1`)).rejects.toThrow(
        /permission denied/i,
      );
      // No registry writes, no secret read, no DDL.
      await expect(
        pool.query(
          `INSERT INTO apps (id, slug, "displayName", "visibilityMode")
           VALUES (gen_random_uuid(), 'devrs', 'x', 'internal')`,
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(pool.query("SELECT count(*) FROM app_secrets")).rejects.toThrow(
        /permission denied/i,
      );
      await expect(pool.query("DROP TABLE apps")).rejects.toThrow(/must be owner/i);
    } finally {
      await pool.end();
    }
  });
});
