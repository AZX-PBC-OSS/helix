import { useState } from "react";
import { Box, Button, Card, Code, Group, Stack, Text } from "@mantine/core";
import { Icon } from "../../components/Icon";
import { Hint, PageHead, PreviewBadge, ToneBadge } from "../../components/primitives";
import { PREVIEW_VIOLATIONS } from "../../preview/previewData";

/** PREVIEW — CSP violation reports become one-click capability requests (M4). */
export function ViolationsPage() {
  const [requested, setRequested] = useState<Record<string, boolean>>({});
  const unhandled = PREVIEW_VIOLATIONS.filter((v) => !v.requested && !requested[v.id]).length;

  return (
    <div className="az-stagger">
      <PageHead
        eyebrow="Control plane"
        title={
          <Group gap={12}>
            CSP Violations <PreviewBadge />
          </Group>
        }
        sub="The proxy reports every blocked request; we turn them into plain-English, one-click capability fixes — silent breakage becomes a guided flow. Mock reports until M4."
        actions={
          <ToneBadge tone="bad" icon="shield">
            {unhandled} unhandled
          </ToneBadge>
        }
      />

      <Stack gap={18}>
        {PREVIEW_VIOLATIONS.map((v) => {
          const handled = v.requested || requested[v.id];
          return (
            <Card key={v.id} style={v.danger ? { borderColor: "var(--az-bad-dim)" } : undefined}>
              <Group justify="space-between" gap={20} wrap="nowrap" align="center">
                <Box>
                  <Group gap={10} mb={9} wrap="wrap">
                    <ToneBadge
                      tone={v.danger ? "bad" : "warn"}
                      icon={v.danger ? "shield" : "alert"}
                    >
                      {v.directive}
                    </ToneBadge>
                    <Group gap={6}>
                      <Icon name="box" size={13} style={{ color: "var(--mantine-color-dark-2)" }} />
                      <Text className="az-mono" fz={12.5} c="accent.4">
                        {v.app}
                      </Text>
                    </Group>
                    <Text className="az-mono" fz={11.5} c="dark.2">
                      {v.count}× · last {v.last} ago
                    </Text>
                  </Group>
                  <Text fz={14} fw={500} mb={6}>
                    {v.plain}
                  </Text>
                  <Code style={{ fontSize: 12 }}>blocked → {v.blocked}</Code>
                </Box>
                <Box style={{ flexShrink: 0 }}>
                  {v.danger ? (
                    <Button color="red" variant="outline" leftSection={<Icon name="x" size={14} />}>
                      Investigate
                    </Button>
                  ) : handled ? (
                    <ToneBadge tone="violet" icon="check">
                      Request filed
                    </ToneBadge>
                  ) : (
                    <Button
                      leftSection={<Icon name="plus" size={14} />}
                      onClick={() => setRequested((r) => ({ ...r, [v.id]: true }))}
                    >
                      Request this origin
                    </Button>
                  )}
                </Box>
              </Group>
            </Card>
          );
        })}
      </Stack>

      <Box mt={18}>
        <Hint icon="shield" tone="info">
          Granting an origin adds a <span className="az-mono">connect-src</span> exception — or
          route the call through the gateway <span className="az-mono">fetch-proxy</span> instead
          for auditing, metering, and server-side secrets.
        </Hint>
      </Box>
    </div>
  );
}
