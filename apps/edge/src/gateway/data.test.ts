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
 * The `/_api/data/*` capability (app-data design §3/§5): per-user private KV
 * (§3.1, gated, caller-scoped, partitioned by the session user — never by app
 * input), the structural §3.2 assertion that no collection read/list verb
 * exists on the edge, and the ADR-0041 write-concurrency contract (CAS on an
 * opaque version, mandatory preconditions on `shared`, 412s that are
 * ledger-visible but never charged).
 * Fakes for the store and ledger — no DB; the RLS partition invariant and the
 * real row-lock CAS semantics are proven against real Postgres in
 * data.integration.test.ts.
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

/**
 * A `DataCapability` with every array defaulted (ADR-0042 added two more), so a
 * test states only what it cares about and the literal noise stays out of the
 * assertions.
 */
function dataCap(overrides: Partial<DataCapability> = {}): DataCapability {
  return {
    user: false,
    collections: [],
    sharedRead: [],
    sharedWrite: [],
    sharedReadPrefixes: [],
    sharedWritePrefixes: [],
    ...overrides,
  };
}

function buildDataEdge(
  opts: {
    data?: Partial<DataCapability> | null;
    visibilityMode?: "internal" | "public";
    withStore?: boolean;
  } = {},
): DataEdge {
  const sessions = new FakeSessionStore();
  const store = new FakeAppDataStore();
  const usage = new FakeUsageStore();
  const data =
    opts.data === undefined
      ? dataCap({ user: true })
      : opts.data === null
        ? null
        : dataCap(opts.data);
  const app = buildApp({
    config: testEdgeConfig({ auth: testAuthConfig(), allowUnauthenticated: false }),
    registry: new FakeRegistry([
      registryEntry({
        appId: APP_ID,
        slug: "notes",
        blobPrefix: PREFIX,
        visibilityMode: opts.visibilityMode ?? "internal",
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
    user: { oid, displayName: oid, name: null, email: null, kind: "user", groups: [] },
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
  opts: {
    token?: string | null;
    origin?: string | null;
    payload?: unknown;
    headers?: Record<string, string>;
  } = {},
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
      ...opts.headers,
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
  it("401s an unauthenticated fetch on an internal app", async () => {
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
    expect(edge.store.collectionItems[0]?.submitter?.userOid ?? null).toBeNull();
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
    expect(edge.store.collectionItems[0]?.submitter?.userOid ?? null).toBe("alice");
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
    await edge.store.putShared(APP_ID, "leaderboard", [{ name: "ada", score: 10 }], "prod", {
      kind: "ifNoneMatch",
    });
    const res = await req(edge, "GET", "/_api/data/shared/leaderboard", { token: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().value).toEqual([{ name: "ada", score: 10 }]);
    // The concurrency token rides the ETag (ADR-0041 decision 2) — a string,
    // quoted, so the client can hand it straight back as If-Match.
    expect(res.headers.etag).toBe('"1"');
  });

  it("403s a key that isn't shared-readable", async () => {
    const edge = buildDataEdge({ visibilityMode: "public", data: SHARED });
    const res = await req(edge, "GET", "/_api/data/shared/poll", { token: null });
    expect(res.statusCode).toBe(403);
  });

  it("creates a shared-writable key with If-None-Match: *, then reads it back", async () => {
    const edge = buildDataEdge({
      visibilityMode: "public",
      data: { ...SHARED, sharedRead: ["poll"] },
    });
    const put = await req(edge, "PUT", "/_api/data/shared/poll", {
      token: null,
      payload: { yes: 1 },
      headers: { "if-none-match": "*" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.headers.etag).toBe('"1"');
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

describe("shared prefix grants + list verb (ADR-0042)", () => {
  const PREFIXED = {
    user: false,
    collections: [],
    sharedRead: ["leaderboard"],
    sharedWrite: [],
    sharedReadPrefixes: ["record:"],
    sharedWritePrefixes: ["record:"],
  };
  const CREATE = { "if-none-match": "*" };

  it("reads and writes runtime-invented keys under a granted prefix", async () => {
    const edge = buildDataEdge({ visibilityMode: "public", data: PREFIXED });
    // Create-if-absent on a natural key — the cross-record dedup ADR-0041
    // identified as a good fit but could not enable while grants were literal.
    const put = await req(edge, "PUT", "/_api/data/shared/record:abc", {
      token: null,
      payload: { title: "first" },
      headers: CREATE,
    });
    expect(put.statusCode).toBe(200);
    expect(put.headers.etag).toBe('"1"');

    const get = await req(edge, "GET", "/_api/data/shared/record:abc", { token: null });
    expect(get.statusCode).toBe(200);
    expect(get.json().value).toEqual({ title: "first" });
  });

  it("a second create on the same natural key loses the race (412 + currentVersion)", async () => {
    const edge = buildDataEdge({ visibilityMode: "public", data: PREFIXED });
    await req(edge, "PUT", "/_api/data/shared/record:abc", {
      token: null,
      payload: { title: "first" },
      headers: CREATE,
    });
    const again = await req(edge, "PUT", "/_api/data/shared/record:abc", {
      token: null,
      payload: { title: "duplicate" },
      headers: CREATE,
    });
    expect(again.statusCode).toBe(412);
    expect(again.json().error.details).toEqual({ currentVersion: "1" });
  });

  it("403s an overlapping-but-uncovered key — startsWith is exact, not a fuzzy match", async () => {
    const edge = buildDataEdge({ visibilityMode: "public", data: PREFIXED });
    // "records:x" shares six characters with the "record:" grant but does not
    // START with it — the difference between a namespace and a guess.
    const get = await req(edge, "GET", "/_api/data/shared/records:x", { token: null });
    expect(get.statusCode).toBe(403);
    const put = await req(edge, "PUT", "/_api/data/shared/records:x", {
      token: null,
      payload: 1,
      headers: CREATE,
    });
    expect(put.statusCode).toBe(403);
  });

  it("literals and prefixes compose — either grant suffices for its half", async () => {
    const edge = buildDataEdge({ visibilityMode: "public", data: PREFIXED });
    await edge.store.putShared(APP_ID, "leaderboard", ["ada"], "prod", { kind: "ifNoneMatch" });
    // The literal grant still works untouched…
    const literal = await req(edge, "GET", "/_api/data/shared/leaderboard", { token: null });
    expect(literal.statusCode).toBe(200);
    // …and the read prefix does not confer WRITE on anything (independence of
    // the two grants is unchanged by prefixes — ADR-0042 decision 1 rides the
    // ADR-0015 rule).
    const write = await req(edge, "PUT", "/_api/data/shared/leaderboard", {
      token: null,
      payload: 1,
      headers: CREATE,
    });
    expect(write.statusCode).toBe(403);
  });

  it("a literal grant does not confer listing — literals already say what exists", async () => {
    const edge = buildDataEdge({
      visibilityMode: "public",
      data: { user: false, sharedRead: ["leaderboard"] },
    });
    const res = await req(edge, "GET", "/_api/data/shared?prefix=leaderboard", { token: null });
    expect(res.statusCode).toBe(403);
  });

  it("400s a missing, empty or control-character prefix — there is no list-everything form", async () => {
    const edge = buildDataEdge({ visibilityMode: "public", data: PREFIXED });
    const missing = await req(edge, "GET", "/_api/data/shared", { token: null });
    expect(missing.statusCode).toBe(400);
    const empty = await req(edge, "GET", "/_api/data/shared?prefix=", { token: null });
    expect(empty.statusCode).toBe(400);
    const control = await req(edge, "GET", "/_api/data/shared?prefix=record%00", { token: null });
    expect(control.statusCode).toBe(400);
  });

  it("403s an uncovered listing prefix with a forbidden ledger row; an empty result is ok", async () => {
    const edge = buildDataEdge({ visibilityMode: "public", data: PREFIXED });
    const denied = await req(edge, "GET", "/_api/data/shared?prefix=secret:", { token: null });
    expect(denied.statusCode).toBe(403);
    // The deny path is audit-visible (the fetch-proxy allowlist precedent) and
    // distinguishable from an empty listing on the very same dimension.
    expect(edge.usage.records.at(-1)).toMatchObject({
      capability: "data",
      model: "shared.list",
      outcome: "forbidden",
    });

    const empty = await req(edge, "GET", "/_api/data/shared?prefix=record:", { token: null });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ keys: [] });
    expect(edge.usage.records.at(-1)).toMatchObject({
      capability: "data",
      model: "shared.list",
      outcome: "ok",
    });
  });

  it("lists keys and versions under the granted prefix — never values, never other namespaces", async () => {
    const edge = buildDataEdge({ visibilityMode: "public", data: PREFIXED });
    // Seeded straight at the store: rows the handler would never have allowed
    // are exactly the point — the listing must not become a way to discover them.
    for (const [key, value] of [
      ["record:2", { secret: "second-value" }],
      ["record:1", { secret: "first-value" }],
      ["secret:1", { secret: "out-of-grant" }],
      ["other:1", { secret: "also-out-of-grant" }],
    ] as const) {
      await edge.store.putShared(APP_ID, key, value, "prod", { kind: "ifNoneMatch" });
    }

    const res = await req(edge, "GET", "/_api/data/shared?prefix=record:", { token: null });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.nextCursor).toBeUndefined();
    expect(body.keys).toHaveLength(2);
    // Ascending by key; each entry carries exactly the three metadata fields —
    // the VALUES (12 MB at the pilot app's median) are fetched, never listed.
    expect(body.keys.map((k: { key: string }) => k.key)).toEqual(["record:1", "record:2"]);
    for (const entry of body.keys) {
      expect(Object.keys(entry).sort()).toEqual(["key", "updatedAt", "version"]);
      expect(entry.version).toBe("1");
    }
    // The out-of-grant keys and the stored values appear nowhere in the body.
    const dump = JSON.stringify(body);
    expect(dump).not.toContain("secret:1");
    expect(dump).not.toContain("other:1");
    expect(dump).not.toContain("first-value");
  });

  it("a narrower listing prefix than the grant is covered, and lists its subset", async () => {
    const edge = buildDataEdge({ visibilityMode: "public", data: PREFIXED });
    await edge.store.putShared(APP_ID, "record:ab", 1, "prod", { kind: "ifNoneMatch" });
    await edge.store.putShared(APP_ID, "record:cd", 2, "prod", { kind: "ifNoneMatch" });
    const res = await req(edge, "GET", "/_api/data/shared?prefix=record:ab", { token: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().keys.map((k: { key: string }) => k.key)).toEqual(["record:ab"]);
  });

  it("paginates at the page cap: 201 keys → 200 + cursor → 1, no overlap, no end cursor", async () => {
    const edge = buildDataEdge({ visibilityMode: "public", data: PREFIXED });
    // Zero-padded so lexicographic order matches numeric order.
    for (let i = 0; i <= 200; i++) {
      const r = await edge.store.putShared(
        APP_ID,
        `record:${String(i).padStart(3, "0")}`,
        i,
        "prod",
        { kind: "ifNoneMatch" },
      );
      if (r.kind !== "ok") throw new Error("seed failed");
    }

    const page1 = await req(edge, "GET", "/_api/data/shared?prefix=record:", { token: null });
    const body1 = page1.json();
    expect(body1.keys).toHaveLength(200);
    expect(body1.keys[0].key).toBe("record:000");
    expect(body1.keys[199].key).toBe("record:199");
    expect(typeof body1.nextCursor).toBe("string");

    const page2 = await req(
      edge,
      "GET",
      `/_api/data/shared?prefix=record:&cursor=${body1.nextCursor}`,
      { token: null },
    );
    const body2 = page2.json();
    expect(body2.keys).toHaveLength(1);
    expect(body2.keys[0].key).toBe("record:200");
    expect(body2.nextCursor).toBeUndefined();
    // No replay across the boundary either.
    expect(body2.keys[0].key > body1.keys[199].key).toBe(true);
  });

  it("400s a garbage cursor rather than silently restarting the page sequence", async () => {
    const edge = buildDataEdge({ visibilityMode: "public", data: PREFIXED });
    const res = await req(edge, "GET", "/_api/data/shared?prefix=record:&cursor=%21%21%21", {
      token: null,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_failed");
  });
});

describe("write concurrency (ADR-0041)", () => {
  const SHARED_RW = {
    user: false,
    collections: [],
    sharedRead: ["index"],
    sharedWrite: ["index"],
  };
  const CREATE = { "if-none-match": "*" };

  /** Seed a shared key directly at the store; returns its current version. */
  async function seedShared(edge: DataEdge, value: unknown): Promise<string> {
    const r = await edge.store.putShared(APP_ID, "index", value, "prod", { kind: "ifNoneMatch" });
    if (r.kind !== "ok") throw new Error("seed failed");
    return r.version;
  }

  it("GET emits ETag and a CAS write with that version succeeds and bumps it", async () => {
    const edge = buildDataEdge({ visibilityMode: "public", data: SHARED_RW });
    await seedShared(edge, ["alpha"]);

    const get = await req(edge, "GET", "/_api/data/shared/index", { token: null });
    expect(get.headers.etag).toBe('"1"');

    const put = await req(edge, "PUT", "/_api/data/shared/index", {
      token: null,
      payload: ["alpha", "beta"],
      headers: { "if-match": '"1"' },
    });
    expect(put.statusCode).toBe(200);
    // The new version comes back on the write too, so a follow-up write can
    // chain without a re-read.
    expect(put.headers.etag).toBe('"2"');

    const after = await req(edge, "GET", "/_api/data/shared/index", { token: null });
    expect(after.json().value).toEqual(["alpha", "beta"]);
    expect(after.headers.etag).toBe('"2"');
  });

  it("two writers on the same base version: exactly one wins, the loser gets 412", async () => {
    const edge = buildDataEdge({ visibilityMode: "public", data: SHARED_RW });
    await seedShared(edge, ["alpha", "beta"]);

    // The ADR's lost-update scenario: both tabs read v1, both write against it.
    const a = await req(edge, "PUT", "/_api/data/shared/index", {
      token: null,
      payload: ["alpha", "beta", "gamma"],
      headers: { "if-match": '"1"' },
    });
    const b = await req(edge, "PUT", "/_api/data/shared/index", {
      token: null,
      payload: ["alpha", "beta", "delta"],
      headers: { "if-match": '"1"' },
    });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(412);
    expect(b.json().error.code).toBe("conflict");
    // The loser learns what the winner committed — in-band recovery, and the
    // only recovery a sharedWrite-only key has (review finding 2).
    expect(b.json().error.details).toEqual({ currentVersion: "2" });
    // And the collision is VISIBLE: a non-charging conflict row per loser
    // (review finding 4) — one ok + one conflict, in order.
    expect(edge.usage.records.map((r) => r.outcome)).toEqual(["ok", "conflict"]);
    expect(edge.usage.records[1]).toMatchObject({ model: "shared.put", capability: "data" });
    // "gamma" is NOT silently gone — the loser is told to re-read and retry.
  });

  it("412s If-Match against an absent key (the upsert-with-WHERE hole)", async () => {
    const edge = buildDataEdge({ visibilityMode: "public", data: SHARED_RW });
    const res = await req(edge, "PUT", "/_api/data/shared/index", {
      token: null,
      payload: ["alpha"],
      headers: { "if-match": '"1"' },
    });
    expect(res.statusCode).toBe(412);
    // No current row → null, so the client knows to create-if-absent next.
    expect(res.json().error.details).toEqual({ currentVersion: null });
    // And it really did not create the key.
    expect(await req(edge, "GET", "/_api/data/shared/index", { token: null })).toMatchObject({
      statusCode: 404,
    });
  });

  it("412s If-None-Match: * against an existing key", async () => {
    const edge = buildDataEdge({ visibilityMode: "public", data: SHARED_RW });
    await seedShared(edge, ["alpha"]);
    const res = await req(edge, "PUT", "/_api/data/shared/index", {
      token: null,
      payload: ["hijacked"],
      headers: CREATE,
    });
    expect(res.statusCode).toBe(412);
    expect(res.json().error.details).toEqual({ currentVersion: "1" });
    const after = await req(edge, "GET", "/_api/data/shared/index", { token: null });
    expect(after.json().value).toEqual(["alpha"]);
  });

  it("428s a shared write with no precondition — and neither meters nor charges it", async () => {
    const edge = buildDataEdge({
      visibilityMode: "public",
      data: { ...SHARED_RW, writesPerDay: 100 },
    });
    const res = await req(edge, "PUT", "/_api/data/shared/index", {
      token: null,
      payload: ["alpha"],
    });
    expect(res.statusCode).toBe(428);
    expect(res.json().error.code).toBe("precondition_required");
    // Decision 7: no gateway_calls row, and the daily budget is untouched.
    expect(edge.usage.records).toHaveLength(0);
    expect(await edge.usage.dataWritesToday()).toBe(0);
  });

  it("428s If-Match: * on shared — the one-character escape hatch stays closed", async () => {
    const edge = buildDataEdge({ visibilityMode: "public", data: SHARED_RW });
    const res = await req(edge, "PUT", "/_api/data/shared/index", {
      token: null,
      payload: ["alpha"],
      headers: { "if-match": "*" },
    });
    expect(res.statusCode).toBe(428);
    expect(res.json().error.code).toBe("precondition_required");
  });

  it("a 412 loser is visible in the ledger but never charged (ADR-0041 decision 7)", async () => {
    const edge = buildDataEdge({
      visibilityMode: "public",
      data: { ...SHARED_RW, writesPerDay: 5 },
    });
    await seedShared(edge, ["alpha"]);
    const writesBefore = await edge.usage.dataWritesToday();
    const res = await req(edge, "PUT", "/_api/data/shared/index", {
      token: null,
      payload: ["stale"],
      headers: { "if-match": '"99"' },
    });
    expect(res.statusCode).toBe(412);
    // Visible: one conflict row. Not charged: the daily budget counts 'ok'
    // only, so a contended retry loop cannot turn into a quota outage.
    expect(edge.usage.records).toHaveLength(1);
    expect(edge.usage.records[0]).toMatchObject({ outcome: "conflict", model: "shared.put" });
    expect(await edge.usage.dataWritesToday()).toBe(writesBefore);
  });

  it("400s malformed preconditions rather than silently downgrading to LWW", async () => {
    const edge = buildDataEdge({ visibilityMode: "public", data: SHARED_RW });
    await seedShared(edge, ["alpha"]);
    const malformed: Record<string, string>[] = [
      { "if-match": "1" }, // bare number, unquoted
      { "if-match": 'W/"1"' }, // weak validator
      { "if-match": '"1", "2"' }, // ETag list
      { "if-match": '"abc"' }, // non-numeric
      { "if-match": '"007"' }, // non-canonical: a validator never issued (leading zeros)
      { "if-match": '"0"' }, // versions start at 1; 0 is never current
      { "if-match": '"9223372036854775808"' }, // int64 max + 1 → Postgres 22003 if bound
      { "if-match": '"99999999999999999999999"' }, // the review's 23-digit reproducer
      { "if-none-match": '"1"' }, // concrete If-None-Match
      { "if-match": '"1"', "if-none-match": "*" }, // both headers
    ];
    for (const headers of malformed) {
      const res = await req(edge, "PUT", "/_api/data/shared/index", {
        token: null,
        payload: ["x"],
        headers,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("validation_failed");
    }
  });

  it("an in-range but never-current If-Match reaches the store and loses cleanly (412, not 502)", async () => {
    const edge = buildDataEdge({ visibilityMode: "public", data: SHARED_RW });
    await seedShared(edge, ["alpha"]);
    // int64 max: canonical and bindable, so it must exercise the real CAS and
    // lose — not blow up the query (the finding-3 hole was exactly this path).
    const res = await req(edge, "PUT", "/_api/data/shared/index", {
      token: null,
      payload: ["x"],
      headers: { "if-match": '"9223372036854775807"' },
    });
    expect(res.statusCode).toBe(412);
    expect(res.json().error.code).toBe("conflict");
  });

  it("user scope keeps last-write-wins by default but honors a stated precondition", async () => {
    const edge = buildDataEdge();
    const token = await seedSession(edge.sessions, "alice");

    // No precondition → today's unconditional upsert.
    const plain = await req(edge, "PUT", "/_api/data/user/prefs", {
      token,
      payload: { theme: "dark" },
    });
    expect(plain.statusCode).toBe(200);
    expect(plain.headers.etag).toBe('"1"');

    // Stale stated version → 412, and the value did not move.
    const stale = await req(edge, "PUT", "/_api/data/user/prefs", {
      token,
      payload: { theme: "light" },
      headers: { "if-match": '"99"' },
    });
    expect(stale.statusCode).toBe(412);
    const get = await req(edge, "GET", "/_api/data/user/prefs", { token });
    expect(get.json().value).toEqual({ theme: "dark" });
    expect(get.headers.etag).toBe('"1"');

    // The current version → 200, bumping to 2.
    const cas = await req(edge, "PUT", "/_api/data/user/prefs", {
      token,
      payload: { theme: "solarized" },
      headers: { "if-match": '"1"' },
    });
    expect(cas.statusCode).toBe(200);
    expect(cas.headers.etag).toBe('"2"');
  });

  it("400s If-Match: * on user scope too — not a supported value anywhere", async () => {
    const edge = buildDataEdge();
    const token = await seedSession(edge.sessions, "alice");
    const res = await req(edge, "PUT", "/_api/data/user/prefs", {
      token,
      payload: { theme: "dark" },
      headers: { "if-match": "*" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_failed");
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
