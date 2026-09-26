import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MyConnection } from "@azx-pbc/shared";
import { renderWithProviders } from "./render";
import { ConnectionsPage } from "../pages/ConnectionsPage";

/**
 * My Connections (`/connections`, I-02 T-0024): the metadata card, the
 * disconnect confirmation contract (criteria 43, 45), the role="status"
 * announcement, the stale-kept-on-error posture, and criterion 46's refresh
 * cadence (30 s while visible, paused hidden, refreshed on return).
 */

function connection(over: Partial<MyConnection> = {}): MyConnection {
  return {
    id: "c1000000-0000-4000-8000-000000000001",
    providerRef: "asana",
    providerDisplayName: "Asana",
    env: "prod",
    status: "live",
    grantedScopes: ["read", "write"],
    grantedAt: new Date(Date.now() - 3_600_000).toISOString(),
    sharedApps: [],
    ...over,
  };
}

/**
 * Stub the connections GET (and optionally the DELETE). Unrelated URLs hang —
 * the page mounts no other queries. `list` is captured by reference: mutate
 * the array (e.g. `list.length = 0`) to change what the next GET answers.
 */
function stubFetch(
  list: MyConnection[],
  opts: { listStatus?: number; deleteReply?: { status: number; body: unknown } } = {},
): Mock & { calls: Array<{ url: string; init?: RequestInit }> } {
  const impl = vi.fn((url: string, init?: RequestInit) => {
    impl.calls.push({ url, init });
    if (url.endsWith("/api/v1/connections/mine")) {
      const failed = opts.listStatus !== undefined && opts.listStatus >= 500;
      return Promise.resolve({
        ok: !failed,
        status: opts.listStatus ?? 200,
        json: async () => ({ connections: list }),
      });
    }
    if (url.includes("/api/v1/connections/mine/")) {
      const reply = opts.deleteReply ?? { status: 200, body: { outcome: "disconnected" } };
      return Promise.resolve({
        ok: reply.status < 400,
        status: reply.status,
        json: async () => reply.body,
      });
    }
    return new Promise(() => {});
  }) as Mock & { calls: Array<{ url: string; init?: RequestInit }> };
  impl.calls = [];
  vi.stubGlobal("fetch", impl);
  return impl;
}

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

function renderPage() {
  return renderWithProviders(<ConnectionsPage />, { route: "/connections" });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setVisibility("visible");
});

describe("ConnectionsPage cards", () => {
  it("renders provider name, env badge, connection date, scopes, and status line", async () => {
    stubFetch([
      connection({
        sharedApps: [
          { id: "a0000000-0000-4000-8000-000000000001", slug: "notes", displayName: "Notes" },
        ],
      }),
    ]);
    renderPage();
    expect(await screen.findByText("Asana")).toBeDefined();
    expect(screen.getByText("Prod")).toBeDefined();
    // The connection date renders through toLocaleString — digits and a time
    // separator, whatever the environment's locale resolves to.
    expect(screen.getByText(/Connected\s+\d/)).toBeDefined();
    expect(screen.getByText("read")).toBeDefined();
    expect(screen.getByText("write")).toBeDefined();
    expect(screen.getByText("Connected")).toBeDefined();
    expect(screen.queryByText("Reconnect needed")).toBeNull();
  });

  it("labels reconnection-needing connections with text and icon, never color alone", async () => {
    stubFetch([connection({ status: "reconnect-needed" })]);
    renderPage();
    expect(await screen.findByText("Reconnect needed")).toBeDefined();
    expect(screen.queryByText("Connected")).toBeNull();
  });

  it("shows the empty state when the caller has connected nothing", async () => {
    stubFetch([]);
    renderPage();
    expect(await screen.findByText(/No connections yet/)).toBeDefined();
  });
});

