import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RouteOptions } from "fastify";
import { portalContracts } from "@azx-pbc/shared/contracts";
import { authHeader, buildTestApp, type TestApp } from "./test/harness.js";

/**
 * Routes the portal registers that are deliberately not in the published
 * portal API (ADR-0054 decision 6), each with the reason.
 */
const UNPUBLISHED: Record<string, string> = {
  "GET /health": "platform health contract, shared by every service",
  "GET /": "the stopgap dashboard, served only without a built SPA",
  "GET /connections/consent/start": "a browser page in the consent popup, not an API",
  "GET /connections/callback": "the OAuth callback page, not an API",
  "POST /internal/connections/consult": "internal edge→portal hop, signed by internal JWT",
  "POST /internal/connections/cancel": "internal edge→portal hop, signed by internal JWT",
  "POST /internal/connections/status": "internal edge→portal hop, signed by internal JWT",
};

let t: TestApp;
const registered = new Set<string>();

beforeAll(async () => {
  t = buildTestApp({
    onRoute: (route: RouteOptions) => {
      for (const method of [route.method].flat()) {
        if (method !== "HEAD") registered.add(`${method} ${route.url}`);
      }
    },
  });
  await t.app.ready();
});

afterAll(async () => {
  await t.close();
});

describe("portal route coverage (ADR-0054)", () => {
  const contracted = new Set(portalContracts.map((c) => `${c.method} ${c.path}`));

  it("every registered route has a contract or a reason to be unpublished", () => {
    const uncovered = [...registered].filter((r) => !contracted.has(r) && !(r in UNPUBLISHED));
    expect(uncovered, "add a contract in packages/shared/src/contracts/portal").toEqual([]);
  });

  it("every contract matches a registered route", () => {
    const missing = [...contracted].filter((c) => !registered.has(c));
    expect(missing).toEqual([]);
  });

  it("the exclusion list names only routes that exist and have no contract", () => {
    for (const r of Object.keys(UNPUBLISHED)) {
      expect(registered.has(r), r).toBe(true);
      expect(contracted.has(r), r).toBe(false);
    }
  });
});

// The body parser refuses these before any handler runs. They go through a real
// contracted route so the harness checks them against the declared responses.
describe("body parser refusals on a contracted route", () => {
  it("answers 415 for an unsupported content type", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: { ...authHeader(), "content-type": "application/xml" },
      payload: "<app/>",
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe("validation_failed");
  });

  it("answers 413 for a JSON body over the parser limit", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: JSON.stringify({ slug: "x", displayName: "x".repeat(2 * 1024 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("bundle_invalid");
  });
});
