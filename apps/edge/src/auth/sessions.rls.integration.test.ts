import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  hashSessionToken,
  newSessionId,
  newSessionToken,
  PgSessionStore,
  type Session,
} from "./sessions.js";
import { deleteApp, seedApp, TEST_DATABASE_URL } from "../test/seed.js";

/**
 * Sessions against real Postgres as the least-privilege `helix_edge` role, so
 * this exercises the actual RLS policy + the SECURITY DEFINER read/sweep
 * functions (ADR-0002 ISSUE-12), not just the hand-written WHERE. The plain
 * sessions.integration.test.ts runs as the superuser owner (bypasses RLS) and
 * covers store behavior; this file is the isolation half. Skips when the runtime
 * role isn't provisioned (CI without db-init).
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

/** Build a Session for the given app; user/expiry are unremarkable. */
function makeSession(appId: string): Session {
  const hour = 60 * 60 * 1000;
  return {
    id: newSessionId(),
    appId,
    user: { oid: "oid-alice", displayName: "Alice", groups: [] },
    refreshDueAt: new Date(Date.now() + hour),
    expiresAt: new Date(Date.now() + hour),
  };
}

let owner: Pool;
let store: PgSessionStore | null = null;
let appA = "";
let appB = "";

beforeAll(async () => {
  owner = new Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
});

afterAll(async () => {
  await store?.close();
  if (appA) await deleteApp(owner, appA);
  if (appB) await deleteApp(owner, appB);
  await owner.end();
});

describe("PgSessionStore as helix_edge (RLS-backed)", () => {
  it("creates, looks up, and isolates sessions by app partition", async () => {
    if (!(await edgeRoleAvailable())) return;
    ({ appId: appA } = await seedApp(owner));
    ({ appId: appB } = await seedApp(owner));
    store = new PgSessionStore(edgeUrl(), { max: 2 });

    const token = newSessionToken();
    const session = makeSession(appA);
    // The INSERT lands only because withPartition sets app.app_id = appA (the
    // WITH CHECK); a mismatch is rejected (asserted below).
    await store.createActive(session, hashSessionToken(token));

    // The gate's read path (SECURITY DEFINER session_lookup) finds it…
    const found = await store.lookup(hashSessionToken(token), appA);
    expect(found?.id).toBe(session.id);
    expect(found?.appId).toBe(appA);

    // …but the same token hash under another app returns nothing — the function
    // binds the appId, so a cross-app read is impossible even with the hash.
    expect(await store.lookup(hashSessionToken(token), appB)).toBeNull();
  });

  it("fails closed: a bare dump of the table with no partition GUC sees nothing", async () => {
    if (!(await edgeRoleAvailable())) return;
    // A row exists (previous test). helix_edge cannot enumerate the table: the
    // partition policy scopes a no-GUC SELECT to zero rows.
    const pool = new Pool({ connectionString: edgeUrl(), max: 1 });
    try {
      const r = await pool.query(`SELECT count(*)::int AS n FROM sessions`);
      expect((r.rows[0] as { n: number }).n).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it("rejects a forged session INSERT into another app's partition (WITH CHECK)", async () => {
    if (!(await edgeRoleAvailable())) return;
    const pool = new Pool({ connectionString: edgeUrl(), max: 1 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.app_id', $1, true)", [appA]);
      // GUC says appA, but the row targets appB — a confused/forged appId can't
      // mint a session for another app.
      await expect(
        client.query(
          `INSERT INTO sessions (id, "tokenHash", "appId", "userOid", "displayName", groups, "activatedAt", "refreshDueAt", "expiresAt")
             VALUES ($1, 'forged', $2, 'x', 'X', '[]'::jsonb, now(), now() + interval '1 hour', now() + interval '1 hour')`,
          [newSessionId(), appB],
        ),
      ).rejects.toThrow(/row-level security/i);
      await client.query("ROLLBACK");
    } finally {
      client.release();
      await pool.end();
    }
  });

  it("sweep() GCs expired/stale rows across all apps but leaves live ones", async () => {
    if (!(await edgeRoleAvailable())) return;
    const s = store ?? new PgSessionStore(edgeUrl(), { max: 1 });
    store = s;

    // Seed an expired session in each app + a stale never-redeemed pending, as
    // the owner (the edge can't write another app's partition without its GUC).
    for (const appId of [appA, appB]) {
      await owner.query(
        `INSERT INTO sessions (id, "tokenHash", "appId", "userOid", "displayName", groups, "activatedAt", "refreshDueAt", "expiresAt")
           VALUES (gen_random_uuid(), $1, $2, 'u', 'U', '[]'::jsonb, now(), now() - interval '2 day', now() - interval '2 day')`,
        [`expired-${appId}`, appId],
      );
    }
    await owner.query(
      `INSERT INTO sessions (id, "appId", "userOid", "displayName", groups, "refreshDueAt", "expiresAt", "createdAt")
         VALUES (gen_random_uuid(), $1, 'u', 'U', '[]'::jsonb, now() + interval '1 hour', now() + interval '1 hour', now() - interval '20 minutes')`,
      [appA],
    );

    const removed = await s.sweep();
    // 2 expired + 1 stale pending.
    expect(removed).toBeGreaterThanOrEqual(3);

    // The live session from the first test survives (counted as owner).
    const live = await owner.query(
      `SELECT count(*)::int AS n FROM sessions WHERE "appId" = ANY($1::uuid[]) AND "expiresAt" > now()`,
      [[appA, appB]],
    );
    expect((live.rows[0] as { n: number }).n).toBe(1);
  });
});
