import { useState } from "react";
import { Box, Card, Center, Grid, Group, Loader, SimpleGrid, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { PLATFORM_RANGES, type PlatformRange, type UsageSeriesPoint } from "@azx-pbc/shared";
import { appsQuery, platformUsageQuery } from "../../api/queries";
import { Donut, Meter } from "../../components/charts";
import {
  MetricToggle,
  RangeControl,
  UsageTrendChart,
  type UsageMetric,
} from "../../components/usageCharts";
import { Eyebrow, Hint, PageHead, Stat, ToneBadge } from "../../components/primitives";
import { fmtCount, fmtUsd } from "../../lib/format";

/**
 * Month-to-date platform spend ceiling (USD), for the display-only budget alert.
 * Configured per-deploy; the platform rollup is exact (gateway is the choke
 * point), so this is a watch line, not an enforced kill-switch. `0`/unset ⇒ no
 * ceiling shown.
 */
const PLATFORM_MONTHLY_USD_CAP = Number(
  (import.meta.env.VITE_PLATFORM_MONTHLY_USD_CAP as string | undefined) ?? 1000,
);

/** Distinct colors for the capability-mix donut, cycled by index. */
const CAP_COLORS = [
  "var(--az-info)",
  "var(--az-acc)",
  "var(--az-violet)",
  "var(--az-warn)",
  "var(--az-bad)",
];

function metricValue(p: UsageSeriesPoint, metric: UsageMetric): number {
  return metric === "cost" ? p.costUsd : metric === "tokens" ? p.tokens : p.requests;
}

/** Week-over-week % change from a daily series, or null if no prior baseline. */
function wowDelta(series: number[]): number | null {
  if (series.length < 14) return null;
  const last = series.slice(-7).reduce((s, x) => s + x, 0);
  const prev = series.slice(-14, -7).reduce((s, x) => s + x, 0);
  if (prev === 0) return null;
  return Math.round(((last - prev) / prev) * 100);
}

function DeltaBadge({ delta }: { delta: number | null }) {
  if (delta === null) return null;
  return (
    <ToneBadge
      tone={delta >= 0 ? "acc" : "warn"}
      {...(delta >= 0 ? { icon: "arrowU" as const } : {})}
    >
      {delta >= 0 ? "+" : ""}
      {delta}% wk
    </ToneBadge>
  );
}

/** Platform-wide gateway rollup over real `gateway_calls` data (architecture §8). */
export function PlatformPage() {
  const [range, setRange] = useState<PlatformRange>("30d");
  const [metric, setMetric] = useState<UsageMetric>("cost");
  const apps = useQuery(appsQuery);
  const platform = useQuery(platformUsageQuery(range));

  const total = apps.data?.length ?? 0;
  const live = apps.data?.filter((a) => !a.archivedAt && a.currentVersionId).length ?? 0;

  const head = (
    <PageHead
      eyebrow="Admin"
      title="Activity"
      sub="Spend, tokens, and requests across apps. Spend is estimated at current model rates."
    />
  );

  const p = platform.data;
  const maxAppTokens = Math.max(...(p?.byApp.map((a) => a.tokens) ?? [0]), 1);
  const mixTotal = p?.capabilityMix.reduce((s, c) => s + c.tokens, 0) ?? 0;
  const metricSeries = p?.series.map((pt) => metricValue(pt, metric)) ?? [];

  // Display-only spend-ceiling watch: MTD spend vs the configured platform cap.
  const costMTD = p?.totals.costMTD ?? 0;
  const capActive = PLATFORM_MONTHLY_USD_CAP > 0;
  const capPct = capActive ? Math.round((costMTD / PLATFORM_MONTHLY_USD_CAP) * 100) : 0;
  const capOver = capActive && costMTD >= PLATFORM_MONTHLY_USD_CAP;
  const capNear = capActive && !capOver && capPct >= 80;

  return (
    <div className="az-stagger">
      {head}

      <SimpleGrid cols={{ base: 2, md: 5 }} spacing={18} mb={18}>
        <Card>
          <Stat icon="grid" label="Apps" value={total} sub={`${live} live`} />
        </Card>
        <Card>
          <Stat icon="bolt" label="Requests MTD" value={fmtCount(p?.totals.requestsMTD ?? 0)} />
        </Card>
        <Card>
          <Stat icon="cpu" label="Tokens MTD" value={fmtCount(p?.totals.tokensMTD ?? 0)} />
        </Card>
        <Card>
          <Stat
            icon="db"
            label="Spend MTD"
            value={fmtUsd(costMTD)}
            sub={capActive ? `${capPct}% of ${fmtUsd(PLATFORM_MONTHLY_USD_CAP)} cap` : "estimated"}
            tone={capOver ? "var(--az-bad)" : capNear ? "var(--az-warn)" : undefined}
          />
        </Card>
        <Card>
          <Stat icon="user" label="Active users" value={p?.totals.activeUsers ?? 0} />
        </Card>
      </SimpleGrid>

      {(capOver || capNear) && (
        <Box mb={18}>
          <Hint icon="alert" tone={capOver ? "bad" : "warn"}>
            {capOver
              ? `Platform spend this month (${fmtUsd(costMTD)}) has reached the ${fmtUsd(PLATFORM_MONTHLY_USD_CAP)} ceiling. Per-app daily caps still apply — this is a platform-wide watch line, not an enforced cut-off.`
              : `Platform spend this month (${fmtUsd(costMTD)}) is at ${capPct}% of the ${fmtUsd(PLATFORM_MONTHLY_USD_CAP)} ceiling.`}
          </Hint>
        </Box>
      )}

      {platform.isPending ? (
        <Center py={60}>
          <Loader size="sm" />
        </Center>
      ) : platform.isError ? (
        <Hint icon="alert" tone="bad">
          Couldn't load platform usage: {platform.error.message}
        </Hint>
      ) : !p ? null : (
        <>
          <Card mb={18}>
            <Group justify="space-between" mb={14}>
              <Group gap={12}>
                <Eyebrow>Usage trend</Eyebrow>
                <DeltaBadge delta={wowDelta(metricSeries)} />
              </Group>
              <Group gap={10}>
                <MetricToggle value={metric} onChange={setMetric} />
                <RangeControl value={range} onChange={setRange} options={PLATFORM_RANGES} />
              </Group>
            </Group>
            <UsageTrendChart series={p.series} metric={metric} grain="day" h={240} />
          </Card>

          <Grid gap={18}>
            <Grid.Col span={{ base: 12, md: 7 }}>
              <Card>
                <Eyebrow mb={16}>Spend by app · last {range}</Eyebrow>
                {p.byApp.length === 0 && (
                  <Text c="dark.2" fz={13} py={8}>
                    No gateway traffic in this window.
                  </Text>
                )}
                {p.byApp.map((a) => (
                  <Group key={a.slug ?? "unknown"} gap={14} py={9} wrap="nowrap">
                    <Text fz={13} fw={500} w={150} className={a.slug ? undefined : "az-mono"}>
                      {a.slug ?? "(deleted)"}
                    </Text>
                    <div style={{ flex: 1 }}>
                      <Meter pct={(a.tokens / maxAppTokens) * 100} />
                    </div>
                    <Text className="az-mono az-tnum" fz={13} c="dark.2" w={70} ta="right">
                      {fmtCount(a.tokens)}
                    </Text>
                    <Text className="az-mono az-tnum" fz={13} w={70} ta="right">
                      {fmtUsd(a.costUsd)}
                    </Text>
                  </Group>
                ))}
              </Card>
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 5 }}>
              <Card>
                <Eyebrow mb={16}>Capability mix · last {range}</Eyebrow>
                <Group justify="center" py={8} pb={18}>
                  <Donut
                    segments={p.capabilityMix.map(
                      (c, i) =>
                        [c.capability, c.tokens, CAP_COLORS[i % CAP_COLORS.length]!] as const,
                    )}
                    centerTop={fmtCount(mixTotal)}
                    centerBottom="TOKENS"
                  />
                </Group>
                <SimpleGrid cols={2} spacing={8}>
                  {p.capabilityMix.map((c, i) => (
                    <Group key={c.capability} gap={8}>
                      <span
                        style={{
                          width: 9,
                          height: 9,
                          borderRadius: 3,
                          background: CAP_COLORS[i % CAP_COLORS.length],
                        }}
                      />
                      <Text fz={12.5} c="dark.1" style={{ flex: 1 }}>
                        {c.capability}
                      </Text>
                      <Text className="az-mono" fz={12.5} c="dark.2">
                        {fmtUsd(c.costUsd)}
                      </Text>
                      <Text className="az-mono" fz={12.5} fw={600}>
                        {mixTotal ? Math.round((c.tokens / mixTotal) * 100) : 0}%
                      </Text>
                    </Group>
                  ))}
                </SimpleGrid>
              </Card>
            </Grid.Col>
          </Grid>
        </>
      )}

      <Stack mt={18} gap={0}>
        <Text size="xs" c="dark.3">
          App and live counts come from the registry; usage is aggregated from the gateway ledger.
        </Text>
      </Stack>
    </div>
  );
}
