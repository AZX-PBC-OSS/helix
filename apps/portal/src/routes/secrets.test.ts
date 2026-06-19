import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevEnvelopeSecretStore } from "@helix/secret-store";
import { authHeader, buildTestApp, uniqueSlug, type TestApp } from "../test/harness.js";

/**
 * Connection-secret CRUD (secrets design §5): app-scoped (owner) and global
 * (admin), write-only/rotate-only, sealed by the store and never re-displayed.
 * The dev token carries the admin group (PORTAL_DEV_ACTOR_GROUPS) so it can
 * drive both families.
 */

let t: TestApp;
// A real envelope store under a throwaway key — proves seal/never-return without
// asserting the on-disk ciphertext (which the store owns).
const store = new DevEnvelopeSecretStore({ masterKey: randomBytes(32) });

beforeAll(async () => {
  t = buildTestApp({ secretStore: store });
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
    payload: { slug, displayName: "Demo" },
  });
  expect(res.statusCode).toBe(201);
  return slug;
}

describe("app-scoped secrets", () => {
  it("creates, lists, rotates, and deletes — never returning the value", async () => {
    const slug = await createApp();
    const create = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/secrets`,
      headers: authHeader(),
      payload: { name: "github-pat", value: "ghp_topsecret" },
    });
    expect(create.statusCode).toBe(201);
    const meta = create.json();
    expect(meta).toMatchObject({
      name: "github-pat",
      scope: "app",
      injection: { kind: "header-bearer" },
    });
    expect(JSON.stringify(meta)).not.toContain("ghp_topsecret"); // write-only

    const list = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/secrets`,
      headers: authHeader(),
    });
    expect(list.json()).toHaveLength(1);

    const rotate = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/secrets/github-pat/rotate`,
      headers: authHeader(),
      payload: { value: "ghp_rotated" },
    });
    expect(rotate.statusCode).toBe(200);
    expect(rotate.json().rotatedAt).not.toBeNull();

    const del = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/apps/${slug}/secrets/github-pat`,
      headers: authHeader(),
    });
    expect(del.statusCode).toBe(204);
    const after = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/secrets`,
      headers: authHeader(),
    });
    expect(after.json()).toHaveLength(0);
  });

  it("rejects a duplicate name for the same app", async () => {
    const slug = await createApp();
    const body = { name: "dupe", value: "v1" };
    expect((await post(`/api/v1/apps/${slug}/secrets`, body)).statusCode).toBe(201);
    const dup = await post(`/api/v1/apps/${slug}/secrets`, { name: "dupe", value: "v2" });
    expect(dup.statusCode).toBe(409);
  });
});

describe("global secrets + grants", () => {
  it("creates a global secret and grants it to an app", async () => {
    const slug = await createApp();
    const create = await post("/api/v1/secrets", { name: uniqueSlug("g"), value: "sk_live" });
    expect(create.statusCode).toBe(201);
    const id = create.json().id;

    const grant = await post(`/api/v1/secrets/${id}/grants`, { appSlug: slug });
    expect(grant.statusCode).toBe(201);

    const list = await t.app.inject({
      method: "GET",
      url: "/api/v1/secrets",
      headers: authHeader(),
    });
    const found = list.json().find((s: { id: string }) => s.id === id);
    expect(found.boundApps).toContain(slug);
  });

  it("rejects a duplicate global name", async () => {
    const name = uniqueSlug("g");
    expect((await post("/api/v1/secrets", { name, value: "a" })).statusCode).toBe(201);
    expect((await post("/api/v1/secrets", { name, value: "b" })).statusCode).toBe(409);
  });
});

async function post(url: string, payload: Record<string, unknown>) {
  return t.app.inject({ method: "POST", url, headers: authHeader(), payload });
}
