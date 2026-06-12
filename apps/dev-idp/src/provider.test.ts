import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDevIdp, type RunningDevIdp } from "./start.js";
import {
  ALL_SCOPES,
  EDGE_CLIENT_ID,
  EDGE_CLIENT_SECRET_DEFAULT,
  PORTAL_AUDIENCE,
  findFixtureUser,
} from "./fixtures.js";
import { decodeJwtPayload, runAuthCodeFlow, runDeviceFlow } from "./testing.js";

const REDIRECT_URI = "https://auth.localtest.me:8080/callback";

let idp: RunningDevIdp;

beforeAll(async () => {
  idp = await startDevIdp({ port: 0, edgeRedirectUris: [REDIRECT_URI] });
});

afterAll(async () => {
  await idp.close();
});

describe("discovery", () => {
  it("serves a discovery document with the bound-port issuer", async () => {
    const res = await fetch(`${idp.issuer}/.well-known/openid-configuration`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc.issuer).toBe(idp.issuer);
    expect(doc.device_authorization_endpoint).toBe(`${idp.issuer}/device/auth`);
    expect(doc.jwks_uri).toBe(`${idp.issuer}/jwks`);
  });

  it("serves a JWKS with an RS256 signing key", async () => {
    const res = await fetch(`${idp.issuer}/jwks`);
    const jwks = (await res.json()) as { keys: Array<Record<string, unknown>> };
    expect(jwks.keys.length).toBeGreaterThan(0);
    expect(jwks.keys[0]?.alg).toBe("RS256");
    expect(jwks.keys[0]?.use).toBe("sig");
    // The private half must never be served.
    expect(jwks.keys[0]?.d).toBeUndefined();
  });
});

describe("device flow (the CLI path)", () => {
  it("yields a portal-audience JWT access token with actor claims", async () => {
    const tokens = await runDeviceFlow(idp.issuer, "alice@azx.dev");
    const claims = decodeJwtPayload(tokens.accessToken);
    const alice = findFixtureUser("alice@azx.dev")!;

    expect(claims.iss).toBe(idp.issuer);
    expect(claims.aud).toBe(PORTAL_AUDIENCE);
    expect(claims.sub).toBe(alice.sub);
    expect(claims.email).toBe("alice@azx.dev");
    expect(claims.name).toBe(alice.name);
    expect(tokens.refreshToken).toBeTruthy();
  });
});

describe("authorization-code flow (the edge path)", () => {
  it("puts groups, email, and name in the ID token itself", async () => {
    const result = await runAuthCodeFlow({
      issuer: idp.issuer,
      clientId: EDGE_CLIENT_ID,
      clientSecret: EDGE_CLIENT_SECRET_DEFAULT,
      redirectUri: REDIRECT_URI,
      userEmail: "bob@azx.dev",
      nonce: "nonce-under-test",
    });
    const bob = findFixtureUser("bob@azx.dev")!;

    expect(result.idTokenClaims.sub).toBe(bob.sub);
    expect(result.idTokenClaims.nonce).toBe("nonce-under-test");
    // conformIdTokenClaims: false is what keeps these in the ID token —
    // the edge never calls userinfo (Entra parity).
    expect(result.idTokenClaims.groups).toEqual(["eng-team"]);
    expect(result.idTokenClaims.email).toBe("bob@azx.dev");
    expect(result.idTokenClaims.name).toBe(bob.name);
  });

  it("denies an unregistered redirect_uri", async () => {
    await expect(
      runAuthCodeFlow({
        issuer: idp.issuer,
        clientId: EDGE_CLIENT_ID,
        clientSecret: EDGE_CLIENT_SECRET_DEFAULT,
        redirectUri: "https://evil.example.com/callback",
        userEmail: "bob@azx.dev",
      }),
    ).rejects.toThrow();
  });

  it("rejects a code exchange without PKCE", async () => {
    // pkce.required is () => true; an authorize request with no challenge
    // must fail before any login happens.
    const authorize = new URL(`${idp.issuer}/auth`);
    authorize.search = new URLSearchParams({
      client_id: EDGE_CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: ALL_SCOPES,
      state: "s",
      nonce: "n",
    }).toString();
    const res = await fetch(authorize, { redirect: "manual" });
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("error=invalid_request");
  });
});
