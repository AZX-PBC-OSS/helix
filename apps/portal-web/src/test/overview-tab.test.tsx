import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  App,
  AppManifest,
  PortalMeResponse,
  UsageRange,
  UsageSummary,
  Version,
} from "@azx-pbc/shared";
import { renderWithProviders } from "./render";
import { AuthProvider } from "../auth/AuthProvider";
import { setToken, clearToken } from "../auth/tokenStore";
import { OverviewTab } from "../pages/tabs/OverviewTab";

/**
 * The Overview tab is the owner's triage surface. Two suites hold it up:
 *
 * - the description edit affordance, mirroring the server's `ownsApp`
 *   (owner-id match or admin) — the server remains the real gate
 *   (apps/portal/src/plugins/auth.ts `ownsApp`, exercised in ownership.test.ts);
 * - the runtime attention signals, read off the gateway ledger (refusals,
 *   failures, silence) and the manifest summary.
 *
 * A third suite pins the 2026 UX-review removals (stat cards, the serving
 * explainer, Slug/App id, the deploy-cadence chart) so the chrome stays out.
 */

const APP: App = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "cost-explorer",
  displayName: "Cost Explorer",
  description: "Tracks Q3 spend by team.",
  visibility: { mode: "internal" },
  currentVersionId: null,
  archivedAt: null,
  createdAt: "2026-06-11T00:00:00.000Z",
  updatedAt: "2026-06-11T00:00:00.000Z",
  url: "https://cost-explorer.apps.example.com",
  ownerId: "oid-owner",
  ownerName: "Alice Anders",
};

const VERSIONS: Version[] = [];

function me(overrides: Partial<PortalMeResponse>): PortalMeResponse {
  return {
    sub: "who@azx.dev",
    via: "oidc",
    isAdmin: false,
    canSearchDirectory: true,
    ...overrides,
  };
}

function usage(range: UsageRange, over: Partial<UsageSummary> = {}): UsageSummary {
  return {
    appId: APP.id,
    range,
    requests: 120,
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 1.23,
    latencyP95Ms: 800,
    errorRate: 0,
    byOutcome: { ok: 120 },
    byModel: [],
    series: [],
    today: { tokens: 10, costUsd: 0.5 },
    ...over,
  };
}

const MANIFEST: AppManifest = {
  app: "cost-explorer",
  visibility: { mode: "internal" },
  capabilities: {
    llm: { models: ["claude-haiku-4-5"], dollarsPerDay: 5 },
    data: {
      user: true,
      collections: ["contacts"],
      sharedRead: [],
      sharedWrite: [],
      sharedReadPrefixes: [],
      sharedWritePrefixes: [],
    },
    mcp: [],
    externalOrigins: [],
  },
};

function stubFetch(
  meResponse: PortalMeResponse,
  opts: { usage?: Partial<UsageSummary>; manifest?: AppManifest } = {},
) {
  const patches: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/v1/me")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => meResponse });
      }
      if (url.includes("/api/v1/auth/config")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ issuer: "https://idp.test", cliClientId: "azx-cli" }),
        });
      }
      if (url.includes("/approvals")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      }
      if (url.includes("/usage")) {
        const range = url.includes("range=7d") ? "7d" : "24h";
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => usage(range, opts.usage),
        });
      }
      if (url.includes("/manifest")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => opts.manifest ?? MANIFEST,
        });
      }
      if (init?.method === "PATCH") {
        patches.push({ url, body: JSON.parse(String(init.body)) });
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ...APP, description: JSON.parse(String(init.body)).description }),
        });
      }
      return new Promise(() => {}); // anything else: pending, as in the other suites
    }),
  );
  return patches;
}

function renderTab(app: App = APP) {
  renderWithProviders(
    <AuthProvider>
      <OverviewTab app={app} versions={VERSIONS} />
    </AuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToken();
});

