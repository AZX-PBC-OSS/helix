import fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authPlugin,
  authenticate,
  requireAdmin,
  type AuthPluginOptions,
  type TokenVerifier,
} from "./auth.js";
import { errorsPlugin } from "./errors.js";

/**
 * The auth plugin's boot guards and the `requireAdmin` gate, exercised on a bare
 * Fastify instance rather than through `buildTestApp`.
 *
 * Bare on purpose, twice over. `buildApp` calls `assertDeploymentConfig()` before
 * it registers this plugin, and that throws on a missing `APP_PUBLIC_BASE` under
 * `NODE_ENV=production` — so a test for the production guard driven through
 * `buildApp` asserts on the wrong error. And nothing here touches Postgres
 * (`requireAdmin` reads only the actor and the env), so the whole file stays
 * DB-free.
 *
 * It also must NOT import `../test/harness.js`: that module sets
 * `PORTAL_DEV_TOKEN` at import scope, which would make `verifiersFromEnv()`
 * non-empty and the empty-chain test below unfalsifiable.
 */

const ADMIN = "admin@azx.io";
const PLAIN = "plain@azx.io";
const ADMIN_GROUP = "platform-admin";

const verifiers: TokenVerifier[] = [
  {
    verify: async (token) => {
      if (token === "admin") return { sub: ADMIN, via: "oidc", groups: [ADMIN_GROUP] };
      if (token === "plain") return { sub: PLAIN, via: "oidc", groups: [] };
      return null;
    },
  },
];

const admin = { authorization: "Bearer admin" };
const plain = { authorization: "Bearer plain" };

// Closed in the hook below, so an instance whose `ready()` rejected is still
// disposed and the guard tests can't leak a listener into the next test.
const instances: FastifyInstance[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(instances.splice(0).map((app) => app.close().catch(() => {})));
});

/** A bare instance carrying only the plugin under test. */
function bareApp(opts: AuthPluginOptions = {}): FastifyInstance {
  const app = fastify();
  app.register(authPlugin, opts);
  instances.push(app);
  return app;
}

/**
 * A bare instance with one admin-gated route, so `requireAdmin` is exercised
 * through the real error handler — which is what turns its `AppError` into the
 * 403 + envelope callers actually see.
 */
function probeApp(): FastifyInstance {
  const app = fastify();
  app.register(errorsPlugin);
  app.register(authPlugin, { verifiers, publicConfig: null });
  app.get("/probe", { preHandler: authenticate }, async (req) => {
    return { sub: requireAdmin(req).sub };
  });
  instances.push(app);
  return app;
}

describe("authPlugin boot guards", () => {
  it("refuses to boot with the self-approve flag under NODE_ENV=production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PORTAL_ALLOW_SELF_APPROVE", "true");
    // Verifiers injected so the rejection can only be the guard under test — an
    // env-built chain would hit `createDevTokenVerifier`'s own production refusal.
    await expect(bareApp({ verifiers }).ready()).rejects.toThrow(/PORTAL_ALLOW_SELF_APPROVE/);
  });

  it("boots with the self-approve flag set outside production", async () => {
    // Negative control: without this, the test above would still pass if the
    // plugin simply failed to register for some unrelated reason.
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("PORTAL_ALLOW_SELF_APPROVE", "true");
    await expect(bareApp({ verifiers }).ready()).resolves.toBeDefined();
  });

  it("refuses to boot with an empty verifier chain", async () => {
    // All three are set in the devcontainer and in CI, so clear them explicitly.
    vi.stubEnv("PORTAL_DEV_TOKEN", undefined);
    vi.stubEnv("PORTAL_OIDC_ISSUER", undefined);
    vi.stubEnv("PORTAL_OIDC_AUDIENCE", undefined);
    await expect(bareApp().ready()).rejects.toThrow(/No auth verifier configured/);
  });

  it.each([
    ["an issuer without an audience", "https://idp.test", undefined],
    ["an audience without an issuer", undefined, "urn:helix:portal"],
  ])("refuses %s", async (_label, issuer, audience) => {
    vi.stubEnv("PORTAL_OIDC_ISSUER", issuer);
    vi.stubEnv("PORTAL_OIDC_AUDIENCE", audience);
    await expect(bareApp().ready()).rejects.toThrow(/must be set together/);
  });
});

describe("requireAdmin", () => {
  it("fails closed when PORTAL_ADMIN_GROUP_ID is unset, even for an actor in the group", async () => {
    vi.stubEnv("PORTAL_ADMIN_GROUP_ID", undefined);
    const res = await probeApp().inject({ method: "GET", url: "/probe", headers: admin });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
    // The actor *is* in `platform-admin`. Asserting the message is what proves
    // the unconfigured check ran ahead of the membership check, rather than the
    // request failing for the ordinary reason.
    expect(res.json().error.message).toMatch(/PORTAL_ADMIN_GROUP_ID/);
  });

  it("refuses an authenticated actor lacking the configured group", async () => {
    vi.stubEnv("PORTAL_ADMIN_GROUP_ID", ADMIN_GROUP);
    const res = await probeApp().inject({ method: "GET", url: "/probe", headers: plain });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/platform-admin role/);
  });

  it("returns the actor when the group matches", async () => {
    vi.stubEnv("PORTAL_ADMIN_GROUP_ID", ADMIN_GROUP);
    const res = await probeApp().inject({ method: "GET", url: "/probe", headers: admin });
    expect(res.statusCode).toBe(200);
    expect(res.json().sub).toBe(ADMIN);
  });
});
