import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PORTAL_AUDIENCE, runDeviceFlow, startDevIdp, type RunningDevIdp } from "@azx-pbc/dev-idp";
import { createOidcVerifier } from "./verifier.js";
import { buildTestApp, uniqueSlug, type TestApp } from "../test/harness.js";

/**
 * Portal auth against the REAL pieces: a live in-process dev-idp, a real
 * device-code login, and the verifier's real discovery + remote-JWKS path
 * (no injected keys). This is the proof that `azx login` tokens drive the
 * deploy API end to end — and that foreign tokens don't.
 */

let idp: RunningDevIdp;
let portal: TestApp;
let accessToken: string;

beforeAll(async () => {
  idp = await startDevIdp();
  portal = buildTestApp({
    auth: {
      verifiers: [
        // allowInsecure: the in-process dev-idp serves plain http.
        createOidcVerifier({ issuer: idp.issuer, audience: PORTAL_AUDIENCE, allowInsecure: true }),
      ],
      publicConfig: { issuer: idp.issuer, cliClientId: "azx-cli" },
    },
  });
  ({ accessToken } = await runDeviceFlow(idp.issuer, "alice@azx.dev"));
}, 30_000);

afterAll(async () => {
  await portal.close();
  await idp.close();
});

describe("portal API with real device-flow tokens", () => {
  it("authenticates /api/v1/me via discovery + remote JWKS", async () => {
    const res = await portal.app.inject({
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sub: "alice@azx.dev", via: "oidc" });
  });

  it("authorizes a mutation and attributes the audit event to alice", async () => {
    const slug = uniqueSlug("oidc");
    const res = await portal.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      payload: { slug, displayName: "device-flow app" },
    });
    expect(res.statusCode).toBe(201);

    const audit = await portal.prisma.auditEvent.findFirst({
      where: { action: "app.create", appId: res.json<{ id: string }>().id },
    });
    expect(audit?.actor).toBe("alice@azx.dev");
  });

  it("rejects a token from a different issuer with the same audience", async () => {
    const foreignIdp = await startDevIdp();
    try {
      const foreign = await runDeviceFlow(foreignIdp.issuer, "alice@azx.dev");
      const res = await portal.app.inject({
        url: "/api/v1/me",
        headers: { authorization: `Bearer ${foreign.accessToken}` },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await foreignIdp.close();
    }
  }, 30_000);

  it("rejects the dev token when the chain has no dev verifier", async () => {
    const res = await portal.app.inject({
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${process.env.PORTAL_DEV_TOKEN ?? "test-token"}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("serves the auth config the CLI bootstraps from", async () => {
    const res = await portal.app.inject({ url: "/api/v1/auth/config" });
    expect(res.json()).toEqual({ issuer: idp.issuer, cliClientId: "azx-cli" });
  });
});
