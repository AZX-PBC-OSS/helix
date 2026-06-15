import { Card, Grid, Group, SimpleGrid, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { appsQuery } from "../../api/queries";
import { Bars, Donut, Meter } from "../../components/charts";
import { Eyebrow, PageHead, PreviewBadge, Stat, ToneBadge } from "../../components/primitives";
import { PREVIEW_PLATFORM } from "../../preview/previewData";

/** PREVIEW (cost/usage) over a REAL app count — platform-wide rollup, M4+. */
export function PlatformPage() {
  const apps = useQuery(appsQuery);
  const p = PREVIEW_PLATFORM;
  const total = apps.data?.length ?? 0;
  const live = apps.data?.filter((a) => !a.archivedAt && a.currentVersionId).length ?? 0;

  return (
    <div className="az-stagger">
      <PageHead
        eyebrow="Control plane"
        title={
          <Group gap={12}>
            Platform <PreviewBadge />
          </Group>
        }
        sub="Usage and cost across every hosted app. The gateway is the single choke point, so these numbers will be exact — not sampled telemetry. Cost/token data is mock until M4."
      />

      <SimpleGrid cols={{ base: 2, md: 5 }} spacing={18} mb={18}>
        <Card>
          <Stat icon="grid" label="Apps" value={total} sub={`${live} live (real)`} />
        </Card>
        <Card>
          <Stat icon="bolt" label="Requests MTD" value={p.totals.requestsMTD} />
        </Card>
        <Card>
          <Stat icon="cpu" label="Tokens MTD" value={p.totals.tokensMTD} />
        </Card>
        <Card>
          <Stat
            icon="key"
            label="Cost MTD"
            value={`$${p.totals.mtdCost.toFixed(0)}`}
            tone="var(--az-acc)"
          />
        </Card>
        <Card>
          <Stat icon="user" label="Active users" value={p.totals.activeUsers} />
        </Card>
      </SimpleGrid>

      <Grid gap={18} mb={18}>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Card>
            <Group justify="space-between" mb={14}>
              <Eyebrow>LLM tokens · 14 days (M)</Eyebrow>
              <ToneBadge tone="acc" icon="arrowU">
                +38% wk
              </ToneBadge>
            </Group>
            <Bars data={p.tokens14d} h={150} color="var(--az-info)" />
          </Card>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Card>
            <Group justify="space-between" mb={14}>
              <Eyebrow>Gateway requests · 14 days (k)</Eyebrow>
              <ToneBadge tone="acc" icon="arrowU">
                +24% wk
              </ToneBadge>
            </Group>
            <Bars data={p.requests14d} h={150} />
          </Card>
        </Grid.Col>
      </Grid>

      <Grid gap={18}>
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Card>
            <Eyebrow mb={16}>Cost by app · month to date</Eyebrow>
            {p.costByApp.map((c) => (
              <Group key={c.app} gap={14} py={9} wrap="nowrap">
                <Text fz={13} fw={500} w={140}>
                  {c.app}
                </Text>
                <div style={{ flex: 1 }}>
                  <Meter pct={c.pct * 2.6} />
                </div>
                <Text className="az-mono az-tnum" fz={13} w={64} ta="right">
                  ${c.cost.toFixed(2)}
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
                segments={p.capabilityMix}
                centerTop={`$${p.totals.mtdCost.toFixed(0)}`}
                centerBottom="MTD"
              />
            </Group>
            <SimpleGrid cols={2} spacing={8}>
              {p.capabilityMix.map(([label, v, color]) => (
                <Group key={label} gap={8}>
                  <span style={{ width: 9, height: 9, borderRadius: 3, background: color }} />
                  <Text fz={12.5} c="dark.1" style={{ flex: 1 }}>
                    {label}
                  </Text>
                  <Text className="az-mono" fz={12.5} fw={600}>
                    {v}%
                  </Text>
                </Group>
              ))}
            </SimpleGrid>
          </Card>
        </Grid.Col>
      </Grid>

      <Stack mt={18} gap={0}>
        <Text size="xs" c="dark.3">
          App and live counts come from the real registry; everything else on this page is mock
          until M4 metering and M5 cost rollups.
        </Text>
      </Stack>
    </div>
  );
}
