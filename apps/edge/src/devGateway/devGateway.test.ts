import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashDevToken, newDevToken } from "@azx-pbc/shared/devToken";
import { buildDevGateway } from "./app.js";
import type { DevTokenRow, DevTokenStore } from "./devTokenStore.js";
import { testDevGatewayConfig } from "../test/config.js";
import { FakeAppDataStore, FakeRegistry, FakeUsageStore, registryEntry } from "../test/fakes.js";
import type { AppDataStore } from "../gateway/data.js";
import type { Env } from "@azx-pbc/shared";

/**
 * Adversarial coverage for the dev-gateway (dev-mode design §5.3/§5.4) — the
 * step-3 security thesis. A cross-origin caller reaches an app's env=dev
 * partition ONLY with a valid, non-revoked, non-expired, app-bound token from a
 * registered origin; every failure is fail-closed and emits no CORS reflection;
 * and the tier is `dev`, baked into the resolver, uninfluenced by request input.
 */

const APP_A = "11111111-1111-4111-8111-111111111111";
const APP_B = "22222222-2222-4222-8222-222222222222";
const GOOD_ORIGIN = "https://myapp.lovable.app";

/** In-memory dev-token store keyed by hash (the real store's shape). */
class FakeDevTokenStore implements DevTokenStore {
  readonly rows = new Map<string, DevTokenRow>();
  add(token: string, row: DevTokenRow): void {
    this.rows.set(hashDevToken(token), row);
  }
  async resolve(tokenHash: string): Promise<DevTokenRow | null> {
    return this.rows.get(tokenHash) ?? null;
  }
  async originAllowed(appId: string, origin: string): Promise<boolean> {
    for (const r of this.rows.values()) {
      if (
        r.appId === appId &&
        r.revokedAt === null &&
        r.expiresAt.getTime() > Date.now() &&
        r.origins.includes(origin)
      ) {
        return true;
      }
    }
    return false;
  }
  async close(): Promise<void> {}
}

/** Records the `env` the handlers thread into the store — proves env=dev routing. */
class EnvRecordingStore implements AppDataStore {
  lastEnv: Env | null = null;
  async putUserKey(_a: string, _u: string, _k: string, _v: unknown, env: Env): Promise<string> {
    this.lastEnv = env;
    return new Date().toISOString();
  }
  async getUserKey(): Promise<unknown> {
    return null;
  }
  async deleteUserKey(): Promise<boolean> {
    return false;
  }
  async listUserKeys(): Promise<never[]> {
    return [];
  }
  async appendCollection(): Promise<void> {}
  async getShared(): Promise<unknown> {
    return null;
  }
  async putShared(): Promise<string> {
    return new Date().toISOString();
  }
  async close(): Promise<void> {}
}

function future(): Date {
  return new Date(Date.now() + 60_000);
}
function past(): Date {
  return new Date(Date.now() - 60_000);
}

function build(devTokens: FakeDevTokenStore, store: AppDataStore = new FakeAppDataStore()) {
  const registry = new FakeRegistry([
    registryEntry({
      slug: "myapp",
      appId: APP_A,
      data: { user: true, collections: [], sharedRead: [], sharedWrite: [] },
    }),
    registryEntry({
      slug: "otherapp",
      appId: APP_B,
      data: { user: true, collections: [], sharedRead: [], sharedWrite: [] },
    }),
  ]);
  const app: FastifyInstance = buildDevGateway({
    config: testDevGatewayConfig(),
    registry,
    devTokens,
    appData: store,
    usage: new FakeUsageStore(),
    llmProvider: null,
    egress: null,
    instructionKey: null,
  });
  return app;
}

function putUser(
  app: FastifyInstance,
  slug: string,
  opts: { token?: string; origin?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.origin) headers.origin = opts.origin;
  return app.inject({
    method: "PUT",
    url: `/${slug}/_api/data/user/foo`,
    headers,
    payload: { hello: "world" },
  });
}

