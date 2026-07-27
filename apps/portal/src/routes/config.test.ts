import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeploymentConfigResponseSchema } from "@azx-pbc/shared";
import { buildTestApp, type TestApp } from "../test/harness.js";

/**
 * GET /api/v1/config — the deployment bootstrap the prebuilt SPA reads its
 * topology from. Env is read per request, so these override it around an inject
 * (same pattern as dashboard.test.ts) rather than rebuilding the app.
 */
let t: TestApp;

beforeAll(async () => {
  t = buildTestApp();
  await t.app.ready();
});

afterAll(async () => {
  await t.close();
});

/** Run `fn` with env overrides applied, restoring the prior values after. */
async function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const prev = new Map(Object.keys(overrides).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("GET /api/v1/config", () => {
  it("is public — no bearer token required", async () => {
    const res = await t.app.inject({ url: "/api/v1/config" });
    expect(res.statusCode).toBe(200);
    const body = DeploymentConfigResponseSchema.parse(res.json());
    expect(body.appPublicBase).toBe("https://local.helix.azxlabs.io:8080");
  });

  it("reports the deployment's apps base", async () => {
    await withEnv({ APP_PUBLIC_BASE: "https://franklin.helix.azxlabs.io" }, async () => {
      const res = await t.app.inject({ url: "/api/v1/config" });
      expect(res.json<{ appPublicBase: string }>().appPublicBase).toBe(
        "https://franklin.helix.azxlabs.io",
      );
    });
  });

  // Unlike /api/v1/auth/config, which 404s without an IdP. Coupling the apps
  // domain to OIDC config would leave a dev-token-only portal's SPA with no base.
  it("still answers when the portal has no OIDC configured", async () => {
    const devOnly = buildTestApp({ auth: { publicConfig: null } });
    try {
      await devOnly.app.ready();
      expect((await devOnly.app.inject({ url: "/api/v1/auth/config" })).statusCode).toBe(404);
      expect((await devOnly.app.inject({ url: "/api/v1/config" })).statusCode).toBe(200);
    } finally {
      await devOnly.close();
    }
  });

  describe("the opt-in dev gateway", () => {
    it("omits devApiBase when it isn't deployed", async () => {
      await withEnv({ DEV_API_PUBLIC_BASE: undefined }, async () => {
        const body = (await t.app.inject({ url: "/api/v1/config" })).json<
          Record<string, unknown>
        >();
        expect(body.devApiBase).toBeUndefined();
      });
    });

    // The Bicep passes '' when deployDevGateway is false.
    it("treats an empty value as not deployed", async () => {
      await withEnv({ DEV_API_PUBLIC_BASE: "" }, async () => {
        const body = (await t.app.inject({ url: "/api/v1/config" })).json<
          Record<string, unknown>
        >();
        expect(body.devApiBase).toBeUndefined();
      });
    });

    it("reports devApiBase when it is deployed", async () => {
      await withEnv(
        { DEV_API_PUBLIC_BASE: "https://dev-api.franklin.helix.azxlabs.io" },
        async () => {
          const body = (await t.app.inject({ url: "/api/v1/config" })).json<{
            devApiBase: string;
          }>();
          expect(body.devApiBase).toBe("https://dev-api.franklin.helix.azxlabs.io");
        },
      );
    });
  });

  describe("the platform spend cap", () => {
    it("is omitted when unset or zero", async () => {
      for (const value of [undefined, "0"]) {
        await withEnv({ PLATFORM_MONTHLY_USD_CAP: value }, async () => {
          const body = (await t.app.inject({ url: "/api/v1/config" })).json<
            Record<string, unknown>
          >();
          expect(body.platformMonthlyUsdCap).toBeUndefined();
        });
      }
    });

    it("is reported when configured", async () => {
      await withEnv({ PLATFORM_MONTHLY_USD_CAP: "2500" }, async () => {
        const body = (await t.app.inject({ url: "/api/v1/config" })).json<{
          platformMonthlyUsdCap: number;
        }>();
        expect(body.platformMonthlyUsdCap).toBe(2500);
      });
    });
  });
});
