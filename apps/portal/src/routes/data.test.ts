import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authHeader, buildTestApp, uniqueSlug, type TestApp } from "../test/harness.js";

/**
 * The owner-facing collection drain/export (app-data design §3.2/§5). These are
 * the read side of the write-only collection — the portal role can SELECT/export/
 * delete what the edge role can only INSERT. Bearer-gated like the usage routes.
 */

let t: TestApp;

beforeAll(async () => {
  t = buildTestApp();
  await t.app.ready();
});

afterAll(async () => {
  await t.close();
});

/** Create an app and seed N collection items into `contacts`. */
async function seedCollection(n: number): Promise<{ id: string; slug: string }> {
  const slug = uniqueSlug();
  const created = await t.app.inject({
    method: "POST",
    url: "/api/v1/apps",
    headers: authHeader(),
    payload: { slug, displayName: "Harvester" },
  });
  const id = created.json().id as string;
  for (let i = 0; i < n; i++) {
    await t.prisma.appCollectionItem.create({
      data: {
        appId: id,
        collection: "contacts",
        userOid: null,
        item: { email: `lead${i}@example.com` },
        meta: { ipHash: "abc123" },
        // Distinct timestamps so the createdAt cursor has no ties (rapid inserts
        // would otherwise share a millisecond — same caveat as the audit log).
        createdAt: new Date(Date.now() - (n - i) * 1000),
      },
    });
  }
  return { id, slug };
}

describe("GET /api/v1/apps/:slug/collections/:name", () => {
  it("requires a bearer token (401)", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/api/v1/apps/whatever/collections/contacts",
    });
    expect(res.statusCode).toBe(401);
  });

  it("404s an unknown app", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${uniqueSlug()}/collections/contacts`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
  });

  it("lists items newest-first and paginates", async () => {
    const { slug } = await seedCollection(3);
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/collections/contacts?limit=2`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rows).toHaveLength(2);
    expect(body.nextBefore).toBeDefined();
    // meta is visible to the owner (abuse triage), unlike to the app.
    expect(body.rows[0].meta).toEqual({ ipHash: "abc123" });

    const next = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/collections/contacts?before=${encodeURIComponent(body.nextBefore)}`,
      headers: authHeader(),
    });
    expect(next.json().rows).toHaveLength(1);
    expect(next.json().nextBefore).toBeUndefined();
  });
});

describe("export + delete", () => {
  it("exports JSON", async () => {
    const { slug } = await seedCollection(2);
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/collections/contacts/export`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(2);
  });

  it("exports CSV with a download disposition", async () => {
    const { slug } = await seedCollection(1);
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/collections/contacts/export?format=csv`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain(".csv");
    expect(res.body.split("\n")[0]).toBe("id,createdAt,userOid,item,meta");
  });

  it("deletes one item (owner erasure)", async () => {
    const { id, slug } = await seedCollection(1);
    const item = await t.prisma.appCollectionItem.findFirst({ where: { appId: id } });
    const del = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/apps/${slug}/collections/contacts/items/${item!.id}`,
      headers: authHeader(),
    });
    expect(del.statusCode).toBe(204);
    const after = await t.prisma.appCollectionItem.count({ where: { appId: id } });
    expect(after).toBe(0);
  });
});