describe("OverviewTab description edit", () => {
  it("lets the owner edit and save the description via PATCH", async () => {
    setToken("t");
    const patches = stubFetch(me({ oid: "oid-owner" }));
    renderTab();

    const edit = await screen.findByRole("button", { name: /edit description/i });
    await userEvent.click(edit);

    const box = screen.getByRole("textbox", { name: /description/i });
    expect((box as HTMLTextAreaElement).value).toBe("Tracks Q3 spend by team.");
    await userEvent.clear(box);
    await userEvent.type(box, "A brand-new summary.");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await vi.waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]?.url).toContain("/api/v1/apps/cost-explorer");
    expect(patches[0]?.body).toEqual({ description: "A brand-new summary." });
    // Saving closes the editor — no stuck form after a clean round-trip.
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
  });

  it("offers no edit affordance to a signed-in non-owner", async () => {
    setToken("t");
    stubFetch(me({ oid: "oid-someone-else" }));
    renderTab();

    expect(await screen.findByText("Tracks Q3 spend by team.")).toBeDefined();
    expect(screen.queryByRole("button", { name: /edit description/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /add description/i })).toBeNull();
  });

  it("seats a platform admin even when they do not own the app", async () => {
    setToken("t");
    stubFetch(me({ oid: "oid-admin", isAdmin: true }));
    renderTab();

    expect(await screen.findByRole("button", { name: /edit description/i })).toBeDefined();
  });

  it("invites a description when the app has none", async () => {
    setToken("t");
    stubFetch(me({ oid: "oid-owner" }));
    renderWithProviders(
      <AuthProvider>
        <OverviewTab app={{ ...APP, description: undefined }} versions={VERSIONS} />
      </AuthProvider>,
    );

    expect(await screen.findByText("No description yet.")).toBeDefined();
    expect(await screen.findByRole("button", { name: /add description/i })).toBeDefined();
  });
});

