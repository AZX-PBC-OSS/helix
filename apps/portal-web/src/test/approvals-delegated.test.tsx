import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ApprovalRequest } from "@azx-pbc/shared";
import { renderWithProviders } from "./render";
import { ApprovalsPage } from "../pages/admin/ApprovalsPage";
import { setToken, clearToken } from "../auth/tokenStore";

/**
 * The approver's view of the delegated-provider request kind (I-02 T-0029): the
 * distinct kind + delta line + high-risk badge, the public-app warning stamped
 * at filing (criterion 16 — advisory, never blocking), and the stale-provider
 * 409 rendered as its own outcome (criteria 8, 18).
 */

const REQUEST_ID = "44444444-4444-4444-8444-444444444444";

const STAMP = {
  ref: "asana",
  env: "prod" as const,
  providerId: "22222222-2222-4222-8222-222222222222",
  revision: 3,
};

/** As T-0009 files a provider-bound origin add: the key-form path plus the stamps. */
function makeDelegatedRequest(publicApp: boolean): ApprovalRequest {
  return {
    id: REQUEST_ID,
    appId: "11111111-1111-4111-8111-111111111111",
    appSlug: "delegator",
    appDisplayName: "Delegator",
    status: "pending",
    risk: "high",
    deltas: [
      {
        path: "fetch.origins[+https://api.asana.com→provider:asana]",
        to: "https://api.asana.com→provider:asana",
        providerStamps: [STAMP],
        publicApp,
      },
    ],
    baseSnapshot: {},
    requestedBy: "owner@azx.io",
    // Sibling history exists but is quiet — the card must still render without
    // fetching it (the history query isDetails-gated, and Details starts closed).
    priorDecisions: {
      total: 1,
      deniedSameArea: 0,
      deniedSameGrant: 0,
      last: {
        status: "withdrawn",
        note: null,
        decidedBy: "owner@azx.io",
        decidedAt: new Date().toISOString(),
      },
    },
    decidedBy: null,
    decisionNote: null,
    createdAt: new Date().toISOString(),
    decidedAt: null,
  };
}

/** A pre-T-0009 secret-bound origin add, with no stamps at all. */
const SECRET_BOUND: ApprovalRequest = {
  id: REQUEST_ID,
  appId: "11111111-1111-4111-8111-111111111111",
  appSlug: "legacy",
  status: "pending",
  risk: "high",
  deltas: [{ path: "fetch.origins[+https://api.foo.com→secret:billing]", to: "billing" }],
  baseSnapshot: {},
  requestedBy: "owner@azx.io",
  decidedBy: null,
  decisionNote: null,
  createdAt: new Date().toISOString(),
  decidedAt: null,
};

type Decision = { ok: boolean; status: number; body: unknown };

/**
 * Serve the queue (always the same rows — the request a 409 leaves pending must
 * still be there after the settle-refetch), and answer each approve POST with
 * the next entry in `decisions` (the last one repeats). Plain objects, not real
 * `Response`s — the house idiom.
 */
function stubFetch(queue: ApprovalRequest[], ...decisions: Decision[]) {
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
    if (typeof url === "string" && url.startsWith("/api/v1/approvals")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => queue,
      });
    }
    return new Promise(() => {}); // anything else — must never be fetched
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
});

