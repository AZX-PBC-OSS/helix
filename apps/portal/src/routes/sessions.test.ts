import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { StaticDirectory, UnavailableDirectory, type GroupSummary } from "@azx-pbc/directory";
import type { TokenVerifier } from "../plugins/auth.js";
import { buildTestApp, uniqueSlug, type TestApp } from "../test/harness.js";

/**
 * Admin session list + revoke (`routes/sessions.ts`). Two actors via an
 * injected verifier chain: a platform admin and an authenticated non-admin —
 * the gate is the boundary under test as much as the kill itself.
 *
 * The kill's *effect* (the edge's uncached `session_lookup` missing the row on
 * the next request) is asserted in the edge's suite
 * (`apps/edge/src/auth/sessions.rls.integration.test.ts`, as `helix_portal`
 * doing exactly this DELETE); here it is the control-plane half: gating,
 * scoping, idempotence, and the audit record.
 */

const ADMIN = "admin@azx.io";
const PLEB = "pleb@azx.io";
const ADMIN_GROUP = "platform-admin";

const verifiers: TokenVerifier[] = [
  {
    verify: async (token) => {
      if (token === "admin") return { sub: ADMIN, via: "oidc", groups: [ADMIN_GROUP] };
      if (token === "pleb") return { sub: PLEB, via: "oidc", groups: [] };
      return null;
    },
  },
];
const admin = { authorization: "Bearer admin" };
const pleb = { authorization: "Bearer pleb" };

// Fixture ids are readable strings, not GUIDs, by design (StaticDirectory) —
// no test here may assume a GUID shape either.
const GROUPS: GroupSummary[] = [
  { id: "eng-team", displayName: "Engineering", securityEnabled: true },
  { id: "prod-oncall", displayName: "Production On-call", securityEnabled: true },
];

let t: TestApp;

beforeAll(async () => {
  process.env.PORTAL_ADMIN_GROUP_ID = ADMIN_GROUP;
  t = buildTestApp({
    auth: { verifiers, publicConfig: null },
    directory: new StaticDirectory(GROUPS),
  });
  await t.app.ready();
});

// Every env override in this file goes through `vi.stubEnv`, so one hook undoes
// them all — including on a failing assertion.
afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await t.close();
});

const HOUR = 60 * 60 * 1000;

/** Create an app via the API, as the admin; returns id + slug. */
async function makeApp(): Promise<{ id: string; slug: string }> {
  const slug = uniqueSlug("sess");
  const res = await t.app.inject({
    method: "POST",
    url: "/api/v1/apps",
    headers: admin,
    payload: { slug, displayName: "Sessions Test" },
  });
  expect(res.statusCode).toBe(201);
  return { id: res.json().id as string, slug };
}

/**
 * Seed one session row directly (owner-connection prisma — RLS-exempt, and the
 * edge's mint paths are not under test here). Defaults describe a live,
 * activated SSO session.
 */
async function seedSession(
  opts: Partial<{
    appId: string;
    userOid: string;
    displayName: string;
    userName: string | null;
    userEmail: string | null;
    userKind: string | null;
    groups: string[];
    pending: boolean;
    expiresInMs: number;
    refreshDueInMs: number;
  }> & { appId: string; userOid: string },
): Promise<string> {
  const id = randomUUID();
  await t.prisma.session.create({
    data: {
      id,
      ...(opts.pending ? {} : { tokenHash: `hash-${id}` }),
      appId: opts.appId,
      userOid: opts.userOid,
      displayName: opts.displayName ?? "Someone",
      userName: opts.userName ?? null,
      userEmail: opts.userEmail ?? null,
      userKind: opts.userKind ?? "user",
      groups: opts.groups ?? [],
      ...(opts.pending ? {} : { activatedAt: new Date() }),
      refreshDueAt: new Date(Date.now() + (opts.refreshDueInMs ?? HOUR)),
      expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 8 * HOUR)),
    },
  });
  return id;
}

describe("admin gate (both routes)", () => {
  // Every route behind `requireAdmin`, with the gate as the handler's first
  // statement — so a non-admin with an *invalid body* still gets the 403, not
  // a 400: this is what pins "gate before parse", not just "gate exists".
  const ADMIN_ROUTES: [method: "GET" | "POST", name: string, url: string, payload?: object][] = [
    ["GET", "the list", "/api/v1/sessions"],
    ["POST", "revoke", "/api/v1/sessions/revoke", {}],
  ];

  it.each(ADMIN_ROUTES)(
    "refuses %s (%s) to an authenticated non-admin",
    async (method, _n, url, payload) => {
      const res = await t.app.inject({ method, url, headers: pleb, payload });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("forbidden");
    },
  );

  it("refuses the list when no admin group is configured", async () => {
    vi.stubEnv("PORTAL_ADMIN_GROUP_ID", undefined);
    const res = await t.app.inject({ method: "GET", url: "/api/v1/sessions", headers: admin });
    expect(res.statusCode).toBe(403);
    // The actor here IS in the admin group, so the message is what separates
    // "not configured" from the ordinary role denial.
    expect(res.json().error.message).toMatch(/PORTAL_ADMIN_GROUP_ID/);
  });
});

