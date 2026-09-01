import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../test/harness.js";

/**
 * SPA serving mode (routes/spa.ts): static assets from the dist dir, deep-link
 * fallback to index.html, while /api/* and /health keep JSON semantics.
 */

const INDEX_HTML = "<!doctype html><html><body>azx-spa-index</body></html>";

let dist: string;
let t: TestApp;

beforeAll(async () => {
  dist = mkdtempSync(path.join(tmpdir(), "portal-web-dist-"));
  writeFileSync(path.join(dist, "index.html"), INDEX_HTML);
  mkdirSync(path.join(dist, "assets"));
  writeFileSync(path.join(dist, "assets", "app.js"), "console.log('spa')");

  t = buildTestApp({ spaDist: dist });
  await t.app.ready();
});

afterAll(async () => {
  await t.close();
  rmSync(dist, { recursive: true, force: true });
});

describe("portal serves the built SPA", () => {
  it("serves index.html at /", async () => {
    const res = await t.app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("azx-spa-index");
  });

  it("serves real static assets", async () => {
    const res = await t.app.inject({ method: "GET", url: "/assets/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("console.log('spa')");
  });

  it("falls back to index.html for SPA deep links", async () => {
    const res = await t.app.inject({ method: "GET", url: "/apps/some-app" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("azx-spa-index");
  });

  it("keeps the JSON envelope for unknown API routes", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("keeps the JSON envelope for non-GET deep paths", async () => {
    const res = await t.app.inject({ method: "POST", url: "/apps/some-app" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("health stays JSON", async () => {
    const res = await t.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", service: "helix-portal" });
  });
});
