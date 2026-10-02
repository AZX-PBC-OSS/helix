import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  App,
  AppManifest,
  GatewayAuditPage,
  GatewayCall,
  UsageSummary,
} from "@azx-pbc/shared";
import { renderWithProviders } from "./render";
import { UsageTab } from "../pages/tabs/UsageTab";
import { AuthProvider } from "../auth/AuthProvider";
import { clearToken, setToken } from "../auth/tokenStore";

const SLUG = "demo";
const APP_ID = "11111111-1111-4111-8111-111111111111";

function makeApp(over: Partial<App> = {}): App {
  return {
    id: APP_ID,
    slug: SLUG,
    displayName: "Demo",
    visibility: { mode: "internal" },
    currentVersionId: null,
    archivedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

function summary(byOutcome: Record<string, number>): UsageSummary {
  return {
    appId: APP_ID,
    range: "24h",
    requests: 6,
    inputTokens: 1500,
    outputTokens: 2500,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0.07,
    latencyP95Ms: null,
    errorRate: 0.5,
    byOutcome,
    byModel: [],
    series: [],
    today: { tokens: 4000, costUsd: 0.07 },
  };
}

function callRow(over: Partial<GatewayCall> = {}): GatewayCall {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    appId: APP_ID,
    slug: SLUG,
    userOid: "oid-caller",
    userName: "Calla Ranked",
    userEmail: "caller@azx.io",
    userKind: "user",
    capability: "llm",
    model: "claude-opus-4-8",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0.01,
    durationMs: 120,
    statusCode: null,
    stopReason: null,
    // What the server nulls for a non-admin caller — the default fixture's shape.
    errorDetail: null,
    path: null,
    method: null,
    outcome: "ok",
    createdAt: new Date().toISOString(),
    ...over,
  };
}

/**
 * Serve the usage GET; the manifest read (the daily-cap line) gets the bare
 * minimum. `opts.me` answers /api/v1/me (otherwise it stays pending, so the
 * caller is neither owner nor admin); `opts.audit` answers the recent-calls
 * feed — absent means the endpoint is never even asked, because the query is
 * disabled for a non-owner.
 */
function stubFetch(
  usage: UsageSummary,
  opts: { me?: Record<string, unknown>; audit?: { rows: GatewayCall[] } } = {},
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (typeof url === "string" && url.includes("/usage?range=")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => usage });
      }
      if (typeof url === "string" && url.endsWith("/manifest")) {
        const m: AppManifest = {
          app: SLUG,
          visibility: { mode: "internal" },
          capabilities: { mcp: [], externalOrigins: [] },
        };
        return Promise.resolve({ ok: true, status: 200, json: async () => m });
      }
      if (typeof url === "string" && url.includes("/audit?limit=")) {
        const page: GatewayAuditPage = { rows: opts.audit?.rows ?? [] };
        return Promise.resolve({ ok: true, status: 200, json: async () => page });
      }
      if (typeof url === "string" && url.endsWith("/me") && opts.me) {
        return Promise.resolve({ ok: true, status: 200, json: async () => opts.me });
      }
      return new Promise(() => {}); // /me — pending forever
    }),
  );
}

function renderUsage(app: App = makeApp()) {
  setToken("t");
  return renderWithProviders(
    <AuthProvider>
      <UsageTab app={app} />
    </AuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
});

describe("UsageTab outcome tones", () => {
  it("renders connection_required with its own tone, distinct from refusal", async () => {
    // Criterion 50's usage-rollup leg: "user not connected" may not read as
    // policy refusal. The badge text is the raw ledger outcome, so the label
    // already differs — the pinned tone makes the two visually distinct too
    // (violet, the provider-bound color, versus refusal's warn).
    stubFetch(summary({ ok: 3, connection_required: 2, refusal: 1 }));
    renderUsage();
    const connect = await screen.findByText("connection_required · 2");
    const refusal = screen.getByText("refusal · 1");
    expect(connect.style.color).toBe("var(--az-violet)");
    expect(refusal.style.color).toBe("var(--az-warn)");
    expect(connect.style.color).not.toBe(refusal.style.color);
  });
});

