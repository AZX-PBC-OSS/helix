import { describe, expect, it } from "vitest";
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
           VALUES (gen_random_uuid(), 'rolesplit', 'x', 'private')`,
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

      // Not the owner — no DDL.
      await expect(pool.query("DROP TABLE app_secrets")).rejects.toThrow(/must be owner/i);
    } finally {
      await pool.end();
    }
  });
});
