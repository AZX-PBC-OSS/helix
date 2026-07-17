import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import type { SecretMetadata } from "@azx-pbc/shared";
import { renderWithProviders } from "./render";
import { SecretsPage } from "../pages/admin/SecretsPage";
import { AuthProvider } from "../auth/AuthProvider";
import { setToken, clearToken } from "../auth/tokenStore";

/** Route GET /api/v1/secrets to a canned list; everything else stays pending. */
function stubSecrets(list: SecretMetadata[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (typeof url === "string" && url.endsWith("/api/v1/secrets")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => list });
      }
      return new Promise(() => {}); // auth config / me — pending forever
    }),
  );
}

const SECRET: SecretMetadata = {
  id: "sec-1",
  name: "stripe-live",
  scope: "global",
  injection: { kind: "header-bearer" },
  createdBy: "alice",
  createdAt: new Date().toISOString(),
  rotatedAt: null,
  lastUsedAt: null,
  boundApps: ["acme-dash"],
};

function render() {
  return renderWithProviders(
    <AuthProvider>
      <SecretsPage />
    </AuthProvider>,
    { route: "/admin/secrets" },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
});

describe("SecretsPage", () => {
  // Sign-in / platform-admin gating now lives in the route guards (RequireAuth /
  // RequireAdmin), tested in guards.test.tsx — the page itself just renders data.

  it("lists global secrets (with bound apps) when authenticated", async () => {
    stubSecrets([SECRET]);
    setToken("test-token");
    render();
    expect(await screen.findByText("stripe-live")).toBeDefined();
    // The granted app is shown as a bound-app chip.
    expect(screen.getByText("acme-dash")).toBeDefined();
    // The create form is present.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create secret" })).toBeDefined(),
    );
  });

  it("shows a platform vendor secret without a grant control", async () => {
    const platform: SecretMetadata = {
      ...SECRET,
      id: "sec-2",
      name: "anthropic",
      scope: "platform",
      injection: { kind: "header", name: "x-api-key", template: "{}" },
      boundApps: [],
    };
    stubSecrets([platform]);
    setToken("test-token");
    render();
    expect(await screen.findByText("anthropic")).toBeDefined();
    expect(screen.getByText("Platform vendor keys")).toBeDefined();
    // Platform secrets are not grantable — no Grant button is rendered.
    expect(screen.queryByRole("button", { name: "Grant" })).toBeNull();
  });
});