describe("UsageTab recent calls", () => {
  it("shows a signed-in non-owner aggregates only, and says who sees the feed", async () => {
    // /me answers for someone who is neither the owner nor an admin: the card
    // is absent, and the absence is explained rather than silent.
    stubFetch(summary({ ok: 6 }), {
      me: { sub: "u", via: "oidc", oid: "oid-someone-else", isAdmin: false },
    });
    renderUsage(makeApp({ ownerId: "oid-owner" }));
    expect(
      await screen.findByText("Per-call history is visible to the app's owner."),
    ).toBeDefined();
    expect(screen.queryByText("Recent calls")).toBeNull();
  });

  it("never asks the server for the feed when the viewer cannot have it", async () => {
    const fetchSpy = vi.fn((url: string) => {
      if (typeof url === "string" && url.includes("/usage?range=")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => summary({ ok: 6 }),
        });
      }
      if (typeof url === "string" && url.endsWith("/manifest")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            app: SLUG,
            visibility: { mode: "internal" },
            capabilities: { mcp: [], externalOrigins: [] },
          }),
        });
      }
      if (typeof url === "string" && url.endsWith("/me")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ sub: "u", via: "oidc", oid: "oid-someone-else", isAdmin: false }),
        });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal("fetch", fetchSpy);
    renderUsage(makeApp({ ownerId: "oid-owner" }));
    await screen.findByText("Per-call history is visible to the app's owner.");
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes("/audit?limit="))).toBe(false);
    // The Visitors section is owner-or-admin too (ADR-0050).
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes("/visitors?range="))).toBe(false);
    expect(screen.queryByText("Visitors")).toBeNull();
  });

  it("shows the owner the app's calls, without the admin-only failure text", async () => {
    stubFetch(summary({ ok: 6 }), {
      me: { sub: "u", via: "oidc", oid: "oid-owner", isAdmin: false },
      audit: {
        rows: [
          callRow({ outcome: "error" }),
          callRow({ id: "33333333-3333-4333-8333-333333333333", userName: "Bob Builder" }),
        ],
      },
    });
    renderUsage(makeApp({ ownerId: "oid-owner" }));
    expect(await screen.findByText("Recent calls")).toBeDefined();
    expect(screen.getByText("Calla Ranked")).toBeDefined();
    expect(screen.getByText("Bob Builder")).toBeDefined();
    // The feed is the app's own rows: no App column to repeat the slug.
    expect(screen.queryByText("App")).toBeNull();
    // Expand the failure: outcome and accounting render, but the upstream error
    // text — nulled server-side for a non-admin owner — never does.
    await userEvent.click(
      screen.getAllByRole("button", { name: "Show call detail" })[0] as HTMLElement,
    );
    expect(screen.getByText("Subject")).toBeDefined();
    expect(screen.getByText("oid-caller")).toBeDefined();
    expect(screen.queryByText("Why it failed")).toBeNull();
  });

  it("points an admin at the audit log for the full failure detail", async () => {
    stubFetch(summary({ ok: 6 }), {
      me: { sub: "u", via: "oidc", oid: "oid-someone-else", isAdmin: true },
      audit: { rows: [callRow({ outcome: "error", errorDetail: "upstream 401: bad key" })] },
    });
    renderUsage(makeApp({ ownerId: "oid-owner" }));
    expect(await screen.findByText("Recent calls")).toBeDefined();
    const link = screen.getByRole("link", { name: /full failure detail/i });
    expect(link.getAttribute("href")).toBe("/admin/audit");
    // The admin's copy of the feed carries errorDetail — expanding shows it.
    await userEvent.click(screen.getByRole("button", { name: "Show call detail" }));
    expect(screen.getByText("Why it failed")).toBeDefined();
    expect(screen.getByText(/bad key/)).toBeDefined();
  });
});
