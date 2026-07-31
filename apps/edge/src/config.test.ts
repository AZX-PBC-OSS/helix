import { describe, expect, it } from "vitest";
import { loadConfig, loadDevGatewayConfig, parseConnectionString, publicOrigin } from "./config.js";

// The well-known Azurite dev credentials (public, not a secret).
const AZURITE_KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
const AZURITE_CS =
  `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${AZURITE_KEY};` +
  "BlobEndpoint=http://azurite:10000/devstoreaccount1;QueueEndpoint=http://azurite:10001/devstoreaccount1";

// Managed-identity blob env (the prod path): endpoint + client_id select it, and
// the IDENTITY_* pair is what Container Apps injects when the MI is attached.
const MI_BLOB_ENV = {
  AZURE_STORAGE_BLOB_ENDPOINT: "https://prodacct.blob.core.windows.net",
  AZURE_CLIENT_ID: "11111111-1111-1111-1111-111111111111",
  IDENTITY_ENDPOINT: "http://169.254.169.254/msi/token",
  IDENTITY_HEADER: "identity-header-value",
};

describe("parseConnectionString", () => {
  it("parses the Azurite connection string (key contains '=', BlobEndpoint wins)", () => {
    const parsed = parseConnectionString(AZURITE_CS);
    expect(parsed.accountName).toBe("devstoreaccount1");
    expect(parsed.accountKey).toEqual(Buffer.from(AZURITE_KEY, "base64"));
    expect(parsed.blobEndpoint).toBe("http://azurite:10000/devstoreaccount1");
  });

  it("derives the Azure endpoint when BlobEndpoint is absent", () => {
    const parsed = parseConnectionString(
      `DefaultEndpointsProtocol=https;AccountName=prodacct;AccountKey=${AZURITE_KEY};EndpointSuffix=core.windows.net`,
    );
    expect(parsed.blobEndpoint).toBe("https://prodacct.blob.core.windows.net");
  });

  it("rejects a connection string without an account key", () => {
    expect(() => parseConnectionString("AccountName=x;BlobEndpoint=http://h")).toThrow();
  });
});

