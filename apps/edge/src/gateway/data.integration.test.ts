import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PgAppDataStore } from "./data.js";
import { TEST_DATABASE_URL } from "../test/seed.js";

/**
 * The app-data store against real Postgres, connecting as the least-privilege
 * `helix_edge` role (app-data design §2.1) — so the test exercises the actual
 * GRANTs and the `app_data_partition` RLS policy, not just the hand-written
 * WHERE. Skips when the runtime role isn't provisioned (CI without db-init).
 */

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

const APP = randomUUID();
const OTHER_APP = randomUUID();
let store: PgAppDataStore | null = null;

afterAll(async () => {
  await store?.close();
  // Clean our rows as the owner (FORCE RLS would otherwise scope a bare delete).
  const owner = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  try {
    await owner.query(`DELETE FROM app_data WHERE "appId" = ANY($1::uuid[])`, [[APP, OTHER_APP]]);
    await owner.query(`DELETE FROM app_collection_items WHERE "appId" = ANY($1::uuid[])`, [
      [APP, OTHER_APP],
    ]);
  } finally {
    await owner.end();
  }
});

describe("PgAppDataStore as helix_edge (RLS-backed)", () => {
  it("round-trips and isolates by partition", async () => {
    if (!(await edgeRoleAvailable())) return;
    store = new PgAppDataStore(edgeUrl(), { max: 2 });

    await store.putUserKey(APP, "alice", "todo", ["milk"], "prod");
    expect(await store.getUserKey(APP, "alice", "todo", "prod")).toEqual(["milk"]);

    // Upsert replaces.
    await store.putUserKey(APP, "alice", "todo", ["milk", "eggs"], "prod");
    expect(await store.getUserKey(APP, "alice", "todo", "prod")).toEqual(["milk", "eggs"]);

    // Different user, same app+key: a distinct partition (absent).
    expect(await store.getUserKey(APP, "bob", "todo", "prod")).toBeNull();
    // Different app, same user+key: also distinct.
    expect(await store.getUserKey(OTHER_APP, "alice", "todo", "prod")).toBeNull();

    await store.putUserKey(APP, "alice", "prefs", { theme: "dark" }, "prod");
    const keys = await store.listUserKeys(APP, "alice", "prod");
    expect(keys.map((k) => k.key)).toEqual(["prefs", "todo"]);

    expect(await store.deleteUserKey(APP, "alice", "todo", "prod")).toBe(true);
    expect(await store.deleteUserKey(APP, "alice", "todo", "prod")).toBe(false);
    expect(await store.getUserKey(APP, "alice", "todo", "prod")).toBeNull();
  });

  it("collections are write-only for the edge role: INSERT works, SELECT/DELETE denied", async () => {
    if (!(await edgeRoleAvailable())) return;
    const s = new PgAppDataStore(edgeUrl(), { max: 1 });
    try {
      // The edge can append (INSERT grant).
      await s.appendCollection(
        APP,
        "contacts",
        { email: "lead@x.z" },
        null,
        { ipHash: "abc" },
        "prod",
      );

      // ...but the role has NO SELECT/DELETE — the §3.2 containment, asserted
      // against the real GRANTs. This is THE load-bearing security property.
      const pool = new Pool({ connectionString: edgeUrl(), max: 1 });
      try {
        await expect(pool.query("SELECT * FROM app_collection_items")).rejects.toThrow(
          /permission denied/i,
        );
        await expect(pool.query("DELETE FROM app_collection_items")).rejects.toThrow(
          /permission denied/i,
        );
      } finally {
        await pool.end();
      }

      // The owner (portal role's superset) CAN drain it — proving the row landed.
      const owner = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
      try {
        const r = await owner.query(
          `SELECT item, "userOid", meta FROM app_collection_items WHERE "appId" = $1`,
          [APP],
        );
        expect(r.rows).toHaveLength(1);
        expect((r.rows[0] as { item: unknown }).item).toEqual({ email: "lead@x.z" });
        expect((r.rows[0] as { userOid: string | null }).userOid).toBeNull();
      } finally {
        await owner.end();
      }
    } finally {
      await s.close();
    }
  });

  it("collection append is partition-scoped: an INSERT into another app is rejected (WITH CHECK)", async () => {
    if (!(await edgeRoleAvailable())) return;
    // On top of the INSERT-only grant, the `app_collection_items_edge_partition`
    // policy (ADR-0002 ISSUE-13) pins the write to the GUC's app: a row targeting
    // a different app fails the WITH CHECK, so an appId-confusion bug can't
    // pollute another app's collection.
    const pool = new Pool({ connectionString: edgeUrl(), max: 1 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.app_id', $1, true)", [APP]);
      await expect(
        client.query(
          `INSERT INTO app_collection_items (id, "appId", collection, item)
             VALUES (gen_random_uuid(), $1, 'contacts', '{}'::jsonb)`,
          [OTHER_APP],
        ),
      ).rejects.toThrow(/row-level security/i);
      await client.query("ROLLBACK");
    } finally {
      client.release();
      await pool.end();
    }
  });

  it("shared keys upsert via the partial unique index", async () => {
    if (!(await edgeRoleAvailable())) return;
    const s = new PgAppDataStore(edgeUrl(), { max: 1 });
    try {
      expect(await s.getShared(APP, "tally", "prod")).toBeNull();
      await s.putShared(APP, "tally", { yes: 1 }, "prod");
      expect(await s.getShared(APP, "tally", "prod")).toEqual({ yes: 1 });
      // Upsert (not a duplicate row) — the partial unique index makes this work
      // even though the full unique index treats NULL userOid as distinct.
      await s.putShared(APP, "tally", { yes: 2 }, "prod");
      expect(await s.getShared(APP, "tally", "prod")).toEqual({ yes: 2 });

      const owner = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
      try {
        const r = await owner.query(
          `SELECT count(*)::int AS n FROM app_data WHERE "appId" = $1 AND "userOid" IS NULL AND key = 'tally'`,
          [APP],
        );
        expect((r.rows[0] as { n: number }).n).toBe(1);
      } finally {
        await owner.end();
      }
    } finally {
      await s.close();
    }
  });

  it("RLS fails closed: a bare read with no partition GUCs sees nothing", async () => {
    if (!(await edgeRoleAvailable())) return;
    await new PgAppDataStore(edgeUrl(), { max: 1 }).putUserKey(APP, "carol", "k", 1, "prod").then(
      // keep store available for cleanup via the same APP id
      () => undefined,
    );
    const pool = new Pool({ connectionString: edgeUrl(), max: 1 });
    try {
      // No set_config — the policy predicate is NULL → matches zero rows.
      const r = await pool.query(`SELECT count(*)::int AS n FROM app_data`);
      expect((r.rows[0] as { n: number }).n).toBe(0);
    } finally {
      await pool.end();
    }
  });
});
