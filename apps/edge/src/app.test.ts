import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import type { EdgeConfig } from "./config.js";
import { FakeBlobReader, FakeRegistry, registryEntry } from "./test/fakes.js";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const PREFIX = `apps/${APP_ID}/1/`;

function testConfig(overrides: Partial<EdgeConfig> = {}): EdgeConfig {
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
    ...overrides,
  };
}

function buildTestEdge(opts: {
  config?: Partial<EdgeConfig>;
  registry?: FakeRegistry;
  blob?: FakeBlobReader;
}): { app: FastifyInstance; blob: FakeBlobReader } {
  const blob = opts.blob ?? new FakeBlobReader();
  const registry =
    opts.registry ??
    new FakeRegistry([registryEntry({ appId: APP_ID, slug: "demo", blobPrefix: PREFIX })]);
  const app = buildApp({ config: testConfig(opts.config), registry, blob });
  return { app, blob };
}

const HOST = { host: "demo.localtest.me" };

let edge: { app: FastifyInstance; blob: FakeBlobReader };

beforeAll(async () => {
  edge = buildTestEdge({});
  edge.blob.set(`${PREFIX}index.html`, {
    body: "<!doctype html><body>demo</body>",
    contentType: "text/html; charset=utf-8",
    etag: '"html-1"',
  });
  edge.blob.set(`${PREFIX}assets/app.js`, {
    body: "console.log(1)",
    contentType: "text/javascript; charset=utf-8",
    etag: '"js-1"',
  });
  await edge.app.ready();
});

afterAll(async () => {
  await edge.app.close();
});

describe("platform hosts", () => {
  it("serves /health with the shared health contract", async () => {
    const res = await edge.app.inject({ url: "/health", headers: { host: "localhost:8080" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", service: "azx-edge" });
  });

  it("404s everything else", async () => {
    const res = await edge.app.inject({ url: "/whatever", headers: { host: "localhost:8080" } });
    expect(res.statusCode).toBe(404);
  });
});

describe("app hosts: asset serving", () => {
  it("serves an asset with forwarded headers and nosniff", async () => {
    const res = await edge.app.inject({ url: "/assets/app.js", headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("console.log(1)");
    expect(res.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(res.headers.etag).toBe('"js-1"');
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    // Non-HTML: cacheable briefly, private (M3 makes app content authed)…
    expect(res.headers["cache-control"]).toBe("private, max-age=300");
    // …and no CSP — the policy governs documents.
    expect(res.headers["content-security-policy"]).toBeUndefined();
  });

  it("serves / as index.html with CSP and no-cache", async () => {
    const res = await edge.app.inject({ url: "/", headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("demo");
    expect(res.headers["content-security-policy"]).toContain("connect-src 'self'");
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("answers HEAD with headers and no body", async () => {
    const res = await edge.app.inject({ method: "HEAD", url: "/assets/app.js", headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"js-1"');
    expect(res.body).toBe("");
  });

  it("returns 304 for a matching If-None-Match", async () => {
    const res = await edge.app.inject({
      url: "/assets/app.js",
      headers: { ...HOST, "if-none-match": '"js-1"' },
    });
    expect(res.statusCode).toBe(304);
    expect(res.headers.etag).toBe('"js-1"');
    expect(res.body).toBe("");
  });

  it("falls back to index.html for HTML-accepting misses (SPA deep links)", async () => {
    const res = await edge.app.inject({
      url: "/some/client/route",
      headers: { ...HOST, accept: "text/html,application/xhtml+xml" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("demo");
    expect(res.headers["content-security-policy"]).toBeDefined();
  });

  it("hard-404s non-HTML misses", async () => {
    const res = await edge.app.inject({
      url: "/missing.js",
      headers: { ...HOST, accept: "*/*" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s traversal attempts without composing a blob key", async () => {
    // `/..%2f` survives client-side URL normalization (unlike `/%2e%2e/`,
    // which browsers and light-my-request collapse before sending), so this
    // exercises the server-side rejection a raw-socket client would hit.
    const before = edge.blob.requests.length;
    const res = await edge.app.inject({ url: "/..%2fsecrets", headers: HOST });
    expect(res.statusCode).toBe(404);
    expect(edge.blob.requests.length).toBe(before); // never reached the blob
  });

  it("405s non-GET/HEAD with Allow", async () => {
    const res = await edge.app.inject({ method: "POST", url: "/", headers: HOST });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("GET, HEAD");
  });

  it("never serves the platform health JSON on an app host", async () => {
    const res = await edge.app.inject({ url: "/health", headers: { ...HOST, accept: "*/*" } });
    // No /health file in this bundle and a non-HTML accept → plain 404.
    expect(res.statusCode).toBe(404);
  });
});

describe("app hosts: registry states", () => {
  it("404s an unknown slug", async () => {
    const res = await edge.app.inject({ url: "/", headers: { host: "nope.localtest.me" } });
    expect(res.statusCode).toBe(404);
  });

  it("404s an app with no live version, identically to unknown", async () => {
    const { app } = buildTestEdge({
      registry: new FakeRegistry([registryEntry({ appId: APP_ID, slug: "fresh" })]),
    });
    const res = await app.inject({ url: "/", headers: { host: "fresh.localtest.me" } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("410s an archived app with Clear-Site-Data", async () => {
    const { app } = buildTestEdge({
      registry: new FakeRegistry([
        registryEntry({ appId: APP_ID, slug: "old", archived: true, blobPrefix: PREFIX }),
      ]),
    });
    const res = await app.inject({ url: "/", headers: { host: "old.localtest.me" } });
    expect(res.statusCode).toBe(410);
    expect(res.headers["clear-site-data"]).toBe('"cache", "storage"');
    expect(res.headers["cache-control"]).toBe("no-store");
    await app.close();
  });

  it("503s app hosts until the first projection load", async () => {
    const { app } = buildTestEdge({ registry: new FakeRegistry([], { loaded: false }) });
    const res = await app.inject({ url: "/", headers: HOST });
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("5");
    // Platform health is independent of the registry.
    const health = await app.inject({ url: "/health", headers: { host: "localhost" } });
    expect(health.statusCode).toBe(200);
    await app.close();
  });
});

describe("the M2 auth bypass flag", () => {
  it("fails closed: without the flag, app hosts 503 and /health still works", async () => {
    const { app } = buildTestEdge({ config: { allowUnauthenticated: false } });
    const res = await app.inject({ url: "/", headers: HOST });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain("EDGE_DEV_ALLOW_UNAUTHENTICATED");
    const health = await app.inject({ url: "/health", headers: { host: "localhost" } });
    expect(health.statusCode).toBe(200);
    await app.close();
  });
});
