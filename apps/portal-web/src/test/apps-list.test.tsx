import { describe, expect, it, vi, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { App } from "@azx-pbc/shared";
import { renderWithProviders } from "./render";
import { AppsListPage } from "../pages/AppsListPage";
import { AuthProvider } from "../auth/AuthProvider";
import { DeployProvider } from "../modals/DeployContext";

/**
 * These deliberately use a non-dev domain everywhere. The bug this guards is a
 * prebuilt bundle showing `*.local.helix.azxlabs.io:8080` in production, so a
 * test that asserted the dev default would pass on the broken code.
 */
const APPS_BASE = "https://apps.example.com";

function makeApp(slug: string, displayName: string, live: boolean, url?: string): App {
  return {
    id: crypto.randomUUID(),
    slug,
    displayName,
    visibility: { mode: "internal" },
    currentVersionId: live ? crypto.randomUUID() : null,
    archivedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(url ? { url } : {}),
  };
}

const APPS = [
  makeApp("cost-explorer", "Cost Explorer", true, "https://cost-explorer.apps.example.com"),
  makeApp("standup", "Standup", false, "https://standup.apps.example.com"),
];

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Route the two calls this page makes, plus the deployment config. Anything else
 * (auth config, health) stays pending, as in the other suites — note that means a
 * route left out of here hangs rather than 404s.
 */
function stubFetch(apps: App[], config: unknown = { appPublicBase: APPS_BASE }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/apps") return Promise.resolve(jsonResponse(apps));
      if (url === "/api/v1/config") {
        return config === "pending"
          ? new Promise<Response>(() => {})
          : Promise.resolve(jsonResponse(config));
      }
      if (/\/versions$/.test(url)) return Promise.resolve(jsonResponse([]));
      return new Promise<Response>(() => {}); // auth config, health: pending
    }),
  );
}

function render() {
  renderWithProviders(
    <AuthProvider>
      <DeployProvider>
        <AppsListPage />
      </DeployProvider>
    </AuthProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("AppsListPage", () => {
  it("renders a card per app from the registry", async () => {
    stubFetch(APPS);
    render();
    expect(await screen.findByText("Cost Explorer")).toBeDefined();
    expect(await screen.findByText("Standup")).toBeDefined();
  });

  it("shows each app's host from the URL the server computed", async () => {
    stubFetch(APPS);
    render();
    expect(await screen.findByText("cost-explorer.apps.example.com")).toBeDefined();
    expect(screen.getByText("standup.apps.example.com")).toBeDefined();
  });

  // An older portal predating AppSchema.url: compose the slug onto the base from
  // /api/v1/config rather than showing nothing.
  it("falls back to the deployment base when an app carries no url", async () => {
    stubFetch([makeApp("legacy", "Legacy", true)]);
    render();
    expect(await screen.findByText("legacy.apps.example.com")).toBeDefined();
  });

  it("renders no host at all while the deployment config is in flight", async () => {
    stubFetch([makeApp("legacy", "Legacy", true)], "pending");
    render();
    // The card renders; only the host line is withheld — never a guessed domain.
    expect(await screen.findByText("Legacy")).toBeDefined();
    expect(screen.queryByText(/helix\.azxlabs\.io/)).toBeNull();
  });

  it("shows the empty state when the registry is empty", async () => {
    stubFetch([]);
    render();
    expect(await screen.findByText("No apps yet")).toBeDefined();
    // The "served at <slug>.<domain>" hint uses the deployment base.
    expect(screen.getByText(`https://<slug>.apps.example.com`)).toBeDefined();
  });

  it("omits the empty-state URL hint until the deployment config arrives", async () => {
    stubFetch([], "pending");
    render();
    expect(await screen.findByText("No apps yet")).toBeDefined();
    expect(screen.queryByText(/served at/)).toBeNull();
  });

  /**
   * The regression that drove the New app / Deploy split, inherited from
   * `deploy-modal.test.tsx`: registering an app was once only reachable through
   * the deploy modal picker's "nothing found" message, so a single app in the
   * registry hid the only path to a second one anywhere in the UI. My Apps now
   * owns creation, and its button does not care how many apps exist.
   */
  it("keeps app creation reachable when apps already exist", async () => {
    stubFetch(APPS);
    render();

    await userEvent.click(await screen.findByRole("button", { name: /create app/i }));
    // The registration form itself, not a link off to somewhere else.
    expect(await screen.findByRole("textbox", { name: /subdomain/i })).toBeDefined();
  });

  it("opens the create modal from the empty state", async () => {
    stubFetch([]);
    render();

    await userEvent.click(await screen.findByRole("button", { name: /create your first app/i }));
    expect(await screen.findByRole("textbox", { name: /subdomain/i })).toBeDefined();
  });

  it("offers no deploy affordance — deploying belongs to an app's own page", async () => {
    stubFetch(APPS);
    render();

    await screen.findByText("Cost Explorer");
    expect(screen.queryByRole("button", { name: /deploy/i })).toBeNull();
  });
});
