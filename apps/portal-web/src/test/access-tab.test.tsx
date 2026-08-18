import { describe, expect, it, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { App, Visibility, VisibilityUpdateResult } from "@azx-pbc/shared";
import { renderWithProviders } from "./render";
import { AccessTab } from "../pages/tabs/AccessTab";
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
 * Route the visibility POST to a canned result and the auth-config query to a
 * deployment that permits both open surfaces (so the public option is offered —
 * these assertions are about the request flow, not the policy gate). Everything
 * else (/me) never resolves — irrelevant here, and `retry: false` in the test
 * QueryClient keeps it quiet.
 */
function stubFetch(result: VisibilityUpdateResult): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string) => {
    if (typeof url === "string" && url.endsWith("/visibility")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => result });
    }
    if (typeof url === "string" && url.endsWith("/auth/config")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          issuer: "https://idp.example",
          cliClientId: "azx-cli",
          allowPublicApps: true,
          allowPasswordApps: true,
        }),
      });
    }
    return new Promise(() => {}); // /me — pending forever
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function render(app: App) {
  return renderWithProviders(
    <AuthProvider>
      <AccessTab app={app} />
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

describe("AccessTab visibility switcher", () => {
  it("hides switch actions and prompts sign-in when logged out", () => {
    stubFetch({ app: makeApp({ mode: "internal" }), applied: [], pending: null });
    render(makeApp({ mode: "internal" }));
    expect(screen.getByText(/You need to be signed in to change visibility/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Request public access" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make internal" })).toBeNull();
  });

  it("opens a confirm dialog and requests public access through the approval gate", async () => {
    const fetchMock = stubFetch({
      app: makeApp({ mode: "internal" }),
      applied: [],
      pending: "req-1", // elevated → pending approval id
    });
    setToken("test-token");
    render(makeApp({ mode: "internal" }));
    const user = userEvent.setup();

    // The public option appears once the auth-config policy resolves.
    await user.click(await screen.findByRole("button", { name: "Request public access" }));
    // Confirm dialog explains it pauses for approval.
    expect(await screen.findByText("Request public access for Demo?")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Request approval" }));

    await waitFor(() =>
      expect(visibilityBody(fetchMock)).toEqual({ visibility: { mode: "public" } }),
    );
    // Success with a pending id surfaces the awaiting-approval hint.
    expect(await screen.findByText(/awaiting admin approval/)).toBeDefined();
  });

  it("makes an app internal immediately, without a confirm dialog", async () => {
    const fetchMock = stubFetch({
      app: makeApp({ mode: "internal" }),
      applied: [{ path: "visibility", from: "public", to: "internal" }],
      pending: null,
    });
    setToken("test-token");
    render(makeApp({ mode: "public" })); // currently public → "Make internal" is offered
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Make internal" }));
    await waitFor(() =>
      expect(visibilityBody(fetchMock)).toEqual({ visibility: { mode: "internal" } }),
    );
    // No confirm modal for a baseline reduction.
    expect(screen.queryByText(/Request public access for/)).toBeNull();
  });

  it("steps aside for password-mode apps (managed by the password card)", () => {
    stubFetch({ app: makeApp({ mode: "internal" }), applied: [], pending: null });
    setToken("test-token");
    render(makeApp({ mode: "password" }));
    expect(screen.getByText(/Disable it on the right to switch/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Request public access" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make internal" })).toBeNull();
  });
});
