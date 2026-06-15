import type { ReactNode } from "react";
import { Box, Button, Card, Center, Code, Grid, Group, Stack, Switch, Text } from "@mantine/core";
import type { App } from "@helix/shared";
import { Icon, type IconName } from "../../components/Icon";
import { Eyebrow, Hint, PreviewBadge, ToneBadge } from "../../components/primitives";
import { PREVIEW_CAPS } from "../../preview/previewData";
import { fmtCount } from "../../lib/format";

/**
 * PREVIEW — the §6.3 capability manifest editor. The manifest pipeline (LLM
 * proxy, app data, MCP grants, origin exceptions) is the M4 gateway; this
 * shows the approved design with mock grants.
 */

function CapBlock({
  icon,
  title,
  desc,
  children,
}: {
  icon: IconName;
  title: string;
  desc: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <Group gap={11} mb={14} align="flex-start" wrap="nowrap">
        <Center
          w={34}
          h={34}
          style={{
            borderRadius: 9,
            background: "var(--mantine-color-dark-5)",
            color: "var(--az-acc)",
            flexShrink: 0,
          }}
        >
          <Icon name={icon} size={17} />
        </Center>
        <Box>
          <Text ff="heading" fw={600} fz={14.5}>
            {title}
          </Text>
          <Text size="xs" c="dark.2" mt={4} lh={1.45}>
            {desc}
          </Text>
        </Box>
      </Group>
      {children}
    </Card>
  );
}

function Chips({ label, chips, add }: { label: string; chips: string[]; add: string }) {
  return (
    <Box>
      <Eyebrow mb={8}>{label}</Eyebrow>
      <Group gap={8}>
        {chips.map((c) => (
          <Code key={c} px={10} py={5} style={{ borderRadius: 7 }}>
            {c}
          </Code>
        ))}
        <Button
          variant="default"
          size="compact-xs"
          leftSection={<Icon name="plus" size={11} />}
          disabled
        >
          {add}
        </Button>
      </Group>
    </Box>
  );
}

export function CapabilitiesTab({ app }: { app: App }) {
  const c = PREVIEW_CAPS;
  const yaml = `app: ${app.slug}
visibility: ${app.visibility.mode}${app.visibility.mode === "group" ? `:${app.visibility.groupId}` : ""}
capabilities:
  llm:
    models: [${c.llm.models.join(", ")}]
    tokens_per_day: ${c.llm.tokensPerDay.toLocaleString()}
  data:
    app_scope: ${c.data.appScope}
    user_scope: ${c.data.userScope}
  mcp: [${c.mcp.join(", ")}]
  external_origins: [${c.origins.join(", ")}]`;

  return (
    <Stack gap={18}>
      <Group>
        <PreviewBadge />
        <Text size="sm" c="dark.2">
          Capability manifests are the M4 gateway — the grants below are mock data showing the
          approved design (architecture §6.3).
        </Text>
      </Group>

      <Grid gap={18} className="az-stagger">
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Stack gap={18}>
            <CapBlock
              icon="cpu"
              title="LLM inference"
              desc="Proxied through the gateway — the platform holds vendor keys; your app never sees them."
            >
              <Chips label="Models" chips={c.llm.models} add="add model" />
              <Box mt={14}>
                <Eyebrow mb={8}>Token budget / day</Eyebrow>
                <Group gap={12}>
                  <Text className="az-mono" fw={600} fz={13}>
                    {fmtCount(c.llm.tokensPerDay)}
                  </Text>
                  <ToneBadge tone="violet" icon="shield">
                    above 2M needs admin approval
                  </ToneBadge>
                </Group>
              </Box>
            </CapBlock>

            <CapBlock
              icon="db"
              title="App data storage"
              desc="App- and user-scoped KV/document storage — removes the need for a custom backend."
            >
              <Stack gap={4}>
                <Switch
                  checked={c.data.appScope}
                  disabled
                  label="App-scoped store"
                  description="/_api/data/app/*"
                />
                <Switch
                  checked={c.data.userScope}
                  disabled
                  label="User-scoped store"
                  description="/_api/data/user/* — auto-partitioned per user"
                />
              </Stack>
            </CapBlock>

            <CapBlock
              icon="key"
              title="MCP servers"
              desc="Platform-registered MCP servers exposed as governed REST endpoints. Any-MCP grants need admin approval."
            >
              <Chips label="Granted" chips={c.mcp.length ? c.mcp : ["none"]} add="request MCP" />
            </CapBlock>

            <CapBlock
              icon="globe"
              title="External origins"
              desc="connect-src CSP exceptions. Prefer the gateway fetch-proxy — it adds auditing, metering, and server-side secrets."
            >
              <Chips
                label="connect-src"
                chips={c.origins.length ? c.origins : ["gateway only"]}
                add="request origin"
              />
            </CapBlock>
          </Stack>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 5 }}>
          <Box style={{ position: "sticky", top: 0 }}>
            <Group justify="space-between" mb={10}>
              <Eyebrow>manifest.yaml</Eyebrow>
              <PreviewBadge />
            </Group>
            <Code block style={{ fontSize: 12, lineHeight: 1.7, padding: "16px 18px" }}>
              {yaml}
            </Code>
            <Box mt={14}>
              <Hint icon="shield" tone="info">
                Manifests are versioned. Saving a change above the baseline opens an approval
                request to platform admins.
              </Hint>
            </Box>
            <Button fullWidth mt={14} disabled leftSection={<Icon name="check" size={14} />}>
              Save manifest (M4)
            </Button>
          </Box>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}
