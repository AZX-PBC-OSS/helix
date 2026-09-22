import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthConfigResponseSchema, PortalMeResponseSchema } from "@azx-pbc/shared";
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
            t === "test-token"
              ? { oid: "dev-token-actor", sub: "dev@azx.io", via: "dev-token", groups: [] }
              : null,
        },
      ],
      publicConfig: { issuer: ISSUER, cliClientId: "azx-cli" },
    },
  });
});

afterAll(async () => {
  await edge.close();
});

async function mintAccessToken(claims: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({
    sub: "oid-1",
    oid: "actor-oid-1",
    email: "alice@azx.dev",
    name: "Alice Anders",
    ...claims,
  })
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

  it("echoes the deployment visibility policy so the SPA can hide disallowed modes", async () => {
    const restrictive = buildTestApp({
      auth: {
        verifiers: [{ verify: async () => null }],
        publicConfig: {
          issuer: ISSUER,
          cliClientId: "azx-cli",
          allowPublicApps: false,
          allowPasswordApps: true,
        },
      },
    });
    const res = await restrictive.app.inject({ url: "/api/v1/auth/config" });
    expect(res.statusCode).toBe(200);
    const body = AuthConfigResponseSchema.parse(res.json());
    expect(body.allowPublicApps).toBe(false);
    expect(body.allowPasswordApps).toBe(true);
    await restrictive.close();
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
      // The canonical principal id is echoed alongside the display half
      // (ADR-0048): additive on the wire, never a comparison key for clients.
      oid: "actor-oid-1",
      sub: "alice@azx.dev",
      via: "oidc",
      name: "Alice Anders",
      email: "alice@azx.dev",
      // No admin group configured here → not an admin.
      isAdmin: false,
      // PORTAL_DIRECTORY_SEARCH unset → the `everyone` tier, so admin-ness is
      // irrelevant. This pins the default: unset must not tighten the surface
      // ADR-0040 shipped open.
      canSearchDirectory: true,
    });
  });

  it("echoes the dev-token actor through the same chain", async () => {
    const res = await edge.app.inject({ url: "/api/v1/me", headers: authHeader("test-token") });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      // The dev-token actor's fixed synthetic oid (ADR-0048 decision 1) —
      // deliberately not directory-id-shaped, so it can never collide with a
      // real login's ownerId.
      oid: "dev-token-actor",
      sub: "dev@azx.io",
      via: "dev-token",
      isAdmin: false,
      canSearchDirectory: true,
    });
  });

  it("401s a correctly signed token with no oid claim — fail closed, no fallback", async () => {
    // ADR-0048 decision 2: the canonical principal id has no fallback. A token
    // like this cannot come from Entra (it emits oid unconditionally), so its
    // only honest treatment is refusal — never a silently wrong actor built
    // from the pairwise sub.
    const token = await mintAccessToken({ oid: undefined });
    const res = await edge.app.inject({ url: "/api/v1/me", headers: authHeader(token) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("reports isAdmin:true when the actor carries the configured admin role", async () => {
    const prev = process.env.PORTAL_ADMIN_GROUP_ID;
    process.env.PORTAL_ADMIN_GROUP_ID = "platform-admin";
    try {
      const token = await mintAccessToken({ roles: ["platform-admin"] });
      const res = await edge.app.inject({ url: "/api/v1/me", headers: authHeader(token) });
      expect(res.statusCode).toBe(200);
      expect(res.json().isAdmin).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.PORTAL_ADMIN_GROUP_ID;
      else process.env.PORTAL_ADMIN_GROUP_ID = prev;
    }
  });

  /**
   * `canSearchDirectory` is what the SPA's group picker branches on, so it has to
   * track the tier and the actor together (ADR-0040 decision 11). The picker
   * never sees the tier itself.
   */
  describe("canSearchDirectory", () => {
    const withEnv = async (
      env: Record<string, string | undefined>,
      run: () => Promise<void>,
    ): Promise<void> => {
      const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      try {
        await run();
      } finally {
        for (const [k, v] of Object.entries(prev)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    };

    const meWith = async (
      roles?: string[],
    ): Promise<{ canSearchDirectory: boolean; searchRestriction?: string }> => {
      const token = await mintAccessToken(roles ? { roles } : {});
      const res = await edge.app.inject({ url: "/api/v1/me", headers: authHeader(token) });
      expect(res.statusCode).toBe(200);
      return res.json() as { canSearchDirectory: boolean; searchRestriction?: string };
    };

    it("is true for a non-admin under the default (everyone) tier", async () => {
      await withEnv({ PORTAL_DIRECTORY_SEARCH: undefined }, async () => {
        expect((await meWith()).canSearchDirectory).toBe(true);
      });
    });

    it("splits admin from non-admin under the admins tier", async () => {
      await withEnv(
        { PORTAL_DIRECTORY_SEARCH: "admins", PORTAL_ADMIN_GROUP_ID: "platform-admin" },
        async () => {
          expect((await meWith(["platform-admin"])).canSearchDirectory).toBe(true);
          expect((await meWith()).canSearchDirectory).toBe(false);
        },
      );
    });

    it("is false even for an admin under the none tier", async () => {
      await withEnv(
        { PORTAL_DIRECTORY_SEARCH: "none", PORTAL_ADMIN_GROUP_ID: "platform-admin" },
        async () => {
          expect((await meWith(["platform-admin"])).canSearchDirectory).toBe(false);
        },
      );
    });

    /**
     * The reason is what lets the picker say something true under both narrow
     * tiers. Without it the UI hard-coded "limited to platform admins", which
     * tells a platform admin refused by `none` that the restriction is the role
     * they hold — sending them to audit a correct `PORTAL_ADMIN_GROUP_ID`.
     */
    describe("searchRestriction", () => {
      it("is absent when the caller may search", async () => {
        await withEnv({ PORTAL_DIRECTORY_SEARCH: undefined }, async () => {
          const me = await meWith();
          expect(me.canSearchDirectory).toBe(true);
          // A permitted caller learns nothing about the posture at all.
          expect(me.searchRestriction).toBeUndefined();
        });
      });

      it("names the admins tier for a refused non-admin", async () => {
        await withEnv(
          { PORTAL_DIRECTORY_SEARCH: "admins", PORTAL_ADMIN_GROUP_ID: "platform-admin" },
          async () => {
            expect((await meWith()).searchRestriction).toBe("admins");
            // …and stays absent for the admin on the same deployment.
            expect((await meWith(["platform-admin"])).searchRestriction).toBeUndefined();
          },
        );
      });

      it("names the none tier even for a platform admin", async () => {
        await withEnv(
          { PORTAL_DIRECTORY_SEARCH: "none", PORTAL_ADMIN_GROUP_ID: "platform-admin" },
          async () => {
            expect((await meWith(["platform-admin"])).searchRestriction).toBe("none");
          },
        );
      });
    });

    it("fails closed to the admins tier on an unrecognised value", async () => {
      await withEnv(
        { PORTAL_DIRECTORY_SEARCH: "everybody", PORTAL_ADMIN_GROUP_ID: "platform-admin" },
        async () => {
          // A typo must not silently widen a surface an operator was narrowing.
          expect((await meWith()).canSearchDirectory).toBe(false);
          expect((await meWith(["platform-admin"])).canSearchDirectory).toBe(true);
        },
      );
    });
  });

  it("401s without or with a bad token", async () => {
    expect((await edge.app.inject({ url: "/api/v1/me" })).statusCode).toBe(401);
    const bad = await edge.app.inject({ url: "/api/v1/me", headers: authHeader("nope") });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toMatchObject({ error: { code: "unauthorized" } });
  });
});

describe("mutating routes through the chain", () => {
  it("accepts an OIDC JWT; ownerId is the oid, the audit actor the email", async () => {
    const slug = `t-${Date.now().toString(36)}jwt`;
    const res = await edge.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: { ...authHeader(await mintAccessToken()), "content-type": "application/json" },
      payload: { slug, displayName: "JWT-created app" },
    });
    expect(res.statusCode).toBe(201);

    // The two halves land in their columns (ADR-0048): the identity half is
    // the oid claim — never the email-collapsed sub the row used to store.
    const appRow = await edge.prisma.app.findUnique({ where: { slug } });
    expect(appRow?.ownerId).toBe("actor-oid-1");

    const audit = await edge.prisma.auditEvent.findFirst({
      where: { action: "app.create", appId: res.json<{ id: string }>().id },
    });
    expect(audit?.actor).toBe("alice@azx.dev");
  });
});
