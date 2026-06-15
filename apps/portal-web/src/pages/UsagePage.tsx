import { Card, Grid, Group, SimpleGrid, Text } from "@mantine/core";
import { Bars, Meter } from "../components/charts";
import { Eyebrow, PageHead, PreviewBadge, Stat } from "../components/primitives";
import { PREVIEW_PLATFORM } from "../preview/previewData";

/** PREVIEW — aggregate owner usage; metering is the M4 gateway. */
export function UsagePage() {
  const p = PREVIEW_PLATFORM;
  return (
    <div className="az-stagger">
      <PageHead
        eyebrow="Workspace"
        title={
          <Group gap={12}>
            Usage <PreviewBadge />
          </Group>
        }
        sub="Aggregate gateway activity across the apps you own — requests, LLM tokens, and storage. Mock data until M4 metering."
      />

      <SimpleGrid cols={{ base: 2, md: 4 }} spacing={18} mb={18}>
        <Card>
          <Stat icon="bolt" label="Requests / day" value="29.5" unit="k" />
        </Card>
        <Card>
          <Stat
            icon="cpu"
            label="LLM tokens / day"
            value="4.61"
            unit="M"
            sub="63% of granted budget"
            tone="var(--az-warn)"
          />
        </Card>
        <Card>
          <Stat icon="db" label="Storage" value="1.74" unit="GB" />
        </Card>
        <Card>
          <Stat icon="user" label="Active users (7d)" value="116" />
        </Card>
      </SimpleGrid>

      <Grid gap={18} mb={18}>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Card>
            <Eyebrow mb={14}>Requests · 14 days (k)</Eyebrow>
            <Bars data={p.requests14d} h={130} />
          </Card>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Card>
            <Eyebrow mb={14}>LLM tokens · 14 days (M)</Eyebrow>
            <Bars data={p.tokens14d} h={130} color="var(--az-info)" />
          </Card>
        </Grid.Col>
      </Grid>

      <Card>
        <Eyebrow mb={14}>By app · cost month-to-date</Eyebrow>
        {p.costByApp.map((c) => (
          <Group key={c.app} gap={14} py={9} wrap="nowrap">
            <Text fz={13} fw={500} w={150}>
              {c.app}
            </Text>
            <div style={{ flex: 1 }}>
              <Meter pct={c.pct * 2.6} tone="var(--az-info)" />
            </div>
            <Text className="az-mono az-tnum" fz={12.5} w={70} ta="right" c="dark.1">
              ${c.cost.toFixed(2)}
            </Text>
          </Group>
        ))}
      </Card>
    </div>
  );
}