describe("dev-gateway DevTokenResolver", () => {
  it("admits a valid token from a registered origin and routes to env=dev", async () => {
    const tokens = new FakeDevTokenStore();
    const token = newDevToken();
    tokens.add(token, {
      appId: APP_A,
      developerOid: "dev@azx.io",
      origins: [GOOD_ORIGIN],
      expiresAt: future(),
      revokedAt: null,
    });
    const store = new EnvRecordingStore();
    const app = build(tokens, store);

    const res = await putUser(app, "myapp", { token, origin: GOOD_ORIGIN });
    expect(res.statusCode).toBe(200);
    // CORS reflected on the response…
    expect(res.headers["access-control-allow-origin"]).toBe(GOOD_ORIGIN);
    // …and the write landed in env=dev (the resolver's env threaded to the store).
    expect(store.lastEnv).toBe("dev");
    await app.close();
  });

  it("rejects an unknown / revoked / expired token with 401 and no CORS", async () => {
    const tokens = new FakeDevTokenStore();
    const revoked = newDevToken();
    const expired = newDevToken();
    tokens.add(revoked, {
      appId: APP_A,
      developerOid: "d",
      origins: [GOOD_ORIGIN],
      expiresAt: future(),
      revokedAt: new Date(),
    });
    tokens.add(expired, {
      appId: APP_A,
      developerOid: "d",
      origins: [GOOD_ORIGIN],
      expiresAt: past(),
      revokedAt: null,
    });
    const app = build(tokens);
    for (const token of [newDevToken(), revoked, expired]) {
      const res = await putUser(app, "myapp", { token, origin: GOOD_ORIGIN });
      expect(res.statusCode).toBe(401);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    }
    // No token at all → 401 too.
    expect((await putUser(app, "myapp", { origin: GOOD_ORIGIN })).statusCode).toBe(401);
    await app.close();
  });

  it("refuses a token bound to another app (403), even with a valid origin", async () => {
    const tokens = new FakeDevTokenStore();
    const token = newDevToken();
    tokens.add(token, {
      appId: APP_A,
      developerOid: "d",
      origins: [GOOD_ORIGIN],
      expiresAt: future(),
      revokedAt: null,
    });
    const app = build(tokens);
    // APP_A's token presented on APP_B's path → 403 (the token is app-bound).
    const res = await putUser(app, "otherapp", { token, origin: GOOD_ORIGIN });
    expect(res.statusCode).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("refuses an unregistered origin with 403 and emits no CORS reflection", async () => {
    const tokens = new FakeDevTokenStore();
    const token = newDevToken();
    tokens.add(token, {
      appId: APP_A,
      developerOid: "d",
      origins: [GOOD_ORIGIN],
      expiresAt: future(),
      revokedAt: null,
    });
    const app = build(tokens);
    const res = await putUser(app, "myapp", { token, origin: "https://evil.example" });
    expect(res.statusCode).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("never lets request input change the tier — env stays 'dev'", async () => {
    const tokens = new FakeDevTokenStore();
    const token = newDevToken();
    tokens.add(token, {
      appId: APP_A,
      developerOid: "d",
      origins: [GOOD_ORIGIN],
      expiresAt: future(),
      revokedAt: null,
    });
    const store = new EnvRecordingStore();
    const app = build(tokens, store);
    // A forged env hint on the request must be ignored.
    const res = await app.inject({
      method: "PUT",
      url: `/myapp/_api/data/user/foo?env=prod`,
      headers: { authorization: `Bearer ${token}`, origin: GOOD_ORIGIN, "x-helix-env": "prod" },
      payload: { x: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(store.lastEnv).toBe("dev");
    await app.close();
  });
});

describe("dev-gateway CORS preflight", () => {
  it("reflects a registered origin and allows the Authorization header", async () => {
    const tokens = new FakeDevTokenStore();
    tokens.add(newDevToken(), {
      appId: APP_A,
      developerOid: "d",
      origins: [GOOD_ORIGIN],
      expiresAt: future(),
      revokedAt: null,
    });
    const app = build(tokens);
    const res = await app.inject({
      method: "OPTIONS",
      url: "/myapp/_api/data/user/foo",
      headers: { origin: GOOD_ORIGIN, "access-control-request-headers": "if-none-match" },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(GOOD_ORIGIN);
    // Advertises every verb the routes accept, incl. the fetch-proxy's PATCH.
    expect(String(res.headers["access-control-allow-methods"])).toMatch(/PATCH/);
    // Echoes the browser's requested headers (so conditional headers aren't blocked).
    expect(String(res.headers["access-control-allow-headers"])).toMatch(/if-none-match/i);
    await app.close();
  });

  it("rejects a preflight from an unregistered origin with no CORS", async () => {
    const tokens = new FakeDevTokenStore();
    tokens.add(newDevToken(), {
      appId: APP_A,
      developerOid: "d",
      origins: [GOOD_ORIGIN],
      expiresAt: future(),
      revokedAt: null,
    });
    const app = build(tokens);
    const res = await app.inject({
      method: "OPTIONS",
      url: "/myapp/_api/data/user/foo",
      headers: { origin: "https://evil.example" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });
});
