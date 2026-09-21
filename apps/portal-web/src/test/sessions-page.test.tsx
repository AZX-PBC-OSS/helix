import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SessionListResponse, SessionSummary } from "@azx-pbc/shared";
import { renderWithProviders } from "./render";
import { SessionsPage } from "../pages/admin/SessionsPage";

/**
 * The admin Sessions screen: grouping, the group-name resolution contract, and
 * the one mutation it exists to aim.
 */

const OPAQUE = "VKn3n7f8eM3JdjdHi6CSFsRTRIBtt1Nob_iPGjKAmPA";
const GUEST = "pw_AbC7xQ9z";

const hour = 60 * 60 * 1000;

function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: crypto.randomUUID(),
    appId: "11111111-1111-4111-8111-111111111111",
    slug: "demo",
    userOid: OPAQUE,
    userName: "Alice Anders",
    userEmail: "alice@azx.dev",
    userKind: "user",
    groups: ["eng-team"],
    createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    activatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    refreshDueAt: new Date(Date.now() + hour).toISOString(),
    expiresAt: new Date(Date.now() + 7 * hour).toISOString(),
    ...over,
  };
}

/** Two of Alice's sessions (two apps) and one shared-password guest. */
function aliceGuestAndGhost(): SessionListResponse {
  return {
    rows: [
      session({ slug: "demo", groups: ["eng-team", "ghost-group"] }),
      session({ slug: "notes", groups: [] }),
      session({
        userOid: GUEST,
        userName: null,
        userEmail: null,
        userKind: "password",
        groups: [],
      }),
    ],
    groupNames: { "eng-team": "Engineering" },
    groupsResolved: true,
  };
}

function stubFetch(body: SessionListResponse) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (typeof url === "string" && url.endsWith("/api/v1/sessions")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => body });
      }
      return new Promise(() => {}); // anything else: pending
    }),
  );
  return calls;
}

function renderPage() {
  return renderWithProviders(<SessionsPage />);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SessionsPage grouping", () => {
  it("folds the flat list into one card per user, sessions beneath", async () => {
    stubFetch(aliceGuestAndGhost());
    renderPage();
    // Alice's two sessions are ONE card: both app slugs under her name. The
    // guest also holds a session on `demo`, so that slug renders twice — once
    // per card, which is the grouping made visible.
    expect(await screen.findByText("Alice Anders")).toBeDefined();
    expect(screen.getByText("alice@azx.dev")).toBeDefined();
    expect(screen.getAllByText("demo")).toHaveLength(2);
    expect(screen.getByText("notes")).toBeDefined();
    // The per-user summary line: 2 sessions, 2 apps.
    expect(screen.getByText(/2 sessions · 2 apps/)).toBeDefined();
    // The guest is a separate card, labelled by its recorded kind — never by
    // guessing at the `pw_` prefix (the audit page's stance).
    expect(screen.getByText("shared password")).toBeDefined();
    // Stats row.
    expect(screen.getByText("Live sessions")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
  });

  it("renders resolved group names, raw ids for the rest — the id stays on title", async () => {
    stubFetch(aliceGuestAndGhost());
    renderPage();
    expect(await screen.findByText("Engineering")).toBeDefined();
    // An id the directory did not name renders as the id itself — the fact, not
    // a blank — and the raw id is copyable via the chip's title.
    expect(screen.getByText("ghost-group")).toBeDefined();
    expect(document.querySelector('[title="eng-team"]')).not.toBeNull();
  });

  it("says why names are missing when the directory could not resolve them", async () => {
    const body = aliceGuestAndGhost();
    stubFetch({ ...body, groupNames: {}, groupsResolved: false });
    renderPage();
    expect(await screen.findByText(/Group names are unavailable/)).toBeDefined();
    // The ids still render — the degradation costs the names, not the list.
    expect(screen.getByText("eng-team")).toBeDefined();
  });

  it("flags refresh-overdue sessions, where the group snapshot may be stale", async () => {
    stubFetch({
      rows: [session({ refreshDueAt: new Date(Date.now() - hour).toISOString() })],
      groupNames: {},
      groupsResolved: true,
    });
    renderPage();
    expect(await screen.findByText("overdue")).toBeDefined();
    expect(await screen.findByText("1 refresh overdue")).toBeDefined();
  });

  it("matches the filter on the captured label, the app and the group", async () => {
    stubFetch(aliceGuestAndGhost());
    renderPage();
    expect(await screen.findByText("Alice Anders")).toBeDefined();
    await userEvent.type(screen.getByPlaceholderText(/Filter by user/i), "notes");
    // Alice matches on the app slug; the guest card does not.
    expect(screen.getByText("notes")).toBeDefined();
    expect(screen.queryByText("shared password")).toBeNull();
  });
});

describe("SessionsPage revoke", () => {
  it("confirms, then POSTs the user-level kill for the clicked user", async () => {
    const calls = stubFetch(aliceGuestAndGhost());
    renderPage();
    const revoke = await screen.findByRole("button", {
      name: `Revoke all sessions for Alice Anders`,
    });
    await userEvent.click(revoke);
    // One click away: the dialog states the blast radius before anything fires.
    expect(await screen.findByText(/Revoke all sessions for Alice Anders\?/)).toBeDefined();
    expect(screen.getByText(/stops working on its next request/)).toBeDefined();
    expect(calls.filter((c) => c.url.includes("/revoke"))).toHaveLength(0);

    await userEvent.click(await screen.findByRole("button", { name: "Revoke sessions" }));
    const posted = calls.find((c) => c.url.endsWith("/api/v1/sessions/revoke"));
    expect(posted).toBeDefined();
    expect(JSON.parse(String(posted?.init?.body))).toEqual({ userOid: OPAQUE });
  });

  it("targets the guest card's pseudonym, not Alice's subject", async () => {
    const calls = stubFetch(aliceGuestAndGhost());
    renderPage();
    const revoke = await screen.findByRole("button", {
      name: "Revoke all sessions for shared password",
    });
    await userEvent.click(revoke);
    await userEvent.click(await screen.findByRole("button", { name: "Revoke sessions" }));
    const posted = calls.find((c) => c.url.endsWith("/api/v1/sessions/revoke"));
    expect(JSON.parse(String(posted?.init?.body))).toEqual({ userOid: GUEST });
  });
});