describe("loadConfig", () => {
  // The platform is HTTPS-only, so dev config must carry TLS material.
  const ENV = {
    DATABASE_URL: "postgresql://helix:helix@db:5432/helix",
    EDGE_DATABASE_URL: "postgresql://helix_edge:helix_edge@db:5432/helix",
    AZURE_STORAGE_CONNECTION_STRING: AZURITE_CS,
    EDGE_TLS_CERT_FILE: "/certs/local-helix.pem",
    EDGE_TLS_KEY_FILE: "/certs/local-helix-key.pem",
  };

  it("applies defaults and the fail-closed auth flag", () => {
    const config = loadConfig({ ...ENV });
    expect(config.baseDomain).toBe("local.helix.azxlabs.io");
    expect(config.blob.provider).toBe("azure");
    expect(config.blob.container).toBe("app-bundles");
    expect(config.allowUnauthenticated).toBe(false);
    expect(config.reconcileIntervalMs).toBe(60_000);
    expect(config.statementTimeoutMs).toBe(10_000);
    expect(config.auth).toBeNull();
    expect(config.tls).toEqual({
      certFile: "/certs/local-helix.pem",
      keyFile: "/certs/local-helix-key.pem",
    });
    expect(config.publicScheme).toBe("https");
    expect(config.publicPort).toBe(8080);
    // "Allow" polarity, default off: both open surfaces forbidden unless opted in.
    expect(config.allowPublicApps).toBe(false);
    expect(config.allowPasswordApps).toBe(false);
  });

  it("permits open surfaces only on an explicit 'true' (EDGE_ALLOW_*_APPS)", () => {
    const config = loadConfig({
      ...ENV,
      EDGE_ALLOW_PUBLIC_APPS: "true",
      EDGE_ALLOW_PASSWORD_APPS: "true",
    });
    expect(config.allowPublicApps).toBe(true);
    expect(config.allowPasswordApps).toBe(true);
    // Any other value (or unset) leaves the surface forbidden.
    expect(loadConfig({ ...ENV, EDGE_ALLOW_PUBLIC_APPS: "1" }).allowPublicApps).toBe(false);
  });

  it("honors overrides", () => {
    const config = loadConfig({
      ...ENV,
      EDGE_BASE_DOMAIN: "AZX.Helix.AzxLabs.io",
      BLOB_CONTAINER: "bundles",
      EDGE_DEV_ALLOW_UNAUTHENTICATED: "true",
      EDGE_RECONCILE_INTERVAL_MS: "5000",
      EDGE_STATEMENT_TIMEOUT_MS: "3000",
    });
    expect(config.baseDomain).toBe("azx.helix.azxlabs.io");
    expect(config.blob.container).toBe("bundles");
    expect(config.allowUnauthenticated).toBe(true);
    expect(config.reconcileIntervalMs).toBe(5000);
    expect(config.statementTimeoutMs).toBe(3000);
  });

  // A bare Number() let NaN through, and NaN reaches setTimeout, which coerces it
  // to ~0 ms — a DB hot loop from every replica, with /health reading `ok`
  // throughout because the loads keep succeeding. Fail the boot instead.
  it("refuses an unusable EDGE_RECONCILE_INTERVAL_MS instead of hot-looping", () => {
    for (const bad of ["abc", "0", "-1", "NaN", "Infinity"]) {
      expect(() => loadConfig({ ...ENV, EDGE_RECONCILE_INTERVAL_MS: bad })).toThrow(
        /EDGE_RECONCILE_INTERVAL_MS must be a positive number/,
      );
    }
    // Unset falls back to the documented default; an explicit value is honored.
    expect(loadConfig({ ...ENV }).reconcileIntervalMs).toBe(60_000);
    // Empty/whitespace counts as unset, not as a bad value: compose and CI pass
    // empty strings for vars that are declared but not set, and `??` wouldn't
    // catch those (`Number("")` is 0).
    for (const blank of ["", "   "]) {
      expect(loadConfig({ ...ENV, EDGE_RECONCILE_INTERVAL_MS: blank }).reconcileIntervalMs).toBe(
        60_000,
      );
    }
    expect(loadConfig({ ...ENV, EDGE_RECONCILE_INTERVAL_MS: "2500" }).reconcileIntervalMs).toBe(
      2500,
    );
  });

  it("applies the same validation to the dev-gateway, which shares the parse", () => {
    expect(() =>
      loadDevGatewayConfig({
        ...ENV,
        EDGE_DEV_DATABASE_URL: "postgresql://helix_dev:helix_dev@db:5432/helix",
        EDGE_RECONCILE_INTERVAL_MS: "abc",
      }),
    ).toThrow(/EDGE_RECONCILE_INTERVAL_MS must be a positive number/);
  });

  it("throws a clear error on missing requirements", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: "x" })).toThrow(/AZURE_STORAGE_CONNECTION_STRING/);
  });

  it("refuses the dev bypass in production", () => {
    expect(() =>
      loadConfig({ ...ENV, EDGE_DEV_ALLOW_UNAUTHENTICATED: "true", NODE_ENV: "production" }),
    ).toThrow(/refused in production/);
  });

  it("refuses the owner-DSN fallback in production (role-split, ADR-0002)", () => {
    // Only DATABASE_URL (the schema owner) set in prod → boot-fail rather than
    // silently connect as owner and bypass RLS.
    const { EDGE_DATABASE_URL: _omit, ...ownerOnly } = ENV;
    void _omit;
    expect(() => loadConfig({ ...ownerOnly, ...MI_BLOB_ENV, NODE_ENV: "production" })).toThrow(
      /EDGE_DATABASE_URL.*required in production/,
    );
    // With the least-privilege role DSN present, prod boots and uses it.
    const config = loadConfig({ ...ENV, ...MI_BLOB_ENV, NODE_ENV: "production" });
    expect(config.databaseUrl).toBe(ENV.EDGE_DATABASE_URL);
  });

  it("still allows the owner-DSN fallback outside production", () => {
    const { EDGE_DATABASE_URL: _omit, ...ownerOnly } = ENV;
    void _omit;
    const config = loadConfig(ownerOnly);
    expect(config.databaseUrl).toBe(ENV.DATABASE_URL);
  });

  const noTls = {
    DATABASE_URL: ENV.DATABASE_URL,
    AZURE_STORAGE_CONNECTION_STRING: ENV.AZURE_STORAGE_CONNECTION_STRING,
  };

  it("requires TLS outside production (HTTPS-only platform)", () => {
    expect(() => loadConfig(noTls)).toThrow(/TLS is required/);
    // Production opts out: ingress owns the cert, the edge runs HTTP behind it.
    // Prod also uses managed-identity blob auth (the connection string is refused).
    const prod = loadConfig({
      DATABASE_URL: ENV.DATABASE_URL,
      EDGE_DATABASE_URL: ENV.EDGE_DATABASE_URL,
      ...MI_BLOB_ENV,
      NODE_ENV: "production",
    });
    expect(prod.tls).toBeNull();
    expect(prod.publicScheme).toBe("https");
  });

  it("selects managed-identity blob auth from endpoint + client_id", () => {
    const config = loadConfig({
      DATABASE_URL: ENV.DATABASE_URL,
      EDGE_DATABASE_URL: ENV.EDGE_DATABASE_URL,
      ...MI_BLOB_ENV,
      NODE_ENV: "production",
    });
    expect(config.blob.provider).toBe("azure");
    expect(config.blob.endpoint).toBe("https://prodacct.blob.core.windows.net");
    expect(config.blob.auth.mode).toBe("managed-identity");
    // Regression (issue #15): the MI path carries no account key, structurally.
    expect("accountKey" in config.blob.auth).toBe(false);
    if (config.blob.auth.mode === "managed-identity") {
      expect(config.blob.auth.clientId).toBe(MI_BLOB_ENV.AZURE_CLIENT_ID);
      expect(config.blob.auth.identityEndpoint).toBe(MI_BLOB_ENV.IDENTITY_ENDPOINT);
      expect(config.blob.auth.identityHeader).toBe(MI_BLOB_ENV.IDENTITY_HEADER);
    }
  });

  it("uses shared-key blob auth from a connection string in dev", () => {
    const config = loadConfig({ ...ENV });
    expect(config.blob.auth.mode).toBe("shared-key");
    if (config.blob.auth.mode === "shared-key") {
      expect(config.blob.auth.accountName).toBe("devstoreaccount1");
      expect(config.blob.auth.accountKey).toEqual(Buffer.from(AZURITE_KEY, "base64"));
    }
  });

  it("prefers managed identity over a connection string when both are set", () => {
    const config = loadConfig({ ...ENV, ...MI_BLOB_ENV, NODE_ENV: "production" });
    expect(config.blob.auth.mode).toBe("managed-identity");
  });

  it("refuses the account-key (SharedKey) blob path in production", () => {
    expect(() => loadConfig({ ...ENV, NODE_ENV: "production" })).toThrow(/refused in production/);
  });

  it("requires IDENTITY_ENDPOINT/IDENTITY_HEADER for managed-identity blob auth", () => {
    const partial = {
      AZURE_STORAGE_BLOB_ENDPOINT: MI_BLOB_ENV.AZURE_STORAGE_BLOB_ENDPOINT,
      AZURE_CLIENT_ID: MI_BLOB_ENV.AZURE_CLIENT_ID,
    };
    expect(() => loadConfig({ ...ENV, ...partial })).toThrow(
      /IDENTITY_ENDPOINT and IDENTITY_HEADER/,
    );
  });

  it("throws when no blob auth is configured at all", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: ENV.DATABASE_URL,
        EDGE_DATABASE_URL: ENV.EDGE_DATABASE_URL,
        NODE_ENV: "production",
      }),
    ).toThrow(/AZURE_STORAGE_CONNECTION_STRING/);
  });

  it("requires TLS cert and key together", () => {
    expect(() => loadConfig({ ...noTls, EDGE_TLS_CERT_FILE: "/c.pem" })).toThrow(/together/);
  });
});

