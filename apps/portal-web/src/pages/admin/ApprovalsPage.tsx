import { useMemo, useState } from "react";
import {
  Button,
  Card,
  Center,
  Code,
  Grid,
  Group,
  Loader,
  Stack,
  Text,
  Textarea,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { ApprovalRequest, Delta } from "@azx-pbc/shared";
import { approvalsQuery } from "../../api/queries";
import { useApproveRequest, useDenyRequest, useRequestChanges } from "../../api/mutations";
import { Icon, type IconName } from "../../components/Icon";
import { Hint, PageHead, ToneBadge, type Tone } from "../../components/primitives";
import { daysSince } from "../../lib/format";

/** The approvals queue for above-baseline capability grants (real, M4+). */

const RISK_META: Record<ApprovalRequest["risk"], [Tone, string]> = {
  high: ["bad", "HIGH RISK"],
  med: ["warn", "ELEVATED"],
  low: ["info", "ROUTINE"],
};

/**
 * Staleness signal. Pending requests never expire (ADR-0038) — nothing sweeps
 * them, so the queue's job is to make an un-reviewed request harder to ignore
 * the longer it sits, not to hide it.
 */
const ageTone = (days: number): Tone => (days >= 30 ? "bad" : days >= 7 ? "warn" : "neutral");

/** Uppercase to sit alongside the risk badges (`HIGH RISK` / `ELEVATED`). */
const ageLabel = (days: number) => (days === 0 ? "PENDING <1D" : `PENDING ${days}D`);

/** Derive a human label + icon for a request from the kinds of deltas it carries. */
function kindMeta(deltas: Delta[]): [IconName, string] {
  if (deltas.some((d) => d.path === "visibility")) return ["globe", "Go public"];
  if (deltas.some((d) => d.path.startsWith("mcp"))) return ["key", "MCP grant"];
  if (deltas.some((d) => d.path.startsWith("externalOrigins"))) return ["globe", "Origin grant"];
  if (deltas.some((d) => d.path.startsWith("llm"))) return ["cpu", "LLM budget"];
  if (deltas.some((d) => d.path.startsWith("data"))) return ["layers", "Data grant"];
  return ["shield", "Capability change"];
}

const fmt = (v: Delta["from"]) => (v === undefined ? "∅" : String(v));

/** Membership deltas (`mcp[+x]`) are self-describing; scalar deltas show from → to. */
function diffText(deltas: Delta[]): string {
  return deltas
    .map((d) => (d.path.includes("[") ? d.path : `${d.path}: ${fmt(d.from)} → ${fmt(d.to)}`))
    .join("\n");
}

export function ApprovalsPage() {
  const queue = useQuery(approvalsQuery({ status: "pending" }));
  const approve = useApproveRequest();
  const deny = useDenyRequest();
  const requestChanges = useRequestChanges();

  // Inline note capture for deny / request-changes (both require a note).
  const [noteFor, setNoteFor] = useState<{ id: string; action: "deny" | "needs_changes" } | null>(
    null,
  );
  const [note, setNote] = useState("");

  const submitNote = () => {
    if (!noteFor || !note.trim()) return;
    const args = { id: noteFor.id, note: note.trim() };
    (noteFor.action === "deny" ? deny : requestChanges).mutate(args);
    setNoteFor(null);
    setNote("");
  };

  // Oldest first. The API sorts `createdAt desc` (it also serves the app-detail
  // banner, where newest-first is right), but a review queue is FIFO work — and
  // newest-first is exactly what lets an old request drift off the bottom.
  const requests = useMemo(
    () => [...(queue.data ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [queue.data],
  );
  const oldestDays = requests[0] ? daysSince(requests[0].createdAt) : null;

  return (
    <div className="az-stagger">
      <PageHead
        eyebrow="Admin"
        title="Approvals"
        sub="Capability change requests."
        actions={
          <>
            <ToneBadge tone="violet" icon="shield">
              {requests.length} pending
            </ToneBadge>
            {oldestDays !== null && (
              <ToneBadge tone={ageTone(oldestDays)} icon="clock">
                oldest {oldestDays}d
              </ToneBadge>
            )}
          </>
        }
      />

      {queue.isPending && (
        <Center py={60}>
          <Loader size="sm" />
        </Center>
      )}

      {queue.isError && (
        <Hint icon="alert" tone="bad">
          Couldn't load the queue: {queue.error.message}
        </Hint>
      )}

      {!queue.isPending && !queue.isError && requests.length === 0 && (
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
        {requests.map((a) => {
          const [icon, label] = kindMeta(a.deltas);
          const [riskTone, riskLabel] = RISK_META[a.risk];
          const days = daysSince(a.createdAt);
          const busy =
            (approve.isPending && approve.variables?.id === a.id) ||
            (deny.isPending && deny.variables?.id === a.id) ||
            (requestChanges.isPending && requestChanges.variables?.id === a.id);
          return (
            <Card key={a.id}>
              <Grid gap={20}>
                <Grid.Col span={{ base: 12, sm: 9 }}>
                  <Group gap={10} mb={10} wrap="wrap">
                    <ToneBadge icon={icon}>{label}</ToneBadge>
                    <ToneBadge tone={riskTone}>{riskLabel}</ToneBadge>
                    <ToneBadge tone={ageTone(days)} icon="clock">
                      {ageLabel(days)}
                    </ToneBadge>
                  </Group>
                  {a.reason && (
                    <Text size="sm" c="dark.2" maw={560} lh={1.5}>
                      {a.reason}
                    </Text>
                  )}
                  <Group gap={18} mt={14}>
                    <Group gap={7}>
                      <Icon name="box" size={14} style={{ color: "var(--mantine-color-dark-2)" }} />
                      <Text className="az-mono" fz={12.5} c="accent.4">
                        {a.appSlug ?? a.appId}
                      </Text>
                    </Group>
                    <Group gap={7}>
                      <Icon
                        name="user"
                        size={14}
                        style={{ color: "var(--mantine-color-dark-2)" }}
                      />
                      <Text fz={12.5} c="dark.1">
                        {a.requestedBy}
                      </Text>
                    </Group>
                  </Group>
                  <Code block mt={14} style={{ fontSize: 12 }}>
                    {diffText(a.deltas)}
                  </Code>
                  {noteFor?.id === a.id && (
                    <Stack gap={8} mt={12}>
                      <Textarea
                        autosize
                        minRows={2}
                        placeholder={`Note (required to ${noteFor.action === "deny" ? "deny" : "request changes"})`}
                        value={note}
                        onChange={(e) => setNote(e.currentTarget.value)}
                      />
                      <Group gap={8}>
                        <Button size="xs" onClick={submitNote} disabled={!note.trim()}>
                          Submit
                        </Button>
                        <Button size="xs" variant="default" onClick={() => setNoteFor(null)}>
                          Cancel
                        </Button>
                      </Group>
                    </Stack>
                  )}
                </Grid.Col>
                <Grid.Col span={{ base: 12, sm: 3 }}>
                  <Stack gap={9} justify="center" h="100%">
                    <Button
                      leftSection={<Icon name="check" size={14} />}
                      loading={busy}
                      onClick={() => approve.mutate({ id: a.id })}
                    >
                      Approve grant
                    </Button>
                    <Button
                      variant="default"
                      disabled={busy}
                      onClick={() => {
                        setNote("");
                        setNoteFor({ id: a.id, action: "needs_changes" });
                      }}
                    >
                      Request changes
                    </Button>
                    <Button
                      color="red"
                      variant="outline"
                      leftSection={<Icon name="x" size={14} />}
                      disabled={busy}
                      onClick={() => {
                        setNote("");
                        setNoteFor({ id: a.id, action: "deny" });
                      }}
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