describe("ApprovalsPage delegated-provider requests", () => {
  it("renders the distinct kind, the provider delta line, and the high-risk badge", async () => {
    stubFetch([makeDelegatedRequest(false)]);
    renderWithProviders(<ApprovalsPage />);

    expect(await screen.findByText("Delegated provider")).toBeDefined();
    expect(
      screen.getByText(/fetch\.origins\[\+https:\/\/api\.asana\.com→provider:asana\]/),
    ).toBeDefined();
    expect(screen.getByText("HIGH RISK")).toBeDefined();
  });

  it("renders from the filing-stamped payload with no extra request", async () => {
    const fetchMock = stubFetch([makeDelegatedRequest(true)]);
    renderWithProviders(<ApprovalsPage />);
    await screen.findByText("Delegated provider");

    // The only network call is the queue itself: visibility and the stamps are
    // data on the request, so the card never fetches the app (design.md).
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual(["/api/v1/approvals?status=pending"]);
  });

  it("warns on a public app's request without disabling the approve action", async () => {
    stubFetch([makeDelegatedRequest(true)]);
    renderWithProviders(<ApprovalsPage />);

    expect(
      await screen.findByText(/This app is public — its anonymous visitors can never connect/),
    ).toBeDefined();
    // Advisory only (criterion 16): a real, enabled button, not a blocked one.
    const approve = screen.getByRole("button", { name: /Approve grant/ });
    expect(approve.hasAttribute("disabled")).toBe(false);
    // The warning never alters classification — the HIGH RISK badge stands alone.
    expect(screen.getByText("HIGH RISK")).toBeDefined();
    expect(screen.queryByText("ELEVATED")).toBeNull();
  });

  it("does not warn on a non-public app's request", async () => {
    stubFetch([makeDelegatedRequest(false)]);
    renderWithProviders(<ApprovalsPage />);

    expect(await screen.findByText("Delegated provider")).toBeDefined();
    expect(screen.queryByText(/its anonymous visitors can never connect/)).toBeNull();
  });

  it("approves a public app's delegated request when the approver chooses it", async () => {
    setToken("test-token");
    const fetchMock = stubFetch([makeDelegatedRequest(true)], {
      ok: true,
      status: 200,
      body: { ...makeDelegatedRequest(true), status: "approved" },
    });
    renderWithProviders(<ApprovalsPage />);

    await userEvent.click(await screen.findByRole("button", { name: /Approve grant/ }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/approve"))).toBe(true);
      expect(screen.queryByText(/Couldn't record that decision/)).toBeNull();
    });
  });

  it("renders the stale-provider conflict and leaves the request pending", async () => {
    setToken("test-token");
    // The 409 assertProviderStampsCurrent throws (T-0009): code `conflict`, the
    // stamped ref in details, nothing applied.
    const fetchMock = stubFetch([makeDelegatedRequest(false)], {
      ok: false,
      status: 409,
      body: {
        error: {
          code: "conflict",
          message:
            "the provider changed after this request was filed — the app owner must resubmit",
          details: { ref: "asana", env: "prod" },
        },
      },
    });
    renderWithProviders(<ApprovalsPage />);

    await userEvent.click(await screen.findByRole("button", { name: /Approve grant/ }));

    await waitFor(() => {
      expect(
        screen.getByText(
          /The provider changed after this request was filed — the app owner must resubmit/,
        ),
      ).toBeDefined();
    });
    // Distinguishable from a lost decision race — never the "already …" reading.
    expect(screen.queryByText(/This request was already /)).toBeNull();
    // Nothing landed: the row is still pending on the refetched queue.
    await waitFor(() => {
      const queueCalls = fetchMock.mock.calls.filter(
        ([url]) => typeof url === "string" && url.includes("/approvals?"),
      );
      expect(queueCalls.length).toBeGreaterThan(1);
    });
    expect(screen.getByText("Delegated provider")).toBeDefined();
  });

  it("operates the approve action from the keyboard", async () => {
    setToken("test-token");
    const fetchMock = stubFetch([makeDelegatedRequest(true)], {
      ok: true,
      status: 200,
      body: { ...makeDelegatedRequest(true), status: "approved" },
    });
    renderWithProviders(<ApprovalsPage />);

    const approve = await screen.findByRole("button", { name: /Approve grant/ });
    approve.focus();
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/approve"))).toBe(true);
    });
  });

  it("renders pre-existing kinds exactly as before — a secret-bound origin is no delegated request", async () => {
    stubFetch([SECRET_BOUND]);
    renderWithProviders(<ApprovalsPage />);

    expect(await screen.findByText("Capability change")).toBeDefined();
    expect(screen.queryByText("Delegated provider")).toBeNull();
    expect(screen.queryByText(/its anonymous visitors can never connect/)).toBeNull();
    expect(screen.getByText("HIGH RISK")).toBeDefined();
  });
});
