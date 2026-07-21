import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

/**
 * ADR-0002 (ISSUE-12/13) — the flip side of the edge partition policies on
 * `gateway_calls` / `app_collection_items`: the control plane must still read
 * them CROSS-app. In production the portal connects as `helix_portal`, which is
 * NOT the table owner and has no BYPASSRLS, so FORCE RLS would scope it to zero
 * rows without the permissive `*_portal_all` policy. The portal route tests run
 * as the superuser owner (bypasses RLS) and would pass even if that policy were
 * dropped, so this guards it directly by connecting as `helix_portal`.
 *
 * Skips when the runtime role isn't provisioned (CI without db-init), same as
 * the edge role-split suites.
 */

const OWNER_URL = process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

function portalUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = "helix_portal";
  u.password = "helix_portal";
  return u.toString();
}

async function portalRoleAvailable(): Promise<boolean> {
  const pool = new Pool({ connectionString: portalUrl(), max: 1 });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

const APP_A = randomUUID();
const APP_B = randomUUID();

afterAll(async () => {
  const owner = new Pool({ connectionString: OWNER_URL, max: 1 });
  try {
    await owner.query(`DELETE FROM gateway_calls WHERE "appId" = ANY($1::uuid[])`, [
      [APP_A, APP_B],
    ]);
    await owner.query(`DELETE FROM app_collection_items WHERE "appId" = ANY($1::uuid[])`, [
      [APP_A, APP_B],
    ]);
  } finally {
    await owner.end();
  }
});

describe("helix_portal reads cross-app under RLS (the *_portal_all policy)", () => {
  it("sees gateway_calls and app_collection_items across apps with no partition GUC", async () => {
    if (!(await portalRoleAvailable())) return;

    // Seed two apps' rows as the owner.
    const owner = new Pool({ connectionString: OWNER_URL, max: 1 });
    try {
      for (const appId of [APP_A, APP_B]) {
        await owner.query(
          `INSERT INTO gateway_calls (id, "appId", "userOid", capability, model, outcome)
             VALUES (gen_random_uuid(), $1, 'u', 'llm', 'm', 'ok')`,
          [appId],
        );
        await owner.query(
          `INSERT INTO app_collection_items (id, "appId", collection, item)
             VALUES (gen_random_uuid(), $1, 'contacts', '{}'::jsonb)`,
          [appId],
        );
      }
    } finally {
      await owner.end();
    }

    // As helix_portal, with no app.app_id GUC set: the permissive policy must
    // admit both apps' rows — the drain / usage rollups depend on this.
    const portal = new Pool({ connectionString: portalUrl(), max: 1 });
    try {
      const calls = await portal.query(
        `SELECT count(*)::int AS n FROM gateway_calls WHERE "appId" = ANY($1::uuid[])`,
        [[APP_A, APP_B]],
      );
      expect((calls.rows[0] as { n: number }).n).toBe(2);

      const items = await portal.query(
        `SELECT count(*)::int AS n FROM app_collection_items WHERE "appId" = ANY($1::uuid[])`,
        [[APP_A, APP_B]],
      );
      expect((items.rows[0] as { n: number }).n).toBe(2);
    } finally {
      await portal.end();
    }
  });
});
