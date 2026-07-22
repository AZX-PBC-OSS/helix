import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../app.js";
import { SESSION_COOKIE } from "../auth/cookies.js";
import { hashSessionToken, newSessionToken } from "../auth/sessions.js";
import { testAuthConfig, testEdgeConfig } from "../test/config.js";
import type { DataCapability } from "@azx-pbc/shared";
import {
  FakeAppDataStore,
  FakeBlobReader,
  FakeOidcClient,
  FakeRegistry,
  FakeSessionStore,
  FakeUsageStore,
  registryEntry,
} from "../test/fakes.js";

/**
 * The `/_api/data/user/*` capability (app-data design §3.1/§5). Per-user private
 * KV: gated, caller-scoped, partitioned by the session user — never by app
 * input. Plus the structural §3.2 assertion: no collection read/list verb
 * exists on the edge. Fakes for the store and ledger — no DB; the RLS partition
 * invariant is proven against real Postgres in data.integration.test.ts.
 */

const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PREFIX = "apps/c/1/";
const HOST = "notes.local.helix.azxlabs.io";
const ORIGIN = "https://notes.local.helix.azxlabs.io:8080";

interface DataEdge {
  app: FastifyInstance;
  sessions: FakeSessionStore;
  store: FakeAppDataStore;
  usage: FakeUsageStore;
}

function buildDataEdge(
  opts: {
    data?: DataCapability | null;
    visibilityMode?: "private" | "public";
    withStore?: boolean;
  } = {},
): DataEdge {
  const sessions = new FakeSessionStore();
  const store = new FakeAppDataStore();
  const usage = new FakeUsageStore();
  const data =
    opts.data === undefined
      ? { user: true, collections: [], sharedRead: [], sharedWrite: [] }
      : opts.data;
  const app = buildApp({
    config: testEdgeConfig({ auth: testAuthConfig(), allowUnauthenticated: false }),
    registry: new FakeRegistry([
      registryEntry({
        appId: APP_ID,
        slug: "notes",
        blobPrefix: PREFIX,
        visibilityMode: opts.visibilityMode ?? "private",
        data,
      }),
    ]),
    blob: new FakeBlobReader(),
    sessions,
    oidc: new FakeOidcClient(),
    usage,
    appData: opts.withStore === false ? null : store,
  });
  return { app, sessions, store, usage };
}

