import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { App } from "@azx-pbc/shared";
import { renderWithProviders } from "./render";
import { AuthProvider } from "../auth/AuthProvider";
import { DevModeTab } from "../pages/tabs/DevModeTab";
import { setToken, clearToken } from "../auth/tokenStore";

/**
 * The dev gateway is an opt-in deployment (`deployDevGateway` in the Bicep), so
 * `devApiBase` can legitimately be absent from GET /api/v1/config. The tab must
 * say so rather than print the host it would have had — an unreachable base is a
 * request-time failure with no explanation attached.
 */

const APP: App = {
  id: crypto.randomUUID(),
  slug: "cost-explorer",
  displayName: "Cost Explorer",
  visibility: { mode: "internal" },
  currentVersionId: crypto.randomUUID(),
  archivedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  url: "https://cost-explorer.apps.example.com",
};

const AUTH_CONFIG = {
  issuer: "https://idp.test",
  cliClientId: "azx-cli",
  webClientId: "azx-portal-web",
};

function stubApi(config: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown) =>
        Promise.resolve({ ok: true, status: 200, json: async () => body });
      if (url.endsWith("/api/v1/auth/config")) return json(AUTH_CONFIG);
      if (url.endsWith("/api/v1/config")) return json(config);
      if (url.endsWith("/api/v1/me")) {
        return json({
          sub: "alice@azx.dev",
          via: "oidc",
          isAdmin: false,
          canSearchDirectory: true,
        });
      }
      if (url.includes("/dev-tokens")) return json([]);
      return new Promise(() => {});
    }),
  );
}

function render() {
  renderWithProviders(
    <AuthProvider>
      <DevModeTab app={APP} />
    </AuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
});

describe("DevModeTab", () => {
  it("shows the dev-gateway base with the app slug in the path", async () => {
    setToken("t");
    stubApi({
      appPublicBase: "https://apps.example.com",
      devApiBase: "https://dev-api.apps.example.com",
    });
    render();
    expect(await screen.findByText("https://dev-api.apps.example.com/cost-explorer")).toBeDefined();
  });

  it("says dev mode isn't enabled when the deployment has no dev gateway", async () => {
    setToken("t");
    stubApi({ appPublicBase: "https://apps.example.com" });
    render();
    expect(await screen.findByText(/dev gateway isn't enabled on this deployment/i)).toBeDefined();
    // Critically: no invented host anywhere on the page.
    expect(screen.queryByText(/dev-api\./)).toBeNull();
  });
});
