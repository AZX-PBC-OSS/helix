import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import type { SecretMetadata } from "@helix/shared";
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
  it("prompts sign-in when logged out", () => {
    stubSecrets([]);
    render();
    expect(screen.getByText(/Sign in as a platform admin to manage global secrets/)).toBeDefined();
  });

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
});
