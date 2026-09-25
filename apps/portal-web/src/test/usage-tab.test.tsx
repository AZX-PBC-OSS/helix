import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { App, AppManifest, UsageSummary } from "@azx-pbc/shared";
import { renderWithProviders } from "./render";
import { UsageTab } from "../pages/tabs/UsageTab";
import { AuthProvider } from "../auth/AuthProvider";
import { clearToken, setToken } from "../auth/tokenStore";

const SLUG = "demo";

function makeApp(): App {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slug: SLUG,
    displayName: "Demo",
    visibility: { mode: "internal" },
    currentVersionId: null,
    archivedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function summary(byOutcome: Record<string, number>): UsageSummary {
  return {
    appId: "11111111-1111-4111-8111-111111111111",
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

/** Serve the usage GET; the manifest read (the daily-cap line) gets the bare minimum. */
function stubFetch(usage: UsageSummary): void {
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
      return new Promise(() => {}); // /me — pending forever
    }),
  );
}

function renderUsage() {
  setToken("t");
  return renderWithProviders(
    <AuthProvider>
      <UsageTab app={makeApp()} />
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
