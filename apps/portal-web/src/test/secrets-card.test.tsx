import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { App, SecretMetadata } from "@azx-pbc/shared";
import { renderWithProviders } from "./render";
import { SecretsCard } from "../pages/tabs/SecretsCard";
import { AuthProvider } from "../auth/AuthProvider";
import { clearToken, setToken } from "../auth/tokenStore";

/**
 * The app-scoped half of the secrets UI. Covers the two states the admin page
 * already had and this card did not: a load failure (which used to render a
 * silently blank panel — `data` is undefined, so both the list and the empty
 * state are falsy) and a row whose stored recipe is unreadable.
 */

const SLUG = "demo";

function makeApp(): App {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slug: SLUG,
    displayName: "Demo",
    visibility: { mode: "private" },
    currentVersionId: null,
    archivedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const SECRET: SecretMetadata = {
  id: "sec-1",
  name: "github-pat",
  scope: "app",
  env: "prod",
  injection: { kind: "header-bearer" },
  createdBy: "alice",
  createdAt: new Date().toISOString(),
  rotatedAt: null,
  lastUsedAt: null,
  boundApps: [],
};

/** Answer the app-secrets GET; leave auth-config/me pending like the sibling suites. */
function stubSecrets(reply: { ok: boolean; status: number; list?: unknown }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (typeof url === "string" && url.includes("/secrets")) {
        return Promise.resolve({
          ok: reply.ok,
          status: reply.status,
          json: async () => reply.list ?? { error: { code: "internal", message: "boom" } },
        });
      }
      return new Promise(() => {});
    }),
  );
}

function render() {
  return renderWithProviders(
    <AuthProvider>
      <SecretsCard app={makeApp()} />
    </AuthProvider>,
    { route: `/apps/${SLUG}` },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
});

describe("SecretsCard", () => {
  // The bug: without an isError branch the card rendered neither rows nor the
  // empty state, so a failure was indistinguishable from "no secrets yet".
  it("reports a load failure instead of rendering a blank panel", async () => {
    stubSecrets({ ok: false, status: 500 });
    setToken("test-token");
    render();
    expect(await screen.findByText(/Couldn't load secrets/)).toBeDefined();
    expect(screen.queryByText("No secrets yet.")).toBeNull();
  });

  it("badges an unreadable recipe, disables Rotate, and keeps Delete", async () => {
    stubSecrets({
      ok: true,
      status: 200,
      list: [{ ...SECRET, id: "sec-2", name: "broken", injection: null }],
    });
    setToken("test-token");
    render();
    expect(await screen.findByText("broken")).toBeDefined();
    expect(screen.getByText("recipe unreadable — recreate this secret")).toBeDefined();
    expect((screen.getByRole("button", { name: "Rotate" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("leaves Rotate available for a readable recipe", async () => {
    stubSecrets({ ok: true, status: 200, list: [SECRET] });
    setToken("test-token");
    render();
    expect(await screen.findByText("github-pat")).toBeDefined();
    expect((screen.getByRole("button", { name: "Rotate" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});
