import { useState } from "react";
import { Button, Card, Center, Group, Loader, SimpleGrid, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { PLATFORM_RANGES, type PlatformRange } from "@helix/shared";
import { platformUsageQuery } from "../api/queries";
import { useAuth } from "../auth/AuthProvider";
import { Meter } from "../components/charts";
import {
  MetricToggle,
  RangeControl,
  UsageTrendChart,
  type UsageMetric,
} from "../components/usageCharts";
import { Eyebrow, Hint, PageHead, Stat } from "../components/primitives";
import { fmtCount, fmtUsd } from "../lib/format";

/**
 * Workspace usage. There's no per-owner ownership model yet (v1 RBAC), so this
 * shows the same platform-wide rollup as the admin Activity page — labelled
 * honestly rather than faking per-owner scoping.
 */
export function UsagePage() {
  const { authenticated, login, loginAvailable } = useAuth();
  const [range, setRange] = useState<PlatformRange>("30d");
  const [metric, setMetric] = useState<UsageMetric>("cost");
  const usage = useQuery({ ...platformUsageQuery(range), enabled: authenticated });

  const head = (
    <PageHead eyebrow="Workspace" title="Usage" sub="Gateway spend, tokens, and requests." />
  );

  if (!authenticated) {
    return (
      <div className="az-stagger">
        {head}
        <Hint
          icon="user"
          tone="neutral"
          action={
            <Button variant="default" size="xs" onClick={login} disabled={!loginAvailable}>
              Sign in
            </Button>
          }
        >
          Sign in to view gateway usage.
        </Hint>
      </div>
    );
  }
  if (usage.isPending) {
    return (
      <div className="az-stagger">
        {head}
        <Center py={60}>
          <Loader size="sm" />
        </Center>
      </div>
    );
  }
  if (usage.isError) {
    return (
      <div className="az-stagger">
        {head}
        <Hint icon="alert" tone="bad">
          Couldn't load usage: {usage.error.message}
        </Hint>
      </div>
    );
  }

  const p = usage.data;
  const maxAppTokens = Math.max(...p.byApp.map((a) => a.tokens), 1);

  return (
    <div className="az-stagger">
      {head}

      <SimpleGrid cols={{ base: 2, md: 4 }} spacing={18} mb={18}>
        <Card>
          <Stat icon="bolt" label="Requests MTD" value={fmtCount(p.totals.requestsMTD)} />
        </Card>
        <Card>
          <Stat icon="cpu" label="Tokens MTD" value={fmtCount(p.totals.tokensMTD)} />
        </Card>
        <Card>
          <Stat icon="db" label="Spend MTD" value={fmtUsd(p.totals.costMTD)} sub="estimated" />
        </Card>
        <Card>
          <Stat icon="user" label="Active users" value={p.totals.activeUsers} />
        </Card>
      </SimpleGrid>

      <Card mb={18}>
        <Group justify="space-between" mb={14}>
          <Eyebrow>Usage trend</Eyebrow>
          <Group gap={10}>
            <MetricToggle value={metric} onChange={setMetric} />
            <RangeControl value={range} onChange={setRange} options={PLATFORM_RANGES} />
          </Group>
        </Group>
        <UsageTrendChart series={p.series} metric={metric} grain="day" h={240} />
      </Card>

      <Card>
        <Eyebrow mb={14}>By app · spend over last {range}</Eyebrow>
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
              <Meter pct={(a.tokens / maxAppTokens) * 100} tone="var(--az-info)" />
            </div>
            <Text className="az-mono az-tnum" fz={12.5} w={70} ta="right" c="dark.2">
              {fmtCount(a.tokens)}
            </Text>
            <Text className="az-mono az-tnum" fz={12.5} w={70} ta="right" c="dark.1">
              {fmtUsd(a.costUsd)}
            </Text>
          </Group>
        ))}
      </Card>
    </div>
  );
}
