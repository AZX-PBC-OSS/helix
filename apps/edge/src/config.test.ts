import { describe, expect, it } from "vitest";
import { loadConfig, parseConnectionString, publicOrigin } from "./config.js";

// The well-known Azurite dev credentials (public, not a secret).
const AZURITE_KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
const AZURITE_CS =
  `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${AZURITE_KEY};` +
  "BlobEndpoint=http://azurite:10000/devstoreaccount1;QueueEndpoint=http://azurite:10001/devstoreaccount1";

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
  const ENV = {
    DATABASE_URL: "postgresql://helix:helix@db:5432/helix",
    AZURE_STORAGE_CONNECTION_STRING: AZURITE_CS,
  };

  it("applies defaults and the fail-closed auth flag", () => {
    const config = loadConfig({ ...ENV });
    expect(config.baseDomain).toBe("localtest.me");
    expect(config.blob.provider).toBe("azure");
    expect(config.blob.container).toBe("app-bundles");
    expect(config.allowUnauthenticated).toBe(false);
    expect(config.reconcileIntervalMs).toBe(60_000);
    expect(config.auth).toBeNull();
    expect(config.tls).toBeNull();
    expect(config.publicScheme).toBe("http");
    expect(config.publicPort).toBe(8080);
  });

  it("honors overrides", () => {
    const config = loadConfig({
      ...ENV,
      EDGE_BASE_DOMAIN: "AZX-Labs.com",
      BLOB_CONTAINER: "bundles",
      EDGE_DEV_ALLOW_UNAUTHENTICATED: "true",
      EDGE_RECONCILE_INTERVAL_MS: "5000",
    });
    expect(config.baseDomain).toBe("azx-labs.com");
    expect(config.blob.container).toBe("bundles");
    expect(config.allowUnauthenticated).toBe(true);
    expect(config.reconcileIntervalMs).toBe(5000);
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

  it("requires TLS cert and key together", () => {
    expect(() => loadConfig({ ...ENV, EDGE_TLS_CERT_FILE: "/c.pem" })).toThrow(/together/);
    const config = loadConfig({
      ...ENV,
      EDGE_TLS_CERT_FILE: "/c.pem",
      EDGE_TLS_KEY_FILE: "/k.pem",
    });
    expect(config.tls).toEqual({ certFile: "/c.pem", keyFile: "/k.pem" });
    // TLS implies https public URLs unless overridden.
    expect(config.publicScheme).toBe("https");
  });
});

describe("auth config", () => {
  const ENV = {
    DATABASE_URL: "postgresql://helix:helix@db:5432/helix",
    AZURE_STORAGE_CONNECTION_STRING: AZURITE_CS,
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
});

describe("publicOrigin", () => {
  const ENV = {
    DATABASE_URL: "postgresql://helix:helix@db:5432/helix",
    AZURE_STORAGE_CONNECTION_STRING: AZURITE_CS,
  };

  it("builds host URLs from config, omitting scheme-default ports", () => {
    const dev = loadConfig({ ...ENV, EDGE_PUBLIC_SCHEME: "https", EDGE_PUBLIC_PORT: "8080" });
    expect(publicOrigin(dev, "auth")).toBe("https://auth.localtest.me:8080");
    expect(publicOrigin(dev, "demo")).toBe("https://demo.localtest.me:8080");

    const prod = loadConfig({
      ...ENV,
      EDGE_BASE_DOMAIN: "azx-labs.com",
      EDGE_PUBLIC_SCHEME: "https",
      EDGE_PUBLIC_PORT: "443",
    });
    expect(publicOrigin(prod, "auth")).toBe("https://auth.azx-labs.com");
    expect(publicOrigin(prod, null)).toBe("https://azx-labs.com");
  });
});
