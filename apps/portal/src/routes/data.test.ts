import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BOM } from "@azx-pbc/shared";
import type { Prisma } from "../db/client.js";
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

/** `item` is a Json column, so a seeded value has to be valid Prisma Json input. */
interface SeedOpts {
  env?: "prod" | "dev";
  item?: (i: number) => Prisma.InputJsonValue;
}

/** Create an app and seed N collection items into `contacts`. */
async function seedCollection(
  n: number,
  opts: SeedOpts = {},
): Promise<{ id: string; slug: string }> {
  const slug = uniqueSlug();
  const created = await t.app.inject({
    method: "POST",
    url: "/api/v1/apps",
    headers: authHeader(),
    payload: { slug, displayName: "Harvester" },
  });
  const id = created.json().id as string;
  await seedInto(id, n, opts);
  return { id, slug };
}

/** Seed N more items into an existing app's `contacts` collection. */
async function seedInto(appId: string, n: number, opts: SeedOpts = {}): Promise<void> {
  for (let i = 0; i < n; i++) {
    await t.prisma.appCollectionItem.create({
      data: {
        appId,
        collection: "contacts",
        env: opts.env ?? "prod",
        userOid: null,
        item: opts.item ? opts.item(i) : { email: `lead${i}@example.com` },
        meta: { ipHash: "abc123" },
        // Distinct timestamps so the createdAt cursor has no ties (rapid inserts
        // would otherwise share a millisecond — same caveat as the audit log).
        createdAt: new Date(Date.now() - (n - i) * 1000),
      },
    });
  }
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

  it("returns both tiers by default and filters on ?env=", async () => {
    // The portal reads cross-env by design; hiding dev rows is the SPA's choice,
    // not the API's, so an owner can always reach everything they collected.
    const { id, slug } = await seedCollection(2);
    await seedInto(id, 3, { env: "dev" });

    const all = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/collections/contacts`,
      headers: authHeader(),
    });
    expect(all.json().rows).toHaveLength(5);
    expect(
      all
        .json()
        .rows.map((r: { env: string }) => r.env)
        .sort(),
    ).toEqual(["dev", "dev", "dev", "prod", "prod"]);

    const dev = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/collections/contacts?env=dev`,
      headers: authHeader(),
    });
    expect(dev.json().rows).toHaveLength(3);

    const prod = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/collections/contacts?env=prod`,
      headers: authHeader(),
    });
    expect(prod.json().rows).toHaveLength(2);
  });

  it("400s an unknown env", async () => {
    const { slug } = await seedCollection(1);
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/collections/contacts?env=staging`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_failed");
  });
});

describe("GET /api/v1/apps/:slug/collections (index)", () => {
  it("counts rows per collection and env", async () => {
    const { id, slug } = await seedCollection(2);
    await seedInto(id, 3, { env: "dev" });
    await t.prisma.appCollectionItem.create({
      data: { appId: id, collection: "feedback", env: "prod", item: { note: "hi" } },
    });

    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/collections`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { name: "contacts", env: "dev", count: 3, lastAt: expect.any(String) },
      { name: "contacts", env: "prod", count: 2, lastAt: expect.any(String) },
      { name: "feedback", env: "prod", count: 1, lastAt: expect.any(String) },
    ]);
  });

  it("returns [] for an app that has collected nothing", async () => {
    const { slug } = await seedCollection(0);
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/collections`,
      headers: authHeader(),
    });
    expect(res.json()).toEqual([]);
  });

  it("surfaces a collection the manifest no longer declares", async () => {
    // The whole reason this route exists: grants are owner-editable and nothing
    // deletes rows, so an undeclared collection is still PII the owner must reach.
    const { id, slug } = await seedCollection(0);
    await t.prisma.appCollectionItem.create({
      data: { appId: id, collection: "orphaned", env: "prod", item: { email: "a@b.c" } },
    });
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/collections`,
      headers: authHeader(),
    });
    expect(res.json()).toEqual([
      { name: "orphaned", env: "prod", count: 1, lastAt: expect.any(String) },
    ]);
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

  it("exports CSV with derived columns and a download disposition", async () => {
    const { slug } = await seedCollection(1);
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/collections/contacts/export?format=csv`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain(".csv");
    // Same PII as the JSON branch, so the same cache directive.
    expect(res.headers["cache-control"]).toBe("no-store");
    // Platform columns, then `item.`-namespaced app keys, then the raw JSON.
    expect(res.body.slice(BOM.length).split("\n")[0]).toBe(
      "id,createdAt,env,userOid,item.email,item,meta",
    );
  });

  it("neutralises a formula a visitor submitted", async () => {
    // The value is anonymous-visitor input; unguarded it executes on open.
    const { slug } = await seedCollection(1, { item: () => ({ name: '=HYPERLINK("http://e/")' }) });
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/collections/contacts/export?format=csv`,
      headers: authHeader(),
    });
    expect(res.body).toContain("'=HYPERLINK");
  });

  it("exports a non-object item without breaking the CSV", async () => {
    const { slug } = await seedCollection(1, { item: () => "just a string" });
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/collections/contacts/export?format=csv`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.slice(BOM.length).split("\n")[0]).toBe("id,createdAt,env,userOid,item,meta");
  });

  it("does not claim truncation on a normal export", async () => {
    const { slug } = await seedCollection(2);
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/collections/contacts/export`,
      headers: authHeader(),
    });
    expect(res.headers["x-helix-export-truncated"]).toBeUndefined();
  });

  it("honours ?env= on the export", async () => {
    const { id, slug } = await seedCollection(2);
    await seedInto(id, 3, { env: "dev" });
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/collections/contacts/export?env=prod`,
      headers: authHeader(),
    });
    expect(res.json().items).toHaveLength(2);
  });

  it("audits an export", async () => {
    const { id, slug } = await seedCollection(2);
    await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/collections/contacts/export?format=csv`,
      headers: authHeader(),
    });
    const events = await t.prisma.auditEvent.findMany({ where: { appId: id } });
    const exported = events.find((e) => e.action === "collection.exported");
    expect(exported).toBeDefined();
    expect(exported!.metadata).toMatchObject({
      collection: "contacts",
      format: "csv",
      rows: 2,
      truncated: false,
    });
  });

  it("deletes one item (owner erasure) and audits it", async () => {
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
    // An erasure with no record is indistinguishable from data loss.
    const events = await t.prisma.auditEvent.findMany({ where: { appId: id } });
    expect(events.find((e) => e.action === "collection.item_deleted")?.metadata).toMatchObject({
      collection: "contacts",
      id: item!.id,
    });
  });
});
