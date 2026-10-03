import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { VisitorSummary } from "@azx-pbc/shared";
import { renderWithProviders } from "./render";
import { bucketLabel, pctDelta, VisitorsSection } from "../pages/tabs/VisitorsSection";

const APP_ID = "11111111-1111-4111-8111-111111111111";

function summary(over: Partial<VisitorSummary> = {}): VisitorSummary {
  return {
    appId: APP_ID,
    range: "30d",
    current: { visits: 1200, uniqueVisitors: 480 },
    prior: { visits: 1000, uniqueVisitors: 500 },
    series: [
      { bucket: "2026-09-30T00:00:00.000Z", visits: 40, uniqueVisitors: 20 },
      { bucket: "2026-10-01T00:00:00.000Z", visits: 50, uniqueVisitors: 25 },
    ],
    locations: [
      {
        country: "US",
        countryName: "United States",
        region: "Washington",
        visitors: 300,
        visits: 700,
      },
      { country: "CA", countryName: "Canada", region: null, visitors: 100, visits: 300 },
    ],
    otherLocations: { visits: 150, uniqueVisitors: 50 },
    unresolved: { visits: 50, uniqueVisitors: 30 },
    geo: {
      available: true,
      reason: null,
      attribution: { text: "IP geolocation by DB-IP", url: "https://db-ip.com" },
    },
    ...over,
  };
}

function stubVisitors(body: (range: string) => VisitorSummary) {
  const spy = vi.fn((url: string) => {
    const m = /\/visitors\?range=(\w+)/.exec(String(url));
    if (m) return Promise.resolve({ ok: true, status: 200, json: async () => body(m[1]!) });
    return new Promise(() => {});
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("VisitorsSection", () => {
  it("shows the KPIs with deltas against the prior window", async () => {
    stubVisitors(() => summary());
    renderWithProviders(<VisitorsSection slug="demo" />);
    expect(await screen.findByText("1.2k")).toBeDefined();
    expect(screen.getByText("+20.0% vs prior 30d")).toBeDefined();
    expect(screen.getByText("480")).toBeDefined();
    expect(screen.getByText("-4.0% vs prior 30d")).toBeDefined();
    // 1200/480 = 2.50 now, 1000/500 = 2.00 before.
    expect(screen.getByText("2.50")).toBeDefined();
    expect(screen.getByText("+0.50 vs prior 30d")).toBeDefined();
  });

  it("lists locations, the rolled-up rest, unresolved traffic, and the licence notice", async () => {
    stubVisitors(() => summary());
    renderWithProviders(<VisitorsSection slug="demo" />);
    expect(await screen.findByText("Washington, United States")).toBeDefined();
    expect(screen.getByText("Canada")).toBeDefined();
    expect(screen.getByText("Other locations")).toBeDefined();
    expect(screen.getByText("Unresolved or private network")).toBeDefined();
    const notice = screen.getByText("IP geolocation by DB-IP");
    expect(notice.getAttribute("href")).toBe("https://db-ip.com");
  });

  it("says location is unavailable instead of showing an empty table", async () => {
    stubVisitors(() =>
      summary({
        locations: [],
        otherLocations: { visits: 0, uniqueVisitors: 0 },
        unresolved: { visits: 1200, uniqueVisitors: 480 },
        geo: {
          available: false,
          reason: "No geolocation database is configured.",
          attribution: null,
        },
      }),
    );
    renderWithProviders(<VisitorsSection slug="demo" />);
    expect(
      await screen.findByText(/Approximate location is unavailable\. No geolocation database/),
    ).toBeDefined();
    expect(screen.queryByText("Unresolved or private network")).toBeNull();
  });

  it("shows the window when it has visitors but no visit started in it", async () => {
    stubVisitors(() =>
      summary({
        current: { visits: 0, uniqueVisitors: 1 },
        locations: [],
        otherLocations: { visits: 0, uniqueVisitors: 0 },
        unresolved: { visits: 0, uniqueVisitors: 1 },
      }),
    );
    renderWithProviders(<VisitorsSection slug="demo" />);
    expect(await screen.findByText("Daily visits")).toBeDefined();
    expect(screen.queryByText(/No visits in this window yet/)).toBeNull();
    expect(screen.getByText("Unresolved or private network")).toBeDefined();
  });

  it("labels each day by its UTC date, whatever the browser's zone", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    try {
      // The browser's own formatting would say Oct 1 here.
      expect(new Date("2026-10-02T00:00:00.000Z").toLocaleDateString("en-US")).toBe("10/1/2026");
      expect(bucketLabel("2026-10-02T00:00:00.000Z")).toBe("Oct 2");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("explains an empty window", async () => {
    stubVisitors(() =>
      summary({
        current: { visits: 0, uniqueVisitors: 0 },
        prior: { visits: 0, uniqueVisitors: 0 },
        locations: [],
        otherLocations: { visits: 0, uniqueVisitors: 0 },
        unresolved: { visits: 0, uniqueVisitors: 0 },
      }),
    );
    renderWithProviders(<VisitorsSection slug="demo" />);
    expect(await screen.findByText(/No visits in this window yet/)).toBeDefined();
  });

  it("refetches for the selected range", async () => {
    const spy = stubVisitors((range) => summary({ range: range as VisitorSummary["range"] }));
    renderWithProviders(<VisitorsSection slug="demo" />);
    await screen.findByText("1.2k");
    await userEvent.click(screen.getByText("7d"));
    expect(await screen.findByText("+20.0% vs prior 7d")).toBeDefined();
    expect(spy.mock.calls.some(([u]) => String(u).includes("/visitors?range=7d"))).toBe(true);
  });
});

describe("pctDelta", () => {
  it.each([
    [110, 100, "+10.0%"],
    [90, 100, "-10.0%"],
    [100, 100, "±0.0%"],
    [5, 0, "new"],
    [0, 0, "±0%"],
  ])("%d vs %d → %s", (cur, prior, out) => {
    expect(pctDelta(cur, prior)).toBe(out);
  });
});
