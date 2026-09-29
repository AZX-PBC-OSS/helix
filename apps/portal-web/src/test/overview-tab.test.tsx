import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { App, PortalMeResponse, Version } from "@azx-pbc/shared";
import { renderWithProviders } from "./render";
import { AuthProvider } from "../auth/AuthProvider";
import { setToken, clearToken } from "../auth/tokenStore";
import { OverviewTab } from "../pages/tabs/OverviewTab";

/**
 * The description edit affordance on the Overview tab's "Registry record" card.
 * The edit button mirrors the server's `ownsApp` (owner-id match or admin) —
 * these tests pin that mirror, while the server remains the real gate
 * (apps/portal/src/plugins/auth.ts `ownsApp`, exercised in ownership.test.ts).
 */

const APP: App = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "cost-explorer",
  displayName: "Cost Explorer",
  description: "Tracks Q3 spend by team.",
  visibility: { mode: "internal" },
  currentVersionId: null,
  archivedAt: null,
  createdAt: "2026-06-11T00:00:00.000Z",
  updatedAt: "2026-06-11T00:00:00.000Z",
  url: "https://cost-explorer.apps.example.com",
  ownerId: "oid-owner",
  ownerName: "Alice Anders",
};

const VERSIONS: Version[] = [];

function me(overrides: Partial<PortalMeResponse>): PortalMeResponse {
  return {
    sub: "who@azx.dev",
    via: "oidc",
    isAdmin: false,
    canSearchDirectory: true,
    ...overrides,
  };
}

function stubFetch(meResponse: PortalMeResponse) {
  const patches: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/v1/me")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => meResponse });
      }
      if (url.includes("/api/v1/auth/config")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ issuer: "https://idp.test", cliClientId: "azx-cli" }),
        });
      }
      if (url.includes("/approvals")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      }
      if (init?.method === "PATCH") {
        patches.push({ url, body: JSON.parse(String(init.body)) });
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ...APP, description: JSON.parse(String(init.body)).description }),
        });
      }
      return new Promise(() => {}); // anything else: pending, as in the other suites
    }),
  );
  return patches;
}

function renderTab() {
  renderWithProviders(
    <AuthProvider>
      <OverviewTab app={APP} versions={VERSIONS} />
    </AuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
});

describe("OverviewTab description edit", () => {
  it("lets the owner edit and save the description via PATCH", async () => {
    setToken("t");
    const patches = stubFetch(me({ oid: "oid-owner" }));
    renderTab();

    const edit = await screen.findByRole("button", { name: /edit description/i });
    await userEvent.click(edit);

    const box = screen.getByRole("textbox", { name: /description/i });
    expect((box as HTMLTextAreaElement).value).toBe("Tracks Q3 spend by team.");
    await userEvent.clear(box);
    await userEvent.type(box, "A brand-new summary.");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await vi.waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]?.url).toContain("/api/v1/apps/cost-explorer");
    expect(patches[0]?.body).toEqual({ description: "A brand-new summary." });
    // Saving closes the editor — no stuck form after a clean round-trip.
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
  });

  it("offers no edit affordance to a signed-in non-owner", async () => {
    setToken("t");
    stubFetch(me({ oid: "oid-someone-else" }));
    renderTab();

    expect(await screen.findByText("Tracks Q3 spend by team.")).toBeDefined();
    expect(screen.queryByRole("button", { name: /edit description/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /add description/i })).toBeNull();
  });

  it("seats a platform admin even when they do not own the app", async () => {
    setToken("t");
    stubFetch(me({ oid: "oid-admin", isAdmin: true }));
    renderTab();

    expect(await screen.findByRole("button", { name: /edit description/i })).toBeDefined();
  });

  it("invites a description when the app has none", async () => {
    setToken("t");
    stubFetch(me({ oid: "oid-owner" }));
    renderWithProviders(
      <AuthProvider>
        <OverviewTab app={{ ...APP, description: undefined }} versions={VERSIONS} />
      </AuthProvider>,
    );

    expect(await screen.findByText("No description yet.")).toBeDefined();
    expect(await screen.findByRole("button", { name: /add description/i })).toBeDefined();
  });
});
