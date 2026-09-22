import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GatewayCall } from "@azx-pbc/shared";
import { renderWithProviders } from "./render";
import { AuditPage } from "../pages/admin/AuditPage";
import { AuthProvider } from "../auth/AuthProvider";
import { clearToken, setToken } from "../auth/tokenStore";

/**
 * The audit log's user column.
 *
 * `userOid` is an opaque principal id — Entra's `oid` claim since ADR-0048 (a
 * pairwise `sub` on rows older than that): stable, and an attribution dead
 * end, because the platform holds no Graph `/users` grant and so it resolves
 * to nobody, for anyone, ever. These assertions are about which of the two
 * halves the operator actually reads.
 */
const APP_ID = "11111111-1111-4111-8111-111111111111";
// A pre-re-base pairwise sub: the historical shape these rows really carry.
const OPAQUE = "VKn3n7f8eM3JdjdHi6CSFsRTRIBtt1Nob_iPGjKAmPA";

let seq = 0;
function call(over: Partial<GatewayCall> = {}): GatewayCall {
  seq += 1;
  return {
    id: crypto.randomUUID(),
    appId: APP_ID,
    slug: "demo",
    userOid: OPAQUE,
    userName: "Alice Anders",
    userEmail: "alice@azx.dev",
    userKind: "user",
    capability: "llm",
    model: "claude-opus-4-8",
    inputTokens: 10 * seq,
    outputTokens: 5,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0.01,
    durationMs: 120,
    statusCode: null,
    stopReason: "end_turn",
    errorDetail: null,
    path: null,
    method: null,
    outcome: "ok",
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function stubFetch(rows: GatewayCall[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (typeof url === "string" && url.includes("/gateway/audit")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ rows }) });
      }
      return new Promise(() => {}); // /me — pending forever
    }),
  );
}

function renderAudit() {
  setToken("t");
  return renderWithProviders(
    <AuthProvider>
      <AuditPage />
    </AuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
});

describe("AuditPage user attribution", () => {
  it("leads with the captured name and address, not the opaque subject", async () => {
    stubFetch([call()]);
    renderAudit();
    expect(await screen.findByText("Alice Anders")).toBeDefined();
    expect(screen.getByText("alice@azx.dev")).toBeDefined();
    // The subject is still reachable — it is what a support thread would quote,
    // and what the row is keyed by — but it is not what the cell renders.
    expect(screen.queryByText(OPAQUE)).toBeNull();
    expect(document.querySelector(`[title="${OPAQUE}"]`)).not.toBeNull();
  });

  it("falls back to the subject when no claims were captured", async () => {
    // Rows written before the columns existed, and any principal the IdP gave no
    // claims for. Showing the raw id is a last resort, not a label.
    stubFetch([call({ userName: null, userEmail: null, userKind: "user" })]);
    renderAudit();
    expect(await screen.findByText(OPAQUE)).toBeDefined();
  });

  it("names the platform-minted principals instead of making the reader decode them", async () => {
    stubFetch([
      call({ userOid: "anon", userName: null, userEmail: null, userKind: "anon" }),
      call({ userOid: "pw_AbC7xQ9z", userName: null, userEmail: null, userKind: "password" }),
    ]);
    renderAudit();
    expect(await screen.findByText("anonymous")).toBeDefined();
    expect(screen.getByText("shared password")).toBeDefined();
  });

  it("does NOT call a real subject a shared-password visitor just because it starts with pw_", async () => {
    // The regression this branch would otherwise have shipped. Entra's `sub` is
    // 32 random bytes in base64url, an alphabet that includes `_`, so ~1 subject
    // in 262,144 begins `pw_` — verified by drawing real-shaped subjects until
    // one did. The old `startsWith("pw_")` test rendered that person's calls as
    // an anonymous shared-password visitor. Reading the recorded kind is what
    // makes the shape of the id irrelevant.
    const collider = "pw_3n7f8eM3JdjdHi6CSFsRTRIBtt1Nob_iPGjKAmPA";
    stubFetch([
      call({ userOid: collider, userName: "Dana Doe", userEmail: null, userKind: "user" }),
    ]);
    renderAudit();
    expect(await screen.findByText("Dana Doe")).toBeDefined();
    expect(screen.queryByText("shared password")).toBeNull();
  });

  it("leaves a pre-userKind row unlabelled rather than mislabelled", async () => {
    // Historical rows carry no kind. Falling through to the raw subject is the
    // point: an old row can no longer be MIS-labelled, only left opaque. `anon`
    // still resolves, because that one is an exact sentinel, not a prefix guess.
    stubFetch([
      call({
        userOid: "pw_3n7f8eM3JdjdHi6CSFsRTRIBtt1Nob_iPGjKAmPA",
        userName: null,
        userEmail: null,
        userKind: null,
      }),
      call({ userOid: "anon", userName: null, userEmail: null, userKind: null }),
    ]);
    renderAudit();
    expect(await screen.findByText("pw_3n7f8eM3JdjdHi6CSFsRTRIBtt1Nob_iPGjKAmPA")).toBeDefined();
    expect(screen.getByText("anonymous")).toBeDefined();
    expect(screen.queryByText("shared password")).toBeNull();
  });

  it("filters on the captured label, not only the id", async () => {
    stubFetch([
      call(),
      call({ userOid: "other", userName: "Bob Builder", userEmail: null, userKind: "user" }),
    ]);
    renderAudit();
    expect(await screen.findByText("Alice Anders")).toBeDefined();

    await userEvent.type(screen.getByPlaceholderText(/Filter by app/i), "bob builder");
    expect(screen.getByText("Bob Builder")).toBeDefined();
    // The whole point: an operator searches for a colleague by name, because the
    // id they would otherwise have to paste is the thing this screen removed.
    expect(screen.queryByText("Alice Anders")).toBeNull();
  });
});

