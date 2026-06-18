import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthConfigResponseSchema, PortalMeResponseSchema } from "@helix/shared";
import { createOidcVerifier } from "../auth/verifier.js";
import { authHeader, buildTestApp, type TestApp } from "../test/harness.js";

/** /api/v1/auth/config and /api/v1/me through the verifier chain. */

type SignKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

const ISSUER = "http://idp.test";
const AUDIENCE = "urn:helix:portal";

let edge: TestApp;
let signKey: SignKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signKey = pair.privateKey;
  const jwks = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), alg: "RS256", use: "sig" }],
  });
  edge = buildTestApp({
    auth: {
      verifiers: [
        createOidcVerifier({
          issuer: ISSUER,
          audience: AUDIENCE,
          getKey: jwks,
          allowInsecure: true,
        }),
        // The dev token rides along, as in the real env-built chain.
        {
          verify: async (t) =>
            t === "test-token" ? { sub: "dev@azx.io", via: "dev-token", groups: [] } : null,
        },
      ],
      publicConfig: { issuer: ISSUER, cliClientId: "azx-cli" },
    },
  });
});

afterAll(async () => {
  await edge.close();
});

async function mintAccessToken(): Promise<string> {
  return new SignJWT({ sub: "oid-1", email: "alice@azx.dev", name: "Alice Anders" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signKey);
}

describe("GET /api/v1/auth/config", () => {
  it("returns the IdP discovery info, unauthenticated", async () => {
    const res = await edge.app.inject({ url: "/api/v1/auth/config" });
    expect(res.statusCode).toBe(200);
    expect(AuthConfigResponseSchema.parse(res.json())).toEqual({
      issuer: ISSUER,
      cliClientId: "azx-cli",
    });
  });

  it("404s when OIDC is not configured", async () => {
    const devOnly = buildTestApp({
      auth: {
        verifiers: [{ verify: async () => null }],
        publicConfig: null,
      },
    });
    const res = await devOnly.app.inject({ url: "/api/v1/auth/config" });
    expect(res.statusCode).toBe(404);
    await devOnly.close();
  });
});

describe("GET /api/v1/me", () => {
  it("echoes the OIDC actor for a valid JWT", async () => {
    const res = await edge.app.inject({
      url: "/api/v1/me",
      headers: authHeader(await mintAccessToken()),
    });
    expect(res.statusCode).toBe(200);
    expect(PortalMeResponseSchema.parse(res.json())).toEqual({
      sub: "alice@azx.dev",
      via: "oidc",
      name: "Alice Anders",
      email: "alice@azx.dev",
    });
  });

  it("echoes the dev-token actor through the same chain", async () => {
    const res = await edge.app.inject({ url: "/api/v1/me", headers: authHeader("test-token") });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sub: "dev@azx.io", via: "dev-token" });
  });

  it("401s without or with a bad token", async () => {
    expect((await edge.app.inject({ url: "/api/v1/me" })).statusCode).toBe(401);
    const bad = await edge.app.inject({ url: "/api/v1/me", headers: authHeader("nope") });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toMatchObject({ error: { code: "unauthorized" } });
  });
});

describe("mutating routes through the chain", () => {
  it("accepts an OIDC JWT and attributes the audit event to the email", async () => {
    const slug = `t-${Date.now().toString(36)}jwt`;
    const res = await edge.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: { ...authHeader(await mintAccessToken()), "content-type": "application/json" },
      payload: { slug, displayName: "JWT-created app" },
    });
    expect(res.statusCode).toBe(201);

    const audit = await edge.prisma.auditEvent.findFirst({
      where: { action: "app.create", appId: res.json<{ id: string }>().id },
    });
    expect(audit?.actor).toBe("alice@azx.dev");
  });
});