async function seedSession(sessions: FakeSessionStore, oid: string): Promise<string> {
  const id = randomUUID();
  await sessions.createPending({
    id,
    appId: APP_ID,
    user: { oid, displayName: oid, groups: [] },
    refreshDueAt: new Date(Date.now() + 60_000),
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  const token = newSessionToken();
  await sessions.redeem(id, APP_ID, hashSessionToken(token));
  return token;
}

function req(
  edge: DataEdge,
  method: string,
  url: string,
  opts: { token?: string | null; origin?: string | null; payload?: unknown } = {},
): Promise<LightMyRequestResponse> {
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  return edge.app.inject({
    method: method as "GET",
    url,
    headers: {
      host: HOST,
      "sec-fetch-mode": "cors",
      // Only declare a JSON body when one is actually sent — Fastify 400s an
      // empty body when content-type is application/json.
      ...(opts.payload !== undefined ? { "content-type": "application/json" } : {}),
      ...(origin ? { origin } : {}),
      ...(opts.token ? { cookie: `${SESSION_COOKIE}=${opts.token}` } : {}),
    },
    ...(opts.payload !== undefined ? { payload: opts.payload as object } : {}),
  });
}

describe("user-scope happy path", () => {
  it("round-trips put → get → list → delete for the caller", async () => {
    const edge = buildDataEdge();
    const token = await seedSession(edge.sessions, "alice");

    const put = await req(edge, "PUT", "/_api/data/user/todo", {
      token,
      payload: ["milk", "eggs"],
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().key).toBe("todo");

    const get = await req(edge, "GET", "/_api/data/user/todo", { token });
    expect(get.statusCode).toBe(200);
    expect(get.json().value).toEqual(["milk", "eggs"]);
    expect(get.headers["cache-control"]).toBe("no-store");

    const list = await req(edge, "GET", "/_api/data/user", { token });
    expect(list.json().keys.map((k: { key: string }) => k.key)).toEqual(["todo"]);

    const del = await req(edge, "DELETE", "/_api/data/user/todo", { token });
    expect(del.statusCode).toBe(204);

    const after = await req(edge, "GET", "/_api/data/user/todo", { token });
    expect(after.statusCode).toBe(404);

    expect(edge.usage.records.every((r) => r.capability === "data")).toBe(true);
  });

  it("partitions by session user — one user's key is invisible to another", async () => {
    const edge = buildDataEdge();
    const aliceTok = await seedSession(edge.sessions, "alice");
    const bobTok = await seedSession(edge.sessions, "bob");

    await req(edge, "PUT", "/_api/data/user/secret", { token: aliceTok, payload: "alice-only" });

    // Bob asks for the same key path — the partition comes from HIS session, so
    // he gets his own (absent) row, never alice's.
    const bobGet = await req(edge, "GET", "/_api/data/user/secret", { token: bobTok });
    expect(bobGet.statusCode).toBe(404);
  });
});

describe("authz + validation", () => {
  it("401s an unauthenticated fetch on a private app", async () => {
    const edge = buildDataEdge();
    const res = await req(edge, "GET", "/_api/data/user/x", { token: null });
    expect(res.statusCode).toBe(401);
  });

  it("403s user-scope on a public app (no anon identity — §6)", async () => {
    const edge = buildDataEdge({ visibilityMode: "public" });
    // Public app: caller is anon, gate is skipped, but user scope needs a user.
    const res = await req(edge, "GET", "/_api/data/user/x", { token: null });
    expect(res.statusCode).toBe(403);
  });

  it("403s when the app has no data.user grant", async () => {
    const edge = buildDataEdge({
      data: { user: false, collections: ["c"], sharedRead: [], sharedWrite: [] },
    });
    const token = await seedSession(edge.sessions, "alice");
    const res = await req(edge, "GET", "/_api/data/user/x", { token });
    expect(res.statusCode).toBe(403);
  });

  it("403s when the app has no data capability at all", async () => {
    const edge = buildDataEdge({ data: null });
    const token = await seedSession(edge.sessions, "alice");
    const res = await req(edge, "GET", "/_api/data/user/x", { token });
    expect(res.statusCode).toBe(403);
  });

  it("503s when the store is not configured", async () => {
    const edge = buildDataEdge({ withStore: false });
    const token = await seedSession(edge.sessions, "alice");
    const res = await req(edge, "GET", "/_api/data/user/x", { token });
    expect(res.statusCode).toBe(503);
  });

  it("403s a cross-origin write (CSRF), but allows same-origin", async () => {
    const edge = buildDataEdge();
    const token = await seedSession(edge.sessions, "alice");
    const evil = await req(edge, "PUT", "/_api/data/user/x", {
      token,
      origin: "https://evil.example.com",
      payload: 1,
    });
    expect(evil.statusCode).toBe(403);
  });

  it("400s an oversized value", async () => {
    const edge = buildDataEdge();
    const token = await seedSession(edge.sessions, "alice");
    const big = "x".repeat(70 * 1024);
    const res = await req(edge, "PUT", "/_api/data/user/big", { token, payload: big });
    expect(res.statusCode).toBe(400);
  });

  it("400s a value under the UTF-16 length cap but over the UTF-8 byte cap (issue #12)", async () => {
    const edge = buildDataEdge();
    const token = await seedSession(edge.sessions, "alice");
    // 25 000 × '中' (3 UTF-8 bytes each). Serialized: ~25 008 UTF-16 code units
    // (under the 64 KiB cap — the old `String.length` check would admit it) but
    // ~75 008 bytes on disk (over it). The byte-based cap must reject it.
    const value = { s: "中".repeat(25_000) };
    const res = await req(edge, "PUT", "/_api/data/user/cjk", { token, payload: value });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "validation_failed" } });
  });
});

describe("collection append (§3.2)", () => {
  const HARVEST = { user: false, collections: ["contacts"], sharedRead: [], sharedWrite: [] };

  it("lets an anonymous visitor append to a public app's collection", async () => {
    const edge = buildDataEdge({ visibilityMode: "public", data: HARVEST });
    const res = await req(edge, "POST", "/_api/data/collections/contacts", {
      token: null,
      origin: ORIGIN,
      payload: { email: "lead@example.com" },
    });
    expect(res.statusCode).toBe(201);
    expect(edge.store.collectionItems).toHaveLength(1);
    expect(edge.store.collectionItems[0]?.item).toEqual({ email: "lead@example.com" });
    // No anon identity — the row is unattributed; metered as anon.
    expect(edge.store.collectionItems[0]?.userOid).toBeNull();
    expect(edge.usage.records.at(-1)).toMatchObject({ capability: "data", userOid: "anon" });
    // Server-stamped triage metadata, never echoed to the client.
    expect(res.body).toBe("");
  });

  it("attributes the item to a signed-in visitor when there is one", async () => {
    const edge = buildDataEdge({ data: HARVEST });
    const token = await seedSession(edge.sessions, "alice");
    const res = await req(edge, "POST", "/_api/data/collections/contacts", {
      token,
      payload: { email: "alice@example.com" },
    });
    expect(res.statusCode).toBe(201);
    expect(edge.store.collectionItems[0]?.userOid).toBe("alice");
  });

  it("403s an undeclared collection name", async () => {
    const edge = buildDataEdge({ visibilityMode: "public", data: HARVEST });
    const res = await req(edge, "POST", "/_api/data/collections/secrets", {
      token: null,
      payload: { x: 1 },
    });
    expect(res.statusCode).toBe(403);
  });

  it("403s a cross-origin append (CSRF)", async () => {
    const edge = buildDataEdge({ visibilityMode: "public", data: HARVEST });
    const res = await req(edge, "POST", "/_api/data/collections/contacts", {
      token: null,
      origin: "https://evil.example.com",
      payload: { x: 1 },
    });
    expect(res.statusCode).toBe(403);
    expect(edge.store.collectionItems).toHaveLength(0);
  });
});

