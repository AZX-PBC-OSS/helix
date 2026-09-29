import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Delta } from "@azx-pbc/shared";
import { renderWithProviders } from "./render";
import { DeltaList, riskBreakdown } from "../components/deltas";

/**
 * The approval card renders each delta as a row of chips (capability, the
 * change, its own risk, help). These cover the path shapes the classifier can
 * emit, the per-delta risk chip and its legacy absence, and the tooltip's
 * plain-English copy.
 */

afterEach(() => vi.unstubAllGlobals());

const render = (deltas: Delta[]) => renderWithProviders(<DeltaList deltas={deltas} />);

describe("DeltaList chips", () => {
  it("renders a membership add as capability + item + per-delta risk", () => {
    render([{ path: "mcp[+pagerduty]", to: "pagerduty", risk: "high" }]);
    expect(screen.getByText("MCP tool servers")).toBeDefined();
    expect(screen.getByText("pagerduty")).toBeDefined();
    expect(screen.getByText("HIGH RISK")).toBeDefined();
  });

  it("renders a scalar change with the field's own units", () => {
    render([{ path: "llm.dollarsPerDay", from: 50, to: 200, risk: "med" }]);
    expect(screen.getByText("LLM spend budget")).toBeDefined();
    expect(screen.getByText("$50.00/day")).toBeDefined();
    expect(screen.getByText("$200.00/day")).toBeDefined();
    expect(screen.getByText("ELEVATED")).toBeDefined();
  });

  it("formats the three budget units", () => {
    render([
      { path: "data.writesPerDay", from: 10_000, to: 50_000, risk: "med" },
      { path: "data.bytesPerDay", from: 50_000_000, to: 100_000_000, risk: "med" },
      { path: "fetch.requestsPerDay", from: 10_000, to: 20_000, risk: "med" },
    ]);
    expect(screen.getByText("10.0k writes/day")).toBeDefined();
    expect(screen.getByText("47.7 MB/day")).toBeDefined();
    expect(screen.getByText("95.4 MB/day")).toBeDefined();
    expect(screen.getByText("10.0k reqs/day")).toBeDefined();
    expect(screen.getByText("20.0k reqs/day")).toBeDefined();
  });

  it("renders visibility as a from → to of modes", () => {
    render([{ path: "visibility", from: "internal", to: "public", risk: "high" }]);
    expect(screen.getByText("App visibility")).toBeDefined();
    expect(screen.getByText("internal")).toBeDefined();
    expect(screen.getByText("public")).toBeDefined();
    expect(screen.getByText("HIGH RISK")).toBeDefined();
  });

  it("abbreviates a long group-id list in the chip (the full list stays in the tooltip path)", () => {
    render([
      {
        path: "visibility",
        from: "group:g1,g2,g3,g4,g5",
        to: "public",
        risk: "high",
      },
    ]);
    expect(screen.getByText("group: g1, g2, g3 …+2 more")).toBeDefined();
  });

  it("splits a provider-bound origin into origin + 'via <ref>'", () => {
    render([
      {
        path: "fetch.origins[+https://api.asana.com→provider:asana]",
        to: "https://api.asana.com→provider:asana",
        risk: "high",
      },
    ]);
    expect(screen.getByText("Delegated provider connection")).toBeDefined();
    expect(screen.getByText("https://api.asana.com")).toBeDefined();
    expect(screen.getByText("asana")).toBeDefined();
  });

  it("renders a secret-bound origin with its secret name", () => {
    render([
      {
        path: "fetch.origins[+https://api.github.com→secret:gh-pat]",
        to: "https://api.github.com→secret:gh-pat",
        risk: "high",
      },
    ]);
    expect(screen.getByText("Proxied origin + stored secret")).toBeDefined();
    expect(screen.getByText("gh-pat")).toBeDefined();
  });

  it("renders a keyless origin plainly", () => {
    render([
      { path: "fetch.origins[+https://httpbin.org]", to: "https://httpbin.org", risk: "med" },
    ]);
    expect(screen.getByText("Proxied origin")).toBeDefined();
    expect(screen.getByText("https://httpbin.org")).toBeDefined();
  });

  it("shows no risk chip for legacy deltas that predate the field", () => {
    render([{ path: "mcp[+pagerduty]", to: "pagerduty" }]);
    expect(screen.getByText("MCP tool servers")).toBeDefined();
    expect(screen.queryByText("HIGH RISK")).toBeNull();
  });

  it("survives a bracket-containing item — the ARRAY_PATH trap", () => {
    render([{ path: "data.sharedReadPrefixes[-cfg[-v2]]", from: "cfg[-v2]", risk: "low" }]);
    expect(screen.getByText("Shared key prefixes")).toBeDefined();
    expect(screen.getByText("cfg[-v2]")).toBeDefined();
    expect(screen.queryByText("HIGH RISK")).toBeNull();
  });
});

describe("DeltaList tooltip", () => {
  it("explains the capability in plain English, with this change's rating", async () => {
    render([{ path: "mcp[+pagerduty]", to: "pagerduty", risk: "high" }]);
    await userEvent.hover(screen.getByLabelText("What this change means"));
    expect(await screen.findByText("What this grants")).toBeDefined();
    expect(screen.getByText(/call tools on the named MCP server/)).toBeDefined();
    expect(screen.getByText("Why it can be risky")).toBeDefined();
    expect(screen.getByText(/Rated HIGH RISK\./)).toBeDefined();
    // The raw path stays on the record inside the tooltip.
    expect(screen.getByText("mcp[+pagerduty]")).toBeDefined();
  });

  it("omits the rating section on legacy deltas but still explains the capability", async () => {
    render([{ path: "mcp[+pagerduty]", to: "pagerduty" }]);
    await userEvent.hover(screen.getByLabelText("What this change means"));
    expect(await screen.findByText(/call tools on the named MCP server/)).toBeDefined();
    expect(screen.queryByText("This change")).toBeNull();
  });
});

describe("riskBreakdown", () => {
  it("counts each level, highest first", () => {
    const deltas: Delta[] = [
      { path: "mcp[+github]", risk: "high" },
      { path: "llm.models[+gpt-5]", risk: "med" },
      { path: "data.sharedReadPrefixes[+cfg:]", risk: "low" },
    ];
    expect(riskBreakdown(deltas)).toBe(
      "Rated by the highest of this request's 3 changes: 1 high risk, 1 elevated, 1 routine.",
    );
  });

  it("is null when no delta carries a risk (legacy rows)", () => {
    expect(riskBreakdown([{ path: "mcp[+pagerduty]" }])).toBeNull();
  });
});
