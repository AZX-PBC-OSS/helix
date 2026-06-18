import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TokenVerifier } from "../plugins/auth.js";
import { buildTestApp, uniqueSlug, type TestApp } from "../test/harness.js";

// Two actors: an app owner (no admin group) and a platform admin.
const OWNER = "owner@azx.io";
const ADMIN = "admin@azx.io";
const ADMIN_GROUP = "platform-admins";

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

afterEach(() => {
  delete process.env.PORTAL_ALLOW_SELF_APPROVE;
});

afterAll(async () => {
  await t.close();
});

/** Create an app owned by OWNER and file an elevated (mcp) request on it. */
async function appWithPendingRequest() {
  const slug = uniqueSlug();
  await t.app.inject({
    method: "POST",
    url: "/api/v1/apps",
    headers: owner,
    payload: { slug, displayName: "Gated" },
  });
  const put = await t.app.inject({
    method: "PUT",
    url: `/api/v1/apps/${slug}/manifest`,
    headers: owner,
    payload: { capabilities: { mcp: ["pagerduty"] }, reason: "need paging" },
  });
  return { slug, requestId: put.json().pending as string };
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

  it("refuses the global queue to non-admins", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/v1/approvals", headers: owner });
    expect(res.statusCode).toBe(403);
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

    const manifest = await t.app.inject({ method: "GET", url: `/api/v1/apps/${slug}/manifest` });
    expect(manifest.json().capabilities.mcp).toEqual(["pagerduty"]);
  });

  it("is idempotent — a second approve is a no-op", async () => {
    const { requestId } = await appWithPendingRequest();
    await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/approve`,
      headers: admin,
    });
    const second = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/approve`,
      headers: admin,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe("approved");
  });

  it("refuses a non-admin approver", async () => {
    const { requestId } = await appWithPendingRequest();
    const res = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/approve`,
      headers: owner,
    });
    expect(res.statusCode).toBe(403);
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

    process.env.PORTAL_ALLOW_SELF_APPROVE = "true";
    const allowed = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/approve`,
      headers: admin,
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().status).toBe("approved");
  });

  it("auto-bounces to needs_changes when the effective state moved (conflict)", async () => {
    const { slug, requestId } = await appWithPendingRequest();
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
    const manifest = await t.app.inject({ method: "GET", url: `/api/v1/apps/${slug}/manifest` });
    expect(manifest.json().capabilities.mcp).toEqual(["other"]);
  });
});

describe("deny / needs_changes / withdraw", () => {
  it("requires a note to deny", async () => {
    const { requestId } = await appWithPendingRequest();
    const noNote = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/deny`,
      headers: admin,
    });
    expect(noNote.statusCode).toBe(400);
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
    const { requestId } = await appWithPendingRequest();
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
  });
});

describe("go-public via the visibility write-gate", () => {
  it("opens a request for → public and applies it on approve", async () => {
    const slug = uniqueSlug();
    await t.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: owner,
      payload: { slug, displayName: "pub" },
    });

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
      (await t.app.inject({ method: "GET", url: `/api/v1/apps/${slug}` })).json().visibility.mode,
    ).toBe("private");

    await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/approve`,
      headers: admin,
    });
    expect(
      (await t.app.inject({ method: "GET", url: `/api/v1/apps/${slug}` })).json().visibility.mode,
    ).toBe("public");
  });

  it("applies a reduction (→ private) immediately, no request", async () => {
    const slug = uniqueSlug();
    await t.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: owner,
      payload: { slug, displayName: "grp", visibility: { mode: "group", groupId: "g1" } },
    });
    const vis = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/visibility`,
      headers: owner,
      payload: { visibility: { mode: "private" } },
    });
    expect(vis.statusCode).toBe(200);
    expect(vis.json().pending).toBeNull();
    expect(vis.json().app.visibility.mode).toBe("private");
  });
});
