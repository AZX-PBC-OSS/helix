import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgSessionStore, hashSessionToken, newSessionToken, type Session } from "./sessions.js";
import { TEST_DATABASE_URL, deleteApp, seedApp } from "../test/seed.js";

// Real-Postgres coverage for the session lifecycle — the redeem UPDATE's
// atomicity is the single-use property of the whole handoff design, so it is
// proven here against the actual database, including a concurrent race.

let pool: Pool;
let store: PgSessionStore;
let appId: string;
let otherAppId: string;

function pendingSession(overrides: Partial<Session> = {}): Session {
  return {
    id: randomUUID(),
    appId,
    user: {
      oid: "oid-1",
      displayName: "Alice Anders",
      name: "Alice Anders",
      email: "alice@azx.dev",
      groups: ["eng-team"],
    },
    refreshDueAt: new Date(Date.now() + 60 * 60 * 1000),
    expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
    ...overrides,
  };
}

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
  store = new PgSessionStore(TEST_DATABASE_URL, { max: 8 });
  appId = (await seedApp(pool)).appId;
  otherAppId = (await seedApp(pool)).appId;
});

afterAll(async () => {
  await deleteApp(pool, appId); // sessions cascade
  await deleteApp(pool, otherAppId);
  await store.close();
  await pool.end();
});

describe("PgSessionStore", () => {
  it("round-trips create-pending → redeem → lookup", async () => {
    const session = pendingSession();
    await store.createPending(session);

    const token = newSessionToken();
    const hash = hashSessionToken(token);
    // Pending rows are invisible to lookup.
    expect(await store.lookup(hash, appId)).toBeNull();

    expect(await store.redeem(session.id, appId, hash)).toBe(true);

    const found = await store.lookup(hash, appId);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(session.id);
    expect(found?.user).toEqual(session.user);
    expect(found?.expiresAt.getTime()).toBeCloseTo(session.expiresAt.getTime(), -3);
  });

  it("createActive inserts an immediately-live session (the password flow)", async () => {
    const session = pendingSession({
      user: { oid: "pw_abc123", displayName: "Guest", name: null, email: null, groups: [] },
    });
    const token = newSessionToken();
    const hash = hashSessionToken(token);
    await store.createActive(session, hash);
    // No redeem needed — it's live on the next lookup.
    const found = await store.lookup(hash, appId);
    expect(found?.id).toBe(session.id);
    expect(found?.user).toEqual({
      oid: "pw_abc123",
      displayName: "Guest",
      name: null,
      email: null,
      groups: [],
    });
  });

  it("refuses a second redeem of the same id (replay)", async () => {
    const session = pendingSession();
    await store.createPending(session);
    expect(await store.redeem(session.id, appId, hashSessionToken(newSessionToken()))).toBe(true);
    expect(await store.redeem(session.id, appId, hashSessionToken(newSessionToken()))).toBe(false);
  });

  it("lets exactly one of N concurrent redeems win", async () => {
    const session = pendingSession();
    await store.createPending(session);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.redeem(session.id, appId, hashSessionToken(newSessionToken())),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("refuses to redeem for a different app (audience confusion, row level)", async () => {
    const session = pendingSession();
    await store.createPending(session);
    expect(await store.redeem(session.id, otherAppId, hashSessionToken(newSessionToken()))).toBe(
      false,
    );
    // Still pending — the failed attempt must not burn it for the right app.
    expect(await store.redeem(session.id, appId, hashSessionToken(newSessionToken()))).toBe(true);
  });

  it("scopes lookup to the app", async () => {
    const session = pendingSession();
    await store.createPending(session);
    const hash = hashSessionToken(newSessionToken());
    await store.redeem(session.id, appId, hash);
    expect(await store.lookup(hash, appId)).not.toBeNull();
    expect(await store.lookup(hash, otherAppId)).toBeNull();
  });

  it("never returns an expired session, and delete is a real logout", async () => {
    const expired = pendingSession({ expiresAt: new Date(Date.now() - 1000) });
    await store.createPending(expired);
    // Redeem refuses expired pendings outright.
    expect(await store.redeem(expired.id, appId, hashSessionToken("t"))).toBe(false);

    const session = pendingSession();
    await store.createPending(session);
    const hash = hashSessionToken(newSessionToken());
    await store.redeem(session.id, appId, hash);
    await store.delete(hash, appId);
    expect(await store.lookup(hash, appId)).toBeNull();
  });

  it("sweeps stale pendings and long-expired sessions", async () => {
    const staleId = randomUUID();
    await pool.query(
      `INSERT INTO sessions (id, "appId", "userOid", "displayName", "createdAt", "refreshDueAt", "expiresAt")
       VALUES ($1, $2, 'o', 'd', now() - interval '11 minutes', now(), now() + interval '1 hour')`,
      [staleId, appId],
    );
    const deadId = randomUUID();
    await pool.query(
      `INSERT INTO sessions (id, "tokenHash", "appId", "userOid", "displayName", "createdAt", "refreshDueAt", "expiresAt")
       VALUES ($1, $2, $3, 'o', 'd', now() - interval '3 days', now() - interval '2 days', now() - interval '2 days')`,
      [deadId, `dead-${deadId}`, appId],
    );

    await store.sweep();
    const { rows } = await pool.query(`SELECT id FROM sessions WHERE id = ANY($1)`, [
      [staleId, deadId],
    ]);
    expect(rows).toHaveLength(0);
  });
});
