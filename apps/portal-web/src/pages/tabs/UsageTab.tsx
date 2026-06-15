import { Card, Grid, Group, SimpleGrid, Stack, Text } from "@mantine/core";
import type { App } from "@helix/shared";
import { Bars, Meter } from "../../components/charts";
import { Eyebrow, PreviewBadge, Stat } from "../../components/primitives";
import { fmtCount } from "../../lib/format";
import { previewUsageFor } from "../../preview/previewData";

/** PREVIEW — per-app metering arrives with the M4 gateway. */
export function UsageTab({ app }: { app: App }) {
  const u = previewUsageFor(app.slug);
  const pct = Math.round((u.tokDay / u.tokBudget) * 100);

  return (
    <Stack gap={18} className="az-stagger">
      <Group>
        <PreviewBadge />
        <Text size="sm" c="dark.2">
          Mock numbers — real metering is recorded per gateway call (app, user, capability, cost)
          once the M4 gateway lands.
        </Text>
      </Group>

      <SimpleGrid cols={{ base: 2, md: 4 }} spacing={18}>
        <Card>
          <Stat icon="bolt" label="Requests / day" value={fmtCount(u.reqDay)} sub="gateway calls" />
        </Card>
        <Card>
          <Stat
            icon="cpu"
            label="Tokens / day"
            value={fmtCount(u.tokDay)}
            tone={pct > 78 ? "var(--az-warn)" : undefined}
            sub={`${pct}% of ${fmtCount(u.tokBudget)} budget`}
          />
        </Card>
        <Card>
          <Stat icon="db" label="Storage" value="—" sub="app + user scope" />
        </Card>
        <Card>
          <Stat
            icon="alert"
            label="Error rate"
            value={`${u.errRate}%`}
            tone={u.errRate > 1 ? "var(--az-warn)" : undefined}
            sub="last 24h"
          />
        </Card>
      </SimpleGrid>

      <Grid gap={18}>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Card>
            <Eyebrow mb={14}>Requests · 16 intervals</Eyebrow>
            <Bars data={u.spark} h={120} />
          </Card>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Card>
            <Eyebrow mb={14}>Token consumption · 16 intervals</Eyebrow>
            <Bars data={u.spark.map((x) => x * 1.3 + 5)} h={120} color="var(--az-info)" />
          </Card>
        </Grid.Col>
      </Grid>

      <Card>
        <Eyebrow mb={14}>Capability breakdown · today</Eyebrow>
        {(
          [
            ["llm.chat", "var(--az-info)", 62],
            ["data.read / write", "var(--az-acc)", 24],
            ["mcp.*", "var(--az-violet)", 9],
            ["llm.embeddings", "var(--az-warn)", 5],
          ] as Array<[string, string, number]>
        ).map(([k, color, p]) => (
          <Group key={k} gap={14} py={8} wrap="nowrap">
            <Text className="az-mono" fz={12.5} c="dark.1" w={160}>
              {k}
            </Text>
            <div style={{ flex: 1 }}>
              <Meter pct={p} tone={color} />
            </div>
            <Text className="az-mono az-tnum" fz={12.5} c="dark.2" w={40} ta="right">
              {p}%
            </Text>
          </Group>
        ))}
      </Card>
    </Stack>
  );
}
