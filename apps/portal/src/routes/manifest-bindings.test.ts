import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevEnvelopeSecretStore } from "@azx-pbc/secret-store";
import type { TokenVerifier } from "../plugins/auth.js";
import { buildTestApp, uniqueSlug, type TestApp } from "../test/harness.js";

/**
 * Per-binding effectiveness on the manifest read (I-02 T-0028) — the portal
 * computes each provider-bound origin's effectiveness server-side, using
 * T-0009's `isProviderBindingEffective` rule over the approved requests' filed
 * stamps, and the manifest payload carries it as `providerBindings`. The SPA's
 * Reapproval-needed badge consumes this field alone — no second request.
 */

const OWNER = "owner@azx.io";
const ADMIN = "admin@azx.io";
const ADMIN_GROUP = "platform-admin";

const verifiers: TokenVerifier[] = [
  {
    verify: async (t) => {
      if (t === "owner") return { oid: "oid-owner", sub: OWNER, via: "oidc", groups: [] };
      if (t === "admin")
        return { oid: "oid-admin", sub: ADMIN, via: "oidc", groups: [ADMIN_GROUP] };
      return null;
    },
  },
];

const owner = { authorization: "Bearer owner" };
const admin = { authorization: "Bearer admin" };

let t: TestApp;

beforeAll(async () => {
  process.env.PORTAL_ADMIN_GROUP_ID = ADMIN_GROUP;
  t = buildTestApp({
    auth: { verifiers, publicConfig: null },
    secretStore: new DevEnvelopeSecretStore({ masterKey: randomBytes(32) }),
  });
  await t.app.ready();
});

afterAll(async () => {
  await t.close();
});

const REF = `prov-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
const ORIGIN = "https://vendor.example";

async function createProvider(): Promise<string> {
  const res = await t.app.inject({
    method: "POST",
    url: "/api/v1/providers",
    headers: admin,
    payload: {
      ref: REF,
      kind: "rest-delegated",
      displayName: "Vendor",
      env: "prod",
      authorizeEndpoint: "https://vendor.example/oauth/authorize",
      tokenEndpoint: "https://vendor.example/oauth/token",
      requestedScopes: ["default"],
      apiOrigins: [ORIGIN],
      tokenPlacement: { kind: "header-bearer" },
      clientId: "vendor-client-id",
      clientSecret: "vendor-client-secret",
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function getManifest(slug: string, headers = owner) {
  const res = await t.app.inject({
    method: "GET",
    url: `/api/v1/apps/${slug}/manifest`,
    headers,
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe("manifest read — per-binding effectiveness (T-0028)", () => {
  it("omits providerBindings for a manifest with no provider binding", async () => {
    const slug = uniqueSlug();
    await t.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: owner,
      payload: { slug, displayName: "Plain" },
    });
    // Exact body: a binding-free manifest keeps its exact pre-T-0028 shape.
    expect(await getManifest(slug)).toEqual({
      app: slug,
      visibility: { mode: "internal" },
      capabilities: { mcp: [], externalOrigins: [] },
    });
  });

  it("reports a binding effective once its approval has applied, then stale after a sensitive edit", async () => {
    const providerId = await createProvider();
    const slug = uniqueSlug();
    await t.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: owner,
      payload: { slug, displayName: "Bound" },
    });

    // A provider-bound origin files a high-risk request (never applies live).
    const put = await t.app.inject({
      method: "PUT",
      url: `/api/v1/apps/${slug}/manifest`,
      headers: owner,
      payload: {
        capabilities: {
          fetch: { shim: false, origins: [{ origin: ORIGIN, provider: REF, required: true }] },
        },
      },
    });
    expect(put.statusCode).toBe(200);
    const requestId = put.json().pending as string;
    expect(requestId).not.toBeNull();
    // Not approved yet: the effective manifest holds no binding, so the
    // read carries no bindings at all.
    expect((await getManifest(slug)).providerBindings).toBeUndefined();

    // Approve — the stamped binding lands in the effective manifest.
    const approved = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/approve`,
      headers: admin,
    });
    expect(approved.statusCode).toBe(200);

    const afterApprove = await getManifest(slug);
    expect(afterApprove.providerBindings).toEqual([{ origin: ORIGIN, ref: REF, effective: true }]);

    // A sensitive provider edit advances the revision — the filed stamp no
    // longer matches, and the read reports the binding stale (criterion 8).
    const row = await t.prisma.connectionProvider.findUniqueOrThrow({ where: { id: providerId } });
    const edit = await t.app.inject({
      method: "PUT",
      url: `/api/v1/providers/${providerId}`,
      headers: admin,
      payload: {
        displayName: "Vendor",
        authorizeEndpoint: "https://vendor.example/oauth/authorize",
        tokenEndpoint: "https://vendor.example/oauth/token",
        requestedScopes: ["default", "extra"],
        apiOrigins: [ORIGIN],
        tokenPlacement: { kind: "header-bearer" },
        revision: row.revision,
        confirmInvalidation: true,
      },
    });
    expect(edit.statusCode).toBe(200);
    expect((await getManifest(slug)).providerBindings).toEqual([
      { origin: ORIGIN, ref: REF, effective: false },
    ]);

    // Deletion is never effective either — a replacement row under the same
    // ref would mint a new surrogate id, so the stamp stays dangling.
    const del = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/providers/${providerId}`,
      headers: admin,
      payload: { confirmInvalidation: true },
    });
    expect(del.statusCode).toBe(200);
    expect((await getManifest(slug)).providerBindings).toEqual([
      { origin: ORIGIN, ref: REF, effective: false },
    ]);
  });
});
