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

/**
 * Serve the queue, and answer the approve POST with `decision`. Note the stubs are
 * plain objects rather than real `Response`s (the house idiom), so `ok`/`status`
 * have to be set explicitly for the client's error path to see them.
 */
function stubFetch(decision: { ok: boolean; status: number; body: unknown }) {
  const fetchMock = vi.fn((url: string) => {
    if (typeof url === "string" && url.includes("/approve")) {
      return Promise.resolve({
        ok: decision.ok,
        status: decision.status,
        json: async () => decision.body,
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
      expect(screen.getByText(/Someone else already denied this request/)).toBeDefined();
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
