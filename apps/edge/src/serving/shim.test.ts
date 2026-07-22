import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { testEdgeConfig } from "../test/config.js";
import { FakeBlobReader, FakeRegistry, registryEntry } from "../test/fakes.js";
import { buildShimScript, injectShimTag } from "./shim.js";

/**
 * The transparent fetch shim (fetch-proxy design §3.2): the per-app script
 * (covering fetch + XMLHttpRequest), served at `/_helix/fetch-shim.js`, and
 * injected into HTML for opt-in apps only.
 */

describe("buildShimScript", () => {
  it("bakes in the origins and patches both fetch and XMLHttpRequest", () => {
    const js = buildShimScript(["https://api.github.com", "https://api.stripe.com"]);
    expect(js).toContain("https://api.github.com");
    expect(js).toContain("https://api.stripe.com");
    expect(js).toContain("window.fetch =");
    expect(js).toContain("XMLHttpRequest.prototype.open");
    expect(js).toContain("/_api/fetch/");
    expect(js).toContain("__helixShim"); // double-injection guard
  });
});

describe("injectShimTag", () => {
  it("inserts the tag right after <head>", () => {
    const out = injectShimTag(
      "<!doctype html><html><head><title>x</title></head><body></body></html>",
    );
    expect(out).toContain('<head><script src="/_helix/fetch-shim.js"></script><title>');
  });
  it("prepends when there is no <head>", () => {
    expect(injectShimTag("<body>x</body>")).toBe(
      '<script src="/_helix/fetch-shim.js"></script><body>x</body>',
    );
  });
});

const SHIMMED = "apps/shimmed/1/";
const PLAIN = "apps/plain/1/";
const HTML = "<!doctype html><html><head></head><body>hi</body></html>";

let app: FastifyInstance;
beforeAll(async () => {
  const blob = new FakeBlobReader();
  blob.set(`${SHIMMED}index.html`, {
    body: HTML,
    contentType: "text/html; charset=utf-8",
    etag: '"h1"',
  });
  blob.set(`${PLAIN}index.html`, {
    body: HTML,
    contentType: "text/html; charset=utf-8",
    etag: '"h2"',
  });
  const registry = new FakeRegistry([
    registryEntry({
      appId: "a1",
      slug: "shimmed",
      blobPrefix: SHIMMED,
      fetch: {
        shim: true,
        connections: new Map([["https://api.github.com", null]]),
        requestsPerDay: null,
      },
    }),
    registryEntry({ appId: "a2", slug: "plain", blobPrefix: PLAIN }),
  ]);
  app = buildApp({ config: testEdgeConfig({ allowUnauthenticated: true }), registry, blob });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe("/_helix/fetch-shim.js", () => {
  it("serves the per-app shim on an app host", async () => {
    const res = await app.inject({
      url: "/_helix/fetch-shim.js",
      headers: { host: "shimmed.local.helix.azxlabs.io" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/javascript");
    expect(res.body).toContain("https://api.github.com"); // this app's proxied origin
    expect(res.body).toContain("XMLHttpRequest.prototype.open");
  });

  it("404s on a platform host", async () => {
    const res = await app.inject({
      url: "/_helix/fetch-shim.js",
      headers: { host: "localhost:8080" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("HTML injection", () => {
  it("injects the shim tag into an opted-in app's HTML, without an etag", async () => {
    const res = await app.inject({ url: "/", headers: { host: "shimmed.local.helix.azxlabs.io" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<script src="/_helix/fetch-shim.js"></script>');
    expect(res.headers.etag).toBeUndefined(); // injected bytes ≠ blob etag
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("does not inject for an app that did not opt in (and keeps its etag)", async () => {
    const res = await app.inject({ url: "/", headers: { host: "plain.local.helix.azxlabs.io" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("/_helix/fetch-shim.js");
    expect(res.headers.etag).toBe('"h2"');
  });
});
