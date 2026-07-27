import { describe, expect, it } from "vitest";
import {
  appPublicHost,
  appPublicUrl,
  assertDeploymentConfig,
  resolveAppPublicBase,
  resolveDevApiBase,
  resolvePlatformMonthlyUsdCap,
} from "./deployment.js";

/**
 * The resolvers take an injectable env, so these assert against literals rather
 * than mutating process.env — the save/set/restore dance is only needed for the
 * route/dashboard tests, which go through a request.
 */
describe("resolveAppPublicBase", () => {
  it("falls back to the dev edge outside production", () => {
    expect(resolveAppPublicBase({}).origin).toBe("https://local.helix.azxlabs.io:8080");
  });

  it("honours APP_PUBLIC_BASE", () => {
    const base = resolveAppPublicBase({ APP_PUBLIC_BASE: "https://azx.helix.azxlabs.io" });
    expect(base.origin).toBe("https://azx.helix.azxlabs.io");
  });

  it("trims surrounding whitespace and treats blank as unset", () => {
    expect(resolveAppPublicBase({ APP_PUBLIC_BASE: "  https://a.example  " }).origin).toBe(
      "https://a.example",
    );
    expect(resolveAppPublicBase({ APP_PUBLIC_BASE: "   " }).origin).toBe(
      "https://local.helix.azxlabs.io:8080",
    );
  });

  // The whole point of the prod-strict check: a portal that silently fell back
  // here would hand every client — portal UI and `azx` alike — dev URLs that
  // resolve to 127.0.0.1.
  it("refuses the dev fallback in production", () => {
    expect(() => resolveAppPublicBase({ NODE_ENV: "production" })).toThrow(
      /required in production/,
    );
  });

  it("accepts an explicit base in production", () => {
    expect(
      resolveAppPublicBase({
        NODE_ENV: "production",
        APP_PUBLIC_BASE: "https://azx.helix.azxlabs.io",
      }).origin,
    ).toBe("https://azx.helix.azxlabs.io");
  });

  it("rejects a non-URL value", () => {
    expect(() => resolveAppPublicBase({ APP_PUBLIC_BASE: "azx.helix.azxlabs.io" })).toThrow(
      /not a valid absolute URL/,
    );
  });
});

describe("appPublicUrl / appPublicHost", () => {
  const env = { APP_PUBLIC_BASE: "https://azx.helix.azxlabs.io" };

  it("prefixes the slug as a subdomain", () => {
    expect(appPublicUrl("demo", env)).toBe("https://demo.azx.helix.azxlabs.io");
    expect(appPublicHost("demo", env)).toBe("demo.azx.helix.azxlabs.io");
  });

  it("carries a non-default port through", () => {
    const dev = { APP_PUBLIC_BASE: "https://local.helix.azxlabs.io:8080" };
    expect(appPublicUrl("demo", dev)).toBe("https://demo.local.helix.azxlabs.io:8080");
    expect(appPublicHost("demo", dev)).toBe("demo.local.helix.azxlabs.io:8080");
  });
});

describe("resolveDevApiBase", () => {
  it("is null when unset — the dev gateway is opt-in", () => {
    expect(resolveDevApiBase({})).toBeNull();
  });

  // The Bicep sets this to '' when deployDevGateway is false, so empty must read
  // as "not deployed" rather than a misconfiguration.
  it("treats an empty value as not deployed", () => {
    expect(resolveDevApiBase({ DEV_API_PUBLIC_BASE: "" })).toBeNull();
    expect(resolveDevApiBase({ DEV_API_PUBLIC_BASE: "   " })).toBeNull();
  });

  it("honours DEV_API_PUBLIC_BASE", () => {
    expect(
      resolveDevApiBase({ DEV_API_PUBLIC_BASE: "https://dev-api.azx.helix.azxlabs.io" })?.origin,
    ).toBe("https://dev-api.azx.helix.azxlabs.io");
  });

  it("rejects a non-URL value", () => {
    expect(() => resolveDevApiBase({ DEV_API_PUBLIC_BASE: "dev-api" })).toThrow(
      /not a valid absolute URL/,
    );
  });
});

describe("resolvePlatformMonthlyUsdCap", () => {
  it("is null when unset, zero, negative, or unparseable", () => {
    expect(resolvePlatformMonthlyUsdCap({})).toBeNull();
    expect(resolvePlatformMonthlyUsdCap({ PLATFORM_MONTHLY_USD_CAP: "0" })).toBeNull();
    expect(resolvePlatformMonthlyUsdCap({ PLATFORM_MONTHLY_USD_CAP: "-5" })).toBeNull();
    expect(resolvePlatformMonthlyUsdCap({ PLATFORM_MONTHLY_USD_CAP: "lots" })).toBeNull();
  });

  it("parses a positive cap", () => {
    expect(resolvePlatformMonthlyUsdCap({ PLATFORM_MONTHLY_USD_CAP: "2500" })).toBe(2500);
  });
});

describe("assertDeploymentConfig", () => {
  it("throws for a production portal with no apps base", () => {
    expect(() => assertDeploymentConfig({ NODE_ENV: "production" })).toThrow(/APP_PUBLIC_BASE/);
  });

  it("throws for a malformed dev-gateway base", () => {
    expect(() => assertDeploymentConfig({ DEV_API_PUBLIC_BASE: "nope" })).toThrow(
      /DEV_API_PUBLIC_BASE/,
    );
  });

  it("passes for a well-formed deployment", () => {
    expect(() =>
      assertDeploymentConfig({
        NODE_ENV: "production",
        APP_PUBLIC_BASE: "https://azx.helix.azxlabs.io",
        DEV_API_PUBLIC_BASE: "",
      }),
    ).not.toThrow();
  });
});
