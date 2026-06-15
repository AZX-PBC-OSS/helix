import { useState } from "react";
import { Button, Card, Code, Grid, Group, Stack, Text } from "@mantine/core";
import { Icon, type IconName } from "../../components/Icon";
import { PageHead, PreviewBadge, ToneBadge, type Tone } from "../../components/primitives";
import { PREVIEW_APPROVALS, type PreviewApproval } from "../../preview/previewData";

/** PREVIEW — the M4 approvals queue for above-baseline capability grants. */

const KIND_META: Record<PreviewApproval["kind"], [IconName, string]> = {
  "go-public": ["globe", "Go public"],
  "mcp-grant": ["key", "MCP grant"],
  "origin-grant": ["globe", "Origin grant"],
  "llm-budget": ["cpu", "LLM budget"],
};

const RISK_META: Record<PreviewApproval["risk"], [Tone, string]> = {
  high: ["bad", "HIGH RISK"],
  med: ["warn", "ELEVATED"],
  low: ["info", "ROUTINE"],
};

export function ApprovalsPage() {
  const [done, setDone] = useState<Record<string, "approved" | "denied">>({});
  const pending = PREVIEW_APPROVALS.filter((a) => !done[a.id]);

  return (
    <div className="az-stagger">
      <PageHead
        eyebrow="Control plane · elevated"
        title={
          <Group gap={12}>
            Approvals <PreviewBadge />
          </Group>
        }
        sub="Grants above the baseline — going public, any MCP server, new external origins, high LLM budgets — pause here for a human decision. Mock queue until M4."
        actions={
          <ToneBadge tone="violet" icon="shield">
            {pending.length} pending
          </ToneBadge>
        }
      />

      {pending.length === 0 && (
        <Card py={56} style={{ textAlign: "center" }}>
          <Stack align="center" gap={6}>
            <Icon name="check" size={26} style={{ color: "var(--az-live)" }} />
            <Text ff="heading" fw={600} fz={17}>
              Queue clear
            </Text>
            <Text c="dark.2" size="sm">
              No elevated grants awaiting review.
            </Text>
          </Stack>
        </Card>
      )}

      <Stack gap={18}>
        {pending.map((a) => {
          const [icon, label] = KIND_META[a.kind];
          const [riskTone, riskLabel] = RISK_META[a.risk];
          return (
            <Card key={a.id}>
              <Grid gap={20}>
                <Grid.Col span={{ base: 12, sm: 9 }}>
                  <Group gap={10} mb={10} wrap="wrap">
                    <ToneBadge icon={icon}>{label}</ToneBadge>
                    <ToneBadge tone={riskTone}>{riskLabel}</ToneBadge>
                    <Text className="az-mono" fz={12} c="dark.2">
                      {a.ago} ago
                    </Text>
                  </Group>
                  <Text ff="heading" fw={600} fz={16} mb={6}>
                    {a.summary}
                  </Text>
                  <Text size="sm" c="dark.2" maw={560} lh={1.5}>
                    {a.detail}
                  </Text>
                  <Group gap={18} mt={14}>
                    <Group gap={7}>
                      <Icon name="box" size={14} style={{ color: "var(--mantine-color-dark-2)" }} />
                      <Text className="az-mono" fz={12.5} c="accent.4">
                        {a.app}
                      </Text>
                    </Group>
                    <Group gap={7}>
                      <Icon
                        name="user"
                        size={14}
                        style={{ color: "var(--mantine-color-dark-2)" }}
                      />
                      <Text fz={12.5} c="dark.1">
                        {a.owner}
                      </Text>
                    </Group>
                  </Group>
                  <Code block mt={14} style={{ fontSize: 12 }}>
                    {a.diff.map(([k, from, to]) => `- ${k}: ${from}\n+ ${k}: ${to}`).join("\n")}
                  </Code>
                </Grid.Col>
                <Grid.Col span={{ base: 12, sm: 3 }}>
                  <Stack gap={9} justify="center" h="100%">
                    <Button
                      leftSection={<Icon name="check" size={14} />}
                      onClick={() => setDone((d) => ({ ...d, [a.id]: "approved" }))}
                    >
                      Approve grant
                    </Button>
                    <Button variant="default">Request changes</Button>
                    <Button
                      color="red"
                      variant="outline"
                      leftSection={<Icon name="x" size={14} />}
                      onClick={() => setDone((d) => ({ ...d, [a.id]: "denied" }))}
                    >
                      Deny
                    </Button>
                  </Stack>
                </Grid.Col>
              </Grid>
            </Card>
          );
        })}
      </Stack>
    </div>
  );
}
