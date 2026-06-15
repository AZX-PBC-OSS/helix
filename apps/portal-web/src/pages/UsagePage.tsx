import { Button, Card, Center, Grid, Group, Loader, SimpleGrid, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { platformUsageQuery } from "../api/queries";
import { useAuth } from "../auth/AuthProvider";
import { Bars, Meter } from "../components/charts";
import { Eyebrow, Hint, PageHead, Stat } from "../components/primitives";
import { fmtCount } from "../lib/format";

/**
 * Workspace usage. There's no per-owner ownership model yet (v1 RBAC), so this
 * shows the same platform-wide rollup as the admin Platform page — labelled
 * honestly rather than faking per-owner scoping.
 */
export function UsagePage() {
  const { authenticated, login, loginAvailable } = useAuth();
  const usage = useQuery({ ...platformUsageQuery, enabled: authenticated });

  const head = (
    <PageHead
      eyebrow="Workspace"
      title="Usage"
      sub="Aggregate gateway activity — requests and LLM tokens. Per-owner scoping lands with RBAC (v1); today this is the platform-wide rollup."
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
          <Stat icon="cpu" label="LLM tokens MTD" value={fmtCount(p.totals.tokensMTD)} />
        </Card>
        <Card>
          <Stat icon="db" label="Storage" value="—" sub="app + user scope (v1)" />
        </Card>
        <Card>
          <Stat icon="user" label="Active users" value={p.totals.activeUsers} />
        </Card>
      </SimpleGrid>

      <Grid gap={18} mb={18}>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Card>
            <Eyebrow mb={14}>Requests · 14 days</Eyebrow>
            <Bars data={p.requests14d} h={130} />
          </Card>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Card>
            <Eyebrow mb={14}>LLM tokens · 14 days</Eyebrow>
            <Bars data={p.tokens14d} h={130} color="var(--az-info)" />
          </Card>
        </Grid.Col>
      </Grid>

      <Card>
        <Eyebrow mb={14}>By app · tokens month-to-date</Eyebrow>
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
              <Meter pct={(a.tokens / maxAppTokens) * 100} tone="var(--az-info)" />
            </div>
            <Text className="az-mono az-tnum" fz={12.5} w={80} ta="right" c="dark.1">
              {fmtCount(a.tokens)}
            </Text>
          </Group>
        ))}
      </Card>
    </div>
  );
}
