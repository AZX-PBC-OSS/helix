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
function stubFetch(
  result: VisibilityUpdateResult,
  directory: { mine: unknown; search: unknown } = {
    mine: AVAILABLE_MINE,
    search: AVAILABLE_SEARCH,
  },
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string) => {
    if (typeof url === "string" && url.endsWith("/visibility")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => result });
    }
    if (typeof url === "string" && url.includes("/directory/my-groups")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => directory.mine,
      });
    }
    if (typeof url === "string" && url.includes("/directory/groups")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => directory.search });
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

/** The caller's own groups, as `/directory/my-groups` answers them. */
const AVAILABLE_MINE = {
  available: true,
  groups: [{ id: "eng-team", displayName: "Engineering", securityEnabled: true }],
};

/** A search hit, as `/directory/groups` answers it. */
const AVAILABLE_SEARCH = {
  available: true,
  groups: [{ id: "product-team", displayName: "Product", securityEnabled: true }],
};

/**
 * The group picker (ADR-0040 §5, §8, §9).
 *
 * Two of these are regression pins rather than feature tests: an owner has to be
 * able to edit the groups of an app that is *already* group-scoped (the row used
 * to go inert once current, so changing groups meant switching to Internal first
 * — briefly widening the app to the whole directory in order to narrow it), and
 * the tab has to keep working when the tenant never granted the Graph
 * permission.
 */
describe("AccessTab group picker", () => {
  it("offers editing to an app that is already group-scoped", async () => {
    stubFetch({ app: makeApp({ mode: "internal" }), applied: [], pending: null });
    setToken("test-token");
    render(makeApp({ mode: "group", groupIds: ["eng-team"] }));
    // Not "Restrict to groups": the app is already there, so the action is an edit.
    expect(await screen.findByRole("button", { name: "Edit groups" })).toBeDefined();
  });

  it("shows the current group ids, and says so when there are none", () => {
    stubFetch({ app: makeApp({ mode: "internal" }), applied: [], pending: null });
    setToken("test-token");
    const { unmount } = render(makeApp({ mode: "group", groupIds: ["eng-team", "product-team"] }));
    expect(screen.getByText(/eng-team, product-team/)).toBeDefined();
    unmount();

    // A zero-group `group` app is inert (the edge fails closed) but looks
    // identical to a working one from the outside, so it is called out.
    render(makeApp({ mode: "group", groupIds: [] }));
    expect(screen.getByText(/No groups selected — nobody can open this app/)).toBeDefined();
  });

  it("saves an edited group set as an array", async () => {
    const fetchMock = stubFetch({
      app: makeApp({ mode: "group", groupIds: ["eng-team"] }),
      applied: [{ path: "visibility", from: "group:eng-team", to: "group:eng-team,product-team" }],
      pending: null,
    });
    setToken("test-token");
    render(makeApp({ mode: "group", groupIds: ["eng-team"] }));
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Edit groups" }));
    // Add a second group through the by-id escape hatch — the same path a group
    // that search can't reach has to take.
    await user.type(await screen.findByLabelText("Add by id"), "product-team");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(screen.getByRole("button", { name: "Save groups" }));

    await waitFor(() =>
      expect(visibilityBody(fetchMock)).toEqual({
        visibility: { mode: "group", groupIds: ["eng-team", "product-team"] },
      }),
    );
  });

  it("will not save an empty group set", async () => {
    const fetchMock = stubFetch({
      app: makeApp({ mode: "internal" }),
      applied: [],
      pending: null,
    });
    setToken("test-token");
    render(makeApp({ mode: "internal" }));
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Restrict to groups" }));
    // No jest-dom in this suite, so assert the attribute the DOM actually carries.
    expect((await screen.findByRole("button", { name: "Apply" })).hasAttribute("disabled")).toBe(
      true,
    );
    expect(visibilityBody(fetchMock)).toBeUndefined();
  });

  /**
   * ADR-0040 §8. A tenant that declined `GroupMember.Read.All` must still get a
   * working Access tab: the picker becomes plain id entry behind a banner naming
   * the permission an administrator would grant. Enforcement never depended on
   * Graph, so group visibility itself keeps working — the banner has to say that
   * too, or it reads as "this feature is broken".
   */
  it("degrades to id entry with a banner when the directory is unavailable", async () => {
    stubFetch(
      { app: makeApp({ mode: "internal" }), applied: [], pending: null },
      {
        mine: {
          available: false,
          reason: "no-consent",
          detail: "tenant said no",
          missingPermission: "GroupMember.Read.All",
        },
        search: {
          available: false,
          reason: "no-consent",
          detail: "tenant said no",
          missingPermission: "GroupMember.Read.All",
        },
      },
    );
    setToken("test-token");
    render(makeApp({ mode: "group", groupIds: ["11111111-1111-4111-8111-111111111111"] }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit groups" }));

    expect(await screen.findByText(/Group search is unavailable/)).toBeDefined();
    expect(screen.getByText(/GroupMember\.Read\.All/)).toBeDefined();
    // And it says the gate still works, so the banner is not read as an outage.
    expect(screen.getByText(/Access control itself is unaffected/)).toBeDefined();
    // The id field is still there, so the stored GUID remains editable.
    expect(screen.getByLabelText("Group id")).toBeDefined();
  });
});
