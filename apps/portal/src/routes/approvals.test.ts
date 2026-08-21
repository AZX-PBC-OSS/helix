import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { TokenVerifier } from "../plugins/auth.js";
import type { PrismaClient } from "../db/client.js";
import { buildTestApp, createTestPrisma, uniqueSlug, type TestApp } from "../test/harness.js";

// Two actors: an app owner (no admin group) and a platform admin.
const OWNER = "owner@azx.io";
const ADMIN = "admin@azx.io";
const ADMIN_GROUP = "platform-admin";

const verifiers: TokenVerifier[] = [
  {
    verify: async (t) => {
      if (t === "owner") return { sub: OWNER, via: "oidc", groups: [] };
      if (t === "admin") return { sub: ADMIN, via: "oidc", groups: [ADMIN_GROUP] };
      return null;
    },
  },
];

const owner = { authorization: "Bearer owner" };
const admin = { authorization: "Bearer admin" };

let t: TestApp;

beforeAll(async () => {
  process.env.PORTAL_ADMIN_GROUP_ID = ADMIN_GROUP;
  t = buildTestApp({ auth: { verifiers, publicConfig: null } });
  await t.app.ready();
});

// Every env override in this file goes through `vi.stubEnv`, so one hook undoes
// them all — including on a failing assertion, which an inline restore misses.
// `PORTAL_ALLOW_SELF_APPROVE` is pinned "false" for the suite in vitest.config.ts;
// before that, this file only cleared it *after* the first test, so the
// separation-of-duty assertions below passed on file order alone.
afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await t.close();
});

/** Create an app owned by OWNER and file an elevated (mcp) request on it. */
async function appWithPendingRequest() {
  const slug = uniqueSlug();
  const created = await t.app.inject({
    method: "POST",
    url: "/api/v1/apps",
    headers: owner,
    payload: { slug, displayName: "Gated" },
  });
  expect(created.statusCode).toBe(201);
  const put = await t.app.inject({
    method: "PUT",
    url: `/api/v1/apps/${slug}/manifest`,
    headers: owner,
    payload: { capabilities: { mcp: ["pagerduty"] }, reason: "need paging" },
  });
  expect(put.statusCode).toBe(200);
  return {
    slug,
    appId: created.json().id as string,
    requestId: put.json().pending as string,
  };
}

/**
 * The audit `action` strings written for one app, sorted.
 *
 * Sorted, not chronological: `createdAt` defaults to CURRENT_TIMESTAMP, which in
 * Postgres is *transaction start* time — so the effective-mutation event and the
 * `approval.approve` written in the same approve txn carry identical timestamps
 * and have no stable order. Every app here comes from `uniqueSlug()`, so this is
 * scoped to one test and safe to compare exactly.
 */
async function auditActions(appId: string): Promise<string[]> {
  const events = await t.prisma.auditEvent.findMany({ where: { appId } });
  return events.map((e) => e.action).sort();
}

describe("GET /api/v1/approvals", () => {
  it("shows the request to the owner and to admins, but hides it from others", async () => {
    const { slug, requestId } = await appWithPendingRequest();

    const adminQueue = await t.app.inject({
      method: "GET",
      url: "/api/v1/approvals?status=pending",
      headers: admin,
    });
    expect(adminQueue.statusCode).toBe(200);
    expect(adminQueue.json().some((r: { id: string }) => r.id === requestId)).toBe(true);

    const ownerView = await t.app.inject({
      method: "GET",
      url: `/api/v1/approvals?app=${slug}`,
      headers: owner,
    });
    expect(ownerView.statusCode).toBe(200);
    expect(ownerView.json()).toHaveLength(1);

    // The owner of one app cannot read another owner's app requests.
    const otherSlug = uniqueSlug();
    await t.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: admin,
      payload: { slug: otherSlug, displayName: "x" },
    });
    const forbidden = await t.app.inject({
      method: "GET",
      url: `/api/v1/approvals?app=${otherSlug}`,
      headers: owner,
    });
    expect(forbidden.statusCode).toBe(403);
  });
});

