import { describe, expect, it, vi, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { App, Version } from "@helix/shared";
import { renderWithProviders } from "./render";
import { VersionsTab } from "../pages/tabs/VersionsTab";
import { AuthProvider } from "../auth/AuthProvider";
import { setToken, clearToken } from "../auth/tokenStore";

const APP_ID = "11111111-1111-4111-8111-111111111111";

function version(number: number, status: Version["status"], id: string): Version {
  return {
    id,
    appId: APP_ID,
    number,
    blobPrefix: `apps/${APP_ID}/${number}/`,
    status,
    createdAt: new Date(Date.now() - number * 3_600_000).toISOString(),
  };
}

const LIVE_ID = "22222222-2222-4222-8222-222222222222";
const app: App = {
  id: APP_ID,
  slug: "demo",
  displayName: "Demo",
  visibility: { mode: "private" },
  currentVersionId: LIVE_ID,
  archivedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
const versions: Version[] = [
  version(3, "preview", "33333333-3333-4333-8333-333333333333"),
  version(2, "live", LIVE_ID),
  version(1, "archived", "44444444-4444-4444-8444-444444444444"),
];

function renderTab() {
  // The tab reads auth config via react-query; a never-resolving fetch keeps
  // it logged-out-pending, which is fine for these assertions.
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
  return renderWithProviders(
    <AuthProvider>
      <VersionsTab app={app} versions={versions} />
    </AuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
});

describe("VersionsTab", () => {
  it("renders every version with its status and marks the live row", () => {
    renderTab();
    expect(screen.getByText("v1")).toBeDefined();
    expect(screen.getByText("v2")).toBeDefined();
    expect(screen.getByText("v3")).toBeDefined();
    expect(screen.getByText("LIVE")).toBeDefined();
    expect(screen.getByText("serving")).toBeDefined();
  });

  it("offers Promote for preview rows and Rollback for archived rows, gated on auth", () => {
    renderTab();
    const promote = screen.getByRole("button", { name: "Promote" });
    const rollbackTo = screen.getByRole("button", { name: "Rollback to" });
    // Logged out: visible but disabled — reads are open, mutations are not.
    expect(promote.hasAttribute("disabled")).toBe(true);
    expect(rollbackTo.hasAttribute("disabled")).toBe(true);
  });

  it("opens a confirm dialog describing the pointer flip when signed in", async () => {
    setToken("test-token");
    renderTab();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Promote" }));
    expect(await screen.findByText("Promote v3 to live?")).toBeDefined();
    expect(screen.getByText(/flips the live pointer/)).toBeDefined();
  });
});
