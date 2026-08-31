import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BOM } from "@azx-pbc/shared";
import type { Prisma } from "../db/client.js";
import type { PrismaClient } from "../db/client.js";
import {
  authHeader,
  buildTestApp,
  createTestPrisma,
  uniqueSlug,
  type TestApp,
} from "../test/harness.js";
import { exportWindow, MAX_EXPORT_ROWS } from "./data.js";

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

  it("treats an empty ?env= as absent, not as a bad value", async () => {
    // What `URLSearchParams.set("env","")` produces from a caller that builds its
    // query string unconditionally. 400ing it would contradict the documented
    // "absent means both tiers".
    const { id, slug } = await seedCollection(2);
    await seedInto(id, 3, { env: "dev" });
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/collections/contacts?env=`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows).toHaveLength(5);
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

/**
 * Which rows survive the export cap, isolated from the database — reaching the
 * cap for real means seeding 10,001 rows, and the interesting behaviour is pure.
 */
describe("exportWindow", () => {
  it("keeps the NEWEST rows when over the cap, and emits them oldest-first", () => {
    // A drain that outgrows the cap must not drop the submissions that just
    // arrived; those are the ones an owner cannot afford to lose.
    const newestFirst = ["r5", "r4", "r3", "r2", "r1"];
    expect(exportWindow(newestFirst, 3)).toEqual({ rows: ["r3", "r4", "r5"], truncated: true });
  });

  it("emits oldest-first when under the cap too", () => {
    // The branch that catches reversing only the truncated side — a short export
    // would silently come back newest-first.
    expect(exportWindow(["r3", "r2", "r1"], 10)).toEqual({
      rows: ["r1", "r2", "r3"],
      truncated: false,
    });
  });

  it("does not report truncation at exactly the cap", () => {
    expect(exportWindow(["r3", "r2", "r1"], 3).truncated).toBe(false);
  });

  it("does not mutate its input", () => {
    const rows = ["r2", "r1"];
    exportWindow(rows, 10);
    expect(rows).toEqual(["r2", "r1"]);
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

  it("emits rows oldest-first", async () => {
    // The export reads as a log, unlike the list route (newest-first). Pins the
    // reverse: dropping it flips every export to descending.
    const { slug } = await seedCollection(3);
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/collections/contacts/export`,
      headers: authHeader(),
    });
    expect(res.json().items.map((i: { item: { email: string } }) => i.item.email)).toEqual([
      "lead0@example.com",
      "lead1@example.com",
      "lead2@example.com",
    ]);
  });

  it("keeps the newest rows when the collection outgrows the export cap", async () => {
    // The one case that separates "capped" from "capped at the wrong end". A
    // single createMany makes the real boundary cheap enough to assert against
    // the route (~0.5s) rather than trusting the unit test alone.
    const { id, slug } = await seedCollection(0);
    const base = Date.now() - 20_000_000;
    await t.prisma.appCollectionItem.createMany({
      data: Array.from({ length: MAX_EXPORT_ROWS + 1 }, (_, i) => ({
        appId: id,
        collection: "bulk",
        item: { n: i },
        createdAt: new Date(base + i * 1000),
      })),
    });

    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/collections/bulk/export`,
      headers: authHeader(),
    });
    const items = res.json().items as { item: { n: number } }[];
    expect(res.headers["x-helix-export-truncated"]).toBe(String(MAX_EXPORT_ROWS));
    expect(items).toHaveLength(MAX_EXPORT_ROWS);
    // n=0 is the oldest row and the one that must be dropped; n=10000 the newest
    // and the one that must survive. Still emitted oldest-first within the window.
    expect(items[0]!.item.n).toBe(1);
    expect(items.at(-1)!.item.n).toBe(MAX_EXPORT_ROWS);
  });

  it("derives columns from the oldest row first", async () => {
    // Column ties break on first appearance in scan order, so the scan direction
    // is load-bearing: at the column cap it decides which key gets a column at
    // all. Distinct key sets per row — jsonb canonicalises key order within a
    // row, so `{b,a}` and `{a,b}` are indistinguishable once stored.
    const { id, slug } = await seedCollection(0);
    await t.prisma.appCollectionItem.create({
      data: {
        appId: id,
        collection: "contacts",
        item: { alpha: "older" },
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    await t.prisma.appCollectionItem.create({
      data: { appId: id, collection: "contacts", item: { beta: "newer" } },
    });

    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/collections/contacts/export?format=csv`,
      headers: authHeader(),
    });
    expect(res.body.slice(BOM.length).split("\n")[0]).toBe(
      "id,createdAt,env,userOid,userName,userEmail,item.alpha,item.beta,item,meta",
    );
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
      "id,createdAt,env,userOid,userName,userEmail,item.email,item,meta",
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
    expect(res.body.slice(BOM.length).split("\n")[0]).toBe(
      "id,createdAt,env,userOid,userName,userEmail,item,meta",
    );
  });

  it("reports column truncation on CSV, but not on JSON", async () => {
    // Two independent caps. Losing columns costs the owner nothing (the raw
    // `item` column keeps every key) but they should still be told — and the
    // claim must not be attached to a JSON export, which has no columns to cap.
    const wide = () => Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, i]));
    const { id, slug } = await seedCollection(1, { item: wide });

    const csv = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/collections/contacts/export?format=csv`,
      headers: authHeader(),
    });
    expect(csv.headers["x-helix-export-columns-truncated"]).toBe("12");

    const json = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/collections/contacts/export`,
      headers: authHeader(),
    });
    expect(json.headers["x-helix-export-columns-truncated"]).toBeUndefined();

    const events = await t.prisma.auditEvent.findMany({ where: { appId: id } });
    const byFormat = (f: string) =>
      events.find(
        (e) =>
          e.action === "collection.exported" && (e.metadata as { format: string }).format === f,
      );
    expect(byFormat("csv")!.metadata).toMatchObject({ columnsTruncated: true });
    expect(byFormat("json")!.metadata).not.toHaveProperty("columnsTruncated");
  });

  it("does not claim column truncation for a narrow collection", async () => {
    const { slug } = await seedCollection(1);
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/collections/contacts/export?format=csv`,
      headers: authHeader(),
    });
    expect(res.headers["x-helix-export-columns-truncated"]).toBeUndefined();
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

  it("treats an empty ?env= on the export as absent, and audits it as absent", async () => {
    const { id, slug } = await seedCollection(2);
    await seedInto(id, 3, { env: "dev" });
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/collections/contacts/export?env=`,
      headers: authHeader(),
    });
    expect(res.json().items).toHaveLength(5);
    // The audit row has to read the same as a request that omitted `env` — the
    // spread must stay empty, not record `env: ""`.
    const events = await t.prisma.auditEvent.findMany({ where: { appId: id } });
    expect(events.find((e) => e.action === "collection.exported")!.metadata).not.toHaveProperty(
      "env",
    );
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

  it("rolls the erasure back when the audit write fails", async () => {
    // The property the transaction exists for, and the only test that fails if it
    // is removed. A deletion that commits while its audit row does not is
    // indistinguishable from data loss — on the route a subject-access request is
    // answered with, where "we erased it" has to be provable afterwards.
    const failing = createTestPrisma().$extends({
      query: {
        auditEvent: {
          create() {
            throw new Error("audit unavailable");
          },
        },
      },
    }) as unknown as PrismaClient;
    // Seed through the healthy app — creating an app audits too, so the failing
    // client cannot be used to set the fixture up.
    const { id, slug } = await seedCollection(1);
    const item = await t.prisma.appCollectionItem.findFirstOrThrow({ where: { appId: id } });

    const bad = buildTestApp({ prisma: failing });
    await bad.app.ready();
    try {
      const res = await bad.app.inject({
        method: "DELETE",
        url: `/api/v1/apps/${slug}/collections/contacts/items/${item.id}`,
        headers: authHeader(),
      });
      expect(res.statusCode).toBe(500);
      // Read back on the healthy client: the row must still be there.
      expect(await t.prisma.appCollectionItem.count({ where: { id: item.id } })).toBe(1);
    } finally {
      await bad.close();
    }
  });

  it("404s an unknown item without writing an audit row", async () => {
    // The erasure and its audit row commit together, so a delete that matched
    // nothing must leave nothing behind. Batching the two statements and throwing
    // afterwards would commit first and leave a `collection.item_deleted` row
    // asserting an erasure that never happened — a lie in the ledger a
    // subject-access request is answered from, and owner-triggerable at will.
    const { id, slug } = await seedCollection(1);
    const res = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/apps/${slug}/collections/contacts/items/00000000-0000-0000-0000-000000000000`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
    const events = await t.prisma.auditEvent.findMany({ where: { appId: id } });
    expect(events.filter((e) => e.action === "collection.item_deleted")).toEqual([]);
    // And the real row is untouched.
    expect(await t.prisma.appCollectionItem.count({ where: { appId: id } })).toBe(1);
  });

  it("404s an item addressed under the wrong collection, without auditing", async () => {
    const { id, slug } = await seedCollection(1);
    const item = await t.prisma.appCollectionItem.findFirst({ where: { appId: id } });
    const res = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/apps/${slug}/collections/feedback/items/${item!.id}`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
    const events = await t.prisma.auditEvent.findMany({ where: { appId: id } });
    expect(events.filter((e) => e.action === "collection.item_deleted")).toEqual([]);
    expect(await t.prisma.appCollectionItem.count({ where: { appId: id } })).toBe(1);
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
