import { describe, expect, it } from "vitest";
import {
  JOBS_DIAGNOSTIC_DISPLAY_NAME,
  JOBS_DIAGNOSTIC_QUALIFIED_TYPE,
  JOBS_FETCH_QUALIFIED_TYPE,
} from "@azx-pbc/shared";
import {
  appPublicHost,
  appPublicUrl,
  assertDeploymentConfig,
  assertDeliveryTargetsMatch,
  connectionsCallbackUrl,
  resolveAdvertisedJobTypes,
  resolveAppPublicBase,
  resolveDevApiBase,
  resolveEgressBaseUrl,
  resolveJobsCatalogueServers,
  resolvePlatformMonthlyUsdCap,
  resolvePortalJobsDeliveryConfig,
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

  it("a non-production catalogue may install the diagnostic type; production never parses it", () => {
    const source = JSON.stringify({
      servers: {
        jobs: {
          state: "serving",
          types: [JOBS_FETCH_QUALIFIED_TYPE, JOBS_DIAGNOSTIC_QUALIFIED_TYPE],
        },
      },
    });
    expect(
      resolveJobsCatalogueServers({ NODE_ENV: "test", PORTAL_JOBS_CATALOGUE: source }),
    ).toEqual({
      servers: {
        jobs: {
          state: "serving",
          types: [JOBS_FETCH_QUALIFIED_TYPE, JOBS_DIAGNOSTIC_QUALIFIED_TYPE],
        },
      },
    });
    expect(() =>
      resolveJobsCatalogueServers({ NODE_ENV: "production", PORTAL_JOBS_CATALOGUE: source }),
    ).toThrow(/PORTAL_JOBS_CATALOGUE/);
  });
});

