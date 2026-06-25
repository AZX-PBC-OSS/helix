import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import type { PortalMeResponse } from "@helix/shared";
import { renderWithProviders } from "./render";
import { AuthProvider } from "../auth/AuthProvider";
import { RequireAdmin, RequireAuth } from "../auth/guards";
import { Shell } from "../components/Shell";
import { setToken, clearToken } from "../auth/tokenStore";

/**
 * Route-guard behaviour: the SPA mirrors the server's posture — a sign-in gate
 * over the whole app, and a platform-admin gate over admin routes.
 */

const AUTH_CONFIG = {
  issuer: "https://idp.test",
  cliClientId: "azx-cli",
  webClientId: "azx-portal-web",
};

/** Stub fetch: a canned /me (or 401), auth config, and an empty registry. */
function stubApi(me: PortalMeResponse | { status: 401 }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v1/me")) {
        if ("status" in me) {
          return Promise.resolve({
            ok: false,
            status: 401,
            json: async () => ({ error: { code: "unauthorized", message: "nope" } }),
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => me });
      }
      if (url.endsWith("/api/v1/auth/config")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => AUTH_CONFIG });
      }
      if (url.endsWith("/api/v1/apps")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      }
      return new Promise(() => {}); // health etc.: pending
    }),
  );
}

const ADMIN: PortalMeResponse = { sub: "alice@azx.dev", via: "oidc", isAdmin: true };
const NON_ADMIN: PortalMeResponse = { sub: "bob@azx.dev", via: "oidc", isAdmin: false };

afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
});

describe("RequireAuth", () => {
  it("shows the sign-in screen and hides content when logged out", () => {
    stubApi({ status: 401 });
    renderWithProviders(
      <AuthProvider>
        <RequireAuth>
          <div>protected content</div>
        </RequireAuth>
      </AuthProvider>,
    );
    expect(screen.getByText("Sign in to Helix")).toBeDefined();
    expect(screen.queryByText("protected content")).toBeNull();
  });

  it("renders the app once a token is present", async () => {
    stubApi(NON_ADMIN);
    setToken("test-token");
    renderWithProviders(
      <AuthProvider>
        <RequireAuth>
          <div>protected content</div>
        </RequireAuth>
      </AuthProvider>,
    );
    expect(await screen.findByText("protected content")).toBeDefined();
  });

  it("falls back to the sign-in screen when the token is rejected (401)", async () => {
    stubApi({ status: 401 });
    setToken("stale-token");
    renderWithProviders(
      <AuthProvider>
        <RequireAuth>
          <div>protected content</div>
        </RequireAuth>
      </AuthProvider>,
    );
    expect(await screen.findByText("Sign in to Helix")).toBeDefined();
    expect(screen.queryByText("protected content")).toBeNull();
  });
});

describe("RequireAdmin", () => {
  it("blocks a signed-in non-admin", async () => {
    stubApi(NON_ADMIN);
    setToken("test-token");
    renderWithProviders(
      <AuthProvider>
        <RequireAdmin>
          <div>admin content</div>
        </RequireAdmin>
      </AuthProvider>,
    );
    expect(await screen.findByText(/requires the platform-admin role/)).toBeDefined();
    expect(screen.queryByText("admin content")).toBeNull();
  });

  it("admits a platform admin", async () => {
    stubApi(ADMIN);
    setToken("test-token");
    renderWithProviders(
      <AuthProvider>
        <RequireAdmin>
          <div>admin content</div>
        </RequireAdmin>
      </AuthProvider>,
    );
    expect(await screen.findByText("admin content")).toBeDefined();
  });
});

describe("Shell admin nav", () => {
  function renderShell() {
    return renderWithProviders(
      <AuthProvider>
        <Shell onDeploy={() => {}}>content</Shell>
      </AuthProvider>,
    );
  }

  it("hides the admin nav for a non-admin", async () => {
    stubApi(NON_ADMIN);
    setToken("test-token");
    renderShell();
    // A workspace link is always present; admin links are not.
    expect(await screen.findByText("My Apps")).toBeDefined();
    await waitFor(() => expect(screen.queryByText("Approvals")).toBeNull());
  });

  it("shows the admin nav for a platform admin", async () => {
    stubApi(ADMIN);
    setToken("test-token");
    renderShell();
    expect(await screen.findByText("Approvals")).toBeDefined();
    expect(screen.getByText("Secrets")).toBeDefined();
  });
});
