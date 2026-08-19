import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppListItem } from "@azx-pbc/shared";
import type { PrismaClient } from "../db/client.js";
import type { TokenVerifier } from "../plugins/auth.js";
import { buildTestApp, createTestPrisma, uniqueSlug, type TestApp } from "../test/harness.js";

/**
 * `GET /api/v1/apps` — the `scope` filter and the deploy aggregates the apps
 * table renders.
 *
 * Two principals via an injected verifier chain, neither an admin: `scope` is a
 * presentation filter, so the interesting assertion is that a **plain** operator
 * can still ask for `all` and see a colleague's apps. If someone later mistakes
 * `mine` for a permission boundary and gates `all` behind admin, the third case
 * here fails and says why.
 */
const ALICE = "alice@azx.dev";
const BOB = "bob@azx.dev";

const verifiers: TokenVerifier[] = [
  {
    verify: async (token) => {
      if (token === "alice")
        return { sub: ALICE, via: "oidc", name: "Alice Anders", email: ALICE, groups: [] };
      if (token === "bob")
        return { sub: BOB, via: "oidc", name: "Bob Builder", email: BOB, groups: [] };
      return null;
    },
  },
];

const alice = { authorization: "Bearer alice" };
const bob = { authorization: "Bearer bob" };

let t: TestApp;

beforeAll(async () => {
  t = buildTestApp({ auth: { verifiers, publicConfig: null } });
  await t.app.ready();
});

afterAll(async () => {
  await t.close();
});

async function createApp(headers: Record<string, string>, displayName = "App"): Promise<string> {
  const slug = uniqueSlug();
  const res = await t.app.inject({
    method: "POST",
    url: "/api/v1/apps",
    headers,
    payload: { slug, displayName },
  });
  expect(res.statusCode).toBe(201);
  return slug;
}

async function list(headers: Record<string, string>, scope?: string): Promise<AppListItem[]> {
  const res = await t.app.inject({
    method: "GET",
    url: scope === undefined ? "/api/v1/apps" : `/api/v1/apps?scope=${scope}`,
    headers,
  });
  expect(res.statusCode).toBe(200);
  return res.json() as AppListItem[];
}

const slugs = (rows: AppListItem[]): string[] => rows.map((r) => r.slug);

