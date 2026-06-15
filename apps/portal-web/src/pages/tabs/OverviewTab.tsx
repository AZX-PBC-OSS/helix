import { Box, Button, Card, Grid, Group, Stack, Text } from "@mantine/core";
import type { App, Version } from "@helix/shared";
import { Bars } from "../../components/charts";
import { Eyebrow, Hint, KV, Stat } from "../../components/primitives";
import { timeAgo } from "../../lib/format";
import { awaitingPromote, deployCadence, liveVersion } from "../../lib/appStatus";
import { useDeploy } from "../../modals/DeployContext";

/** All real: registry + version history, no metering required. */
export function OverviewTab({ app, versions }: { app: App; versions: Version[] }) {
  const live = liveVersion(app, versions);
  const pending = awaitingPromote(app, versions);
  const last = versions[0];
  const { openDeploy } = useDeploy();

  return (
    <Grid gap={18} className="az-stagger">
      <Grid.Col span={{ base: 12, md: 7 }}>
        <Stack gap={18}>
          <Group grow gap={18}>
            <Card>
              <Stat
                icon="layers"
                label="Versions"
                value={versions.length}
                sub="immutable, in Blob"
              />
            </Card>
            <Card>
              <Stat
                icon="dot"
                label="Serving"
                value={live ? `v${live.number}` : "—"}
                tone={live ? "var(--az-live)" : undefined}
                sub={live ? "registry pointer" : "nothing promoted yet"}
              />
            </Card>
            <Card>
              <Stat
                icon="clock"
                label="Last deploy"
                value={last ? timeAgo(last.createdAt).replace(" ago", "") : "—"}
                sub={last ? `v${last.number} · ${last.status}` : "deploy from the CLI"}
              />
            </Card>
          </Group>

          <Card>
            <Group justify="space-between" mb={14}>
              <Eyebrow>Deploy cadence · since first version</Eyebrow>
            </Group>
            <Bars data={deployCadence(versions)} h={92} />
          </Card>

          {pending && (
            <Hint
              icon="layers"
              tone="violet"
              action={
                <Button variant="default" size="xs" onClick={() => openDeploy(app.slug)}>
                  Review preview
                </Button>
              }
            >
              <b>v{pending.number}</b> is deployed to preview and awaiting promotion. Live traffic
              is unaffected until you promote.
            </Hint>
          )}
          {versions.length === 0 && (
            <Hint icon="upload" tone="info">
              No versions yet — run <span className="az-mono">azx deploy</span> from the app
              directory, or drop a zip in the Deploy dialog.
            </Hint>
          )}
        </Stack>
      </Grid.Col>

      <Grid.Col span={{ base: 12, md: 5 }}>
        <Stack gap={18}>
          <Card>
            <Eyebrow mb={4}>Registry record</Eyebrow>
            <KV k="Slug" mono>
              {app.slug}
            </KV>
            <KV k="App id" mono>
              {app.id.slice(0, 8)}…
            </KV>
            <KV k="Visibility" mono>
              {app.visibility.mode}
              {app.visibility.mode === "group" ? `:${app.visibility.groupId}` : ""}
            </KV>
            <KV k="Created" mono>
              {new Date(app.createdAt).toLocaleDateString()}
            </KV>
            <KV k="Updated" mono>
              {timeAgo(app.updatedAt)}
            </KV>
          </Card>

          <Card>
            <Eyebrow mb={4}>How serving works</Eyebrow>
            <Box mt={8}>
              <Text size="sm" c="dark.1" lh={1.55}>
                The edge resolves <span className="az-mono">{app.slug}.*</span> against a read-only
                registry projection and streams assets for the pinned version straight from Blob —
                promote and rollback only ever flip that pointer.
              </Text>
            </Box>
          </Card>
        </Stack>
      </Grid.Col>
    </Grid>
  );
}
