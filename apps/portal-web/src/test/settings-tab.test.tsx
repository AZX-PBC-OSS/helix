import { describe, expect, it, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { App, Visibility, VisibilityUpdateResult } from "@helix/shared";
import { renderWithProviders } from "./render";
import { SettingsTab } from "../pages/tabs/SettingsTab";
import { AuthProvider } from "../auth/AuthProvider";
import { setToken, clearToken } from "../auth/tokenStore";

const APP_ID = "11111111-1111-4111-8111-111111111111";

function makeApp(visibility: Visibility): App {
  return {
    id: APP_ID,
    slug: "demo",
    displayName: "Demo",
    visibility,
    currentVersionId: null,
    archivedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Route the visibility POST to a canned result; everything else (auth config,
 * /me) never resolves — irrelevant to these assertions, and `retry: false` in
 * the test QueryClient keeps it quiet.
 */
function stubFetch(result: VisibilityUpdateResult): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string) => {
    if (typeof url === "string" && url.endsWith("/visibility")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => result });
    }
    return new Promise(() => {}); // auth config / me — pending forever
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function render(app: App) {
  return renderWithProviders(
    <AuthProvider>
      <SettingsTab app={app} />
    </AuthProvider>,
  );
}

/** The body the visibility POST was called with (or undefined if never called). */
function visibilityBody(fetchMock: ReturnType<typeof vi.fn>): unknown {
  const call = fetchMock.mock.calls.find(
    ([url]) => typeof url === "string" && url.endsWith("/visibility"),
  );
  return call ? JSON.parse((call[1] as { body: string }).body) : undefined;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
});

describe("SettingsTab visibility switcher", () => {
  it("hides switch actions and prompts sign-in when logged out", () => {
    stubFetch({ app: makeApp({ mode: "private" }), applied: [], pending: null });
    render(makeApp({ mode: "private" }));
    expect(screen.getByText(/Changing visibility needs a signed-in actor/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Request public access" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make private" })).toBeNull();
  });

  it("opens a confirm dialog and requests public access through the approval gate", async () => {
    const fetchMock = stubFetch({
      app: makeApp({ mode: "private" }),
      applied: [],
      pending: "req-1", // elevated → pending approval id
    });
    setToken("test-token");
    render(makeApp({ mode: "private" }));
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Request public access" }));
    // Confirm dialog explains it pauses for approval.
    expect(await screen.findByText("Request public access for Demo?")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Request approval" }));

    await waitFor(() =>
      expect(visibilityBody(fetchMock)).toEqual({ visibility: { mode: "public" } }),
    );
    // Success with a pending id surfaces the awaiting-approval hint.
    expect(await screen.findByText(/awaiting admin approval/)).toBeDefined();
  });

  it("makes an app private immediately, without a confirm dialog", async () => {
    const fetchMock = stubFetch({
      app: makeApp({ mode: "private" }),
      applied: [{ path: "visibility", from: "public", to: "private" }],
      pending: null,
    });
    setToken("test-token");
    render(makeApp({ mode: "public" })); // currently public → "Make private" is offered
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Make private" }));
    await waitFor(() =>
      expect(visibilityBody(fetchMock)).toEqual({ visibility: { mode: "private" } }),
    );
    // No confirm modal for a baseline reduction.
    expect(screen.queryByText(/Request public access for/)).toBeNull();
  });

  it("steps aside for password-mode apps (managed by the password card)", () => {
    stubFetch({ app: makeApp({ mode: "private" }), applied: [], pending: null });
    setToken("test-token");
    render(makeApp({ mode: "password" }));
    expect(screen.getByText(/Disable it on the right to switch/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Request public access" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make private" })).toBeNull();
  });
});