describe("GET /api/v1/apps — scope", () => {
  it("defaults to the caller's own apps", async () => {
    const mine = await createApp(alice);
    const theirs = await createApp(bob);

    expect(slugs(await list(alice))).toContain(mine);
    expect(slugs(await list(alice))).not.toContain(theirs);
  });

  it("returns every app under scope=all — for a non-admin too", async () => {
    const hers = await createApp(alice);
    const his = await createApp(bob);

    // Bob holds no admin group. Browsing a colleague's apps is the intended
    // behaviour, not a privilege: one trusted org per deployment (ADR-0028).
    const all = slugs(await list(bob, "all"));
    expect(all).toContain(his);
    expect(all).toContain(hers);
  });

  it("falls back to mine on an unrecognised scope rather than 400ing", async () => {
    const mine = await createApp(alice);
    const theirs = await createApp(bob);

    const rows = slugs(await list(alice, "everything"));
    expect(rows).toContain(mine);
    expect(rows).not.toContain(theirs);
  });

  it("still requires sign-in for scope=all", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/v1/apps?scope=all" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/v1/apps — owner", () => {
  it("carries the owner's identity and display claims, captured at create", async () => {
    const slug = await createApp(alice);
    const row = (await list(alice)).find((r) => r.slug === slug);

    expect(row?.ownerId).toBe(ALICE);
    expect(row?.ownerName).toBe("Alice Anders");
    expect(row?.ownerEmail).toBe(ALICE);
  });

  // The display half is for rendering, so it must reach a caller who is not the
  // owner — an owner column that blanks out for everyone else answers nothing.
  it("shows a colleague's owner rather than hiding it", async () => {
    const hers = await createApp(alice);
    const row = (await list(bob, "all")).find((r) => r.slug === hers);

    expect(row?.ownerId).toBe(ALICE);
    expect(row?.ownerName).toBe("Alice Anders");
  });

  it("omits owner fields for a row that has none", async () => {
    const slug = await createApp(alice);
    await t.prisma.app.update({
      where: { slug },
      data: { ownerId: null, ownerName: null, ownerEmail: null },
    });

    // Only reachable via scope=all now: an app with no owner is nobody's.
    const row = (await list(alice, "all")).find((r) => r.slug === slug);
    expect(row).toBeDefined();
    expect(row?.ownerId).toBeUndefined();
    expect(row?.ownerName).toBeUndefined();
    expect(row?.ownerEmail).toBeUndefined();
  });
});

describe("GET /api/v1/apps — deploy aggregates", () => {
  /** Give an app `count` versions; promote `liveNumber` if given. */
  async function seedVersions(slug: string, count: number, liveNumber?: number): Promise<void> {
    const row = await t.prisma.app.findUniqueOrThrow({ where: { slug } });
    for (let n = 1; n <= count; n += 1) {
      const v = await t.prisma.version.create({
        data: {
          appId: row.id,
          number: n,
          blobPrefix: `apps/${row.id}/${n}/`,
          status: n === liveNumber ? "live" : "preview",
        },
      });
      if (n === liveNumber) {
        await t.prisma.app.update({ where: { id: row.id }, data: { currentVersionId: v.id } });
      }
    }
  }

  it("reports zeroes for an app that has never been deployed", async () => {
    const slug = await createApp(alice);
    const row = (await list(alice)).find((r) => r.slug === slug);

    expect(row?.lastDeployAt).toBeNull();
    expect(row?.liveVersionNumber).toBeNull();
    expect(row?.latestPreviewNumber).toBeNull();
  });

  it("rolls up last deploy, live version and latest preview", async () => {
    const slug = await createApp(alice);
    await seedVersions(slug, 3, 2);
    const row = (await list(alice)).find((r) => r.slug === slug);

    expect(row?.liveVersionNumber).toBe(2);
    // v1 and v3 are preview; the newest is what the "awaiting promote" signal reads.
    expect(row?.latestPreviewNumber).toBe(3);
    expect(row?.lastDeployAt).not.toBeNull();
  });

  /**
   * The reason these fields exist. The card grid this replaced fetched
   * `GET /versions` per app, so first paint cost 1+N round trips and the table's
   * status column — which had no versions to read — could not tell an
   * undeployed app from one with a preview waiting. Pin the query count flat.
   */
  it("costs the same number of queries for one app as for several", async () => {
    let queries = 0;
    const counting = createTestPrisma().$extends({
      query: {
        async $allOperations({ args, query }) {
          queries += 1;
          return query(args);
        },
      },
    }) as unknown as PrismaClient;
    const counted = buildTestApp({ auth: { verifiers, publicConfig: null }, prisma: counting });
    await counted.app.ready();

    try {
      const one = uniqueSlug();
      await counted.app.inject({
        method: "POST",
        url: "/api/v1/apps",
        headers: alice,
        payload: { slug: one, displayName: "One" },
      });

      queries = 0;
      await counted.app.inject({ method: "GET", url: "/api/v1/apps", headers: alice });
      const forOne = queries;

      for (const name of ["Two", "Three", "Four"]) {
        await counted.app.inject({
          method: "POST",
          url: "/api/v1/apps",
          headers: alice,
          payload: { slug: uniqueSlug(), displayName: name },
        });
      }

      queries = 0;
      const many = await counted.app.inject({
        method: "GET",
        url: "/api/v1/apps",
        headers: alice,
      });
      expect(many.json().length).toBeGreaterThanOrEqual(4);
      expect(queries).toBe(forOne);
    } finally {
      await counted.close();
    }
  });
});