describe("auth config", () => {
  const ENV = {
    DATABASE_URL: "postgresql://helix:helix@db:5432/helix",
    EDGE_DATABASE_URL: "postgresql://helix_edge:helix_edge@db:5432/helix",
    AZURE_STORAGE_CONNECTION_STRING: AZURITE_CS,
    EDGE_TLS_CERT_FILE: "/certs/local-helix.pem",
    EDGE_TLS_KEY_FILE: "/certs/local-helix-key.pem",
  };
  // 32 zero bytes, base64.
  const SECRET = Buffer.alloc(32).toString("base64");
  const AUTH_ENV = {
    EDGE_OIDC_ISSUER: "https://idp.example.com",
    EDGE_OIDC_CLIENT_ID: "helix-edge",
    EDGE_OIDC_CLIENT_SECRET: "s3cret",
    EDGE_AUTH_SECRET: SECRET,
  };

  it("is null when no auth env is present (fail-closed boot)", () => {
    expect(loadConfig({ ...ENV }).auth).toBeNull();
  });

  it("rejects a partial auth block", () => {
    expect(() => loadConfig({ ...ENV, EDGE_OIDC_ISSUER: "https://idp.example.com" })).toThrow(
      /Partial auth config/,
    );
  });

  it("parses a full auth block with defaults", () => {
    const auth = loadConfig({ ...ENV, ...AUTH_ENV }).auth;
    expect(auth).not.toBeNull();
    expect(auth?.issuerUrl).toBe("https://idp.example.com");
    expect(auth?.groupsClaim).toBe("groups");
    expect(auth?.scopes).toBe("openid profile email groups");
    expect(auth?.secret).toEqual(Buffer.alloc(32));
    expect(auth?.sessionTtlMs).toBe(8 * 60 * 60 * 1000);
    expect(auth?.refreshAfterMs).toBe(60 * 60 * 1000);
    expect(auth?.handoffTtlSec).toBe(30);
  });

  it("rejects an http issuer unless explicitly allowed", () => {
    const httpIssuer = { ...ENV, ...AUTH_ENV, EDGE_OIDC_ISSUER: "http://localhost:3002" };
    expect(() => loadConfig(httpIssuer)).toThrow(/must be https/);
    const allowed = loadConfig({ ...httpIssuer, EDGE_OIDC_ALLOW_INSECURE: "true" });
    expect(allowed.auth?.allowInsecureIdp).toBe(true);
  });

  it("rejects a short secret", () => {
    expect(() =>
      loadConfig({ ...ENV, ...AUTH_ENV, EDGE_AUTH_SECRET: Buffer.alloc(16).toString("base64") }),
    ).toThrow(/32 bytes/);
  });

  it("parses a full auth block as a secret credential", () => {
    const auth = loadConfig({ ...ENV, ...AUTH_ENV }).auth;
    expect(auth?.credential).toEqual({ kind: "secret", clientSecret: "s3cret" });
  });

  // Certificate auth (private_key_jwt) for tenants that block client secrets.
  const PEM_KEY = "-----BEGIN PRIVATE KEY-----\nMIG\n-----END PRIVATE KEY-----";
  const PEM_CERT = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
  const CERT_BASE = {
    EDGE_OIDC_ISSUER: "https://idp.example.com",
    EDGE_OIDC_CLIENT_ID: "helix-edge",
    EDGE_AUTH_SECRET: SECRET,
  };

  it("parses a certificate credential (raw PEM)", () => {
    const auth = loadConfig({
      ...ENV,
      ...CERT_BASE,
      EDGE_OIDC_CLIENT_PRIVATE_KEY: PEM_KEY,
      EDGE_OIDC_CLIENT_CERTIFICATE: PEM_CERT,
    }).auth;
    expect(auth?.credential).toEqual({
      kind: "certificate",
      privateKeyPem: PEM_KEY,
      certificatePem: PEM_CERT,
    });
  });

  it("accepts base64-encoded PEM for certificate credentials", () => {
    const auth = loadConfig({
      ...ENV,
      ...CERT_BASE,
      EDGE_OIDC_CLIENT_PRIVATE_KEY: Buffer.from(PEM_KEY).toString("base64"),
      EDGE_OIDC_CLIENT_CERTIFICATE: Buffer.from(PEM_CERT).toString("base64"),
    }).auth;
    expect(auth?.credential).toEqual({
      kind: "certificate",
      privateKeyPem: PEM_KEY,
      certificatePem: PEM_CERT,
    });
  });

  it("rejects a non-PEM, non-base64 certificate value", () => {
    expect(() =>
      loadConfig({
        ...ENV,
        ...CERT_BASE,
        EDGE_OIDC_CLIENT_PRIVATE_KEY: "not-a-pem",
        EDGE_OIDC_CLIENT_CERTIFICATE: PEM_CERT,
      }),
    ).toThrow(/PEM or base64-encoded PEM/);
  });

  it("rejects a certificate credential missing its private key", () => {
    expect(() =>
      loadConfig({ ...ENV, ...CERT_BASE, EDGE_OIDC_CLIENT_CERTIFICATE: PEM_CERT }),
    ).toThrow(/needs both/);
  });

  it("rejects both a secret and a certificate", () => {
    expect(() =>
      loadConfig({
        ...ENV,
        ...AUTH_ENV,
        EDGE_OIDC_CLIENT_PRIVATE_KEY: PEM_KEY,
        EDGE_OIDC_CLIENT_CERTIFICATE: PEM_CERT,
      }),
    ).toThrow(/not both/);
  });

  it("rejects a base block with no credential at all", () => {
    expect(() => loadConfig({ ...ENV, ...CERT_BASE })).toThrow(/needs a client credential/);
  });
});