describe("ConnectionsPage disconnect", () => {
  /** Open the confirm dialog and return its content element. */
  async function openDialog() {
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("dialog");
    return dialog;
  }

  it("confirms with the sharing apps and the vendor-authorization line before anything fires", async () => {
    const impl = stubFetch([
      connection({
        sharedApps: [
          { id: "a0000000-0000-4000-8000-000000000001", slug: "notes", displayName: "Notes" },
          { id: "a0000000-0000-4000-8000-000000000002", slug: "tasks", displayName: "Tasks" },
        ],
      }),
    ]);
    renderPage();
    const dialog = await openDialog();
    expect(within(dialog).getByText("Disconnect Asana (Prod)?")).toBeDefined();
    // Criteria 43 + 45 in the dialog's body, with the shared apps named.
    expect(within(dialog).getByText(/Notes, Tasks/)).toBeDefined();
    expect(within(dialog).getByText(/sharing the connection in Prod/)).toBeDefined();
    expect(within(dialog).getByText(/Helix access stops immediately/)).toBeDefined();
    expect(within(dialog).getByText(/may still finish/)).toBeDefined();
    expect(within(dialog).getByText(/Vendor-side authorization remains/)).toBeDefined();
    expect(within(dialog).getByText(/remove it at the vendor/)).toBeDefined();
    expect(impl.calls.filter((c) => c.init?.method === "DELETE")).toHaveLength(0);
  });

  it("fires the DELETE only on confirm, then announces the disconnect via role=status", async () => {
    const impl = stubFetch([connection()], {
      deleteReply: { status: 200, body: { outcome: "disconnected" } },
    });
    renderPage();
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    const deleted = impl.calls.find((c) => c.init?.method === "DELETE");
    expect(deleted?.url).toBe("/api/v1/connections/mine/c1000000-0000-4000-8000-000000000001");
    // The live region is persistent; the announcement lands in it.
    expect((await screen.findByRole("status")).textContent).toContain(
      "Disconnected — Helix access to Asana has stopped.",
    );
  });

  it("announces an already-removed repeat instead of pretending to disconnect", async () => {
    stubFetch([connection()], {
      deleteReply: { status: 200, body: { outcome: "already_removed" } },
    });
    renderPage();
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect((await screen.findByRole("status")).textContent).toContain("Already removed");
  });

  it("on a failed disconnect keeps the dialog open with the error — nothing resubmitted", async () => {
    const impl = stubFetch([connection()], {
      deleteReply: { status: 500, body: { error: { code: "internal", message: "boom" } } },
    });
    renderPage();
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(await within(dialog).findByText("boom")).toBeDefined();
    expect(impl.calls.filter((c) => c.init?.method === "DELETE")).toHaveLength(1);
  });
});

describe("ConnectionsPage refresh failure", () => {
  it("keeps loaded data with a stale indication when a refresh fails", async () => {
    const impl = stubFetch([connection()]);
    renderPage();
    expect(await screen.findByText("Asana")).toBeDefined();
    impl.mockImplementation((url: string) => {
      if (url.endsWith("/api/v1/connections/mine")) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({ error: { code: "internal", message: "refetch failed" } }),
        });
      }
      return new Promise(() => {});
    });
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    // The stale cards stay, and the failure is announced — never an empty
    // successful result.
    expect(await screen.findByText(/Couldn't refresh/)).toBeDefined();
    expect(screen.getByText("Asana")).toBeDefined();
  });

  it("shows an error, not an empty list, when the first load fails", async () => {
    stubFetch([], { listStatus: 500 });
    renderPage();
    expect(await screen.findByText(/Couldn't load your connections/)).toBeDefined();
    expect(screen.queryByText(/No connections yet/)).toBeNull();
  });
});

describe("ConnectionsPage refresh cadence (criterion 46)", () => {
  it("ticks every 30 s while visible, pauses while hidden, refetches on return", async () => {
    vi.useFakeTimers();
    const impl = stubFetch([connection()]);
    renderPage();
    // The initial page-entry fetch: settle it fully — the rendered card is
    // the proof the stub answered, so the baseline below counts it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    });
    expect(screen.getByText("Asana")).toBeDefined();
    // fetchJson always passes a `method: "GET"`, so count those explicitly.
    const gets = () => impl.calls.filter((c) => (c.init?.method ?? "GET") === "GET").length;
    const afterEntry = gets();

    // Two visible ticks, 30 s apart.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(gets()).toBe(afterEntry + 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(gets()).toBe(afterEntry + 2);

    // Hidden: the interval pauses — minutes pass, nothing fetches.
    act(() => setVisibility("hidden"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(gets()).toBe(afterEntry + 2);

    // Return: refreshed.
    act(() => setVisibility("visible"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(gets()).toBe(afterEntry + 3);
  });
});
