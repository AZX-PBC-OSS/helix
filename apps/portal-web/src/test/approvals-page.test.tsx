import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ApprovalRequest } from "@azx-pbc/shared";
import { renderWithProviders } from "./render";
import { ApprovalsPage } from "../pages/admin/ApprovalsPage";
import { AuthProvider } from "../auth/AuthProvider";
import { setToken, clearToken } from "../auth/tokenStore";

const REQUEST_ID = "33333333-3333-4333-8333-333333333333";

const pending: ApprovalRequest = {
  id: REQUEST_ID,
  appId: "11111111-1111-4111-8111-111111111111",
  appSlug: "demo",
  appDisplayName: "Demo",
  status: "pending",
  risk: "high",
  deltas: [{ path: "mcp[+pagerduty]" }],
  baseSnapshot: {},
  requestedBy: "owner@azx.io",
  reason: "need paging",
  decidedBy: null,
  decisionNote: null,
  createdAt: new Date().toISOString(),
  decidedAt: null,
};

type Decision = { ok: boolean; status: number; body: unknown };

/**
 * Serve the queue, and answer each successive approve POST with the next entry in
 * `decisions` (the last one repeats). Note the stubs are plain objects rather than
 * real `Response`s (the house idiom), so `ok`/`status` have to be set explicitly
 * for the client's error path to see them.
 */
function stubFetch(...decisions: Decision[]) {
  let nth = 0;
  const fetchMock = vi.fn((url: string) => {
    if (typeof url === "string" && url.includes("/approve")) {
      const decision = decisions[Math.min(nth++, decisions.length - 1)]!;
      return Promise.resolve({
        ok: decision.ok,
        status: decision.status,
        json: async () => decision.body,
      });
    }
    if (typeof url === "string" && url.includes("/deny")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ...pending, status: "denied", decisionNote: "no" }),
      });
    }
    if (typeof url === "string" && url.includes("/api/v1/approvals")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => [pending] });
    }
    return new Promise(() => {}); // /me — pending forever
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
});

describe("ApprovalsPage decision errors", () => {
  it("names the decision that actually landed when the request was already decided", async () => {
    setToken("test-token");
    // The 409 a lost decision race answers with (docs/design/approvals.md §5).
    const fetchMock = stubFetch({
      ok: false,
      status: 409,
      body: {
        error: {
          code: "conflict",
          message: `approval request "${REQUEST_ID}" was already denied — re-read it and retry`,
          details: { status: "denied" },
        },
      },
    });
    renderWithProviders(
      <AuthProvider>
        <ApprovalsPage />
      </AuthProvider>,
    );

    await userEvent.click(await screen.findByRole("button", { name: /Approve grant/ }));

    await waitFor(() => {
      expect(screen.getByText(/This request was already denied by another admin/)).toBeDefined();
    });
    // …and the queue refetched, so the row on screen is the stored state, not the
    // one this admin was looking at when they clicked.
    await waitFor(() => {
      const queueCalls = fetchMock.mock.calls.filter(
        ([url]) => typeof url === "string" && url.includes("/approvals?"),
      );
      expect(queueCalls.length).toBeGreaterThan(1);
    });
  });

  it("clears a stale banner when a different decision succeeds", async () => {
    setToken("test-token");
    // Cross-hook is the failure that matters: react-query already clears a hook's
    // own error when that same hook fires again, but the banner reads three hooks,
    // and it names no row — so a dead approve error sitting over a successful deny
    // reads as though the deny had failed.
    stubFetch({
      ok: false,
      status: 409,
      body: {
        error: { code: "conflict", message: "already denied", details: { status: "denied" } },
      },
    });
    renderWithProviders(
      <AuthProvider>
        <ApprovalsPage />
      </AuthProvider>,
    );

    await userEvent.click(await screen.findByRole("button", { name: /Approve grant/ }));
    await waitFor(() => {
      expect(screen.getByText(/This request was already denied/)).toBeDefined();
    });

    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    await userEvent.type(screen.getByRole("textbox"), "no");
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(screen.queryByText(/This request was already denied/)).toBeNull();
    });
  });

  it("surfaces any other decision failure instead of silently stopping the spinner", async () => {
    setToken("test-token");
    stubFetch({
      ok: false,
      status: 403,
      body: {
        error: {
          code: "forbidden",
          message: "self-approval is not permitted (separation of duty)",
        },
      },
    });
    renderWithProviders(
      <AuthProvider>
        <ApprovalsPage />
      </AuthProvider>,
    );

    await userEvent.click(await screen.findByRole("button", { name: /Approve grant/ }));

    await waitFor(() => {
      expect(screen.getByText(/Couldn't record that decision/)).toBeDefined();
      expect(screen.getByText(/separation of duty/)).toBeDefined();
    });
  });
});
