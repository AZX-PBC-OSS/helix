import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authHeader, buildTestApp, uniqueSlug, type TestApp } from "../test/harness.js";

let t: TestApp;

beforeAll(async () => {
  t = buildTestApp();
  await t.app.ready();
});

afterAll(async () => {
  await t.close();
});

function createApp(payload: Record<string, unknown>) {
  return t.app.inject({ method: "POST", url: "/api/v1/apps", headers: authHeader(), payload });
}

describe("POST /api/v1/apps", () => {
  it("creates an app (201), defaulting visibility to private", async () => {
    const slug = uniqueSlug();
    const res = await createApp({ slug, displayName: "My App" });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.slug).toBe(slug);
    expect(body.displayName).toBe("My App");
    expect(body.visibility).toEqual({ mode: "private" });
    expect(body.currentVersionId).toBeNull();
  });

  it("rejects an unauthenticated request (401)", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      payload: { slug: uniqueSlug(), displayName: "X" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("rejects a duplicate slug (409 slug_taken)", async () => {
    const slug = uniqueSlug();
    expect((await createApp({ slug, displayName: "First" })).statusCode).toBe(201);
    const res = await createApp({ slug, displayName: "Second" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("slug_taken");
  });

  it("rejects a non-DNS-label slug (400 validation_failed)", async () => {
    const res = await createApp({ slug: "Bad Slug", displayName: "X" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_failed");
  });
});

describe("POST /api/v1/apps/:slug/archive and /unarchive", () => {
  it("archives and unarchives an app, idempotently, with audit events", async () => {
    const slug = uniqueSlug();
    const created = await createApp({ slug, displayName: "Archivable" });
    expect(created.json().archivedAt).toBeNull();

    const archived = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/archive`,
      headers: authHeader(),
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().archivedAt).not.toBeNull();

    // Idempotent: re-archiving keeps the original timestamp.
    const again = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/archive`,
      headers: authHeader(),
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().archivedAt).toBe(archived.json().archivedAt);

    const unarchived = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/unarchive`,
      headers: authHeader(),
    });
    expect(unarchived.statusCode).toBe(200);
    expect(unarchived.json().archivedAt).toBeNull();

    const appId = created.json().id;
    const events = await t.prisma.auditEvent.findMany({ where: { appId } });
    const actions = events.map((e) => e.action);
    expect(actions).toContain("app.archive");
    expect(actions).toContain("app.unarchive");
    // Idempotent re-archive must not have produced a second archive event.
    expect(actions.filter((a) => a === "app.archive")).toHaveLength(1);
  });

  it("requires auth (401) and 404s on unknown slug", async () => {
    const noAuth = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${uniqueSlug()}/archive`,
    });
    expect(noAuth.statusCode).toBe(401);

    const missing = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${uniqueSlug()}/archive`,
      headers: authHeader(),
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("manifest (capabilities) GET/PUT", () => {
  it("stores capabilities at create time and returns them via the manifest", async () => {
    const slug = uniqueSlug();
    await createApp({
      slug,
      displayName: "LLM App",
      capabilities: { llm: { models: ["claude-opus-4-8"], dollarsPerDay: 10 } },
    });

    const got = await t.app.inject({ method: "GET", url: `/api/v1/apps/${slug}/manifest` });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toEqual({
      app: slug,
      visibility: { mode: "private" },
      capabilities: {
        llm: { models: ["claude-opus-4-8"], dollarsPerDay: 10 },
        mcp: [],
        externalOrigins: [],
      },
    });
  });

  it("defaults to the baseline grant set when capabilities are omitted", async () => {
    const slug = uniqueSlug();
    await createApp({ slug, displayName: "Bare" });
    const got = await t.app.inject({ method: "GET", url: `/api/v1/apps/${slug}/manifest` });
    expect(got.json().capabilities).toEqual({ mcp: [], externalOrigins: [] });
  });

  it("replaces grants via PUT (auth required) and audits the change", async () => {
    const slug = uniqueSlug();
    const created = await createApp({ slug, displayName: "Editable" });

    const noAuth = await t.app.inject({
      method: "PUT",
      url: `/api/v1/apps/${slug}/manifest`,
      payload: { capabilities: { llm: { models: ["m"] } } },
    });
    expect(noAuth.statusCode).toBe(401);

    const put = await t.app.inject({
      method: "PUT",
      url: `/api/v1/apps/${slug}/manifest`,
      headers: authHeader(),
      payload: { capabilities: { llm: { models: ["claude-opus-4-8"], dollarsPerDay: 25 } } },
    });
    expect(put.statusCode).toBe(200);
    // Curated model + sub-baseline budget → all baseline, nothing pending.
    expect(put.json().manifest.capabilities.llm).toEqual({
      models: ["claude-opus-4-8"],
      dollarsPerDay: 25,
    });
    expect(put.json().pending).toBeNull();

    const events = await t.prisma.auditEvent.findMany({ where: { appId: created.json().id } });
    expect(events.map((e) => e.action)).toContain("app.manifest.set");
  });

  it("write-gate: commits baseline deltas live but bundles elevated ones into a pending request", async () => {
    const slug = uniqueSlug();
    const created = await createApp({ slug, displayName: "Gated" });

    const put = await t.app.inject({
      method: "PUT",
      url: `/api/v1/apps/${slug}/manifest`,
      headers: authHeader(),
      payload: {
        capabilities: {
          // baseline: a data scope grant
          data: { user: true },
          // elevated: an arbitrary MCP server (high risk)
          mcp: ["pagerduty"],
        },
      },
    });
    expect(put.statusCode).toBe(200);
    const body = put.json();
    // The pending part is NOT applied to the live manifest.
    expect(body.manifest.capabilities.mcp).toEqual([]);
    expect(body.manifest.capabilities.data.user).toBe(true);
    expect(typeof body.pending).toBe("string");

    const reqs = await t.prisma.approvalRequest.findMany({ where: { appId: created.json().id } });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.status).toBe("pending");
    expect(reqs[0]?.risk).toBe("high");

    const events = await t.prisma.auditEvent.findMany({ where: { appId: created.json().id } });
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(["app.manifest.set", "approval.request"]),
    );
  });

  it("404s setting a manifest on an unknown slug", async () => {
    const res = await t.app.inject({
      method: "PUT",
      url: `/api/v1/apps/${uniqueSlug()}/manifest`,
      headers: authHeader(),
      payload: { capabilities: { llm: { models: ["m"] } } },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/v1/apps and /:slug", () => {
  it("round-trips a group-visibility app and 404s on unknown", async () => {
    const slug = uniqueSlug();
    await createApp({ slug, displayName: "Grouped", visibility: { mode: "group", groupId: "g1" } });

    const got = await t.app.inject({ method: "GET", url: `/api/v1/apps/${slug}` });
    expect(got.statusCode).toBe(200);
    expect(got.json().visibility).toEqual({ mode: "group", groupId: "g1" });

    const list = await t.app.inject({ method: "GET", url: "/api/v1/apps" });
    expect(list.statusCode).toBe(200);
    expect(list.json().some((a: { slug: string }) => a.slug === slug)).toBe(true);

    const missing = await t.app.inject({ method: "GET", url: `/api/v1/apps/${uniqueSlug()}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("not_found");
  });
});