describe("admin gate", () => {
  // Every route behind `requireAdmin`. On each, the gate is the first statement
  // of the handler — ahead of any zod parse or DB read — so one shared pending
  // request and an empty body are enough to reach it, and it 403s before the
  // request is ever touched, which is why the fixture is reusable.
  const ADMIN_ROUTES: [method: "GET" | "POST", name: string, urlOf: (id: string) => string][] = [
    ["GET", "the global queue", () => "/api/v1/approvals"],
    ["POST", "approve", (id) => `/api/v1/approvals/${id}/approve`],
    ["POST", "deny", (id) => `/api/v1/approvals/${id}/deny`],
    ["POST", "needs_changes", (id) => `/api/v1/approvals/${id}/needs_changes`],
  ];

  let requestId: string;
  beforeAll(async () => {
    ({ requestId } = await appWithPendingRequest());
  });

  it.each(ADMIN_ROUTES)("refuses %s (%s) to a non-admin", async (method, _name, urlOf) => {
    const res = await t.app.inject({ method, url: urlOf(requestId), headers: owner });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });

  it("refuses a decision when no admin group is configured", async () => {
    vi.stubEnv("PORTAL_ADMIN_GROUP_ID", undefined);
    const res = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/approve`,
      headers: admin,
    });
    expect(res.statusCode).toBe(403);
    // The actor here IS in the admin group, so the message is what separates
    // "not configured" from the ordinary role denial — without it this passes
    // for the wrong reason.
    expect(res.json().error.message).toMatch(/PORTAL_ADMIN_GROUP_ID/);
  });
});

describe("approve", () => {
  it("applies the elevated deltas and closes the request", async () => {
    const { slug, requestId } = await appWithPendingRequest();

    const res = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/approve`,
      headers: admin,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("approved");

    const manifest = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/manifest`,
      headers: owner,
    });
    expect(manifest.json().capabilities.mcp).toEqual(["pagerduty"]);
  });

  it("writes both the effective mutation and the decision as separate audit rows", async () => {
    // docs/design/approvals.md §2 step 5: an approve writes TWO events — the
    // effective-mutation action AND an `approval.approve`. The audit page relies
    // on that to show a capability change and the decision authorising it as
    // separate rows. Exact-equal, not `toContain`: a dropped or duplicated row
    // is exactly the regression this is here to catch.
    const { appId, requestId } = await appWithPendingRequest();
    await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/approve`,
      headers: admin,
    });
    // No `app.manifest.set` at request time: `{ mcp: [...] }` is wholly
    // elevated, so the write-gate committed no baseline deltas.
    expect(await auditActions(appId)).toEqual([
      "app.create",
      "app.manifest.set",
      "approval.approve",
      "approval.request",
    ]);
  });

  it("is idempotent — a second approve is a no-op", async () => {
    const { appId, requestId } = await appWithPendingRequest();
    await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/approve`,
      headers: admin,
    });
    const afterFirst = await auditActions(appId);

    const second = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/approve`,
      headers: admin,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe("approved");
    // The status alone would survive a refactor that re-applied the deltas and
    // re-emitted the events; an unchanged audit trail is what pins the no-op.
    expect(await auditActions(appId)).toEqual(afterFirst);
  });

  it("blocks self-approval unless the dev flag is set (separation of duty)", async () => {
    // Admin files the request, then tries to approve their own.
    const slug = uniqueSlug();
    await t.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: admin,
      payload: { slug, displayName: "self" },
    });
    const put = await t.app.inject({
      method: "PUT",
      url: `/api/v1/apps/${slug}/manifest`,
      headers: admin,
      payload: { capabilities: { mcp: ["pagerduty"] } },
    });
    const requestId = put.json().pending as string;

    const blocked = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/approve`,
      headers: admin,
    });
    expect(blocked.statusCode).toBe(403);

    vi.stubEnv("PORTAL_ALLOW_SELF_APPROVE", "true");
    const allowed = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/approve`,
      headers: admin,
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().status).toBe("approved");
  });

  it("writes externalOrigins once the origin grant is approved", async () => {
    // The one-click grant from the Violations screen (approvals.md §6.2). csp.test.ts
    // covers it being opened as a med-risk request and stops there — this is the
    // other half, and the only end-to-end run of the capDelta path for a
    // capability that isn't `mcp`.
    const slug = uniqueSlug();
    const created = await t.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: owner,
      payload: { slug, displayName: "og" },
    });
    expect(created.statusCode).toBe(201);

    const grant = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/access/origin`,
      headers: owner,
      payload: { origin: "https://api.foo.com" },
    });
    expect(grant.statusCode).toBe(200);

    const approved = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${grant.json().pending}/approve`,
      headers: admin,
    });
    expect(approved.statusCode).toBe(200);

    const manifest = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/manifest`,
      headers: owner,
    });
    expect(manifest.json().capabilities.externalOrigins).toEqual(["https://api.foo.com"]);
    // The delta applied to its own area only — that's the capDelta filter working.
    expect(manifest.json().capabilities.mcp).toEqual([]);
  });

  it("auto-bounces to needs_changes when the effective state moved (conflict)", async () => {
    const { slug, appId, requestId } = await appWithPendingRequest();
    // Simulate a concurrent change to the touched (mcp) area.
    const row = await t.prisma.app.findUniqueOrThrow({ where: { slug } });
    await t.prisma.app.update({
      where: { id: row.id },
      data: { capabilities: { mcp: ["other"], externalOrigins: [] } },
    });

    const res = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/approve`,
      headers: admin,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("needs_changes");

    // The stale request did not clobber the concurrent value.
    const manifest = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/manifest`,
      headers: owner,
    });
    expect(manifest.json().capabilities.mcp).toEqual(["other"]);

    // The auto-bounce is discriminated from an admin's by `reason`, which is the
    // only way the audit page can tell them apart.
    const bounce = await t.prisma.auditEvent.findFirstOrThrow({
      where: { appId, action: "approval.needs_changes" },
    });
    expect(bounce.metadata).toMatchObject({ reason: "stale_snapshot" });

    // Replaying the same approve is still a no-op, not a conflict: the decision
    // it would be conflicting with is the one this very call just made, and a
    // client that retried a timed-out request must not be told otherwise.
    const replay = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/approve`,
      headers: admin,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().status).toBe("needs_changes");
  });

  it("will not approve a request already bounced to needs_changes", async () => {
    // `needs_changes` is terminal at the API level despite the name: both
    // decision paths guard on `status === "pending"`, so the owner must file a
    // fresh request (approvals.md §5). Nothing else pins this, and it is exactly
    // what a well-meaning "let admins un-bounce a request" change would break.
    const { slug, requestId } = await appWithPendingRequest();
    const bounced = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/needs_changes`,
      headers: admin,
      payload: { note: "narrow the scope" },
    });
    expect(bounced.json().status).toBe("needs_changes");

    const res = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/approve`,
      headers: admin,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("needs_changes");

    // And the deltas it carried were never applied.
    const manifest = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/manifest`,
      headers: owner,
    });
    expect(manifest.json().capabilities.mcp).toEqual([]);
  });
});

describe("deny / needs_changes / withdraw", () => {
  // Both routes come out of one loop parameterised on exactly three values, so
  // this table is the whole of what differs between them — and a bad edit to
  // that tuple array is precisely the silent break this suite is here to catch.
  // Everything else on the path (the note check, the pending guard, separation
  // of duty) is shared source and is covered once, below, rather than twice here.
  it.each([
    ["deny", "denied", "approval.deny"],
    ["needs_changes", "needs_changes", "approval.needs_changes"],
  ])("maps %s → status %s and audit action %s", async (suffix, status, action) => {
    const { appId, requestId } = await appWithPendingRequest();
    const res = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/${suffix}`,
      headers: admin,
      payload: { note: "not yet" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status, decisionNote: "not yet" });
    expect(await auditActions(appId)).toContain(action);
  });

  it("refuses to decide your own request (separation of duty)", async () => {
    // The approve path has its own guard and its own message; this is the
    // deny/needs_changes one, which nothing exercised.
    const slug = uniqueSlug();
    await t.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: admin,
      payload: { slug, displayName: "self-deny" },
    });
    const put = await t.app.inject({
      method: "PUT",
      url: `/api/v1/apps/${slug}/manifest`,
      headers: admin,
      payload: { capabilities: { mcp: ["pagerduty"] } },
    });

    const res = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${put.json().pending}/deny`,
      headers: admin,
      payload: { note: "mine" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/separation of duty/);
  });

  it.each(["approve", "deny", "needs_changes", "withdraw"])(
    "404s on an unknown request id (%s)",
    async (suffix) => {
      // A real UUID: the column is `@db.Uuid`, so a non-UUID makes Prisma raise
      // and the generic handler turn it into a 500 rather than this 404.
      const res = await t.app.inject({
        method: "POST",
        url: `/api/v1/approvals/${randomUUID()}/${suffix}`,
        headers: admin,
        payload: { note: "x" },
      });
      expect(res.statusCode).toBe(404);
    },
  );

  it("requires a note to deny", async () => {
    const { requestId } = await appWithPendingRequest();
    const noNote = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/deny`,
      headers: admin,
    });
    expect(noNote.statusCode).toBe(400);
    // An empty note is not a note — the schema leaves `note` optional with no
    // min length, so the route's own check is what rejects this.
    const emptyNote = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/deny`,
      headers: admin,
      payload: { note: "" },
    });
    expect(emptyNote.statusCode).toBe(400);
    const withNote = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/deny`,
      headers: admin,
      payload: { note: "too risky" },
    });
    expect(withNote.statusCode).toBe(200);
    expect(withNote.json()).toMatchObject({ status: "denied", decisionNote: "too risky" });
  });

  it("lets the requester withdraw but not a stranger", async () => {
    const { appId, requestId } = await appWithPendingRequest();
    const stranger = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/withdraw`,
      headers: admin,
    });
    expect(stranger.statusCode).toBe(403);
    const self = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/withdraw`,
      headers: owner,
    });
    expect(self.statusCode).toBe(200);
    expect(self.json().status).toBe("withdrawn");
    expect(await auditActions(appId)).toContain("approval.withdraw");
  });
});