describe("GET /api/v1/sessions", () => {
  it("requires a bearer token (401)", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/v1/sessions" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("lists only live, activated sessions and resolves group names", async () => {
    const a = await makeApp();
    const b = await makeApp();
    const alice = `sub-${randomUUID()}`;
    const guest = `pw_${randomUUID().slice(0, 12)}`;

    const liveA = await seedSession({
      appId: a.id,
      userOid: alice,
      displayName: "Alice",
      userName: "Alice Anders",
      userEmail: "alice@azx.dev",
      groups: ["eng-team", "ghost-group"],
    });
    await seedSession({ appId: b.id, userOid: alice, groups: [] });
    // Refresh-due is still live: the gate treats it as an authorization
    // boundary for /_api/*, but the session row exists and the admin is
    // looking at exactly the rows the edge would still admit.
    await seedSession({ appId: a.id, userOid: alice, refreshDueInMs: -HOUR });
    // Not listed: a pending (un-redeemed handoff — not a credential yet)…
    await seedSession({ appId: a.id, userOid: alice, pending: true });
    // …and a hard-expired one (the gate's lookup filters these out too).
    await seedSession({ appId: a.id, userOid: alice, expiresInMs: -HOUR });
    // A shared-password visitor, and a pre-column kind that must narrow to
    // null rather than smuggle through the page parse.
    await seedSession({
      appId: a.id,
      userOid: guest,
      displayName: "Guest",
      userName: null,
      userEmail: null,
      userKind: "password",
      groups: [],
    });
    await seedSession({ appId: a.id, userOid: `sub-${randomUUID()}`, userKind: "future-kind" });

    const res = await t.app.inject({ method: "GET", url: "/api/v1/sessions", headers: admin });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const mine = body.rows.filter((r: { userOid: string }) => r.userOid === alice);
    // 3, not 2: the refresh-due row is live too (the gate treats it as an
    // authorization boundary for /_api/*, not as a dead session) — the two
    // absent rows are the pending and the expired one.
    expect(mine).toHaveLength(3);
    const first = mine.find((r: { id: string }) => r.id === liveA);
    expect(first).toMatchObject({
      appId: a.id,
      slug: a.slug,
      userName: "Alice Anders",
      userEmail: "alice@azx.dev",
      userKind: "user",
      groups: ["eng-team", "ghost-group"],
    });
    // An unknown kind narrows to null (no page-parse failure, no smuggling).
    expect(body.rows.some((r: { userKind: string | null }) => r.userKind === null)).toBe(true);
    // The shared-password visitor renders with its kind and no captured claims.
    const guestRow = body.rows.find((r: { userOid: string }) => r.userOid === guest);
    expect(guestRow).toMatchObject({ userKind: "password", userName: null, userEmail: null });
    // Scoped-by-user on purpose: the route lists the whole platform and other
    // tests in this DB may hold live rows; `mine` is 2 because the pending and
    // the expired row above are excluded — that is the liveness filter, proven.
    expect(body.rows.length).toBeGreaterThanOrEqual(5);
    // Names resolved for the ids the fixtures know; the ghost id is omitted
    // (the provider contract), not an error — `groupsResolved` stays true and
    // the SPA renders the bare id.
    expect(body.groupNames).toEqual({ "eng-team": "Engineering" });
    expect(body.groupsResolved).toBe(true);
  });

  it("caps ?limit=", async () => {
    const a = await makeApp();
    await seedSession({ appId: a.id, userOid: "cap-user" });
    await seedSession({ appId: a.id, userOid: "cap-user" });
    const res = await t.app.inject({
      method: "GET",
      url: "/api/v1/sessions?limit=1",
      headers: admin,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows).toHaveLength(1);
  });

  it("degrades to raw group ids when the directory is unavailable", async () => {
    // Scoped app: same verifiers, an UnavailableDirectory — the degraded path
    // is the same code path as the happy one (ADR-0040 decision 8), and the
    // list must keep working: revocation never depended on Graph.
    const scoped = buildTestApp({
      auth: { verifiers, publicConfig: null },
      directory: new UnavailableDirectory(),
    });
    await scoped.app.ready();
    try {
      const a = await makeApp();
      await scoped.prisma.session.create({
        data: {
          id: randomUUID(),
          tokenHash: `hash-${randomUUID()}`,
          appId: a.id,
          userOid: "dir-user",
          displayName: "Someone",
          groups: ["eng-team"],
          activatedAt: new Date(),
          refreshDueAt: new Date(Date.now() + HOUR),
          expiresAt: new Date(Date.now() + 8 * HOUR),
        },
      });
      const res = await scoped.app.inject({
        method: "GET",
        url: "/api/v1/sessions",
        headers: admin,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.groupsResolved).toBe(false);
      expect(body.groupNames).toEqual({});
      // The rows are still there — the degradation costs the names, not the list.
      expect(body.rows.some((r: { userOid: string }) => r.userOid === "dir-user")).toBe(true);
    } finally {
      await scoped.close();
    }
  });
});

describe("POST /api/v1/sessions/revoke", () => {
  it("requires a bearer token (401)", async () => {
    const res = await t.app.inject({ method: "POST", url: "/api/v1/sessions/revoke" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("kills every session of the user — live and pending — and only that user's", async () => {
    const a = await makeApp();
    const b = await makeApp();
    const alice = `sub-${randomUUID()}`;
    const bob = `sub-${randomUUID()}`;
    await seedSession({
      appId: a.id,
      userOid: alice,
      userName: "Alice Anders",
      userEmail: "alice@azx.dev",
      groups: ["eng-team"],
    });
    await seedSession({ appId: b.id, userOid: alice, userName: "Alice Anders" });
    // A login in flight for the same user: collateral of the same kill.
    await seedSession({ appId: a.id, userOid: alice, pending: true });
    // Someone else's session on the same app — must survive.
    await seedSession({ appId: a.id, userOid: bob, userName: "Bob Baker" });

    const res = await t.app.inject({
      method: "POST",
      url: "/api/v1/sessions/revoke",
      headers: admin,
      payload: { userOid: alice },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.removed).toBe(3);
    expect([...body.apps].sort()).toEqual([a.slug, b.slug].sort());

    // The kill, verified at the table the edge reads.
    expect(await t.prisma.session.count({ where: { userOid: alice } })).toBe(0);
    expect(await t.prisma.session.count({ where: { userOid: bob } })).toBe(1);

    // The audit row: platform-level (appId null), attributed, carrying the
    // display half captured from the removed rows — which are about to be
    // gone, so this is the only place the name survives.
    const event = await t.prisma.auditEvent.findFirstOrThrow({
      where: { action: "session.revoke", actor: ADMIN },
      orderBy: { createdAt: "desc" },
    });
    expect(event.appId).toBeNull();
    expect(event.metadata).toMatchObject({
      userOid: alice,
      userName: "Alice Anders",
      userEmail: "alice@azx.dev",
      userKind: "user",
      removed: 3,
    });
    expect((event.metadata as { apps: string[] }).apps.sort()).toEqual([a.slug, b.slug].sort());
  });

  it("is idempotent: a second revoke reports zero and still records the attempt", async () => {
    const a = await makeApp();
    const carol = `sub-${randomUUID()}`;
    await seedSession({ appId: a.id, userOid: carol });

    const first = await t.app.inject({
      method: "POST",
      url: "/api/v1/sessions/revoke",
      headers: admin,
      payload: { userOid: carol },
    });
    expect(first.json().removed).toBe(1);

    // A stale list click: the desired end state already holds, so this is a
    // result, not an error — and the *attempt* is still a fact worth auditing.
    const second = await t.app.inject({
      method: "POST",
      url: "/api/v1/sessions/revoke",
      headers: admin,
      payload: { userOid: carol },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ removed: 0, apps: [] });

    const events = await t.prisma.auditEvent.findMany({
      where: { action: "session.revoke", actor: ADMIN },
    });
    const forCarol = events.filter((e) => (e.metadata as { userOid?: string }).userOid === carol);
    expect(forCarol).toHaveLength(2);
    expect(forCarol.at(-1)?.metadata).toMatchObject({ removed: 0 });
  });

  it.each([
    ["an empty body", undefined],
    ["a missing userOid", {}],
    ["an empty userOid", { userOid: "" }],
    ["an oversized userOid", { userOid: "x".repeat(201) }],
  ] satisfies [string, object | undefined][])(
    "rejects %s with a clean 400",
    async (_name, payload) => {
      const res = await t.app.inject({
        method: "POST",
        url: "/api/v1/sessions/revoke",
        headers: admin,
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("validation_failed");
    },
  );
});