describe("publicOrigin", () => {
  const ENV = {
    DATABASE_URL: "postgresql://helix:helix@db:5432/helix",
    EDGE_DATABASE_URL: "postgresql://helix_edge:helix_edge@db:5432/helix",
    AZURE_STORAGE_CONNECTION_STRING: AZURITE_CS,
    EDGE_TLS_CERT_FILE: "/certs/local-helix.pem",
    EDGE_TLS_KEY_FILE: "/certs/local-helix-key.pem",
  };

  it("builds https host URLs from config, omitting the default 443", () => {
    const dev = loadConfig({ ...ENV, EDGE_PUBLIC_PORT: "8080" });
    expect(publicOrigin(dev, "auth")).toBe("https://auth.local.helix.azxlabs.io:8080");
    expect(publicOrigin(dev, "demo")).toBe("https://demo.local.helix.azxlabs.io:8080");

    // Production: ingress terminates TLS (no edge cert), public port 443, and
    // blob auth is managed identity (the connection string is refused in prod).
    const prod = loadConfig({
      DATABASE_URL: ENV.DATABASE_URL,
      EDGE_DATABASE_URL: ENV.EDGE_DATABASE_URL,
      ...MI_BLOB_ENV,
      EDGE_BASE_DOMAIN: "azx.helix.azxlabs.io",
      EDGE_PUBLIC_PORT: "443",
      NODE_ENV: "production",
    });
    expect(publicOrigin(prod, "auth")).toBe("https://auth.azx.helix.azxlabs.io");
    expect(publicOrigin(prod, null)).toBe("https://azx.helix.azxlabs.io");
  });
});

