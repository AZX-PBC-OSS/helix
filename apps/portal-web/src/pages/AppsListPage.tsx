import { useMemo, useState } from "react";
import { Link } from "react-router";
import {
  Box,
  Button,
  Card,
  Center,
  Code,
  Group,
  Loader,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { App } from "@azx-pbc/shared";
import { appsQuery, versionsQuery } from "../api/queries";
import { Icon } from "../components/Icon";
import { Sparkline } from "../components/charts";
import {
  CopyBtn,
  Eyebrow,
  Hint,
  PageHead,
  StatusLine,
  ToneBadge,
  VisibilityBadge,
} from "../components/primitives";
import { timeAgo } from "../lib/format";
import { useDeployment } from "../lib/deployment";
import { appStatus, awaitingPromote, deployCadence, liveVersion } from "../lib/appStatus";
import { useDeploy } from "../modals/DeployContext";
import { useHelp } from "../modals/HelpContext";
import { useRenderedSkill } from "../lib/skill";

function AppCard({ app }: { app: App }) {
  const { hostFor } = useDeployment();
  const versions = useQuery(versionsQuery(app.slug));
  const vs = versions.data ?? [];
  const status = appStatus(app, vs);
  const live = liveVersion(app, vs);
  const pending = awaitingPromote(app, vs);
  const lastDeploy = vs[0];

  return (
    <Card
      component={Link}
      to={`/apps/${app.slug}`}
      style={{ display: "flex", flexDirection: "column", gap: 14, color: "inherit" }}
    >
      <Group justify="space-between" align="flex-start" gap={12} wrap="nowrap">
        <Group gap={12} wrap="nowrap" style={{ minWidth: 0 }}>
          <Center
            w={38}
            h={38}
            style={{
              borderRadius: 10,
              background: "var(--mantine-color-dark-5)",
              border: "1px solid var(--az-line-2)",
              flexShrink: 0,
            }}
          >
            <Text ff="heading" fw={600} fz={15} c="dark.1">
              {app.displayName[0]?.toUpperCase()}
            </Text>
          </Center>
          <Box style={{ minWidth: 0 }}>
            <Text ff="heading" fw={600} fz={15} truncate>
              {app.displayName}
            </Text>
            <Text className="az-mono" fz={11.5} c="dark.2" mt={3} truncate>
              {hostFor(app)}
            </Text>
          </Box>
        </Group>
        <StatusLine kind={status} />
      </Group>

      <Group gap={8} wrap="wrap">
        <VisibilityBadge visibility={app.visibility} />
        {live && <ToneBadge icon="layers">live v{live.number}</ToneBadge>}
        {pending && (
          <ToneBadge tone="violet" icon="layers">
            v{pending.number} awaiting promote
          </ToneBadge>
        )}
      </Group>

      <Group
        justify="space-between"
        align="flex-end"
        pt={13}
        mt="auto"
        style={{ borderTop: "1px solid var(--az-line)" }}
      >
        <Group gap={20}>
          <Box>
            <Eyebrow>Deploys</Eyebrow>
            <Text className="az-mono az-tnum" fz={15} fw={600} mt={3}>
              {versions.isPending ? "…" : vs.length}
            </Text>
          </Box>
          <Box>
            <Eyebrow>Last deploy</Eyebrow>
            <Text className="az-mono az-tnum" fz={15} fw={600} mt={3}>
              {lastDeploy ? timeAgo(lastDeploy.createdAt) : "—"}
            </Text>
          </Box>
        </Group>
        <Sparkline
          data={deployCadence(vs)}
          w={92}
          h={32}
          stroke={status === "archived" ? "var(--mantine-color-dark-3)" : "var(--az-acc)"}
          dot
        />
      </Group>
    </Card>
  );
}

/**
 * Hand the agent the instructions, from the screen it starts on.
 *
 * Unconditional, and it replaced four stat cards counting apps by state. Those
 * were a dashboard for a workspace that mostly has three apps in it, and at zero
 * apps they were four zeroes greeting a first-time user. This is the trade: the
 * skill is the highest-value thing the portal hands out, it was one click deep
 * behind the sidebar's **How to develop**, and it is not first-run content —
 * you re-copy it whenever you start an app or a fresh agent session, which is
 * exactly when you are standing here.
 *
 * The pitch is a one-line version of the modal's own callout
 * (`modals/HelpModal.tsx`); keep the two saying the same thing. Creating an app
 * deliberately isn't here — the page header owns that, a few pixels up.
 */
function AgentHandoff() {
  const { openHelp } = useHelp();
  const skill = useRenderedSkill();

  return (
    <Card
      mb={24}
      p="14px 18px"
      style={{
        border: "1px solid var(--az-line-2)",
        background: "color-mix(in srgb, var(--az-acc) 6%, transparent)",
      }}
    >
      <Group justify="space-between" align="center" gap={16} wrap="wrap">
        <Box style={{ minWidth: 260, flex: 1 }}>
          <Eyebrow mb={4}>Building with an AI agent?</Eyebrow>
          <Text size="sm" c="dark.2" lh={1.5}>
            Hand it this deployment&apos;s instructions — the capability manifest, the{" "}
            <Code>/_api/*</Code> gateway, the CSP to build within, and the deploy flow, with real
            hostnames already filled in.
          </Text>
        </Box>
        <Group gap={8} wrap="nowrap">
          {/* Cyan, not the primary orange: the page header's Create app sits a few
              pixels above, and two filled CTAs in the same hue read as one choice
              made twice. Handing over the skill is the accent family's job — the
              same hue this card is tinted with. */}
          {/* Disabled, never a half-rendered skill, until GET /api/v1/config lands. */}
          {skill ? (
            <CopyBtn
              value={skill}
              label="Copy agent instructions"
              size="sm"
              variant="filled"
              color="accent"
            />
          ) : (
            <Button size="sm" disabled leftSection={<Icon name="copy" size={13} />}>
              Copy agent instructions
            </Button>
          )}
          <Button
            variant="default"
            size="sm"
            leftSection={<Icon name="book" size={14} />}
            onClick={openHelp}
          >
            How to develop
          </Button>
        </Group>
      </Group>
    </Card>
  );
}