describe("resolveAdvertisedJobTypes", () => {
  const DIAGNOSTIC_CATALOGUE = JSON.stringify({
    servers: {
      jobs: {
        state: "serving",
        types: [JOBS_FETCH_QUALIFIED_TYPE, JOBS_DIAGNOSTIC_QUALIFIED_TYPE],
      },
    },
  });
  const FETCH_CATALOGUE = JSON.stringify({
    servers: { jobs: { state: "serving", types: [JOBS_FETCH_QUALIFIED_TYPE] } },
  });

  it("advertises the diagnostic type with its display name only off a non-production stack", () => {
    expect(
      resolveAdvertisedJobTypes({ NODE_ENV: "test", PORTAL_JOBS_CATALOGUE: DIAGNOSTIC_CATALOGUE }),
    ).toEqual([
      { id: JOBS_FETCH_QUALIFIED_TYPE, displayName: "Outbound fetch job" },
      { id: JOBS_DIAGNOSTIC_QUALIFIED_TYPE, displayName: JOBS_DIAGNOSTIC_DISPLAY_NAME },
    ]);
    // Same document on a production stack cannot even parse — the advertised
    // set can never carry the type there.
    expect(() =>
      resolveAdvertisedJobTypes({
        NODE_ENV: "production",
        PORTAL_JOBS_CATALOGUE: DIAGNOSTIC_CATALOGUE,
      }),
    ).toThrow(/PORTAL_JOBS_CATALOGUE/);
  });

  it("advertises fetch only when the catalogue installs fetch only", () => {
    expect(
      resolveAdvertisedJobTypes({ NODE_ENV: "test", PORTAL_JOBS_CATALOGUE: FETCH_CATALOGUE }),
    ).toEqual([{ id: JOBS_FETCH_QUALIFIED_TYPE, displayName: "Outbound fetch job" }]);
    // The fully disabled installation advertises nothing.
    expect(resolveAdvertisedJobTypes({ NODE_ENV: "test" })).toEqual([]);
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

describe("resolvePortalJobsDeliveryConfig", () => {
  const ROOT = Buffer.alloc(32, 7).toString("base64");
  const OTHER_ROOT = Buffer.alloc(32, 8).toString("base64");

  it("is null when unset, blank, or an empty map — the fully disabled posture", () => {
    expect(resolvePortalJobsDeliveryConfig({})).toBeNull();
    expect(resolvePortalJobsDeliveryConfig({ PORTAL_JOBS_CONFIG: "   " })).toBeNull();
    expect(resolvePortalJobsDeliveryConfig({ PORTAL_JOBS_CONFIG: '{"servers":{}}' })).toBeNull();
  });

  it("parses the portal's permitted subset and derives the mint keys at load", () => {
    const config = resolvePortalJobsDeliveryConfig({
      PORTAL_JOBS_CONFIG: JSON.stringify({
        servers: { jobs: { endpoint: "http://jobs.internal:3003/", portalToJobsRoot: ROOT } },
      }),
    });
    expect(config).not.toBeNull();
    const target = config?.get("jobs");
    // The trailing slash is stripped: the sender appends the operation matrix's
    // own routes, and a doubled slash would sign a resource no receiver serves.
    expect(target?.endpoint).toBe("http://jobs.internal:3003");
    expect(target?.portalToJobsKey).toBeInstanceOf(Uint8Array);
    expect(target?.portalToJobsKey.byteLength).toBe(32);
  });

  it("refuses invalid JSON, a malformed entry, and a leaked field, naming the variable", () => {
    expect(() => resolvePortalJobsDeliveryConfig({ PORTAL_JOBS_CONFIG: "not json" })).toThrow(
      /PORTAL_JOBS_CONFIG/,
    );
    expect(() =>
      resolvePortalJobsDeliveryConfig({ PORTAL_JOBS_CONFIG: '{"servers":{"jobs":{}}}' }),
    ).toThrow(/PORTAL_JOBS_CONFIG/);
    // The full deployment map's fields must never reach this process: the
    // strict parse names the leaked field instead of silently holding it.
    expect(() =>
      resolvePortalJobsDeliveryConfig({
        PORTAL_JOBS_CONFIG: JSON.stringify({
          servers: {
            jobs: {
              endpoint: "http://jobs.internal:3003",
              portalToJobsRoot: ROOT,
              databaseUrl: "postgresql://helix:helix@db:5432/jobs",
            },
          },
        }),
      }),
    ).toThrow(/PORTAL_JOBS_CONFIG/);
    // The other direction's root is the same custody line (the portal mints
    // portal→jobs instructions only — ADR-0008's matrix gives it no authority
    // over any other direction's secret).
    expect(() =>
      resolvePortalJobsDeliveryConfig({
        PORTAL_JOBS_CONFIG: JSON.stringify({
          servers: {
            jobs: {
              endpoint: "http://jobs.internal:3003",
              portalToJobsRoot: ROOT,
              edgeToJobsRoot: OTHER_ROOT,
            },
          },
        }),
      }),
    ).toThrow(/PORTAL_JOBS_CONFIG/);
    expect(() =>
      resolvePortalJobsDeliveryConfig({
        PORTAL_JOBS_CONFIG:
          '{"servers":{"__proto__":{"endpoint":"http://x","portalToJobsRoot":""}}}',
      }),
    ).toThrow(/PORTAL_JOBS_CONFIG/);
  });

  it("refuses a root that is not the canonical base64 of 32 bytes, and an endpoint that is not a bare internal base", () => {
    // 31 bytes decodes fine but is not the 32-byte secret the HKDF derive
    // expects; an unpadded encoding decodes to the same 32 bytes yet does not
    // re-encode to itself. Both must fail the boot at load, not the first
    // delivery pass.
    const thirtyOneBytes = Buffer.alloc(31, 7).toString("base64");
    const unpadded = ROOT.replace(/=+$/, "");
    const entry = (over: Record<string, unknown>): string =>
      JSON.stringify({
        servers: {
          jobs: { endpoint: "http://jobs.internal:3003", portalToJobsRoot: ROOT, ...over },
        },
      });
    for (const badRoot of [thirtyOneBytes, unpadded, "short"]) {
      expect(() =>
        resolvePortalJobsDeliveryConfig({
          PORTAL_JOBS_CONFIG: entry({ portalToJobsRoot: badRoot }),
        }),
      ).toThrow(/PORTAL_JOBS_CONFIG/);
    }
    // A userinfo part on the endpoint would sit in a routing constant every
    // consumer logs; a query string would be silently dropped by URL
    // composition while looking configured. Both are refused at the load.
    expect(() =>
      resolvePortalJobsDeliveryConfig({
        PORTAL_JOBS_CONFIG: entry({ endpoint: "http://user:pass@jobs.internal:3003" }),
      }),
    ).toThrow(/PORTAL_JOBS_CONFIG/);
    expect(() =>
      resolvePortalJobsDeliveryConfig({
        PORTAL_JOBS_CONFIG: entry({ endpoint: "http://jobs.internal:3003/?x=1" }),
      }),
    ).toThrow(/PORTAL_JOBS_CONFIG/);
  });

  it("refuses one root shared across servers — the custody line the map holds", () => {
    expect(() =>
      resolvePortalJobsDeliveryConfig({
        PORTAL_JOBS_CONFIG: JSON.stringify({
          servers: {
            jobs: { endpoint: "http://jobs.internal:3003", portalToJobsRoot: ROOT },
            legacy: { endpoint: "http://legacy.internal:3003", portalToJobsRoot: ROOT },
          },
        }),
      }),
    ).toThrow(/independently generated root/);
    expect(
      resolvePortalJobsDeliveryConfig({
        PORTAL_JOBS_CONFIG: JSON.stringify({
          servers: {
            jobs: { endpoint: "http://jobs.internal:3003", portalToJobsRoot: ROOT },
            legacy: { endpoint: "http://legacy.internal:3003", portalToJobsRoot: OTHER_ROOT },
          },
        }),
      }),
    ).not.toBeNull();
  });

  it("is part of the boot assertion", () => {
    expect(() => assertDeploymentConfig({ PORTAL_JOBS_CONFIG: "not json" })).toThrow(
      /PORTAL_JOBS_CONFIG/,
    );
  });
});

describe("assertDeliveryTargetsMatch", () => {
  const CATALOGUE = {
    servers: { jobs: { state: "serving" as const, types: ["jobs:fetch"] } },
  };
  const ROOT = Buffer.alloc(32, 7).toString("base64");
  const delivery = (server: string) =>
    resolvePortalJobsDeliveryConfig({
      PORTAL_JOBS_CONFIG: JSON.stringify({
        servers: { [server]: { endpoint: "http://jobs.internal:3003", portalToJobsRoot: ROOT } },
      }),
    });

  it("passes when both documents name the same servers", () => {
    expect(assertDeliveryTargetsMatch(CATALOGUE, delivery("jobs"))).toBeUndefined();
    expect(assertDeliveryTargetsMatch({ servers: {} }, null)).toBeUndefined();
  });

  it("fails loudly when the catalogue names a target with no delivery path", () => {
    expect(() => assertDeliveryTargetsMatch(CATALOGUE, null)).toThrow(/"jobs"/);
    expect(() =>
      assertDeliveryTargetsMatch(
        {
          servers: {
            jobs: { state: "serving" as const, types: ["jobs:fetch"] },
            legacy: { state: "retiring" as const, types: [] },
          },
        },
        delivery("jobs"),
      ),
    ).toThrow(/legacy/);
  });

  it("fails loudly when a delivery credential has no catalogue reader", () => {
    expect(() => assertDeliveryTargetsMatch({ servers: {} }, delivery("jobs"))).toThrow(/jobs/);
  });
});
