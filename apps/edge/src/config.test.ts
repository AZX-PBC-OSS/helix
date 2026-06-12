import { describe, expect, it } from "vitest";
import { loadConfig, parseConnectionString } from "./config.js";

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
});