describe("OverviewTab runtime attention", () => {
  it("reports budget refusals with the count and a path to usage", async () => {
    setToken("t");
    stubFetch(me({ oid: "oid-someone-else" }), {
      usage: { requests: 120, byOutcome: { ok: 110, quota_blocked: 10 }, errorRate: 0 },
    });
    renderTab();

    expect(await screen.findByText(/refused today/)).toBeDefined();
    expect(screen.getByText("10 calls")).toBeDefined();
    const link = screen.getByRole("link", { name: /view usage/i });
    expect(link.getAttribute("href")).toContain("tab=usage");
  });

  it("reports policy refusals with a path to the manifest", async () => {
    setToken("t");
    stubFetch(me({ oid: "oid-someone-else" }), {
      usage: { requests: 120, byOutcome: { ok: 118, forbidden: 2 }, errorRate: 0 },
    });
    renderTab();

    expect(await screen.findByText(/refused by policy/)).toBeDefined();
    const link = screen.getByRole("link", { name: /review capabilities/i });
    expect(link.getAttribute("href")).toContain("tab=capabilities");
  });

  it("reports unconnected callers as a consent problem, violet", async () => {
    setToken("t");
    stubFetch(me({ oid: "oid-someone-else" }), {
      usage: { requests: 120, byOutcome: { ok: 119, connection_required: 1 }, errorRate: 0 },
    });
    renderTab();

    expect(await screen.findByText(/isn't connected to/)).toBeDefined();
  });

  it("reports a failing call rate above threshold", async () => {
    setToken("t");
    stubFetch(me({ oid: "oid-someone-else" }), {
      usage: { requests: 100, byOutcome: { ok: 90, error: 10 }, errorRate: 0.1 },
    });
    renderTab();

    expect(await screen.findByText(/calls failed/)).toBeDefined();
  });

  it("stays quiet below the failing-call threshold", async () => {
    setToken("t");
    // A single flaky call in a thousand is noise, not an attention item.
    stubFetch(me({ oid: "oid-someone-else" }), {
      usage: { requests: 1000, byOutcome: { ok: 999, error: 1 }, errorRate: 0.001 },
    });
    renderTab();

    // When the activity card renders, this window's usage has landed — so if
    // the quiet fixture were over threshold, the hint would be up by now.
    await screen.findByText("Gateway activity · last 7 days");
    expect(screen.queryByText(/calls failed/)).toBeNull();
  });

  it("reports a live app with no traffic this week", async () => {
    setToken("t");
    stubFetch(me({ oid: "oid-someone-else" }), {
      usage: { requests: 0, byOutcome: {}, errorRate: 0, costUsd: 0 },
    });
    renderTab({ ...APP, currentVersionId: "22222222-2222-4222-8222-222222222222" });

    expect(await screen.findByText(/No gateway calls in 7 days/)).toBeDefined();
  });

  it("keeps the activity strip to summary depth over the 7d window", async () => {
    setToken("t");
    stubFetch(me({ oid: "oid-someone-else" }), {
      usage: { requests: 120, costUsd: 1.23 },
    });
    renderTab();

    expect(await screen.findByText("Gateway activity · last 7 days")).toBeDefined();
    expect(screen.getByText("120")).toBeDefined();
    expect(screen.getByText("$1.23")).toBeDefined();
    // The Usage tab owns the deep views: no range controls, no model table here.
    expect(screen.queryByText("Model breakdown")).toBeNull();
  });
});

describe("OverviewTab capabilities summary", () => {
  it("summarises the manifest's grants one line per capability", async () => {
    setToken("t");
    stubFetch(me({ oid: "oid-someone-else" }));
    renderTab();

    expect(await screen.findByText("Granted capabilities")).toBeDefined();
    expect(screen.getByText("claude-haiku-4-5 · $5.00/day")).toBeDefined();
    expect(screen.getByText("user store · 1 collection")).toBeDefined();
    const edit = screen.getByRole("link", { name: "Edit" });
    expect(edit.getAttribute("href")).toContain("tab=capabilities");
  });

  it("says so plainly when nothing is granted", async () => {
    setToken("t");
    stubFetch(me({ oid: "oid-someone-else" }), {
      manifest: {
        app: "cost-explorer",
        visibility: { mode: "internal" },
        capabilities: { mcp: [], externalOrigins: [] },
      },
    });
    renderTab();

    expect(await screen.findByText(/No gateway capabilities granted yet/)).toBeDefined();
  });
});

describe("OverviewTab chrome", () => {
  // The Aug 2026 UX review: the tab opened on a wall of platform explanation.
  // The version count lives on the Versions tab label, the live version in the
  // page header, and the serving model in the docs the Help modal points at —
  // none of it belongs on every visit. The deploy-cadence chart went with the
  // 2026 redesign: the runtime activity strip answers the same slot's question
  // ("is this app alive") with signal the cadence chart never had, and the
  // deploy rhythm is the Versions tab's own table.
  it("keeps the trimmed tab trimmed", async () => {
    setToken("t");
    stubFetch(me({ oid: "oid-someone-else" }));
    renderTab();

    await screen.findByText("Tracks Q3 spend by team.");
    for (const gone of [
      "Versions",
      "Serving",
      "Last deploy",
      "immutable, in Blob",
      "registry pointer",
      "How serving works",
      "Deploy cadence",
      "Slug",
      "App id",
    ]) {
      expect(screen.queryByText(gone), `"${gone}" should be gone`).toBeNull();
    }
    // What survived: the record card's facts, and the two cards that answer
    // "is it alive" and "what can it do". The cards arrive with their queries,
    // so wait for them rather than racing the fetch.
    expect(screen.getByText("Visibility")).toBeDefined();
    expect(await screen.findByText("Gateway activity · last 7 days")).toBeDefined();
    expect(await screen.findByText("Granted capabilities")).toBeDefined();
  });
});
