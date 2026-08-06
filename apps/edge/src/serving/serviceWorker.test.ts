import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { testEdgeConfig } from "../test/config.js";
import { FakeBlobReader, FakeRegistry, registryEntry } from "../test/fakes.js";
import { buildRegistrationSnippet, buildServiceWorkerScript } from "./serviceWorker.js";

/**
 * The offline capability (ADR-0035). The adversarial half of this lives here
 * rather than in `auth/adversarial.test.ts` because every assertion is about the
 * *serving* surface — but it is the same class of test: the platform-wide
 * service-worker ban exists to keep a worker away from the handoff token, and
 * these pin the exceptions that lifting it introduces.
 */

const OFFLINE = "apps/offline/1/";
const PLAIN = "apps/plain/1/";
const GONE = "apps/gone/1/";
const HTML = "<!doctype html><html><head></head><body>hi</body></html>";
const SHELL = "<!doctype html><html><head></head><body>shell</body></html>";

const H = (slug: string) => ({ host: `${slug}.local.helix.azxlabs.io` });

let app: FastifyInstance;
beforeAll(async () => {
  const blob = new FakeBlobReader();
  // An offline app is served from its scope, so its bundle nests under it and
  // has no root index.html — exactly the layout the SPA fallback must handle.
  blob.set(`${OFFLINE}app/index.html`, {
    body: SHELL,
    contentType: "text/html; charset=utf-8",
    etag: '"s1"',
  });
  blob.set(`${OFFLINE}app/main.js`, { body: "console.log(1)", contentType: "text/javascript" });
  blob.set(`${PLAIN}index.html`, {
    body: HTML,
    contentType: "text/html; charset=utf-8",
    etag: '"h2"',
  });

  const registry = new FakeRegistry([
    registryEntry({
      appId: "a1",
      slug: "offline",
      blobPrefix: OFFLINE,
      offline: { scope: "/app/" },
    }),
    registryEntry({ appId: "a2", slug: "plain", blobPrefix: PLAIN }),
    registryEntry({
      appId: "a3",
      slug: "gone",
      blobPrefix: GONE,
      archived: true,
      offline: { scope: "/app/" },
    }),
  ]);
  app = buildApp({ config: testEdgeConfig({ allowUnauthenticated: true }), registry, blob });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe("buildServiceWorkerScript", () => {
  const js = buildServiceWorkerScript({ scope: "/app/", cacheVersion: "apps/x/7/" });

  it("bakes in the scope and versions the cache by blob prefix", () => {
    // Version-keyed cache is what preserves the ADR-0018 pointer flip: a
    // promote changes these bytes, so the browser installs a new worker and
    // activate drops the stale cache.
    expect(js).toContain('"/app/"');
    expect(js).toContain('"helix:apps/x/7/"');
  });

  it("refuses to handle the platform namespaces", () => {
    expect(js).toContain('"/_auth/"');
    expect(js).toContain('"/_api/"');
    expect(js).toContain('"/_helix/"');
  });

  it("is network-first for navigations and cache-first otherwise", () => {
    expect(js).toContain('request.mode === "navigate"');
    expect(js).toContain("caches.match(request)");
  });

  it("answers helix:status so apps never depend on the cache-name format", () => {
    expect(js).toContain('"helix:status"');
    expect(js).toContain('"helix:precache"');
  });
});

describe("buildRegistrationSnippet", () => {
  it("registers at the declared scope, bypassing the HTTP cache for updates", () => {
    const js = buildRegistrationSnippet("/app/");
    expect(js).toContain('"/_helix/sw.js"');
    expect(js).toContain("scope: SCOPE");
    expect(js).toContain('updateViaCache: "none"');
  });

  it("hands the worker what the first visit already loaded", () => {
    // Without this the registering page's own requests bypass the worker and
    // offline boot needs a SECOND visit.
    expect(buildRegistrationSnippet("/app/")).toContain('getEntriesByType("resource")');
  });
});

describe("GET /_helix/sw.js", () => {
  it("serves the worker for a granted app, scoped and under the app CSP", async () => {
    const res = await app.inject({ url: "/_helix/sw.js", headers: H("offline") });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/javascript");
    // The one route on the platform that widens worker scope.
    expect(res.headers["service-worker-allowed"]).toBe("/app/");
    // For a worker the CSP on the SCRIPT governs the worker's own context —
    // served bare, its fetch() would escape `connect-src 'self'`.
    expect(res.headers["content-security-policy"]).toContain("connect-src 'self'");
    // Always revalidated, so a withdrawn grant converges on the next check.
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.body).toContain("helix:apps/offline/1/");
  });

  it("serves a self-unregistering tombstone — never a 404 — when there is no grant", async () => {
    // A 404 is not reliable: browsers differ on whether one during an update
    // check unregisters the worker or merely fails the update.
    const res = await app.inject({ url: "/_helix/sw.js", headers: H("plain") });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("self.registration.unregister()");
    expect(res.headers["service-worker-allowed"]).toBeUndefined();
  });

  it("tombstones an archived app", async () => {
    const res = await app.inject({ url: "/_helix/sw.js", headers: H("gone") });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("self.registration.unregister()");
    expect(res.headers["service-worker-allowed"]).toBeUndefined();
  });

  it("tombstones an unknown slug rather than leaking its absence", async () => {
    const res = await app.inject({ url: "/_helix/sw.js", headers: H("nope") });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("self.registration.unregister()");
  });

  it("404s on a platform host", async () => {
    const res = await app.inject({ url: "/_helix/sw.js", headers: { host: "localhost:8080" } });
    expect(res.statusCode).toBe(404);
  });
});

describe("the ban survives, and Service-Worker-Allowed never leaks", () => {
  it("still 403s a registration fetch for an app asset", async () => {
    const res = await app.inject({
      url: "/app/main.js",
      headers: { ...H("offline"), "service-worker": "script" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("403s a registration fetch aimed at the fetch shim", async () => {
    // The ban lives in the asset handler, so a reserved *script* route had to
    // state its own refusal — otherwise an app could register the shim itself.
    const res = await app.inject({
      url: "/_helix/fetch-shim.js",
      headers: { ...H("offline"), "service-worker": "script" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("403s a registration fetch aimed at the registration snippet", async () => {
    const res = await app.inject({
      url: "/_helix/sw-register.js",
      headers: { ...H("offline"), "service-worker": "script" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("emits Service-Worker-Allowed on the worker route and nowhere else", async () => {
    for (const url of ["/app/", "/app/index.html", "/app/main.js", "/_helix/sw-register.js"]) {
      const res = await app.inject({ url, headers: { ...H("offline"), accept: "text/html" } });
      expect(res.headers["service-worker-allowed"], url).toBeUndefined();
    }
  });
});

describe("registration injection", () => {
  it("injects the registration into a granted app's HTML, without an etag", async () => {
    // A navigation to the scope root: `normalizeRequestPath` drops the trailing
    // slash, so `/app/` resolves through the HTML fallback below — which is why
    // the Accept header (which every real navigation sends) matters here.
    const res = await app.inject({
      url: "/app/",
      headers: { ...H("offline"), accept: "text/html" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<script src="/_helix/sw-register.js"></script>');
    expect(res.headers.etag).toBeUndefined(); // injected bytes ≠ blob etag
  });

  it("does not inject for an app without the grant (and keeps its etag)", async () => {
    const res = await app.inject({ url: "/", headers: H("plain") });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("/_helix/sw-register.js");
    expect(res.headers.etag).toBe('"h2"');
  });

  it("serves the snippet only for a granted app", async () => {
    const ok = await app.inject({ url: "/_helix/sw-register.js", headers: H("offline") });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('"/app/"');
    const no = await app.inject({ url: "/_helix/sw-register.js", headers: H("plain") });
    expect(no.statusCode).toBe(404);
  });
});

describe("scope-aware SPA fallback", () => {
  it("falls back to the scope's shell for a deep link inside the scope", async () => {
    // The bundle has no ROOT index.html — falling back there would 404 every
    // client-side route of an app served from a prefix.
    const res = await app.inject({
      url: "/app/review/123",
      headers: { ...H("offline"), accept: "text/html" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("shell");
  });

  it("does not rescue a deep link outside the scope", async () => {
    const res = await app.inject({
      url: "/elsewhere/x",
      headers: { ...H("offline"), accept: "text/html" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("leaves a non-offline app's root fallback alone", async () => {
    const res = await app.inject({
      url: "/deep/link",
      headers: { ...H("plain"), accept: "text/html" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("hi");
  });

  it("still hard-404s an asset miss inside the scope", async () => {
    const res = await app.inject({ url: "/app/missing.js", headers: H("offline") });
    expect(res.statusCode).toBe(404);
  });
});
