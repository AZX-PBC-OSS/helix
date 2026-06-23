import { Button, Card, Center, Grid, Group, Loader, SimpleGrid, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { appsQuery, platformUsageQuery } from "../../api/queries";
import { useAuth } from "../../auth/AuthProvider";
import { Bars, Donut, Meter } from "../../components/charts";
import { Eyebrow, Hint, PageHead, Stat, ToneBadge } from "../../components/primitives";
import { fmtCount, fmtUsd } from "../../lib/format";

/** Distinct colors for the capability-mix donut, cycled by index. */
const CAP_COLORS = [
  "var(--az-info)",
  "var(--az-acc)",
  "var(--az-violet)",
  "var(--az-warn)",
  "var(--az-bad)",
];

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
  const { authenticated, login, loginAvailable } = useAuth();
  const apps = useQuery(appsQuery);
  const platform = useQuery({ ...platformUsageQuery, enabled: authenticated });

  const total = apps.data?.length ?? 0;
  const live = apps.data?.filter((a) => !a.archivedAt && a.currentVersionId).length ?? 0;

  const head = (
    <PageHead
      eyebrow="Control plane"
      title="Platform"
      sub="Usage across every hosted app. The gateway is the single choke point, so these numbers are exact — not sampled telemetry. Spend is estimated at current model rates."
    />
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
          Platform-wide usage requires a signed-in actor.
        </Hint>
      </div>
    );
  }

  const p = platform.data;
  const maxAppTokens = Math.max(...(p?.byApp.map((a) => a.tokens) ?? [0]), 1);
  const mixTotal = p?.capabilityMix.reduce((s, c) => s + c.tokens, 0) ?? 0;

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
            value={fmtUsd(p?.totals.costMTD ?? 0)}
            sub="estimated"
          />
        </Card>
        <Card>
          <Stat icon="user" label="Active users" value={p?.totals.activeUsers ?? 0} />
        </Card>
      </SimpleGrid>

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
          <Grid gap={18} mb={18}>
            <Grid.Col span={{ base: 12, md: 4 }}>
              <Card>
                <Group justify="space-between" mb={14}>
                  <Eyebrow>LLM tokens · 14 days</Eyebrow>
                  <DeltaBadge delta={wowDelta(p.tokens14d)} />
                </Group>
                <Bars data={p.tokens14d} h={150} color="var(--az-info)" />
              </Card>
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 4 }}>
              <Card>
                <Group justify="space-between" mb={14}>
                  <Eyebrow>Spend · 14 days</Eyebrow>
                  <DeltaBadge delta={wowDelta(p.cost14d)} />
                </Group>
                <Bars data={p.cost14d} h={150} color="var(--az-acc)" />
              </Card>
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 4 }}>
              <Card>
                <Group justify="space-between" mb={14}>
                  <Eyebrow>Gateway requests · 14 days</Eyebrow>
                  <DeltaBadge delta={wowDelta(p.requests14d)} />
                </Group>
                <Bars data={p.requests14d} h={150} />
              </Card>
            </Grid.Col>
          </Grid>

          <Grid gap={18}>
            <Grid.Col span={{ base: 12, md: 7 }}>
              <Card>
                <Eyebrow mb={16}>Spend by app · month to date</Eyebrow>
                {p.byApp.length === 0 && (
                  <Text c="dark.2" fz={13} py={8}>
                    No gateway traffic yet this month.
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
                <Eyebrow mb={16}>Capability mix · MTD</Eyebrow>
                <Group justify="center" py={8} pb={18}>
                  <Donut
                    segments={p.capabilityMix.map(
                      (c, i) =>
                        [c.capability, c.tokens, CAP_COLORS[i % CAP_COLORS.length]!] as const,
                    )}
                    centerTop={fmtCount(p.totals.tokensMTD)}
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
