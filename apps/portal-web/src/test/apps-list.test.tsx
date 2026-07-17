import { describe, expect, it, vi, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import type { App } from "@azx-pbc/shared";
import { renderWithProviders } from "./render";
import { AppsListPage } from "../pages/AppsListPage";
import { AuthProvider } from "../auth/AuthProvider";
import { DeployProvider } from "../modals/DeployContext";

function makeApp(slug: string, displayName: string, live: boolean): App {
  return {
    id: crypto.randomUUID(),
    slug,
    displayName,
    visibility: { mode: "private" },
    currentVersionId: live ? crypto.randomUUID() : null,
    archivedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const APPS = [
  makeApp("cost-explorer", "Cost Explorer", true),
  makeApp("standup", "Standup", false),
];

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("AppsListPage", () => {
  it("renders a card per app from the registry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/v1/apps") return Promise.resolve(jsonResponse(APPS));
        if (/\/versions$/.test(url)) return Promise.resolve(jsonResponse([]));
        return new Promise<Response>(() => {}); // auth config, health: pending
      }),
    );
    renderWithProviders(
      <AuthProvider>
        <DeployProvider>
          <AppsListPage />
        </DeployProvider>
      </AuthProvider>,
    );
    expect(await screen.findByText("Cost Explorer")).toBeDefined();
    expect(await screen.findByText("Standup")).toBeDefined();
    // host line is derived from the slug + APP_PUBLIC_BASE default
    expect(screen.getByText("cost-explorer.localtest.me:8080")).toBeDefined();
  });

  it("shows the empty state when the registry is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/v1/apps") return Promise.resolve(jsonResponse([]));
        return new Promise<Response>(() => {});
      }),
    );
    renderWithProviders(
      <AuthProvider>
        <DeployProvider>
          <AppsListPage />
        </DeployProvider>
      </AuthProvider>,
    );
    expect(await screen.findByText("No apps yet")).toBeDefined();
  });
});
