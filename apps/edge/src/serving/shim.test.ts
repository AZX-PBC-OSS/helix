import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { testEdgeConfig } from "../test/config.js";
import { FakeBlobReader, FakeRegistry, registryEntry } from "../test/fakes.js";
import { buildShimScript, injectHeadScripts, jsonInline } from "./shim.js";

/**
 * The transparent fetch shim (fetch-proxy design §3.2): the per-app script
 * (covering fetch + XMLHttpRequest), **inlined** into HTML for opt-in apps only.
 *
 * Inline rather than `<script src="/_helix/fetch-shim.js">` because `/_helix/*`
 * is deliberately unprecachable, so the tag was unloadable on exactly the offline
 * cold boot the offline capability exists for (ADR-0035).
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
    expect(js).toContain("//# sourceURL=helix/fetch-shim.js"); // still named in devtools
  });

  it("cannot be broken out of by a manifest-derived origin", () => {
    // The origins come from the app's manifest, and inlining puts them inside a
    // <script> block — so a value carrying `</script>` would close the platform
    // script and inject app-controlled markup. `jsonInline` escapes every `<`.
    const hostile = "https://x</script><script>alert(1)</script>";
    const js = buildShimScript([hostile]);
    expect(js).not.toContain("</script");
    expect(js).not.toContain("<script");
    expect(js).toContain("\\u003c/script>"); // present, but as an escape
    // And it still round-trips to the original string at runtime.
    expect(JSON.parse(jsonInline(hostile)) as string).toBe(hostile);
    // The assembled document therefore holds exactly one script block.
    const out = injectHeadScripts("<head></head>", [js]);
    expect(out.match(/<script/g)).toHaveLength(1);
  });
});

describe("injectHeadScripts", () => {
  const JS = "void 0;";

  it("inlines the script right after <head>", () => {
    const out = injectHeadScripts(
      "<!doctype html><html><head><title>x</title></head><body></body></html>",
      [JS],
    );
    expect(out).toContain("<head><script>void 0;</script><title>");
  });

  it("composes several scripts in order", () => {
    const out = injectHeadScripts("<head></head>", ["a();", "b();"]);
    expect(out).toContain("<head><script>a();</script><script>b();</script>");
  });

  it("leaves the document alone when there is nothing to inject", () => {
    expect(injectHeadScripts("<head></head>", [])).toBe("<head></head>");
  });

  it("prepends when there is no <head>", () => {
    expect(injectHeadScripts("<body>x</body>", [JS])).toBe(
      "<script>void 0;</script><body>x</body>",
    );
  });

  it("goes after a leading doctype, so the document does not fall into quirks mode", () => {
    // A <script> before the doctype takes the parser out of "initial" insertion
    // mode; the doctype token is then ignored and the page renders in quirks
    // mode. Single-file apps with a doctype and no <head> are common enough
    // that this is the realistic shape, not an edge case.
    const out = injectHeadScripts('<!doctype html>\n<meta charset="utf-8" />\n<body>x</body>', [
      JS,
    ]);
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(out).toContain("<!doctype html><script>void 0;</script>");
  });

  it("tolerates leading whitespace and an uppercase DOCTYPE", () => {
    const out = injectHeadScripts("  <!DOCTYPE HTML>\n<body>x</body>", [JS]);
    expect(out).toContain("<!DOCTYPE HTML><script>void 0;</script>");
  });

  it("refuses a script body that could terminate the block", () => {
    // Unreachable given `jsonInline`, and it should stay that way — a silent
    // escape here would corrupt the app's document.
    expect(() => injectHeadScripts("<head></head>", ["var x = '</script>';"])).toThrow(
      /terminating sequence/,
    );
    expect(() => injectHeadScripts("<head></head>", ["var x = '<!--';"])).toThrow(
      /terminating sequence/,
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
  // The route is gone: the shim is inlined, so nothing fetches it. `/_helix/*`
  // stays reserved, so the path 404s rather than falling through to a blob.
  it("404s on an app host", async () => {
    const res = await app.inject({
      url: "/_helix/fetch-shim.js",
      headers: { host: "shimmed.local.helix.azxlabs.io" },
    });
    expect(res.statusCode).toBe(404);
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
  it("inlines the shim into an opted-in app's HTML, without an etag", async () => {
    const res = await app.inject({ url: "/", headers: { host: "shimmed.local.helix.azxlabs.io" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<head><script>(function () {");
    expect(res.body).toContain("XMLHttpRequest.prototype.open");
    expect(res.body).toContain("https://api.github.com"); // this app's proxied origin
    // The whole point: nothing to fetch, so an offline cold boot still patches.
    expect(res.body).not.toContain("/_helix/");
    expect(res.headers.etag).toBeUndefined(); // injected bytes ≠ blob etag
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("does not inject for an app that did not opt in (and keeps its etag)", async () => {
    const res = await app.inject({ url: "/", headers: { host: "plain.local.helix.azxlabs.io" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(HTML);
    expect(res.headers.etag).toBe('"h2"');
  });
});
