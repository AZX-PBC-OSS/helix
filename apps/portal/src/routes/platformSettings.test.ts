import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TokenVerifier } from "../plugins/auth.js";
import { buildTestApp, uniqueSlug, type TestApp } from "../test/harness.js";
import { PLATFORM_CONFIG_VARS } from "../platformConfig.js";

const ADMIN_GROUP = "platform-admin";
const verifiers: TokenVerifier[] = [
  {
    verify: async (t) => {
      if (t === "member")
        return { oid: "oid-member", sub: "member@azx.io", via: "oidc", groups: [] };
      if (t === "admin")
        return { oid: "oid-admin", sub: "admin@azx.io", via: "oidc", groups: [ADMIN_GROUP] };
      return null;
    },
  },
];
const member = { authorization: "Bearer member" };
const admin = { authorization: "Bearer admin" };

/** A term no other suite's slugs can contain, so a blocked term here never leaks into them. */
function uniqueTerm(): string {
  return `blk${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

let t: TestApp;
const addedTermIds: string[] = [];

async function addTerm(term: string, note?: string) {
  const res = await t.app.inject({
    method: "POST",
    url: "/api/v1/admin/slug-terms",
    headers: admin,
    payload: { term, note },
  });
  if (res.statusCode === 201) addedTermIds.push(res.json().id as string);
  return res;
}

beforeAll(async () => {
  process.env.PORTAL_ADMIN_GROUP_ID = ADMIN_GROUP;
  t = buildTestApp({ auth: { verifiers, publicConfig: null } });
  await t.app.ready();
});

afterAll(async () => {
  await t.prisma.blockedSlugTerm.deleteMany({ where: { id: { in: addedTermIds } } });
  await t.close();
});

describe("admin-only routes", () => {
  it.each([
    ["GET", "/api/v1/admin/settings"],
    ["PUT", "/api/v1/admin/settings"],
    ["GET", "/api/v1/admin/slug-terms"],
    ["POST", "/api/v1/admin/slug-terms"],
    ["DELETE", `/api/v1/admin/slug-terms/${randomUUID()}`],
    ["GET", "/api/v1/admin/config"],
  ] as const)("%s %s refuses a non-admin", async (method, url) => {
    const res = await t.app.inject({ method, url, headers: member, payload: {} });
    expect(res.statusCode).toBe(403);
  });
});

describe("blocked app-name terms", () => {
  it("refuses creation of an app whose slug contains a blocked term, and audits it", async () => {
    const term = uniqueTerm();
    expect((await addTerm(term, "a client name")).statusCode).toBe(201);

    for (const slug of [term, `${term}-demo`, `demo-${term}`]) {
      const res = await t.app.inject({
        method: "POST",
        url: "/api/v1/apps",
        headers: member,
        payload: { slug, displayName: "x" },
      });
      expect(res.statusCode, slug).toBe(400);
      expect(res.json().error).toMatchObject({
        code: "validation_failed",
        details: { field: "slug", reason: "blocked", term },
      });
      expect(res.json().error.message).toContain(`"${term}"`);
    }

    const audit = await t.prisma.auditEvent.findFirst({
      where: { action: "app.create.rejected", metadata: { path: ["slug"], equals: term } },
    });
    expect(audit?.actor).toBe("member@azx.io");
  });

  it("allows a slug where the term is only part of a longer token", async () => {
    const term = uniqueTerm();
    await addTerm(term);
    const res = await t.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: member,
      payload: { slug: `${term}x-demo`, displayName: "x" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("refuses the platform's reserved labels", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: member,
      payload: { slug: "portal", displayName: "x" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details).toMatchObject({ reason: "reserved" });
  });

  it("normalizes, validates and de-duplicates terms", async () => {
    const term = uniqueTerm();
    const created = await addTerm(`  ${term.toUpperCase()} `);
    expect(created.statusCode).toBe(201);
    expect(created.json().term).toBe(term);

    expect((await addTerm(term)).statusCode).toBe(409);
    for (const bad of ["", "a b", "-x", "(a+)+", "x.y"]) {
      expect((await addTerm(bad)).statusCode, bad).toBe(400);
    }
  });

  it("lists terms with the existing apps that already match, and removes them", async () => {
    const slug = uniqueSlug("live");
    await t.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: member,
      payload: { slug, displayName: "Already live" },
    });
    const term = slug.split("-")[1]!;
    const added = await addTerm(term);

    const list = await t.app.inject({
      method: "GET",
      url: "/api/v1/admin/slug-terms",
      headers: admin,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().terms.map((x: { term: string }) => x.term)).toContain(term);
    expect(list.json().matchingApps).toContainEqual({ slug, displayName: "Already live", term });

    const id = added.json().id as string;
    const del = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/admin/slug-terms/${id}`,
      headers: admin,
    });
    expect(del.statusCode).toBe(204);
    const again = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/admin/slug-terms/${id}`,
      headers: admin,
    });
    expect(again.statusCode).toBe(404);
    const notUuid = await t.app.inject({
      method: "DELETE",
      url: "/api/v1/admin/slug-terms/nope",
      headers: admin,
    });
    expect(notUuid.statusCode).toBe(404);
  });
});

describe("GET /api/v1/slug-check", () => {
  const check = async (slug: string) =>
    (
      await t.app.inject({
        method: "GET",
        url: `/api/v1/slug-check?slug=${encodeURIComponent(slug)}`,
        headers: member,
      })
    ).json();

  it("reports ok, invalid, reserved, blocked and taken", async () => {
    const term = uniqueTerm();
    await addTerm(term);
    const taken = uniqueSlug("taken");
    await t.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: member,
      payload: { slug: taken, displayName: "x" },
    });

    expect(await check(uniqueSlug("free"))).toEqual({ ok: true });
    expect(await check("Not A Slug")).toMatchObject({ ok: false, reason: "invalid" });
    expect(await check("www")).toMatchObject({ ok: false, reason: "reserved" });
    expect(await check(`${term}-demo`)).toMatchObject({ ok: false, reason: "blocked" });
    expect(await check(taken)).toMatchObject({ ok: false, reason: "taken" });
  });

  it("requires authentication", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/v1/slug-check?slug=x" });
    expect(res.statusCode).toBe(401);
  });
});

describe("operator settings", () => {
  it("round-trips, clears blank fields, and audits the change", async () => {
    const put = await t.app.inject({
      method: "PUT",
      url: "/api/v1/admin/settings",
      headers: admin,
      payload: {
        operatorName: "  Example Co  ",
        operatorDescription: "Client deliverables from Example Co.",
        operatorContactUrl: "mailto:ops@example.com",
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({
      operatorName: "Example Co",
      operatorContactUrl: "mailto:ops@example.com",
      updatedBy: "admin@azx.io",
    });

    const cleared = await t.app.inject({
      method: "PUT",
      url: "/api/v1/admin/settings",
      headers: admin,
      payload: { operatorName: "", operatorDescription: null, operatorContactUrl: " " },
    });
    expect(cleared.json()).toMatchObject({
      operatorName: null,
      operatorDescription: null,
      operatorContactUrl: null,
    });

    const audit = await t.prisma.auditEvent.findFirst({
      where: { action: "platform.settings.updated", actor: "admin@azx.io" },
    });
    expect(audit).not.toBeNull();
  });

  it("accepts only https: and mailto: contact links", async () => {
    for (const bad of [
      "javascript:alert(1)",
      "http://example.com",
      "data:text/html,x",
      "nope",
      "https://user:pass@example.com",
    ]) {
      const res = await t.app.inject({
        method: "PUT",
        url: "/api/v1/admin/settings",
        headers: admin,
        payload: { operatorName: null, operatorDescription: null, operatorContactUrl: bad },
      });
      expect(res.statusCode, bad).toBe(400);
    }
  });
});

describe("GET /api/v1/admin/config", () => {
  it("never returns the value of a secret", async () => {
    const sentinel = `sentinel-${randomUUID()}`;
    const secrets = PLATFORM_CONFIG_VARS.filter((v) => v.secret).map((v) => v.name);
    const saved = Object.fromEntries(
      [...secrets, "PORTAL_EGRESS_URL", "AZURE_STORAGE_BLOB_ENDPOINT"].map((n) => [
        n,
        process.env[n],
      ]),
    );
    try {
      for (const name of secrets) process.env[name] = sentinel;
      // A non-secret URL that carries credentials is withheld too.
      process.env.PORTAL_EGRESS_URL = `https://user:${sentinel}@egress.internal`;
      // …and so is one with a query string, where a SAS token rides.
      process.env.AZURE_STORAGE_BLOB_ENDPOINT = `https://acct.blob.core.windows.net/?sv=1&sig=${sentinel}`;

      const res = await t.app.inject({
        method: "GET",
        url: "/api/v1/admin/config",
        headers: admin,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(sentinel);
      const egress = res
        .json()
        .entries.find((e: { name: string }) => e.name === "PORTAL_EGRESS_URL");
      expect(egress).toMatchObject({ set: true, secret: true, value: null });
      const blob = res
        .json()
        .entries.find((e: { name: string }) => e.name === "AZURE_STORAGE_BLOB_ENDPOINT");
      expect(blob).toMatchObject({ set: true, secret: true, value: null });
      for (const name of secrets) {
        const entry = res.json().entries.find((e: { name: string }) => e.name === name);
        expect(entry, name).toMatchObject({ set: true, secret: true, value: null });
      }
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("shows non-secret values", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/v1/admin/config", headers: admin });
    const entry = res
      .json()
      .entries.find((e: { name: string }) => e.name === "PORTAL_ADMIN_GROUP_ID");
    expect(entry).toMatchObject({ set: true, secret: false, value: ADMIN_GROUP });
  });
});
