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
