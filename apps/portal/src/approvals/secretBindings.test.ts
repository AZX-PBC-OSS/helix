import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevEnvelopeSecretStore } from "@azx-pbc/secret-store";
import type { TokenVerifier } from "../plugins/auth.js";
import { buildTestApp, uniqueSlug, type TestApp } from "../test/harness.js";

const verifiers: TokenVerifier[] = [
  {
    verify: async (token) =>
      token === "owner"
        ? { oid: "oauth-owner", sub: "oauth-owner", via: "oidc", groups: [] }
        : token === "admin"
          ? { oid: "oauth-admin", sub: "oauth-admin", via: "oidc", groups: ["oauth-admins"] }
          : null,
  },
];
const owner = { authorization: "Bearer owner" },
  admin = { authorization: "Bearer admin" };
const store = new DevEnvelopeSecretStore({ masterKey: randomBytes(32) });
let t: TestApp;
const recipe = {
  kind: "oauth-service-account",
  tokenEndpoint: "https://identity.example/token",
  grantType: "password",
  clientAuthentication: "none",
  scopes: ["read"],
};
const value = JSON.stringify({
  kind: recipe.kind,
  username: "username-SENTINEL",
  password: "password-SENTINEL",
});
beforeAll(async () => {
  process.env.PORTAL_ADMIN_GROUP_ID = "oauth-admins";
  t = buildTestApp({ auth: { verifiers, publicConfig: null }, secretStore: store });
  await t.app.ready();
});
afterAll(async () => t.close());
async function setup() {
  const slug = uniqueSlug();
  const res = await t.app.inject({
    method: "POST",
    url: "/api/v1/apps",
    headers: owner,
    payload: { slug, displayName: "OAuth test" },
  });
  expect(res.statusCode).toBe(201);
  return { slug, appId: res.json().id as string };
}
const create = (slug: string, env = "prod") =>
  t.app.inject({
    method: "POST",
    url: `/api/v1/apps/${slug}/secrets`,
    headers: owner,
    payload: { name: "service", injection: recipe, value, env },
  });
const save = (slug: string, origin = "https://api.example") =>
  t.app.inject({
    method: "PUT",
    url: `/api/v1/apps/${slug}/manifest`,
    headers: owner,
    payload: {
      capabilities: {
        fetch: { origins: [{ origin, connection: "service" }] },
      },
    },
  });
const approve = (id: string) =>
  t.app.inject({ method: "POST", url: `/api/v1/approvals/${id}/approve`, headers: admin });