describe("shared scope (§3.3)", () => {
  const SHARED = {
    user: false,
    collections: [],
    sharedRead: ["leaderboard"],
    sharedWrite: ["poll"],
  };

  it("reads a shared key on a public app anonymously", async () => {
    const edge = buildDataEdge({ visibilityMode: "public", data: SHARED });
    await edge.store.putShared(APP_ID, "leaderboard", [{ name: "ada", score: 10 }]);
    const res = await req(edge, "GET", "/_api/data/shared/leaderboard", { token: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().value).toEqual([{ name: "ada", score: 10 }]);
  });

  it("403s a key that isn't shared-readable", async () => {
    const edge = buildDataEdge({ visibilityMode: "public", data: SHARED });
    const res = await req(edge, "GET", "/_api/data/shared/poll", { token: null });
    expect(res.statusCode).toBe(403);
  });

  it("writes a shared-writable key, then reads it back", async () => {
    const edge = buildDataEdge({
      visibilityMode: "public",
      data: { ...SHARED, sharedRead: ["poll"] },
    });
    const put = await req(edge, "PUT", "/_api/data/shared/poll", {
      token: null,
      payload: { yes: 1 },
    });
    expect(put.statusCode).toBe(200);
    const get = await req(edge, "GET", "/_api/data/shared/poll", { token: null });
    expect(get.json().value).toEqual({ yes: 1 });
  });

  it("403s a write to a non-shared-writable key", async () => {
    const edge = buildDataEdge({ visibilityMode: "public", data: SHARED });
    const res = await req(edge, "PUT", "/_api/data/shared/leaderboard", {
      token: null,
      payload: 1,
    });
    expect(res.statusCode).toBe(403);
  });

  it("403s a cross-origin shared write (CSRF)", async () => {
    const edge = buildDataEdge({ visibilityMode: "public", data: SHARED });
    const res = await req(edge, "PUT", "/_api/data/shared/poll", {
      token: null,
      origin: "https://evil.example.com",
      payload: 1,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("writesPerDay budget (§7)", () => {
  it("429s a write once the per-app daily budget is exhausted", async () => {
    const edge = buildDataEdge({
      visibilityMode: "public",
      data: {
        user: false,
        collections: ["contacts"],
        sharedRead: [],
        sharedWrite: [],
        writesPerDay: 2,
      },
    });
    edge.usage.writesToday = 2; // already at budget
    const res = await req(edge, "POST", "/_api/data/collections/contacts", {
      token: null,
      payload: { email: "x@y.z" },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("quota_exceeded");
    // The block is recorded, and nothing was written.
    expect(edge.store.collectionItems).toHaveLength(0);
    expect(edge.usage.records.at(-1)).toMatchObject({
      outcome: "quota_blocked",
      capability: "data",
    });
  });

  it("admits a write while under budget", async () => {
    const edge = buildDataEdge({
      visibilityMode: "public",
      data: {
        user: false,
        collections: ["contacts"],
        sharedRead: [],
        sharedWrite: [],
        writesPerDay: 5,
      },
    });
    edge.usage.writesToday = 1;
    const res = await req(edge, "POST", "/_api/data/collections/contacts", {
      token: null,
      payload: { email: "x@y.z" },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("adversarial: no collection read verb exists on the edge", () => {
  it("404s GET/DELETE on a collection path — only POST (append) exists", async () => {
    const edge = buildDataEdge({
      data: { user: true, collections: ["contacts"], sharedRead: [], sharedWrite: [] },
    });
    const token = await seedSession(edge.sessions, "alice");
    for (const method of ["GET", "DELETE"] as const) {
      const res = await req(edge, method, "/_api/data/collections/contacts", { token });
      // No such route — the platform namespace 404s rather than reaching a verb.
      expect([404, 405]).toContain(res.statusCode);
    }
  });
});
