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
 * `userOid` is Entra's pairwise `sub`: stable, and an attribution dead end — it
 * resolves to nobody, for anyone, ever. So these assertions are about which of
 * the two halves the operator actually reads.
 */
const APP_ID = "11111111-1111-4111-8111-111111111111";
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
    stubFetch([call({ userName: null, userEmail: null })]);
    renderAudit();
    expect(await screen.findByText(OPAQUE)).toBeDefined();
  });

  it("names the platform-minted principals instead of making the reader decode them", async () => {
    stubFetch([
      call({ userOid: "anon", userName: null, userEmail: null }),
      call({ userOid: "pw_AbC7xQ9z", userName: null, userEmail: null }),
    ]);
    renderAudit();
    expect(await screen.findByText("anonymous")).toBeDefined();
    expect(screen.getByText("shared password")).toBeDefined();
  });

  it("filters on the captured label, not only the id", async () => {
    stubFetch([call(), call({ userOid: "other", userName: "Bob Builder", userEmail: null })]);
    renderAudit();
    expect(await screen.findByText("Alice Anders")).toBeDefined();

    await userEvent.type(screen.getByPlaceholderText(/Filter by app/i), "bob builder");
    expect(screen.getByText("Bob Builder")).toBeDefined();
    // The whole point: an operator searches for a colleague by name, because the
    // id they would otherwise have to paste is the thing this screen removed.
    expect(screen.queryByText("Alice Anders")).toBeNull();
  });
});
