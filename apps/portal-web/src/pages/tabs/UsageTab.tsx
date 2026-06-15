import { Button, Card, Center, Grid, Group, Loader, SimpleGrid, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { App } from "@helix/shared";
import { manifestQuery, usageQuery } from "../../api/queries";
import { useAuth } from "../../auth/AuthProvider";
import { Bars, Meter } from "../../components/charts";
import { Eyebrow, Hint, Stat, ToneBadge } from "../../components/primitives";
import { Icon } from "../../components/Icon";
import { fmtCount } from "../../lib/format";

/** Outcome → badge tone, over the real gateway vocabulary. */
const OUTCOME_TONE = {
  ok: "live",
  error: "bad",
  refusal: "warn",
  quota_blocked: "warn",
} as const;

/** Per-app gateway metering, today (window=1). Real `gateway_calls` data. */
export function UsageTab({ app }: { app: App }) {
  const { authenticated, login, loginAvailable } = useAuth();
  // The usage endpoint is bearer-gated; only fetch once signed in.
  const usage = useQuery({ ...usageQuery(app.slug, 1), enabled: authenticated });
  // Manifest read is open — used to show the budget the tokens are measured against.
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
  const budget = manifest.data?.capabilities.llm?.tokensPerDay;
  const pct = budget ? Math.round((totalTokens / budget) * 100) : null;
  const errPct = Math.round(u.errorRate * 1000) / 10;
  const tokenSeries = u.series.map((s) => s.tokens);
  const requestSeries = u.series.map((s) => s.requests);

  return (
    <Stack gap={18} className="az-stagger">
      <SimpleGrid cols={{ base: 2, md: 4 }} spacing={18}>
        <Card>
          <Stat
            icon="bolt"
            label="Requests · today"
            value={fmtCount(u.requests)}
            sub="gateway calls"
          />
        </Card>
        <Card>
          <Stat
            icon="cpu"
            label="Tokens · today"
            value={fmtCount(totalTokens)}
            tone={pct !== null && pct > 78 ? "var(--az-warn)" : undefined}
            sub={
              budget
                ? `${pct}% of ${fmtCount(budget)} daily cap`
                : `${fmtCount(u.inputTokens)} in · ${fmtCount(u.outputTokens)} out`
            }
          />
        </Card>
        <Card>
          <Stat icon="db" label="Storage" value="—" sub="app + user scope (v1)" />
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

      {u.requests === 0 ? (
        <Hint icon="bolt" tone="info">
          No gateway calls today yet. Grant the LLM capability and exercise the app — metering fills
          in here within seconds.
        </Hint>
      ) : (
        <>
          <Grid gap={18}>
            <Grid.Col span={{ base: 12, md: 6 }}>
              <Card>
                <Eyebrow mb={14}>Requests · hourly</Eyebrow>
                <Bars data={requestSeries} h={120} />
              </Card>
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 6 }}>
              <Card>
                <Eyebrow mb={14}>Token consumption · hourly</Eyebrow>
                <Bars data={tokenSeries} h={120} color="var(--az-info)" />
              </Card>
            </Grid.Col>
          </Grid>

          <Card>
            <Group justify="space-between" mb={14}>
              <Eyebrow>Model breakdown · today</Eyebrow>
              <Group gap={8}>
                {Object.entries(u.byOutcome).map(([outcome, count]) => (
                  <ToneBadge
                    key={outcome}
                    tone={OUTCOME_TONE[outcome as keyof typeof OUTCOME_TONE] ?? "neutral"}
                  >
                    {outcome} · {count}
                  </ToneBadge>
                ))}
              </Group>
            </Group>
            {u.byModel.map((m) => {
              const p = totalTokens ? Math.round((m.tokens / totalTokens) * 100) : 0;
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
                </Group>
              );
            })}
          </Card>
        </>
      )}

      <Group gap={6} c="dark.3">
        <Icon name="shield" size={12} />
        <Text size="xs" c="dark.3">
          Metered per gateway call; tokens, not cost — pricing isn't modelled yet.
        </Text>
      </Group>
    </Stack>
  );
}
