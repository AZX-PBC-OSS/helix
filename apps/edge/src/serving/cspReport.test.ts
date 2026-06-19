import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import type { EdgeConfig } from "../config.js";
import { FakeBlobReader, FakeRegistry, registryEntry } from "../test/fakes.js";
import { extractReport, type CspReportRecord, type CspReportStore } from "./cspReport.js";

const APP_ID = "11111111-1111-4111-8111-111111111111";

function testConfig(): EdgeConfig {
  return {
    baseDomain: "localtest.me",
    databaseUrl: "postgresql://unused",
    blob: {
      provider: "azure",
      accountName: "devstoreaccount1",
      accountKey: Buffer.from("dGVzdA==", "base64"),
      endpoint: "http://azurite:10000/devstoreaccount1",
      container: "app-bundles",
    },
    auth: null,
    allowUnauthenticated: true,
    publicScheme: "https",
    publicPort: 8080,
    tls: null,
    reconcileIntervalMs: 60_000,
    llm: { endpoint: "https://api.anthropic.com", anthropicVersion: "2023-06-01" },
    anonRateLimit: { max: 0, windowMs: 60_000 },
    fetch: { egressUrl: null, instructionSecret: null, timeoutMs: 30_000 },
  };
}

class FakeCspReportStore implements CspReportStore {
  records: CspReportRecord[] = [];
  async record(r: CspReportRecord): Promise<void> {
    this.records.push(r);
  }
  async close(): Promise<void> {}
}

describe("extractReport", () => {
  it("parses a legacy report-uri body", () => {
    expect(
      extractReport({
        "csp-report": {
          "effective-directive": "connect-src",
          "blocked-uri": "https://api.foo.com/x",
          "document-uri": "https://demo.localtest.me/",
        },
      }),
    ).toEqual({
      directive: "connect-src",
      blockedUri: "https://api.foo.com/x",
      documentUri: "https://demo.localtest.me/",
    });
  });

  it("parses a Reporting-API array body", () => {
    expect(
      extractReport([
        {
          type: "csp-violation",
          body: { effectiveDirective: "img-src", blockedURL: "https://x.io/a.png" },
        },
      ]),
    ).toMatchObject({ directive: "img-src", blockedUri: "https://x.io/a.png" });
  });

  it("returns null when there is no blocked URL", () => {
    expect(extractReport({ "csp-report": {} })).toBeNull();
    expect(extractReport({})).toBeNull();
    expect(extractReport("garbage")).toBeNull();
  });
});

describe("POST /_csp-report", () => {
  let store: FakeCspReportStore;
  let edge: { app: FastifyInstance };

  beforeAll(async () => {
    store = new FakeCspReportStore();
    const registry = new FakeRegistry([
      registryEntry({ appId: APP_ID, slug: "demo", blobPrefix: `apps/${APP_ID}/1/` }),
    ]);
    const app = buildApp({
      config: testConfig(),
      registry,
      blob: new FakeBlobReader(),
      cspReports: store,
    });
    edge = { app };
    await app.ready();
  });

  afterAll(async () => {
    await edge.app.close();
  });

  it("records a reported violation and answers 204", async () => {
    const res = await edge.app.inject({
      method: "POST",
      url: "/_csp-report",
      headers: { host: "demo.localtest.me", "content-type": "application/csp-report" },
      payload: JSON.stringify({
        "csp-report": {
          "effective-directive": "connect-src",
          "blocked-uri": "https://api.foo.com",
        },
      }),
    });
    expect(res.statusCode).toBe(204);
    expect(store.records).toEqual([
      {
        appId: APP_ID,
        directive: "connect-src",
        blockedUri: "https://api.foo.com",
        documentUri: null,
      },
    ]);
  });

  it("204s without recording when the report has nothing useful", async () => {
    store.records.length = 0;
    const res = await edge.app.inject({
      method: "POST",
      url: "/_csp-report",
      headers: { host: "demo.localtest.me", "content-type": "application/csp-report" },
      payload: JSON.stringify({ "csp-report": {} }),
    });
    expect(res.statusCode).toBe(204);
    expect(store.records).toHaveLength(0);
  });

  it("404s for an unknown app", async () => {
    const res = await edge.app.inject({
      method: "POST",
      url: "/_csp-report",
      headers: { host: "nope.localtest.me", "content-type": "application/csp-report" },
      payload: JSON.stringify({ "csp-report": { "blocked-uri": "https://x" } }),
    });
    expect(res.statusCode).toBe(404);
  });
});
