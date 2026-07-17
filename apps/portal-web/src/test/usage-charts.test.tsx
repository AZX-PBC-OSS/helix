import { useState } from "react";
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UsageSeriesPoint } from "@azx-pbc/shared";
import { renderWithProviders } from "./render";
import { MetricToggle, UsageTrendChart, type UsageMetric } from "../components/usageCharts";

const SERIES: UsageSeriesPoint[] = [
  { bucket: "2026-06-23T10:00:00.000Z", costUsd: 0.05, tokens: 1200, requests: 3 },
  { bucket: "2026-06-23T11:00:00.000Z", costUsd: 0, tokens: 0, requests: 0 },
];

describe("usage charts", () => {
  it("renders the trend without throwing for a sparse series", () => {
    // Recharts' ResponsiveContainer has no layout in jsdom; we assert the
    // component mounts (no throw) rather than on rendered pixels.
    expect(() =>
      renderWithProviders(<UsageTrendChart series={SERIES} metric="cost" grain="hour" />),
    ).not.toThrow();
  });

  it("MetricToggle switches the active metric", async () => {
    function Harness() {
      const [metric, setMetric] = useState<UsageMetric>("cost");
      return (
        <>
          <span data-testid="metric">{metric}</span>
          <MetricToggle value={metric} onChange={setMetric} />
        </>
      );
    }
    renderWithProviders(<Harness />);
    const user = userEvent.setup();

    expect(screen.getByTestId("metric").textContent).toBe("cost");
    await user.click(screen.getByText("Tokens"));
    expect(screen.getByTestId("metric").textContent).toBe("tokens");
    await user.click(screen.getByText("Requests"));
    expect(screen.getByTestId("metric").textContent).toBe("requests");
  });
});
