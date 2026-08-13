import { describe, expect, it, vi, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import type { ApprovalRequest } from "@azx-pbc/shared";
import { renderWithProviders } from "./render";
import { ApprovalsPage } from "../pages/admin/ApprovalsPage";

/**
 * Pending requests never expire (ADR-0038), so the queue carries the whole
 * burden of making an un-reviewed request harder to ignore the longer it sits.
 * These cover the two halves of that: the escalating age badge, and the
 * oldest-first sort that keeps a stale request off the bottom of the list.
 */

const DAY = 86_400_000;

function makeRequest(id: string, ageDays: number, risk: ApprovalRequest["risk"]): ApprovalRequest {
  return {
    id,
    appId: crypto.randomUUID(),
    appSlug: `app-${id}`,
    status: "pending",
    risk,
    deltas: [{ path: "llm.tokenBudget", from: 100_000, to: 500_000 }],
    baseSnapshot: {},
    requestedBy: "someone@example.com",
    // Relative to the real clock, so no timer mocking is needed.
    createdAt: new Date(Date.now() - ageDays * DAY).toISOString(),
  };
}

const QUEUE = [
  // Served newest-first, as the API does — the page is what re-sorts.
  makeRequest("fresh", 2, "low"),
  makeRequest("ageing", 9, "med"),
  makeRequest("stale", 34, "high"),
];

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Only the queue call is routed; anything else stays pending, as it hangs rather than 404s. */
function stubFetch(queue: ApprovalRequest[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/v1/approvals")) return Promise.resolve(jsonResponse(queue));
      return new Promise<Response>(() => {});
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("ApprovalsPage", () => {
  it("labels each request with how long it has been pending", async () => {
    stubFetch(QUEUE);
    renderWithProviders(<ApprovalsPage />);
    expect(await screen.findByText("PENDING 34D")).toBeDefined();
    expect(screen.getByText("PENDING 9D")).toBeDefined();
    expect(screen.getByText("PENDING 2D")).toBeDefined();
  });

  /**
   * The drift this fixes: the API sorts `createdAt desc`, so the request nobody
   * has looked at for a month sinks to the bottom of the queue.
   */
  it("puts the oldest request first, whatever order the API returned", async () => {
    stubFetch(QUEUE);
    renderWithProviders(<ApprovalsPage />);
    await screen.findByText("PENDING 34D");
    const ages = screen.getAllByText(/^PENDING /).map((el) => el.textContent);
    expect(ages).toEqual(["PENDING 34D", "PENDING 9D", "PENDING 2D"]);
  });

  it("summarises the backlog's age in the header", async () => {
    stubFetch(QUEUE);
    renderWithProviders(<ApprovalsPage />);
    expect(await screen.findByText("3 pending")).toBeDefined();
    expect(screen.getByText("oldest 34d")).toBeDefined();
  });

  it("renders a request filed today without a negative or blank age", async () => {
    stubFetch([makeRequest("today", 0, "low")]);
    renderWithProviders(<ApprovalsPage />);
    expect(await screen.findByText("PENDING <1D")).toBeDefined();
  });

  it("shows the empty state and no age summary when the queue is clear", async () => {
    stubFetch([]);
    renderWithProviders(<ApprovalsPage />);
    expect(await screen.findByText("Queue clear")).toBeDefined();
    expect(screen.queryByText(/^oldest /)).toBeNull();
  });
});