describe("service-account approval and lifecycle", () => {
  it("records immutable recipients in approval, keeps material private, and permits rotation without reapproval", async () => {
    const { slug, appId } = await setup();
    const secret = await create(slug);
    expect(secret.statusCode).toBe(201);
    expect(secret.body).not.toContain("SENTINEL");
    const filed = await save(slug);
    expect(filed.statusCode).toBe(200);
    const pending = await t.prisma.approvalRequest.findUniqueOrThrow({
      where: { id: filed.json().pending },
    });
    expect(JSON.stringify(pending.deltas)).toContain("https://identity.example/token");
    expect(JSON.stringify(pending.deltas)).not.toContain("SENTINEL");
    const decision = await approve(pending.id);
    expect(decision.statusCode, decision.body).toBe(200);
    expect(await t.prisma.secretConnectionBinding.findMany({ where: { appId } })).toMatchObject([
      { secretId: secret.json().id, env: "prod" },
    ]);
    const rotated = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/secrets/service/rotate`,
      headers: owner,
      payload: { value },
    });
    expect(rotated.statusCode).toBe(200);
    expect(
      (await t.prisma.appSecret.findUniqueOrThrow({ where: { id: secret.json().id } }))
        .credentialGeneration,
    ).toBe(2);
    expect((await save(slug)).json().pending).toBeFalsy();
  });
  it("rejects approval after same-name replacement, and re-elevates an already approved replacement", async () => {
    const { slug } = await setup();
    await create(slug);
    const filed = await save(slug);
    await t.app.inject({
      method: "DELETE",
      url: `/api/v1/apps/${slug}/secrets/service`,
      headers: owner,
    });
    await create(slug);
    expect((await approve(filed.json().pending)).statusCode).toBe(409);
    const again = await save(slug);
    expect((await approve(again.json().pending)).statusCode).toBe(200);
    await t.app.inject({
      method: "DELETE",
      url: `/api/v1/apps/${slug}/secrets/service`,
      headers: owner,
    });
    await create(slug);
    const refile = await save(slug);
    expect(refile.json().pending).toBeTruthy();
  });
  it("invalidates an approved global binding when an app secret shadows it", async () => {
    const { slug, appId } = await setup();
    const secret = await t.prisma.appSecret.create({
      data: {
        scope: "global",
        name: "service",
        material: await store.seal(value),
        injection: recipe,
        createdBy: "oauth-admin",
      },
    });
    try {
      await t.prisma.appSecretGrant.create({
        data: { secretId: secret.id, appId, grantedBy: "oauth-admin" },
      });
      const filed = await save(slug);
      expect((await approve(filed.json().pending)).statusCode).toBe(200);
      await create(slug);
      const read = await t.app.inject({
        method: "GET",
        url: `/api/v1/apps/${slug}/manifest`,
        headers: owner,
      });
      expect(read.json().secretBindings).toMatchObject([{ effective: false }]);
      expect((await save(slug)).json().pending).toBeTruthy();
    } finally {
      await t.prisma.appSecret.delete({ where: { id: secret.id } });
    }
  });
  it("requires fresh approval for a new environment and refuses credential/configuration mismatches", async () => {
    const { slug } = await setup();
    await create(slug);
    const filed = await save(slug);
    expect((await approve(filed.json().pending)).statusCode).toBe(200);
    await create(slug, "dev");
    expect((await save(slug)).json().pending).toBeTruthy();
    const bad = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/secrets/service/rotate`,
      headers: owner,
      payload: { value: "SENTINEL-private" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain("SENTINEL");
    const staticBlob = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/secrets`,
      headers: owner,
      payload: { name: "bad", value },
    });
    expect(staticBlob.statusCode).toBe(400);
  });
  it("canonicalizes origins for approval, inspection and replacement approval", async () => {
    const { slug, appId } = await setup();
    await create(slug);
    const origin = "https://API.example:443/";
    expect((await approve((await save(slug, origin)).json().pending)).statusCode).toBe(200);
    expect(await t.prisma.secretConnectionBinding.findMany({ where: { appId } })).toMatchObject([
      { origin: "https://api.example" },
    ]);
    const inspect = () =>
      t.app.inject({ method: "GET", url: `/api/v1/apps/${slug}/manifest`, headers: owner });
    expect((await inspect()).json().secretBindings).toMatchObject([{ effective: true }]);
    await t.app.inject({
      method: "DELETE",
      url: `/api/v1/apps/${slug}/secrets/service`,
      headers: owner,
    });
    await create(slug);
    expect((await inspect()).json().secretBindings).toMatchObject([{ effective: false }]);
    const refile = await save(slug, origin);
    expect(refile.json().pending).toBeTruthy();
    expect((await approve(refile.json().pending)).statusCode).toBe(200);
    expect((await inspect()).json().secretBindings).toMatchObject([{ effective: true }]);
  });
  it("keeps ordinary static replacement self-service but requires approval to replace OAuth with static", async () => {
    const { slug, appId } = await setup();
    const createStatic = () =>
      t.app.inject({
        method: "POST",
        url: `/api/v1/apps/${slug}/secrets`,
        headers: owner,
        payload: { name: "service", value: "static-key" },
      });
    await createStatic();
    expect((await approve((await save(slug)).json().pending)).statusCode).toBe(200);
    expect(await t.prisma.secretConnectionBinding.count({ where: { appId } })).toBe(0);
    await t.app.inject({
      method: "DELETE",
      url: `/api/v1/apps/${slug}/secrets/service`,
      headers: owner,
    });
    await createStatic();
    expect((await save(slug)).json().pending).toBeFalsy();
    await t.app.inject({
      method: "DELETE",
      url: `/api/v1/apps/${slug}/secrets/service`,
      headers: owner,
    });
    await create(slug);
    expect((await approve((await save(slug)).json().pending)).statusCode).toBe(200);
    await t.app.inject({
      method: "DELETE",
      url: `/api/v1/apps/${slug}/secrets/service`,
      headers: owner,
    });
    await createStatic();
    const refile = await save(slug);
    expect(refile.json().pending).toBeTruthy();
    expect((await approve(refile.json().pending)).statusCode).toBe(200);
    expect(await t.prisma.secretConnectionBinding.count({ where: { appId } })).toBe(0);
  });
  it("allows global dev credentials and never allows OAuth under platform scope", async () => {
    const name = `oauth-${randomUUID().slice(0, 8)}`;
    const response = await t.app.inject({
      method: "POST",
      url: "/api/v1/secrets",
      headers: admin,
      payload: { name, value, injection: recipe, scope: "global", env: "dev" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().env).toBe("dev");
    const list = await t.app.inject({ method: "GET", url: "/api/v1/secrets", headers: admin });
    expect(list.json().find((s: { name: string }) => s.name === name).oauthStatus.status).toBe(
      "unconfigured",
    );
    await t.prisma.appSecret.delete({ where: { id: response.json().id } });
    const denied = await t.app.inject({
      method: "POST",
      url: "/api/v1/secrets",
      headers: admin,
      payload: { name, value, injection: recipe, scope: "platform" },
    });
    expect(denied.statusCode).toBe(400);
  });
});
