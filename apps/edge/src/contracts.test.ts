import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RouteOptions } from "fastify";
import { appContracts } from "@azx-pbc/shared/contracts";
import { buildJobsEdge, type JobsHarness } from "./test/jobsGateway.js";

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
const PENDING: string[] = [
  "GET /_api/me",
  "GET /_api/connections/:ref/start",
  "POST /_api/connections/attempt/cancel",
  "GET /_api/connections/:ref/status",
  "POST /_api/llm/chat",
  "POST /_api/openai/v1/chat/completions",
  "GET /_api/openai/v1/models",
  "PUT /_api/data/user/:key",
  "GET /_api/data/user/:key",
  "DELETE /_api/data/user/:key",
  "GET /_api/data/user",
  "POST /_api/data/collections/:name",
  "GET /_api/data/shared",
  "GET /_api/data/shared/:key",
  "PUT /_api/data/shared/:key",
  "GET /_api/fetch/*",
  "POST /_api/fetch/*",
  "PUT /_api/fetch/*",
  "PATCH /_api/fetch/*",
  "DELETE /_api/fetch/*",
  "OPTIONS /_api/fetch/*",
  "POST /_api/jobs/:server/types/:type",
  "GET /_api/jobs/:server/:jobId",
  "GET /_api/jobs/:server/:jobId/result",
  "DELETE /_api/jobs/:server/:jobId",
];

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
