import { SegmentedControl } from "@mantine/core";
import { AreaChart } from "@mantine/charts";
import type { UsageSeriesPoint } from "@azx-pbc/shared";
import { fmtCount, fmtUsd } from "../lib/format";

/**
 * Shared usage visualization — a real Recharts-backed trend (via @mantine/charts)
 * plus the metric/range switchers. Replaces the old decorative `Bars`: axes,
 * value + time labels, and tooltips, and it reads correctly on sparse data
 * (a low/flat line, not a solid block). Dollars are the default metric.
 */

export type UsageMetric = "cost" | "tokens" | "requests";

const METRIC_META: Record<UsageMetric, { label: string; color: string }> = {
  cost: { label: "Spend", color: "var(--az-acc)" },
  tokens: { label: "Tokens", color: "var(--az-info)" },
  requests: { label: "Requests", color: "var(--az-mag)" },
};

/** Hourly ranges get clock-time ticks; daily ranges get calendar-day ticks. */
function bucketLabel(iso: string, grain: "hour" | "day"): string {
  const d = new Date(iso);
  return grain === "hour"
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function MetricToggle({
  value,
  onChange,
}: {
  value: UsageMetric;
  onChange: (m: UsageMetric) => void;
}) {
  return (
    <SegmentedControl
      size="xs"
      value={value}
      onChange={(v) => onChange(v as UsageMetric)}
      data={[
        { value: "cost", label: "Spend" },
        { value: "tokens", label: "Tokens" },
        { value: "requests", label: "Requests" },
      ]}
    />
  );
}

export function RangeControl<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (r: T) => void;
  options: readonly T[];
}) {
  return (
    <SegmentedControl
      size="xs"
      value={value}
      onChange={(v) => onChange(v as T)}
      data={options.map((o) => ({ value: o, label: o }))}
    />
  );
}

/**
 * Trend over a dense usage series. `metric` selects the plotted value, color,
 * and y-axis/tooltip formatter; `grain` (derived from the range by the caller)
 * picks the x-axis tick style.
 */
export function UsageTrendChart({
  series,
  metric,
  grain,
  h = 220,
}: {
  series: UsageSeriesPoint[];
  metric: UsageMetric;
  grain: "hour" | "day";
  h?: number;
}) {
  const meta = METRIC_META[metric];
  const data = series.map((p) => ({
    label: bucketLabel(p.bucket, grain),
    cost: p.costUsd,
    tokens: p.tokens,
    requests: p.requests,
  }));
  return (
    <AreaChart
      h={h}
      data={data}
      dataKey="label"
      series={[{ name: metric, label: meta.label, color: meta.color }]}
      valueFormatter={metric === "cost" ? fmtUsd : fmtCount}
      curveType="monotone"
      withDots={false}
      gridAxis="y"
      tickLine="y"
      areaProps={{ fillOpacity: 0.16 }}
    />
  );
}
