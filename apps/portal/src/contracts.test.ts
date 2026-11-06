import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RouteOptions } from "fastify";
import { portalContracts } from "@azx-pbc/shared/contracts";
import { buildTestApp, type TestApp } from "./test/harness.js";

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

/**
 * Published routes not yet converted to contracts. This list only shrinks; a
 * new route goes straight into a contract.
 */
const PENDING: string[] = [
  "GET /api/v1/slug-check",
  "POST /api/v1/apps",
  "GET /api/v1/apps",
  "GET /api/v1/apps/:slug",
  "PATCH /api/v1/apps/:slug",
  "POST /api/v1/apps/:slug/archive",
  "POST /api/v1/apps/:slug/unarchive",
  "GET /api/v1/apps/:slug/manifest",
  "PUT /api/v1/apps/:slug/manifest",
  "POST /api/v1/apps/:slug/access/origin",
  "POST /api/v1/apps/:slug/visibility",
  "POST /api/v1/apps/:slug/access/password",
  "POST /api/v1/apps/:slug/access/password/rotate",
  "GET /api/v1/apps/:slug/access/password",
  "DELETE /api/v1/apps/:slug/access/password",
  "GET /api/v1/apps/:slug/secrets",
  "POST /api/v1/apps/:slug/secrets",
  "POST /api/v1/apps/:slug/secrets/:name/rotate",
  "DELETE /api/v1/apps/:slug/secrets/:name",
  "GET /api/v1/secrets",
  "POST /api/v1/secrets",
  "POST /api/v1/secrets/:id/rotate",
  "DELETE /api/v1/secrets/:id",
  "POST /api/v1/secrets/:id/grants",
  "DELETE /api/v1/secrets/:id/grants/:appSlug",
  "GET /api/v1/providers",
  "POST /api/v1/providers",
  "GET /api/v1/providers/:id",
  "GET /api/v1/providers/:id/export",
  "PUT /api/v1/providers/:id",
  "POST /api/v1/providers/import/preview",
  "POST /api/v1/providers/import",
  "GET /api/v1/providers/:id/impact",
  "DELETE /api/v1/providers/:id",
  "GET /api/v1/apps/:slug/dev-tokens",
  "POST /api/v1/apps/:slug/dev-tokens",
  "POST /api/v1/apps/:slug/dev-tokens/:id/rotate",
  "DELETE /api/v1/apps/:slug/dev-tokens/:id",
  "GET /api/v1/approvals",
  "POST /api/v1/approvals/:id/approve",
  "POST /api/v1/approvals/:id/deny",
  "POST /api/v1/approvals/:id/needs_changes",
  "POST /api/v1/approvals/:id/withdraw",
  "GET /api/v1/csp/violations",
  "POST /api/v1/apps/:slug/versions",
  "GET /api/v1/apps/:slug/versions",
  "POST /api/v1/apps/:slug/versions/:number/promote",
  "POST /api/v1/apps/:slug/rollback",
  "GET /api/v1/apps/:slug/repo-binding",
  "PUT /api/v1/apps/:slug/repo-binding",
  "DELETE /api/v1/apps/:slug/repo-binding",
  "POST /api/v1/apps/:slug/ci/versions",
  "GET /api/v1/apps/:slug/usage",
  "GET /api/v1/apps/:slug/audit",
  "GET /api/v1/gateway/audit",
  "GET /api/v1/gateway/usage",
  "GET /api/v1/apps/:slug/visitors",
  "GET /api/v1/sessions",
  "POST /api/v1/sessions/revoke",
  "GET /api/v1/apps/:slug/collections",
  "GET /api/v1/apps/:slug/collections/:name",
  "GET /api/v1/apps/:slug/collections/:name/export",
  "DELETE /api/v1/apps/:slug/collections/:name/items/:id",
  "GET /api/v1/auth/config",
  "GET /api/v1/me",
  "GET /api/v1/config",
  "GET /api/v1/capabilities",
  "GET /api/v1/skill",
  "GET /api/v1/directory/groups",
  "GET /api/v1/apps/:slug/visibility/groups",
  "GET /api/v1/directory/my-groups",
  "GET /api/v1/connections/mine",
  "DELETE /api/v1/connections/mine/:id",
];

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
    const uncovered = [...registered].filter(
      (r) => !contracted.has(r) && !(r in UNPUBLISHED) && !PENDING.includes(r),
    );
    expect(uncovered, "add a contract in packages/shared/src/contracts/portal").toEqual([]);
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
