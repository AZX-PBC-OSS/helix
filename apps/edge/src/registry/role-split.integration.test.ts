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

      // The meter: SELECT + INSERT on gateway_calls.
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

      // Not the owner — no DDL.
      await expect(pool.query("DROP TABLE apps")).rejects.toThrow(/must be owner/i);
    } finally {
      await pool.end();
    }
  });
});
