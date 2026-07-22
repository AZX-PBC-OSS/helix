import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashDevToken } from "@azx-pbc/shared/devToken";
import { authHeader, buildTestApp, uniqueSlug, type TestApp } from "../test/harness.js";

/**
 * Dev-token CRUD against the test DB (dev-mode design §4). Asserts the write-only
 * property (plaintext returned once, only its hash persisted), rotate/revoke
 * semantics, per-app scoping of the token id, and origin validation. The
 * cross-owner adversarial case lives in `ownership.test.ts`.
 */

let t: TestApp;

beforeAll(async () => {
  t = buildTestApp();
  await t.app.ready();
});

afterAll(async () => {
  await t.close();
});

async function createApp(): Promise<string> {
  const slug = uniqueSlug();
  const res = await t.app.inject({
    method: "POST",
    url: "/api/v1/apps",
    headers: authHeader(),
    payload: { slug, displayName: "Dev" },
  });
  expect(res.statusCode).toBe(201);
  return slug;
}

function mint(slug: string, origins: string[]) {
  return t.app.inject({
    method: "POST",
    url: `/api/v1/apps/${slug}/dev-tokens`,
    headers: authHeader(),
    payload: { origins },
  });
}

describe("dev-token routes", () => {
  it("mints a token once and persists only its hash; the list never leaks it", async () => {
    const slug = await createApp();
    const res = await mint(slug, ["https://myapp.lovable.app", "http://localhost:5173"]);
    expect(res.statusCode).toBe(201);
    const body = res.json();

    expect(body.token).toMatch(/^azxdev_/);
    expect(body.metadata.origins).toEqual(["https://myapp.lovable.app", "http://localhost:5173"]);
    expect(body.metadata.revokedAt ?? null).toBeNull();

    // Stored as a hash of the returned plaintext — never the plaintext itself.
    const row = await t.prisma.appDevToken.findUniqueOrThrow({ where: { id: body.metadata.id } });
    expect(row.tokenHash).toBe(hashDevToken(body.token));
    expect(row.tokenHash).not.toContain(body.token);

    // The list returns metadata only.
    const list = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/dev-tokens`,
      headers: authHeader(),
    });
    expect(list.statusCode).toBe(200);
    const items = list.json();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(body.metadata.id);
    expect(list.body).not.toContain("tokenHash");
    expect(list.body).not.toContain(body.token);
  });

  it("rotate returns a new token, replaces the hash, and keeps the origins", async () => {
    const slug = await createApp();
    const first = (await mint(slug, ["https://x.example"])).json();
    const oldHash = (
      await t.prisma.appDevToken.findUniqueOrThrow({ where: { id: first.metadata.id } })
    ).tokenHash;

    const res = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/dev-tokens/${first.metadata.id}/rotate`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).not.toBe(first.token);
    expect(body.metadata.origins).toEqual(["https://x.example"]);

    const row = await t.prisma.appDevToken.findUniqueOrThrow({ where: { id: first.metadata.id } });
    expect(row.tokenHash).toBe(hashDevToken(body.token));
    expect(row.tokenHash).not.toBe(oldHash);
  });

  it("revoke soft-flips revokedAt (a lookup the dev-gateway checks)", async () => {
    const slug = await createApp();
    const first = (await mint(slug, ["https://x.example"])).json();
    const res = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/apps/${slug}/dev-tokens/${first.metadata.id}`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(204);
    const row = await t.prisma.appDevToken.findUniqueOrThrow({ where: { id: first.metadata.id } });
    expect(row.revokedAt).not.toBeNull();
  });

  it("rejects invalid origins (wildcard / path / bare host) and an empty list with 400", async () => {
    const slug = await createApp();
    for (const bad of [["https://*.lovable.app"], ["https://x.example/path"], ["myapp.com"], []]) {
      const res = await mint(slug, bad);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("validation_failed");
    }
  });

  it("scopes the token id to the app — another app's id is a 404, not a cross-app mutation", async () => {
    const a = await createApp();
    const b = await createApp();
    const token = (await mint(a, ["https://x.example"])).json();
    const rotate = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${b}/dev-tokens/${token.metadata.id}/rotate`,
      headers: authHeader(),
    });
    expect(rotate.statusCode).toBe(404);
    const revoke = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/apps/${b}/dev-tokens/${token.metadata.id}`,
      headers: authHeader(),
    });
    expect(revoke.statusCode).toBe(404);
  });

  it("canonicalizes origins on mint (a trailing slash is dropped so step-3 Origin match works)", async () => {
    const slug = await createApp();
    const res = await mint(slug, ["https://x.example/", "http://localhost:5173"]);
    expect(res.statusCode).toBe(201);
    // Stored/returned as canonical origins — the form a browser Origin header carries
    // (no trailing slash), so the dev-gateway's exact set-membership check matches.
    expect(res.json().metadata.origins).toEqual(["https://x.example", "http://localhost:5173"]);
  });

  it("refuses to rotate a revoked token — revocation is terminal", async () => {
    const slug = await createApp();
    const first = (await mint(slug, ["https://x.example"])).json();
    await t.app.inject({
      method: "DELETE",
      url: `/api/v1/apps/${slug}/dev-tokens/${first.metadata.id}`,
      headers: authHeader(),
    });
    const rotate = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/dev-tokens/${first.metadata.id}/rotate`,
      headers: authHeader(),
    });
    expect(rotate.statusCode).toBe(409);
    // The row stays revoked — rotate didn't re-activate it.
    const row = await t.prisma.appDevToken.findUniqueOrThrow({ where: { id: first.metadata.id } });
    expect(row.revokedAt).not.toBeNull();
  });
});