describe("loadDevGatewayConfig", () => {
  // The dev-gateway's ONLY required env is its own helix_dev DSN (+ TLS in dev).
  const DEV_ENV = {
    EDGE_DEV_DATABASE_URL: "postgresql://helix_dev:helix_dev@db:5432/helix",
    EDGE_TLS_CERT_FILE: "/certs/local-helix.pem",
    EDGE_TLS_KEY_FILE: "/certs/local-helix-key.pem",
  };

  it("loads from the dev DSN alone — no edge DSN or blob env required", () => {
    // Deliberately NO EDGE_DATABASE_URL, DATABASE_URL, or AZURE_STORAGE_* here.
    const config = loadDevGatewayConfig({ ...DEV_ENV });
    expect(config.devGateway.databaseUrl).toBe(DEV_ENV.EDGE_DEV_DATABASE_URL);
    expect(config.devGateway.allowDevMode).toBe(false); // opt-in, default off
    expect(config.devGateway.port).toBe(8082);
    // Shared gateway defaults still resolve.
    expect(config.baseDomain).toBe("local.helix.azxlabs.io");
    expect(config.llm.connection).toBe("anthropic");
    expect(config.fetch.egressUrl).toBeNull();
    // Airtight: the type — and the value — structurally lack the edge data plane,
    // so this process cannot name the helix_edge pool or a blob account.
    expect("databaseUrl" in config).toBe(false);
    expect("blob" in config).toBe(false);
    expect("auth" in config).toBe(false);
  });

  it("reflects the opt-in flag and port overrides", () => {
    const config = loadDevGatewayConfig({
      ...DEV_ENV,
      EDGE_ALLOW_DEV_MODE: "true",
      EDGE_DEV_GATEWAY_PORT: "9099",
    });
    expect(config.devGateway.allowDevMode).toBe(true);
    expect(config.devGateway.port).toBe(9099);
  });

  it("requires EDGE_DEV_DATABASE_URL with NO owner-DSN fallback", () => {
    // Even a full set of edge/owner DSNs must not satisfy the dev-gateway — the
    // env-literal RLS only holds when it connects as helix_dev (dev-mode §5.3).
    expect(() =>
      loadDevGatewayConfig({
        DATABASE_URL: "postgresql://helix@db/helix",
        EDGE_DATABASE_URL: "postgresql://helix_edge@db/helix",
        EDGE_TLS_CERT_FILE: "/c.pem",
        EDGE_TLS_KEY_FILE: "/k.pem",
      }),
    ).toThrow(/EDGE_DEV_DATABASE_URL/);
  });

  it("enforces the HTTPS-only TLS rule outside production", () => {
    const noTls = { EDGE_DEV_DATABASE_URL: DEV_ENV.EDGE_DEV_DATABASE_URL };
    expect(() => loadDevGatewayConfig(noTls)).toThrow(/TLS is required/);
  });

  it("runs without a local cert in production (ingress terminates TLS)", () => {
    const config = loadDevGatewayConfig({
      EDGE_DEV_DATABASE_URL: DEV_ENV.EDGE_DEV_DATABASE_URL,
      NODE_ENV: "production",
    });
    expect(config.tls).toBeNull();
    expect(config.devGateway.databaseUrl).toBe(DEV_ENV.EDGE_DEV_DATABASE_URL);
  });
});