describe("AuditPage failure detail", () => {
  it("reveals the failure reason only when the row is expanded", async () => {
    stubFetch([call({ outcome: "error", errorDetail: "upstream 500: overloaded" })]);
    renderAudit();
    await screen.findByText("Alice Anders");
    // One click away, not stashed in a tooltip an operator has no reason to
    // suspect: the reason is absent from the collapsed table, then leads the
    // detail card once the row is open.
    expect(screen.queryByText(/overloaded/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show call detail" }));
    expect(screen.getByText(/overloaded/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Hide call detail" })).toBeDefined();
  });

  it("shows the full call record on expand — request line, status, accounting, identity", async () => {
    stubFetch([
      call({
        capability: "fetch",
        model: "api.github.com",
        method: "POST",
        path: "/repos/azxlabs/helix/issues",
        outcome: "error",
        statusCode: 502,
        errorDetail: "egress request failed: upstream connect timeout",
        // The fixture's `10 * seq` counts calls across the whole file, so pin
        // the accounting this test asserts on.
        inputTokens: 10,
      }),
    ]);
    renderAudit();
    await screen.findByText("api.github.com");
    await userEvent.click(screen.getByRole("button", { name: "Show call detail" }));
    expect(screen.getByText("POST /repos/azxlabs/helix/issues")).toBeDefined();
    expect(screen.getByText("502")).toBeDefined();
    expect(screen.getByText(/connect timeout/)).toBeDefined();
    expect(screen.getByText("10 in · 5 out")).toBeDefined();
    // The raw subject — what a support thread would quote — renders in the
    // detail as copyable text, while the user cell still leads with the
    // captured claims and keeps the subject on `title`.
    expect(screen.getByText(OPAQUE)).toBeDefined();
    expect(document.querySelector(`[title="${OPAQUE}"]`)).not.toBeNull();
  });

  it("matches the upstream error text in the filter box", async () => {
    stubFetch([call(), call({ outcome: "error", errorDetail: "connection reset by peer" })]);
    renderAudit();
    expect(await screen.findAllByRole("button", { name: "Show call detail" })).toHaveLength(2);
    // The error string renders nowhere until a row is expanded — the filter
    // still finds it. Filter finds, expand reveals.
    await userEvent.type(screen.getByPlaceholderText(/Filter by/i), "connection reset");
    expect(screen.getAllByRole("button", { name: "Show call detail" })).toHaveLength(1);
  });

  it("keeps the first row open when a second is expanded", async () => {
    stubFetch([
      call({ outcome: "error", errorDetail: "first failure" }),
      call({ outcome: "error", errorDetail: "second failure" }),
    ]);
    renderAudit();
    await userEvent.click(
      (await screen.findAllByRole("button", { name: "Show call detail" }))[0] as HTMLElement,
    );
    expect(screen.getByText(/first failure/)).toBeDefined();
    await userEvent.click(
      (await screen.findAllByRole("button", { name: "Show call detail" }))[0] as HTMLElement,
    );
    // The point of a set over the Data tab's single-open idiom: two failures
    // open at once, because comparing them is this screen's job.
    expect(screen.getByText(/first failure/)).toBeDefined();
    expect(screen.getByText(/second failure/)).toBeDefined();
    // Closing one leaves the other where it is.
    await userEvent.click(
      screen.getAllByRole("button", { name: "Hide call detail" })[0] as HTMLElement,
    );
    expect(screen.queryByText(/first failure/)).toBeNull();
    expect(screen.getByText(/second failure/)).toBeDefined();
  });

  it("breaks the not-delivered count down by outcome", async () => {
    stubFetch([
      call(),
      call({ outcome: "error", errorDetail: "boom" }),
      call({ outcome: "error", errorDetail: "boom" }),
      call({ outcome: "quota_blocked" }),
    ]);
    renderAudit();
    // Same `!== "ok"` stance as the count itself, so the two can't drift.
    expect(await screen.findByText("2 error · 1 quota")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
  });
});
