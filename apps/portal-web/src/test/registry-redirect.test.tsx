import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { PortalMeResponse } from "@azx-pbc/shared";
import { renderWithProviders } from "./render";
import { App } from "../App";
import { setToken, clearToken } from "../auth/tokenStore";

/**
 * `/admin/registry` was an admin-only table rendering the same
 * `GET /api/v1/apps` the apps page shows — two names for one query. It is now
 * that page's `all` scope, open to any signed-in principal, so the old path
 * redirects rather than 404ing anyone's bookmark.
 *
 * Rendered through the real `App` route table: the point is the routing, and a
 * hand-copied `<Routes>` here would only ever test the copy.
 */
const ME: PortalMeResponse = {
  sub: "bob@azx.dev",
  via: "oidc",
  name: "Bob Builder",
  email: "bob@azx.dev",
  // Deliberately not an admin — that is the behaviour change being pinned.
  isAdmin: false,
};

const OWNED = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "someone-elses",
  displayName: "Someone Else's App",
  visibility: { mode: "internal" },
  currentVersionId: null,
  archivedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  url: "https://someone-elses.apps.example.com",
  ownerId: "alice@azx.dev",
  ownerName: "Alice Anders",
  ownerEmail: "alice@azx.dev",
  versionCount: 0,
  lastDeployAt: null,
  liveVersionNumber: null,
  latestPreviewNumber: null,
};

function ok(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}

/** Records every apps-list URL requested, so the scope actually sent is assertable. */
function stubApi(): string[] {
  const appsCalls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/me")) return ok(ME);
      if (url.includes("/api/v1/auth/config")) {
        return ok({ issuer: "https://idp.test", cliClientId: "azx-cli" });
      }
      if (/\/api\/v1\/apps(\?|$)/.test(url)) {
        appsCalls.push(url);
        // Only the `all` scope has anything in it: Bob owns nothing here.
        return ok(url.includes("scope=all") ? [OWNED] : []);
      }
      if (url.includes("/api/v1/config")) return ok({ appPublicBase: "https://apps.example.com" });
      if (url.includes("/api/v1/gateway/usage")) {
        return ok({
          range: "30d",
          series: [],
          byApp: [],
          totals: { tokensMTD: 0, requestsMTD: 0, costMTD: 0, activeUsers: 0 },
          capabilityMix: [],
        });
      }
      return new Promise(() => {}); // anything else: pending, as in the other suites
    }),
  );
  return appsCalls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
});

describe("/admin/registry", () => {
  it("redirects a non-admin to the apps page at scope=all", async () => {
    setToken("test-token");
    const appsCalls = stubApi();

    renderWithProviders(<App />, { route: "/admin/registry" });

    // The full registry, reached without the admin gate that used to guard it.
    expect(await screen.findByText("Someone Else's App")).toBeDefined();
    expect(await screen.findByText("Alice Anders")).toBeDefined();
    expect(appsCalls.some((u) => u.includes("scope=all"))).toBe(true);
  });
});
