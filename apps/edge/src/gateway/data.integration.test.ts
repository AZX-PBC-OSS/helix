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

    await store.putUserKey(APP, "alice", "todo", ["milk"], "prod", { kind: "none" });
    expect((await store.getUserKey(APP, "alice", "todo", "prod"))?.value).toEqual(["milk"]);

    // Upsert replaces.
    await store.putUserKey(APP, "alice", "todo", ["milk", "eggs"], "prod", { kind: "none" });
    expect((await store.getUserKey(APP, "alice", "todo", "prod"))?.value).toEqual(["milk", "eggs"]);

    // Different user, same app+key: a distinct partition (absent).
    expect(await store.getUserKey(APP, "bob", "todo", "prod")).toBeNull();
    // Different app, same user+key: also distinct.
    expect(await store.getUserKey(OTHER_APP, "alice", "todo", "prod")).toBeNull();

    await store.putUserKey(APP, "alice", "prefs", { theme: "dark" }, "prod", { kind: "none" });
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

  it("shared keys create-if-absent and CAS via the partial unique index (ADR-0041)", async () => {
    if (!(await edgeRoleAvailable())) return;
    const s = new PgAppDataStore(edgeUrl(), { max: 1 });
    try {
      expect(await s.getShared(APP, "tally", "prod")).toBeNull();

      // Create-if-absent lands at version 1 — a STRING, because BIGINT is the
      // whole point: the opaque token never passes through a JS Number.
      const created = await s.putShared(APP, "tally", { yes: 1 }, "prod", { kind: "ifNoneMatch" });
      expect(created).toMatchObject({ kind: "ok", version: "1" });
      expect(await s.getShared(APP, "tally", "prod")).toMatchObject({
        value: { yes: 1 },
        version: "1",
      });

      // A second create-if-absent conflicts instead of clobbering — and
      // discloses the version it conflicted with (review finding 2).
      const dupe = await s.putShared(APP, "tally", { yes: 99 }, "prod", { kind: "ifNoneMatch" });
      expect(dupe).toEqual({ kind: "conflict", currentVersion: "1" });

      // If-Match on the current version wins and bumps; on a stale one loses.
      const won = await s.putShared(APP, "tally", { yes: 2 }, "prod", {
        kind: "ifMatch",
        version: "1",
      });
      expect(won).toMatchObject({ kind: "ok", version: "2" });
      const stale = await s.putShared(APP, "tally", { yes: 3 }, "prod", {
        kind: "ifMatch",
        version: "1",
      });
      expect(stale).toEqual({ kind: "conflict", currentVersion: "2" });
      // If-Match against an absent key conflicts rather than inserting — the
      // precise hole a single `ON CONFLICT … WHERE` upsert would leave open.
      const absent = await s.putShared(APP, "never-written", 1, "prod", {
        kind: "ifMatch",
        version: "1",
      });
      expect(absent).toEqual({ kind: "conflict", currentVersion: null });
      expect(await s.getShared(APP, "never-written", "prod")).toBeNull();

      // int64 max binds cleanly and simply loses (the handler rejects anything
      // larger with 400 before it reaches here — binding it raised 22003).
      const huge = await s.putShared(APP, "tally", { yes: 4 }, "prod", {
        kind: "ifMatch",
        version: "9223372036854775807",
      });
      expect(huge).toEqual({ kind: "conflict", currentVersion: "2" });

      // Still one row, not a pile of near-duplicates: the partial unique index
      // is what every conflict target above keys off.
      const owner = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
      try {
        const r = await owner.query(
          `SELECT count(*)::int AS n, max(version)::int AS v FROM app_data
            WHERE "appId" = $1 AND "userOid" IS NULL AND key = 'tally'`,
          [APP],
        );
        expect(r.rows[0]).toMatchObject({ n: 1, v: 2 });
      } finally {
        await owner.end();
      }
    } finally {
      await s.close();
    }
  });

  it("two concurrent CAS writes on the same base version: exactly one wins", async () => {
    if (!(await edgeRoleAvailable())) return;
    const s = new PgAppDataStore(edgeUrl(), { max: 2 });
    try {
      await s.putShared(APP, "hot", ["alpha"], "prod", { kind: "ifNoneMatch" });

      // The ADR's race for real: both writers assert version 1. Under READ
      // COMMITTED the loser's UPDATE waits on the winner's row lock, then
      // re-evaluates `version = 1` against the committed row — and misses.
      const [a, b] = await Promise.all([
        s.putShared(APP, "hot", ["alpha", "gamma"], "prod", { kind: "ifMatch", version: "1" }),
        s.putShared(APP, "hot", ["alpha", "delta"], "prod", { kind: "ifMatch", version: "1" }),
      ]);
      const outcomes = [a.kind, b.kind].sort();
      expect(outcomes).toEqual(["conflict", "ok"]);
      // The loser sees the winner's committed version (the post-conflict
      // SELECT runs after the row-lock wait, on a fresh READ COMMITTED
      // snapshot) — so one blind retry would land.
      const loser = a.kind === "conflict" ? a : b;
      expect(loser.kind === "conflict" && loser.currentVersion).toBe("2");

      const stored = await s.getShared(APP, "hot", "prod");
      expect(stored?.version).toBe("2");
      // Whichever won, the row is exactly one writer's value — not a merge.
      expect([
        ["alpha", "gamma"],
        ["alpha", "delta"],
      ]).toContainEqual(stored?.value);
    } finally {
      await s.close();
    }
  });

  it("RLS fails closed: a bare read with no partition GUCs sees nothing", async () => {
    if (!(await edgeRoleAvailable())) return;
    await new PgAppDataStore(edgeUrl(), { max: 1 })
      .putUserKey(APP, "carol", "k", 1, "prod", { kind: "none" })
      .then(
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
