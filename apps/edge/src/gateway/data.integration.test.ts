import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PgAppDataStore, decodeListCursor } from "./data.js";
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
// Dedicated partitions for the two listShared tests that seed a whole page of
// `record:*` keys: the walk asserts exact counts/orderings, and the sibling
// tests' `record:`-prefixed rows under APP would be indistinguishable pollution.
const PAGING_APP = randomUUID();
const ORDER_APP = randomUUID();
// The two row-level listShared tests get one too — they seed `record:*` keys
// and assert exact contents, which must not depend on file execution order.
const LIST_APP = randomUUID();
let store: PgAppDataStore | null = null;

afterAll(async () => {
  await store?.close();
  // Clean our rows as the owner (FORCE RLS would otherwise scope a bare delete).
  const owner = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  try {
    await owner.query(`DELETE FROM app_data WHERE "appId" = ANY($1::uuid[])`, [
      [APP, OTHER_APP, PAGING_APP, ORDER_APP, LIST_APP],
    ]);
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

  it("round-trips an authenticated submitter's captured display half", async () => {
    if (!(await edgeRoleAvailable())) return;
    const s = new PgAppDataStore(edgeUrl(), { max: 1 });
    const owner = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    try {
      await s.appendCollection(
        APP,
        "labelled",
        { email: "lead@x.z" },
        {
          userOid: "VKn3n7f8eM3JdjdHi6CSFsRTRIBtt1Nob_iPGjKAmPA",
          userName: "Alice Anders",
          userEmail: "alice@azx.dev",
          userKind: "user" as const,
        },
        { ipHash: "abc" },
        "prod",
      );
      // Raw SQL as the owner, because the quoted camelCase identifiers in the
      // INSERT are only validated at runtime.
      const r = await owner.query(
        `SELECT "userOid", "userName", "userEmail", "userKind"
           FROM app_collection_items WHERE "appId" = $1 AND collection = 'labelled'`,
        [APP],
      );
      expect(r.rows[0]).toEqual({
        userOid: "VKn3n7f8eM3JdjdHi6CSFsRTRIBtt1Nob_iPGjKAmPA",
        userName: "Alice Anders",
        userEmail: "alice@azx.dev",
        userKind: "user",
      });
    } finally {
      await owner.query(`DELETE FROM app_collection_items WHERE "appId" = $1`, [APP]);
      await owner.end();
      await s.close();
    }
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
          `SELECT item, "userOid", "userName", "userEmail", "userKind", meta
             FROM app_collection_items WHERE "appId" = $1`,
          [APP],
        );
        expect(r.rows).toHaveLength(1);
        expect((r.rows[0] as { item: unknown }).item).toEqual({ email: "lead@x.z" });
        expect((r.rows[0] as { userOid: string | null }).userOid).toBeNull();
        // A null submitter means no display half and no kind either — all of them
        // or none, which is why `appendCollection` takes one argument, not four.
        expect(
          r.rows[0] as {
            userName: string | null;
            userEmail: string | null;
            userKind: string | null;
          },
        ).toMatchObject({ userName: null, userEmail: null, userKind: null });
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

  it("listShared: prefix-scoped, shared-only, this app only, values never selected (ADR-0042)", async () => {
    if (!(await edgeRoleAvailable())) return;
    const s = new PgAppDataStore(edgeUrl(), { max: 1 });
    try {
      // A user-scoped row whose KEY matches the prefix, a sibling app's shared
      // row, and an out-of-prefix shared key: none of them may be listed.
      await s.putUserKey(APP, "alice", "record:mine", 1, "prod", { kind: "none" });
      await s.putShared(OTHER_APP, "record:theirs", 1, "prod", { kind: "ifNoneMatch" });
      await s.putShared(LIST_APP, "journal:1", 1, "prod", { kind: "ifNoneMatch" });
      await s.putShared(LIST_APP, "record:b", { v: 2 }, "prod", { kind: "ifNoneMatch" });
      const first = await s.putShared(LIST_APP, "record:a", { v: 1 }, "prod", {
        kind: "ifNoneMatch",
      });
      expect(first).toMatchObject({ kind: "ok", version: "1" });
      await s.putShared(LIST_APP, "record:a", { v: 1.1 }, "prod", {
        kind: "ifMatch",
        version: "1",
      });

      const page = await s.listShared(LIST_APP, "record:", null, "prod");
      expect(page.nextCursor).toBeUndefined();
      expect(page.keys).toHaveLength(2);
      expect(page.keys.map((k) => k.key)).toEqual(["record:a", "record:b"]);
      // version is the bumped counter, still a string; updatedAt is ISO.
      expect(page.keys[0]).toMatchObject({ key: "record:a", version: "2" });
      expect(typeof page.keys[0]!.updatedAt).toBe("string");
      // Keys-only: the VALUES column is never selected, and the projection
      // cannot accidentally widen without this failing.
      expect(Object.keys(page.keys[0]!).sort()).toEqual(["key", "updatedAt", "version"]);
    } finally {
      await s.close();
    }
  });

  it("listShared: the prefix is a LITERAL starts_with, never LIKE metacharacters", async () => {
    if (!(await edgeRoleAvailable())) return;
    const s = new PgAppDataStore(edgeUrl(), { max: 1 });
    try {
      // With a LIKE-built predicate, `record:100_` would also match
      // `record:100Xc` (the underscore is a one-char wildcard). `starts_with`
      // has no metacharacters — the whole reason it was chosen.
      await s.putShared(LIST_APP, "record:100_pc", 1, "prod", { kind: "ifNoneMatch" });
      await s.putShared(LIST_APP, "record:100Xc", 2, "prod", { kind: "ifNoneMatch" });
      const page = await s.listShared(LIST_APP, "record:100_", null, "prod");
      expect(page.keys.map((k) => k.key)).toEqual(["record:100_pc"]);
    } finally {
      await s.close();
    }
  });

  it(
    'listShared: keyset pagination walks every row exactly once, in COLLATE "C" order',
    // 205 seeded writes, each a 4-round-trip partition transaction — comfortably
    // over the 5s default, so the test owns its budget explicitly.
    { timeout: 30_000 },
    async () => {
      if (!(await edgeRoleAvailable())) return;
      const s = new PgAppDataStore(edgeUrl(), { max: 2 });
      try {
        // 205 rows: one full page (200), a 5-row tail, and a mid-walk boundary.
        const total = 205;
        for (let i = 0; i < total; i++) {
          const r = await s.putShared(
            PAGING_APP,
            `record:${String(i).padStart(3, "0")}`,
            i,
            "prod",
            {
              kind: "ifNoneMatch",
            },
          );
          if (r.kind !== "ok") throw new Error("seed failed");
        }

        const seen: string[] = [];
        let afterKey: string | null = null;
        let pages = 0;
        for (;;) {
          const page = await s.listShared(PAGING_APP, "record:", afterKey, "prod");
          pages += 1;
          expect(page.keys.length).toBeGreaterThan(0);
          seen.push(...page.keys.map((k) => k.key));
          if (page.nextCursor === undefined) break;
          // Opaque: not the bare key, not readable as one.
          expect(page.nextCursor).not.toContain("record:");
          // The store's contract is the DECODED key (the handler owns the
          // opaque-cursor decode); a cursor the store itself emitted must
          // round-trip through the same decoder the handler uses.
          afterKey = decodeListCursor(page.nextCursor);
          if (afterKey === null) throw new Error("store emitted an undecodable cursor");
        }

        expect(pages).toBe(2);
        expect(seen).toHaveLength(total);
        // Exactly once, ascending — the composite-safe property the collection
        // drain's `?before=` lacks (TODO.md): no skips, no replays at boundaries.
        expect(new Set(seen).size).toBe(total);
        expect([...seen].sort()).toEqual(seen);
      } finally {
        await s.close();
      }
    },
  );

  it('listShared: ordering is bytewise (COLLATE "C"), not the database\'s locale collation', async () => {
    if (!(await edgeRoleAvailable())) return;
    const s = new PgAppDataStore(edgeUrl(), { max: 1 });
    try {
      for (const key of ["record:z", "record:A", "record:0", "record:a"]) {
        await s.putShared(ORDER_APP, key, 1, "prod", { kind: "ifNoneMatch" });
      }
      const page = await s.listShared(ORDER_APP, "record:", null, "prod");
      // Bytewise: digits before capitals before lowercase. A linguistic
      // collation could reorder "A"/"a" — pinning this order is what keeps the
      // SQL keyset and the in-memory fake's code-unit comparison in agreement,
      // whatever collation the deployment's database happens to default to.
      expect(page.keys.map((k) => k.key)).toEqual(["record:0", "record:A", "record:a", "record:z"]);
    } finally {
      await s.close();
    }
  });
});
