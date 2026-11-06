import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RouteOptions } from "fastify";
import { appContracts } from "@azx-pbc/shared/contracts";
import * as telemetry from "@azx-pbc/shared/telemetry";
import { buildJobsEdge, type JobsHarness } from "./test/jobsGateway.js";
import { assertConformance } from "./test/conformance.js";

afterEach(assertConformance);

/**
 * Routes the edge registers that are deliberately not in the published app API
 * (ADR-0054 decision 6), each with the reason.
 */
const UNPUBLISHED: Record<string, string> = {
  "GET /health": "platform health contract, shared by every service",
  "GET /start": "auth host: the OIDC sign-in redirect, a browser navigation",
  "GET /callback": "auth host: the OIDC callback, a browser navigation",
  "GET /connections/*": "auth host: proxied consent pages, browser navigations",
  "POST /connections/*": "auth host: proxied consent pages, browser navigations",
  "GET /_auth/login": "app host: the sign-in page, a browser navigation",
  "POST /_auth/login": "app host: the shared-password form post",
  "GET /_auth/complete": "app host: the sign-in handoff, a browser navigation",
  "POST /_auth/logout": "app host: sign-out form post, a browser navigation",
  "POST /_csp-report": "browser-generated CSP violation reports, not app-called",
  "GET /_helix/sw.js": "the platform service worker script",
  "GET /*": "static asset serving for the app's own files",
  "POST /internal/jobs/v1/fetch": "internal jobs→edge hop, signed by its own root",
};

/**
 * Published routes not yet converted to contracts. This list only shrinks; a
 * new route goes straight into a contract.
 */
const PENDING: string[] = [];

let h: JobsHarness;
const registered = new Set<string>();

beforeAll(async () => {
  h = buildJobsEdge({
    onRoute: (route: RouteOptions) => {
      for (const method of [route.method].flat()) {
        if (method !== "HEAD") registered.add(`${method} ${route.url}`);
      }
    },
  });
  await h.app.ready();
});

afterAll(async () => {
  await h.app.close();
});

describe("edge route coverage (ADR-0054)", () => {
  const contracted = new Set(appContracts.map((c) => `${c.method} ${c.path}`));

  it("every registered route has a contract or a reason to be unpublished", () => {
    const uncovered = [...registered].filter(
      (r) => !contracted.has(r) && !(r in UNPUBLISHED) && !PENDING.includes(r),
    );
    expect(uncovered, "add a contract in packages/shared/src/contracts/app").toEqual([]);
  });

  it("every contract matches a registered route", () => {
    const missing = [...contracted].filter((c) => !registered.has(c));
    expect(missing).toEqual([]);
  });

  it("the exclusion lists name only routes that exist and have no contract", () => {
    for (const r of [...Object.keys(UNPUBLISHED), ...PENDING]) {
      expect(registered.has(r), r).toBe(true);
      expect(contracted.has(r), r).toBe(false);
    }
  });
});

/**
 * `ROUTE_*` telemetry constants that name an `/_api` path but are not a route,
 * each with the reason. Every other one must equal a contract's path, so the
 * `http.route` a span carries is the path the contract documents.
 */
const ROUTE_GROUPS: Record<string, string> = {
  ROUTE_DATA: "one span route for all eight app-data routes; the verb is its own attribute",
};

describe("ROUTE_* telemetry constants (ADR-0054)", () => {
  it("name contracted paths", () => {
    const paths = new Set(appContracts.map((c) => c.path));
    const named: [string, string][] = [];
    for (const [name, value] of Object.entries(telemetry)) {
      if (name.startsWith("ROUTE_") && typeof value === "string" && value.startsWith("/_api/")) {
        named.push([name, value]);
      }
    }
    expect(named.length).toBeGreaterThan(0);
    for (const [name, path] of named) {
      if (name in ROUTE_GROUPS) continue;
      expect(paths.has(path), `${name} = ${path}`).toBe(true);
    }
  });

  it("list only route groups that exist", () => {
    for (const name of Object.keys(ROUTE_GROUPS)) {
      expect(telemetry, name).toHaveProperty(name);
    }
  });
});
