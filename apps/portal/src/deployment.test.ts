import { describe, expect, it } from "vitest";
import {
  appPublicHost,
  appPublicUrl,
  assertDeploymentConfig,
  connectionsCallbackUrl,
  resolveAppPublicBase,
  resolveDevApiBase,
  resolveEgressBaseUrl,
  resolveJobsCatalogueServers,
  resolvePlatformMonthlyUsdCap,
} from "./deployment.js";
import { JOBS_FETCH_QUALIFIED_TYPE } from "@azx-pbc/shared";

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
  // here would hand every client — portal UI and `helix` alike — dev URLs that
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

describe("connectionsCallbackUrl", () => {
  // The convention pin: the
  // callback is `auth.<APP_PUBLIC_BASE host>` + `/connections/callback` — the
  // label apps/edge/src/routing/hosts.ts classifies as the auth host, under
  // the prefix apps/edge/src/routing/connectionsProxy.ts forwards to this
  // portal. A drift in either file's half of the convention must fail here.
  it("derives the reserved-subdomain auth host from the apps base", () => {
    expect(connectionsCallbackUrl({ APP_PUBLIC_BASE: "https://azx.helix.azxlabs.io" })).toBe(
      "https://auth.azx.helix.azxlabs.io/connections/callback",
    );
  });

  it("carries scheme and port through", () => {
    expect(connectionsCallbackUrl({ APP_PUBLIC_BASE: "https://local.helix.azxlabs.io:8080" })).toBe(
      "https://auth.local.helix.azxlabs.io:8080/connections/callback",
    );
    expect(connectionsCallbackUrl({ APP_PUBLIC_BASE: "http://localhost:8081" })).toBe(
      "http://auth.localhost:8081/connections/callback",
    );
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

describe("resolveEgressBaseUrl", () => {
  // The exchange delegation is opt-in exactly like the
  // edge's EDGE_EGRESS_URL: null unwires it, and the consuming route refuses
  // rather than degrades.
  it("is null when unset — the exchange delegation is opt-in", () => {
    expect(resolveEgressBaseUrl({})).toBeNull();
  });

  it("honours PORTAL_EGRESS_URL", () => {
    expect(
      resolveEgressBaseUrl({ PORTAL_EGRESS_URL: "http://helix-egress.internal:8081" })?.origin,
    ).toBe("http://helix-egress.internal:8081");
  });

  it("rejects a non-URL value", () => {
    expect(() => resolveEgressBaseUrl({ PORTAL_EGRESS_URL: "egress" })).toThrow(
      /not a valid absolute URL/,
    );
  });

  it("is part of the boot assertion", () => {
    expect(() => assertDeploymentConfig({ PORTAL_EGRESS_URL: "nope" })).toThrow(
      /PORTAL_EGRESS_URL/,
    );
  });
});

describe("resolveJobsCatalogueServers", () => {
  // Unset and blank both read as the fully disabled empty map — the same
  // "absent means not enabled" convention as DEV_API_PUBLIC_BASE.
  it("is the empty map when unset or blank", () => {
    expect(resolveJobsCatalogueServers({})).toEqual({ servers: {} });
    expect(resolveJobsCatalogueServers({ PORTAL_JOBS_CATALOGUE: "   " })).toEqual({
      servers: {},
    });
  });

  it("parses the credential-free server map", () => {
    const source = JSON.stringify({
      servers: { jobs: { state: "serving", types: [JOBS_FETCH_QUALIFIED_TYPE] } },
    });
    expect(resolveJobsCatalogueServers({ PORTAL_JOBS_CATALOGUE: source })).toEqual({
      servers: { jobs: { state: "serving", types: [JOBS_FETCH_QUALIFIED_TYPE] } },
    });
  });

  it("refuses invalid JSON and a malformed map, naming the variable", () => {
    expect(() => resolveJobsCatalogueServers({ PORTAL_JOBS_CATALOGUE: "not json" })).toThrow(
      /PORTAL_JOBS_CATALOGUE/,
    );
    expect(() =>
      resolveJobsCatalogueServers({ PORTAL_JOBS_CATALOGUE: '{"servers":{"jobs":{}}}' }),
    ).toThrow(/PORTAL_JOBS_CATALOGUE/);
    // A synthetic actor cannot ride the projection into discovery.
    expect(() =>
      resolveJobsCatalogueServers({
        PORTAL_JOBS_CATALOGUE: JSON.stringify({
          servers: { jobs: { state: "serving", types: ["jobs:synthetic-actor"] } },
        }),
      }),
    ).toThrow(/PORTAL_JOBS_CATALOGUE/);
    // JSON.parse materializes an own __proto__ key; the parse's raw-input
    // screen is the refusal, so the wire-shaped document never parses clean.
    expect(() =>
      resolveJobsCatalogueServers({
        PORTAL_JOBS_CATALOGUE: '{"servers":{"__proto__":{"state":"serving","types":[]}}}',
      }),
    ).toThrow(/PORTAL_JOBS_CATALOGUE/);
  });

  it("is part of the boot assertion", () => {
    expect(() => assertDeploymentConfig({ PORTAL_JOBS_CATALOGUE: "not json" })).toThrow(
      /PORTAL_JOBS_CATALOGUE/,
    );
    expect(() =>
      assertDeploymentConfig({
        NODE_ENV: "production",
        APP_PUBLIC_BASE: "https://azx.helix.azxlabs.io",
        PORTAL_JOBS_CATALOGUE: '{"servers":{}}',
      }),
    ).not.toThrow();
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
