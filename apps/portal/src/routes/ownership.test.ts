import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TokenVerifier } from "../plugins/auth.js";
import { buildTestApp, uniqueSlug, type TestApp } from "../test/harness.js";

/**
 * Adversarial coverage for the `ownsApp` gate (ADR-0007, issue #9): a plain
 * authenticated principal must NOT be able to mutate an app it does not own.
 * Three principals via an injected verifier chain — the app owner, a second
 * non-owner operator (the attacker), and a platform-admin (the owner-or-admin
 * override).
 */
const OWNER = "owner@azx.io";
const OTHER = "other@azx.io";
const ADMIN = "admin@azx.io";
const ADMIN_GROUP = "platform-admin";

const verifiers: TokenVerifier[] = [
  {
    verify: async (t) => {
      if (t === "owner") return { sub: OWNER, via: "oidc", groups: [] };
      if (t === "other") return { sub: OTHER, via: "oidc", groups: [] };
      if (t === "admin") return { sub: ADMIN, via: "oidc", groups: [ADMIN_GROUP] };
      return null;
    },
  },
];

const owner = { authorization: "Bearer owner" };
const other = { authorization: "Bearer other" };
const admin = { authorization: "Bearer admin" };

let t: TestApp;

beforeAll(async () => {
  process.env.PORTAL_ADMIN_GROUP_ID = ADMIN_GROUP;
  t = buildTestApp({ auth: { verifiers, publicConfig: null } });
  await t.app.ready();
});

afterAll(async () => {
  await t.close();
});

/** Create an app owned by OWNER, return its slug. */
async function ownerApp(): Promise<string> {
  const slug = uniqueSlug();
  const res = await t.app.inject({
    method: "POST",
    url: "/api/v1/apps",
    headers: owner,
    payload: { slug, displayName: "Owned" },
  });
  expect(res.statusCode).toBe(201);
  return slug;
}

describe("ownsApp — every app-scoped mutating route rejects a non-owner", () => {
  // One shared owner-owned app: each case below 403s in the preHandler before
  // the handler runs, so the app is never actually mutated and can be reused.
  let slug: string;
  beforeAll(async () => {
    slug = await ownerApp();
  });

  // Every gated route, as (method, url-builder, minimal body). Bodies are
  // minimal valid JSON — the ownership gate runs before any zod/multipart
  // parsing, so shape doesn't matter here; only that the request reaches
  // `ownsApp` with an existing (owner-owned) app.
  interface Route {
    name: string;
    method: "POST" | "PUT" | "DELETE" | "GET";
    urlOf: (s: string) => string;
    payload?: object;
  }
  const ROUTES: Route[] = [
    { name: "archive", method: "POST", urlOf: (s) => `/api/v1/apps/${s}/archive` },
    { name: "unarchive", method: "POST", urlOf: (s) => `/api/v1/apps/${s}/unarchive` },
    {
      name: "manifest PUT",
      method: "PUT",
      urlOf: (s) => `/api/v1/apps/${s}/manifest`,
      payload: { capabilities: {}, reason: "x" },
    },
    {
      name: "access/origin",
      method: "POST",
      urlOf: (s) => `/api/v1/apps/${s}/access/origin`,
      payload: { origin: "https://x.example", reason: "x" },
    },
    {
      name: "visibility",
      method: "POST",
      urlOf: (s) => `/api/v1/apps/${s}/visibility`,
      payload: { visibility: { mode: "private" } },
    },
    {
      name: "access/password enable",
      method: "POST",
      urlOf: (s) => `/api/v1/apps/${s}/access/password`,
    },
    {
      name: "access/password rotate",
      method: "POST",
      urlOf: (s) => `/api/v1/apps/${s}/access/password/rotate`,
      payload: {},
    },
    {
      name: "access/password re-display",
      method: "GET",
      urlOf: (s) => `/api/v1/apps/${s}/access/password`,
    },
    {
      name: "access/password disable",
      method: "DELETE",
      urlOf: (s) => `/api/v1/apps/${s}/access/password`,
    },
    { name: "deploy", method: "POST", urlOf: (s) => `/api/v1/apps/${s}/versions` },
    { name: "promote", method: "POST", urlOf: (s) => `/api/v1/apps/${s}/versions/1/promote` },
    { name: "rollback", method: "POST", urlOf: (s) => `/api/v1/apps/${s}/rollback`, payload: {} },
    { name: "secret list", method: "GET", urlOf: (s) => `/api/v1/apps/${s}/secrets` },
    {
      name: "secret create",
      method: "POST",
      urlOf: (s) => `/api/v1/apps/${s}/secrets`,
      payload: { name: "k", value: "v", injection: { kind: "bearer" } },
    },
    {
      name: "secret rotate",
      method: "POST",
      urlOf: (s) => `/api/v1/apps/${s}/secrets/k/rotate`,
      payload: { value: "v" },
    },
    { name: "secret delete", method: "DELETE", urlOf: (s) => `/api/v1/apps/${s}/secrets/k` },
    {
      name: "dev-token mint",
      method: "POST",
      urlOf: (s) => `/api/v1/apps/${s}/dev-tokens`,
      payload: { origins: ["https://x.example"] },
    },
    {
      name: "dev-token rotate",
      method: "POST",
      urlOf: (s) => `/api/v1/apps/${s}/dev-tokens/00000000-0000-0000-0000-000000000000/rotate`,
    },
    {
      name: "dev-token revoke",
      method: "DELETE",
      urlOf: (s) => `/api/v1/apps/${s}/dev-tokens/00000000-0000-0000-0000-000000000000`,
    },
    {
      name: "collection item delete",
      method: "DELETE",
      urlOf: (s) => `/api/v1/apps/${s}/collections/c/items/00000000-0000-0000-0000-000000000000`,
    },
  ];

  it.each(ROUTES)("rejects non-owner: $name", async (r) => {
    const res = await t.app.inject({
      method: r.method,
      url: r.urlOf(slug),
      headers: other,
      payload: r.payload,
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error.code).toBe("forbidden");
    // The specific message proves this is the ownership gate, not a policy 403
    // (e.g. public/password disabled) that a route might raise for other reasons.
    expect(body.error.message).toMatch(/own this app/);
  });
});

describe("ownsApp — owner and admin pass the gate", () => {
  it("lets the owner mutate their own app", async () => {
    const slug = await ownerApp();
    const res = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/archive`,
      headers: owner,
    });
    expect(res.statusCode).toBe(200);
  });

  it("lets an admin mutate an app they do not own", async () => {
    const slug = await ownerApp();
    const res = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/archive`,
      headers: admin,
    });
    expect(res.statusCode).toBe(200);
  });

  it("lets the owner PUT a baseline manifest", async () => {
    const slug = await ownerApp();
    const res = await t.app.inject({
      method: "PUT",
      url: `/api/v1/apps/${slug}/manifest`,
      headers: owner,
      payload: { capabilities: {}, reason: "baseline" },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("ownsApp — unknown app is 404, not 403", () => {
  it("returns 404 for a slug that does not exist", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${uniqueSlug()}/archive`,
      headers: other,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });
});
