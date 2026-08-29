import { useState } from "react";
import { Button, Card, Center, Group, Loader, SimpleGrid, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import {
  priceForModel,
  USAGE_RANGES,
  type App,
  type GatewayOutcome,
  type UsageRange,
} from "@azx-pbc/shared";
import { manifestQuery, usageQuery } from "../../api/queries";
import { useAuth } from "../../auth/AuthProvider";
import { Meter } from "../../components/charts";
import {
  MetricToggle,
  RangeControl,
  UsageTrendChart,
  type UsageMetric,
} from "../../components/usageCharts";
import { Eyebrow, Hint, Stat, ToneBadge, type Tone } from "../../components/primitives";
import { Icon } from "../../components/Icon";
import { fmtCount, fmtUsd } from "../../lib/format";

/**
 * Outcome → badge tone. Typed `Record<GatewayOutcome, Tone>` so a new outcome is
 * a compile error here rather than a silent grey badge — the same guarantee
 * `OUT_META` gives on the audit page, and the point of making GATEWAY_OUTCOMES
 * the single source of truth.
 */
const OUTCOME_TONE: Record<GatewayOutcome, Tone> = {
  ok: "live",
  error: "bad",
  refusal: "warn",
  quota_blocked: "warn",
  conflict: "warn",
  forbidden: "bad",
};

/** Per-app gateway metering over a selectable range. Real `gateway_calls` data. */
export function UsageTab({ app }: { app: App }) {
  const { authenticated, login, loginAvailable } = useAuth();
  const [range, setRange] = useState<UsageRange>("24h");
  const [metric, setMetric] = useState<UsageMetric>("cost");
  // The usage endpoint is bearer-gated; only fetch once signed in.
  const usage = useQuery({ ...usageQuery(app.slug, range), enabled: authenticated });
  // Manifest read is open — used to show the daily cap the budget is measured against.
  const manifest = useQuery(manifestQuery(app.slug));

  if (!authenticated) {
    return (
      <Hint
        icon="user"
        tone="neutral"
        action={
          <Button variant="default" size="xs" onClick={login} disabled={!loginAvailable}>
            Sign in
          </Button>
        }
      >
        Sign in to view this app's gateway usage.
      </Hint>
    );
  }
  if (usage.isPending) {
    return (
      <Center py={60}>
        <Loader size="sm" />
      </Center>
    );
  }
  if (usage.isError) {
    return (
      <Hint icon="alert" tone="bad">
        Couldn't load usage: {usage.error.message}
      </Hint>
    );
  }

  const u = usage.data;
  const totalTokens = u.inputTokens + u.outputTokens;
  const errPct = Math.round(u.errorRate * 1000) / 10;
  const grain = range === "24h" ? "hour" : "day";

  // Daily-cap gauge is today-scoped (the budget the edge enforces is per day),
  // denominated in USD off the frozen per-call cost — same number the gate uses.
  const budget = manifest.data?.capabilities.llm?.dollarsPerDay;
  const capPct = budget ? Math.round((u.today.costUsd / budget) * 100) : null;

  return (
    <Stack gap={18} className="az-stagger">
      <Group justify="space-between" align="center">
        <Eyebrow>Gateway usage</Eyebrow>
        <RangeControl value={range} onChange={setRange} options={USAGE_RANGES} />
      </Group>

      <SimpleGrid cols={{ base: 2, md: 5 }} spacing={18}>
        <Card>
          <Stat icon="bolt" label="Requests" value={fmtCount(u.requests)} sub={`last ${range}`} />
        </Card>
        <Card>
          <Stat
            icon="cpu"
            label="Tokens"
            value={fmtCount(totalTokens)}
            sub={`${fmtCount(u.inputTokens)} in · ${fmtCount(u.outputTokens)} out`}
          />
        </Card>
        <Card>
          <Stat icon="db" label="Spend" value={fmtUsd(u.costUsd)} sub="estimated, current rates" />
        </Card>
        <Card>
          <Stat
            icon="bolt"
            label="Latency · p95"
            value={u.latencyP95Ms == null ? "—" : `${Math.round(u.latencyP95Ms)}ms`}
            sub="upstream round-trip"
          />
        </Card>
        <Card>
          <Stat
            icon="alert"
            label="Error rate"
            value={`${errPct}%`}
            tone={errPct > 1 ? "var(--az-warn)" : undefined}
            sub="non-ok outcomes"
          />
        </Card>
      </SimpleGrid>

      {budget && (
        <Card>
          <Group justify="space-between" mb={10}>
            <Eyebrow>Daily spend budget · today</Eyebrow>
            <Text
              className="az-mono az-tnum"
              fz={12.5}
              c={capPct! > 78 ? "var(--az-warn)" : "dark.1"}
            >
              {fmtUsd(u.today.costUsd)} / {fmtUsd(budget)} ({capPct}%)
            </Text>
          </Group>
          <Meter pct={capPct ?? 0} />
        </Card>
      )}

      <Card>
        <Group justify="space-between" mb={14}>
          <Eyebrow>Usage trend</Eyebrow>
          <MetricToggle value={metric} onChange={setMetric} />
        </Group>
        <UsageTrendChart series={u.series} metric={metric} grain={grain} />
      </Card>

      {u.requests === 0 ? (
        <Hint icon="bolt" tone="info">
          No gateway calls in this window yet. Grant the LLM capability and exercise the app —
          metering fills in here within seconds.
        </Hint>
      ) : (
        <Card>
          <Group justify="space-between" mb={14}>
            <Eyebrow>Model breakdown · last {range}</Eyebrow>
            <Group gap={8}>
              {Object.entries(u.byOutcome).map(([outcome, count]) => (
                <ToneBadge
                  key={outcome}
                  // `byOutcome` is string-keyed on the wire (z.record), not the
                  // enum, so the runtime fallback stays: during a rolling deploy
                  // the edge can write an outcome this build has never heard of.
                  // The map's own exhaustiveness is enforced by its type above.
                  tone={OUTCOME_TONE[outcome as GatewayOutcome] ?? "neutral"}
                >
                  {outcome} · {count}
                </ToneBadge>
              ))}
            </Group>
          </Group>
          {u.byModel.map((m) => {
            const p = totalTokens ? Math.round((m.tokens / totalTokens) * 100) : 0;
            const unpriced = priceForModel(m.model) === undefined;
            return (
              <Group key={m.model} gap={14} py={8} wrap="nowrap">
                <Text className="az-mono" fz={12.5} c="dark.1" w={200} style={{ flexShrink: 0 }}>
                  {m.model}
                </Text>
                <div style={{ flex: 1 }}>
                  <Meter pct={p} tone="var(--az-info)" />
                </div>
                <Text className="az-mono az-tnum" fz={12.5} c="dark.2" w={90} ta="right">
                  {fmtCount(m.tokens)} tok
                </Text>
                <Text
                  className="az-mono az-tnum"
                  fz={12.5}
                  c={unpriced ? "dark.3" : "dark.1"}
                  w={70}
                  ta="right"
                  title={unpriced ? "no rate configured for this model" : undefined}
                >
                  {unpriced ? "unpriced" : fmtUsd(m.costUsd)}
                </Text>
              </Group>
            );
          })}
        </Card>
      )}

      <Group gap={6} c="dark.3">
        <Icon name="shield" size={12} />
        <Text size="xs" c="dark.3">
          Metered per gateway call. Spend is estimated at current model rates; the daily cap is
          still token-denominated.
        </Text>
      </Group>
    </Stack>
  );
}