type Filter = "all" | "live" | "preview" | "archived";

export function AppsListPage() {
  const apps = useQuery(appsQuery);
  const { appHost, appUrl } = useDeployment();
  const { openCreate } = useDeploy();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");

  const list = useMemo(() => apps.data ?? [], [apps.data]);
  const counts = useMemo(
    () => ({
      all: list.length,
      live: list.filter((a) => !a.archivedAt && a.currentVersionId).length,
      preview: list.filter((a) => !a.archivedAt && !a.currentVersionId).length,
      archived: list.filter((a) => a.archivedAt).length,
    }),
    [list],
  );

  const shown = list.filter((a) => {
    if (filter === "live" && (a.archivedAt || !a.currentVersionId)) return false;
    if (filter === "preview" && (a.archivedAt || a.currentVersionId)) return false;
    if (filter === "archived" && !a.archivedAt) return false;
    if (search && !(a.displayName + a.slug).toLowerCase().includes(search.toLowerCase()))
      return false;
    return true;
  });

  return (
    <div>
      <PageHead
        // The apps domain arrives with the deployment config; until it does, the
        // eyebrow is just "Workspace" rather than a guessed host.
        eyebrow={["Workspace", appHost("<slug>")].filter(Boolean).join(" · ")}
        title="My Apps"
        sub="Static apps you've deployed."
        actions={
          // The one creation surface in the SPA, and deliberately unconditional:
          // registration used to hide inside the deploy modal's app picker, so a
          // single registered app cut off the path to a second. Deploying moved
          // to the app's own page, where it has a target.
          <Button size="md" leftSection={<Icon name="plus" size={15} />} onClick={openCreate}>
            Create app
          </Button>
        }
      />

      <AgentHandoff />

      <Group mb={18} gap={10}>
        <SegmentedControl
          value={filter}
          onChange={(v) => setFilter(v as Filter)}
          data={[
            { value: "all", label: `All ${counts.all}` },
            { value: "live", label: `Live ${counts.live}` },
            { value: "preview", label: `Preview ${counts.preview}` },
            { value: "archived", label: `Archived ${counts.archived}` },
          ]}
        />
        <TextInput
          placeholder="Search apps…"
          leftSection={<Icon name="search" size={14} />}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          style={{ flex: 1, maxWidth: 280 }}
        />
      </Group>

      {apps.isPending && (
        <Center py={80}>
          <Loader />
        </Center>
      )}
      {apps.isError && (
        <Hint tone="bad" icon="alert">
          Couldn&apos;t reach the portal API: {apps.error.message}
        </Hint>
      )}
      {apps.isSuccess && shown.length === 0 && (
        <Card py={56} style={{ textAlign: "center" }}>
          <Stack align="center" gap={6}>
            <Text ff="heading" fw={600} fz={17}>
              {list.length === 0 ? "No apps yet" : "Nothing matches"}
            </Text>
            <Text c="dark.2" size="sm" maw={420}>
              {list.length === 0 ? (
                <>
                  Register one here or from the CLI, then ship a build into it.
                  {/* Drop the "served at" clause entirely until the deployment
                      config lands — a half-rendered URL is worse than none. */}
                  {appUrl("<slug>") && (
                    <>
                      {" "}
                      It will be served at{" "}
                      <Text component="span" className="az-mono" fz={12}>
                        {appUrl("<slug>")}
                      </Text>
                      .
                    </>
                  )}
                </>
              ) : (
                "Try a different filter or search."
              )}
            </Text>
            {list.length === 0 && (
              <Button
                mt={12}
                size="md"
                leftSection={<Icon name="plus" size={15} />}
                onClick={openCreate}
              >
                Create your first app
              </Button>
            )}
          </Stack>
        </Card>
      )}

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing={18} className="az-stagger">
        {shown.map((a) => (
          <AppCard key={a.id} app={a} />
        ))}
      </SimpleGrid>
    </div>
  );
}