describe("prior decisions on the admin queue (issue #26)", () => {
  async function createApp(slug: string, headers = owner) {
    await t.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers,
      payload: { slug, displayName: "refile" },
    });
  }

  /** File an elevated mcp grant on an existing app; returns the pending request id. */
  async function fileMcp(slug: string, server = "pagerduty") {
    const put = await t.app.inject({
      method: "PUT",
      url: `/api/v1/apps/${slug}/manifest`,
      headers: owner,
      payload: { capabilities: { mcp: [server] }, reason: "need paging" },
    });
    return put.json().pending as string;
  }

  async function denyReq(requestId: string, note = "no") {
    await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/deny`,
      headers: admin,
      payload: { note },
    });
  }

  /** The admin's pending-queue entry for a given request id. */
  async function queueEntry(requestId: string) {
    const queue = await t.app.inject({
      method: "GET",
      url: "/api/v1/approvals?status=pending",
      headers: admin,
    });
    return queue.json().find((r: { id: string }) => r.id === requestId);
  }

  it("flags a refiled grant that was already denied (the inverse of the bug report)", async () => {
    const slug = uniqueSlug();
    await createApp(slug);
    // Uniform notes: `decidedAt` can tie at ms resolution, so keep `last` deterministic.
    for (let i = 0; i < 3; i++) await denyReq(await fileMcp(slug), "no");
    const refiled = await fileMcp(slug);

    const entry = await queueEntry(refiled);
    expect(entry.priorDecisions).toMatchObject({
      total: 3,
      deniedSameGrant: 3,
      deniedSameArea: 3,
    });
    expect(entry.priorDecisions.last).toMatchObject({ status: "denied", note: "no" });
    // The signal the bug report found missing is now present on the payload.
    expect(JSON.stringify(entry)).toMatch(/denied|priorDecisions/i);
  });

  it("flags a same-area denial quietly and not as the same grant", async () => {
    const slug = uniqueSlug();
    await createApp(slug);
    await denyReq(await fileMcp(slug, "other"), "not that one");
    const refiled = await fileMcp(slug, "pagerduty");

    const entry = await queueEntry(refiled);
    expect(entry.priorDecisions).toMatchObject({
      total: 1,
      deniedSameArea: 1,
      deniedSameGrant: 0,
    });
  });

  it("omits priorDecisions for a first-time request, and never sets it on the per-app view", async () => {
    const { slug, requestId } = await appWithPendingRequest();
    expect((await queueEntry(requestId)).priorDecisions).toBeUndefined();

    // Even once history exists, the per-app owner view stays unenriched (scope: admin queue).
    await denyReq(requestId, "no");
    const refiled = await fileMcp(slug);
    const ownerView = await t.app.inject({
      method: "GET",
      url: `/api/v1/approvals?app=${slug}`,
      headers: owner,
    });
    const ownerEntry = ownerView.json().find((r: { id: string }) => r.id === refiled);
    expect(ownerEntry.priorDecisions).toBeUndefined();
  });
});

describe("go-public via the visibility write-gate", () => {
  it("opens a request for → public and applies it on approve", async () => {
    const slug = uniqueSlug();
    const created = await t.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: owner,
      payload: { slug, displayName: "pub" },
    });
    const appId = created.json().id as string;

    const vis = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/visibility`,
      headers: owner,
      payload: { visibility: { mode: "public" }, reason: "demo" },
    });
    expect(vis.statusCode).toBe(200);
    const requestId = vis.json().pending as string;
    expect(requestId).toBeTruthy();
    // Not public yet.
    expect(
      (await t.app.inject({ method: "GET", url: `/api/v1/apps/${slug}`, headers: owner })).json()
        .visibility.mode,
    ).toBe("internal");

    await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/approve`,
      headers: admin,
    });
    expect(
      (await t.app.inject({ method: "GET", url: `/api/v1/apps/${slug}`, headers: owner })).json()
        .visibility.mode,
    ).toBe("public");

    // The other half of the two-events invariant: a visibility delta lands on the
    // flat columns and pairs `app.visibility.set` with the decision. The absence
    // of `app.manifest.set` is the load-bearing half — it is what pins the
    // capDelta/visDelta split, which nothing else exercises.
    expect(await auditActions(appId)).toEqual([
      "app.create",
      "app.visibility.set",
      "approval.approve",
      "approval.request",
    ]);
  });

  it("applies a reduction (→ internal) immediately, no request", async () => {
    const slug = uniqueSlug();
    await t.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: owner,
      payload: { slug, displayName: "grp", visibility: { mode: "group", groupIds: ["g1"] } },
    });
    const vis = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/visibility`,
      headers: owner,
      payload: { visibility: { mode: "internal" } },
    });
    expect(vis.statusCode).toBe(200);
    expect(vis.json().pending).toBeNull();
    expect(vis.json().app.visibility.mode).toBe("internal");
  });

  it("refuses to commit a pending → public if public is disabled before approval (403, no partial apply)", async () => {
    const slug = uniqueSlug();
    await t.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: owner,
      payload: { slug, displayName: "pub-later" },
    });
    const vis = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/visibility`,
      headers: owner,
      payload: { visibility: { mode: "public" } },
    });
    const requestId = vis.json().pending as string;
    expect(requestId).toBeTruthy();

    const prev = process.env.PORTAL_ALLOW_PUBLIC_APPS;
    process.env.PORTAL_ALLOW_PUBLIC_APPS = "false";
    try {
      const res = await t.app.inject({
        method: "POST",
        url: `/api/v1/approvals/${requestId}/approve`,
        headers: admin,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("forbidden");
    } finally {
      if (prev === undefined) delete process.env.PORTAL_ALLOW_PUBLIC_APPS;
      else process.env.PORTAL_ALLOW_PUBLIC_APPS = prev;
    }

    // The transaction rolled back — the app never went public.
    expect(
      (await t.app.inject({ method: "GET", url: `/api/v1/apps/${slug}`, headers: owner })).json()
        .visibility.mode,
    ).toBe("internal");
  });
});

/**
 * Concurrent decisions on one request (docs/design/approvals.md §5). The property
 * under test is that the `pending → terminal` transition is what gates the `apps`
 * write: a decision that loses the race must apply nothing and say so (409), not
 * overwrite the decision that won.
 */
describe("concurrent decisions on one approval request", () => {
  /**
   * A second client whose write of `status` is parked until released, so the
   * interleaving is deterministic rather than timing-dependent. Plain `Promise.all`
   * is not enough: in-process the two requests serialise and the second legitimately
   * sees the first's committed status (the same note as secrets.test.ts:292).
   * Matching on the target status catches the `updateMany` CAS the routes use.
   */
  function gatedDecider(status: string) {
    let reachedItsWrite!: () => void;
    const atTheWrite = new Promise<void>((resolve) => {
      reachedItsWrite = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stall = async (data: unknown) => {
      if ((data as { status?: string }).status === status) {
        reachedItsWrite();
        await gate;
      }
    };
    const prisma = createTestPrisma().$extends({
      query: {
        approvalRequest: {
          async update({ args, query }) {
            await stall(args.data);
            return query(args);
          },
          async updateMany({ args, query }) {
            await stall(args.data);
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    return { prisma, atTheWrite, release };
  }

  it("does not leave the request withdrawn while the elevated capability is live", async () => {
    const { slug, requestId } = await appWithPendingRequest();
    const gated = gatedDecider("withdrawn");
    const withdrawer = buildTestApp({
      auth: { verifiers, publicConfig: null },
      prisma: gated.prisma,
    });
    await withdrawer.app.ready();
    try {
      // The async IIFE matters: light-my-request defers dispatch until something
      // awaits the chain, so a bare `inject()` never runs (secrets.test.ts:395).
      const withdrawing = (async () =>
        withdrawer.app.inject({
          method: "POST",
          url: `/api/v1/approvals/${requestId}/withdraw`,
          headers: owner,
        }))();
      // The withdraw has read `pending` and is about to write it. Let the approve
      // commit its whole transaction underneath it, then release the write.
      await gated.atTheWrite;
      const approve = await t.app.inject({
        method: "POST",
        url: `/api/v1/approvals/${requestId}/approve`,
        headers: admin,
      });
      expect(approve.statusCode).toBe(200);
      gated.release();
      const withdraw = await withdrawing;

      // The loser is told the truth instead of overwriting the winner.
      expect(withdraw.statusCode).toBe(409);
      expect(withdraw.json().error.code).toBe("conflict");
      expect(withdraw.json().error.details).toEqual({ status: "approved" });

      const row = await t.prisma.approvalRequest.findUniqueOrThrow({ where: { id: requestId } });
      const appRow = await t.prisma.app.findUniqueOrThrow({ where: { slug } });
      const mcp = (appRow.capabilities as { mcp?: string[] }).mcp ?? [];
      // The state the bug produced: the queue and the audit trail said the grant
      // was pulled while the edge served the capability from the `apps` row.
      expect({ status: row.status, mcp }).not.toEqual({ status: "withdrawn", mcp: ["pagerduty"] });
      expect({ status: row.status, mcp }).toEqual({ status: "approved", mcp: ["pagerduty"] });

      // Exactly one decision in the ledger — the bug recorded both.
      const events = await t.prisma.auditEvent.findMany({ where: { appId: appRow.id } });
      expect(events.map((e) => e.action).filter((a) => a.startsWith("approval."))).toEqual([
        "approval.request",
        "approval.approve",
      ]);
    } finally {
      await withdrawer.close();
    }
  });

  it("does not apply the deltas when a deny lands first", async () => {
    const { slug, requestId } = await appWithPendingRequest();
    const gated = gatedDecider("approved");
    const approver = buildTestApp({
      auth: { verifiers, publicConfig: null },
      prisma: gated.prisma,
    });
    await approver.app.ready();
    try {
      const approving = (async () =>
        approver.app.inject({
          method: "POST",
          url: `/api/v1/approvals/${requestId}/approve`,
          headers: admin,
        }))();
      await gated.atTheWrite;
      const deny = await t.app.inject({
        method: "POST",
        url: `/api/v1/approvals/${requestId}/deny`,
        headers: admin,
        payload: { note: "too risky" },
      });
      expect(deny.statusCode).toBe(200);
      gated.release();
      const approve = await approving;

      expect(approve.statusCode).toBe(409);
      expect(approve.json().error.details).toEqual({ status: "denied" });
      // The whole approve transaction rolled back, so the capability never landed.
      const appRow = await t.prisma.app.findUniqueOrThrow({ where: { slug } });
      expect((appRow.capabilities as { mcp?: string[] }).mcp ?? []).toEqual([]);
      const row = await t.prisma.approvalRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(row.status).toBe("denied");
    } finally {
      await approver.close();
    }
  });

  it("survives two decisions fired at once, whichever wins", async () => {
    const { slug, requestId } = await appWithPendingRequest();
    const [a, b] = await Promise.all([
      t.app.inject({
        method: "POST",
        url: `/api/v1/approvals/${requestId}/approve`,
        headers: admin,
      }),
      t.app.inject({
        method: "POST",
        url: `/api/v1/approvals/${requestId}/deny`,
        headers: admin,
        payload: { note: "no" },
      }),
    ]);
    // Exactly one decision may land; the other is a 409. Which one is timing.
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);

    const row = await t.prisma.approvalRequest.findUniqueOrThrow({ where: { id: requestId } });
    const appRow = await t.prisma.app.findUniqueOrThrow({ where: { slug } });
    const mcp = (appRow.capabilities as { mcp?: string[] }).mcp ?? [];
    // The invariant: the recorded decision and the effective state agree.
    expect(mcp).toEqual(row.status === "approved" ? ["pagerduty"] : []);
  });

  it("409s a decision that disagrees with the one already recorded", async () => {
    const { requestId } = await appWithPendingRequest();
    await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/deny`,
      headers: admin,
      payload: { note: "no" },
    });
    const approve = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/approve`,
      headers: admin,
    });
    expect(approve.statusCode).toBe(409);
    expect(approve.json().error.code).toBe("conflict");
    expect(approve.json().error.details).toEqual({ status: "denied" });

    // …and the requester's withdraw of an already-denied request likewise.
    const withdraw = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/withdraw`,
      headers: owner,
    });
    expect(withdraw.statusCode).toBe(409);
  });

  it("stays a 200 no-op when the same decision is repeated", async () => {
    const { requestId } = await appWithPendingRequest();
    await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/withdraw`,
      headers: owner,
    });
    // A double-click is not a conflict — the caller's intent is already the truth.
    const again = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/withdraw`,
      headers: owner,
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().status).toBe("withdrawn");
  });
});
