import { Anchor, Box, Button, Center, Group, Loader, Tabs, Text, Title } from "@mantine/core";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { appQuery, versionsQuery } from "../api/queries";
import { Icon } from "../components/Icon";
import { Hint, Principal, StatusLine, ToneBadge, VisibilityBadge } from "../components/primitives";
import { useDeployment } from "../lib/deployment";
import { appStatus, awaitingPromoteNumber, deployFacts } from "../lib/appStatus";
import { useDeploy } from "../modals/DeployContext";
import { OverviewTab } from "./tabs/OverviewTab";
import { VersionsTab } from "./tabs/VersionsTab";
import { CapabilitiesTab } from "./tabs/CapabilitiesTab";
import { UsageTab } from "./tabs/UsageTab";
import { DataTab } from "./tabs/DataTab";
import { AccessTab } from "./tabs/AccessTab";
import { DevModeTab } from "./tabs/DevModeTab";

export function AppDetailPage() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { openDeploy } = useDeploy();

  const app = useQuery(appQuery(slug));
  const versions = useQuery(versionsQuery(slug));
  const { hostFor, urlFor } = useDeployment();

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
          back to Apps
        </Anchor>
      </Hint>
    );
  }

  const a = app.data;
  const vs = versions.data ?? [];
  // This page has the full version list, so facts come from it rather than from
  // the list endpoint's projection — same shape either way (`lib/appStatus`).
  const facts = deployFacts(a, vs);
  const status = appStatus(a, facts);
  const pending = awaitingPromoteNumber(facts);
  const tab = params.get("tab") ?? "overview";
  const appLink = urlFor(a);
  const appHostText = hostFor(a);

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
        <Icon name="chevR" size={13} style={{ transform: "rotate(180deg)" }} /> Apps
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
            {/* Only a link once we know where the app actually is — otherwise
                (not live, or the deployment config hasn't landed) plain text. */}
            {status === "live" && appLink ? (
              <Anchor
                href={appLink}
                target="_blank"
                rel="noreferrer"
                className="az-mono"
                fz={13}
                c="accent.4"
                mt={7}
                style={{ display: "inline-flex", alignItems: "center", gap: 7 }}
              >
                {appHostText} <Icon name="ext" size={13} />
              </Anchor>
            ) : (
              <Text className="az-mono" fz={13} c="dark.2" mt={7}>
                {appHostText}
              </Text>
            )}
            <Group gap={8} mt={12} wrap="wrap">
              <VisibilityBadge visibility={a.visibility} slug={a.slug} />
              <ToneBadge icon="layers">
                live {facts.liveNumber === null ? "—" : `v${facts.liveNumber}`}
              </ToneBadge>
              {pending !== null && <ToneBadge tone="slate">preview v{pending}</ToneBadge>}
              {/* Whose app this is. Shown to every signed-in reader, not just the
                  owner — "who do I ask about this?" is the question the field
                  exists to answer, and a deployment serves one trusted org.
                  Not a ToneBadge: `Principal` can render a second line, which a
                  badge's inline span has nowhere to put. */}
              {(a.ownerId ?? a.ownerName ?? a.ownerEmail) && (
                <Group gap={6} wrap="nowrap" c="dark.2">
                  <Icon name="user" size={12} />
                  <Principal id={a.ownerId} name={a.ownerName} email={a.ownerEmail} fz={12} />
                </Group>
              )}
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
          <Tabs.Tab value="data" leftSection={<Icon name="db" size={15} />}>
            Data
          </Tabs.Tab>
          <Tabs.Tab value="access" leftSection={<Icon name="lock" size={15} />}>
            Access
          </Tabs.Tab>
          <Tabs.Tab value="dev-mode" leftSection={<Icon name="terminal" size={15} />}>
            Dev mode
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
        <Tabs.Panel value="data">
          <DataTab app={a} />
        </Tabs.Panel>
        <Tabs.Panel value="access">
          {/* Keyed so the group-picker draft resets per app — see AccessTab. */}
          <AccessTab key={a.id} app={a} />
        </Tabs.Panel>
        <Tabs.Panel value="dev-mode">
          <DevModeTab app={a} />
        </Tabs.Panel>
      </Tabs>
    </div>
  );
}
