import { Anchor, Box, Button, Center, Group, Loader, Tabs, Text, Title } from "@mantine/core";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { appQuery, versionsQuery } from "../api/queries";
import { Icon } from "../components/Icon";
import { Hint, StatusLine, ToneBadge, VisibilityBadge } from "../components/primitives";
import { appHost, appUrl } from "../lib/format";
import { appStatus, awaitingPromote, liveVersion } from "../lib/appStatus";
import { useDeploy } from "../modals/DeployContext";
import { OverviewTab } from "./tabs/OverviewTab";
import { VersionsTab } from "./tabs/VersionsTab";
import { CapabilitiesTab } from "./tabs/CapabilitiesTab";
import { UsageTab } from "./tabs/UsageTab";
import { AccessTab } from "./tabs/AccessTab";

export function AppDetailPage() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { openDeploy } = useDeploy();

  const app = useQuery(appQuery(slug));
  const versions = useQuery(versionsQuery(slug));

  if (app.isPending) {
    return (
      <Center py={120}>
        <Loader />
      </Center>
    );
  }
  if (app.isError) {
    return (
      <Hint tone="bad" icon="alert">
        {app.error.message} —{" "}
        <Anchor component={Link} to="/">
          back to My Apps
        </Anchor>
      </Hint>
    );
  }

  const a = app.data;
  const vs = versions.data ?? [];
  const status = appStatus(a, vs);
  const live = liveVersion(a, vs);
  const pending = awaitingPromote(a, vs);
  const tab = params.get("tab") ?? "overview";

  return (
    <div>
      <Anchor
        component={Link}
        to="/"
        size="sm"
        c="dark.2"
        mb={16}
        style={{ display: "inline-flex", alignItems: "center", gap: 7 }}
      >
        <Icon name="chevR" size={13} style={{ transform: "rotate(180deg)" }} /> My Apps
      </Anchor>

      <Group justify="space-between" align="flex-start" mb={24} gap="lg" wrap="wrap">
        <Group gap={16} align="flex-start">
          <Center
            w={52}
            h={52}
            style={{
              borderRadius: 13,
              background: "var(--mantine-color-dark-5)",
              border: "1px solid var(--az-line-2)",
            }}
          >
            <Text ff="heading" fw={600} fz={21}>
              {a.displayName[0]?.toUpperCase()}
            </Text>
          </Center>
          <Box>
            <Group gap={12}>
              <Title order={1} style={{ fontSize: 25 }}>
                {a.displayName}
              </Title>
              <StatusLine kind={status} />
            </Group>
            {status === "live" ? (
              <Anchor
                href={appUrl(a.slug)}
                target="_blank"
                rel="noreferrer"
                className="az-mono"
                fz={13}
                c="accent.4"
                mt={7}
                style={{ display: "inline-flex", alignItems: "center", gap: 7 }}
              >
                {appHost(a.slug)} <Icon name="ext" size={13} />
              </Anchor>
            ) : (
              <Text className="az-mono" fz={13} c="dark.2" mt={7}>
                {appHost(a.slug)}
              </Text>
            )}
            <Group gap={8} mt={12} wrap="wrap">
              <VisibilityBadge visibility={a.visibility} />
              <ToneBadge icon="layers">live {live ? `v${live.number}` : "—"}</ToneBadge>
              {pending && <ToneBadge tone="slate">preview v{pending.number}</ToneBadge>}
            </Group>
          </Box>
        </Group>
        <Group gap={10}>
          <Button
            variant="default"
            leftSection={<Icon name="rotate" size={15} />}
            onClick={() => setParams({ tab: "versions" })}
          >
            Rollback
          </Button>
          <Button leftSection={<Icon name="upload" size={15} />} onClick={() => openDeploy(a.slug)}>
            Deploy
          </Button>
        </Group>
      </Group>

      <Tabs
        value={tab}
        onChange={(t) => {
          if (t === "overview") void navigate(`/apps/${a.slug}`, { replace: true });
          else setParams({ tab: t ?? "overview" });
        }}
        keepMounted={false}
      >
        <Tabs.List mb={18}>
          <Tabs.Tab value="overview" leftSection={<Icon name="grid" size={15} />}>
            Overview
          </Tabs.Tab>
          <Tabs.Tab
            value="versions"
            leftSection={<Icon name="layers" size={15} />}
            rightSection={
              <Text component="span" className="az-mono" fz={11} c="dark.3">
                {vs.length}
              </Text>
            }
          >
            Versions
          </Tabs.Tab>
          <Tabs.Tab value="capabilities" leftSection={<Icon name="shield" size={15} />}>
            Capabilities
          </Tabs.Tab>
          <Tabs.Tab value="usage" leftSection={<Icon name="gauge" size={15} />}>
            Usage
          </Tabs.Tab>
          <Tabs.Tab value="access" leftSection={<Icon name="lock" size={15} />}>
            Access
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="overview">
          <OverviewTab app={a} versions={vs} />
        </Tabs.Panel>
        <Tabs.Panel value="versions">
          <VersionsTab app={a} versions={vs} />
        </Tabs.Panel>
        <Tabs.Panel value="capabilities">
          <CapabilitiesTab app={a} />
        </Tabs.Panel>
        <Tabs.Panel value="usage">
          <UsageTab app={a} />
        </Tabs.Panel>
        <Tabs.Panel value="access">
          <AccessTab app={a} />
        </Tabs.Panel>
      </Tabs>
    </div>
  );
}
