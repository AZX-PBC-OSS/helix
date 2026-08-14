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
import type { ApprovalRequest, ApprovalStatus, Delta } from "@azx-pbc/shared";
import { PortalApiError } from "../../api/client";
import { approvalsQuery } from "../../api/queries";
import { useApproveRequest, useDenyRequest, useRequestChanges } from "../../api/mutations";
import { Icon, type IconName } from "../../components/Icon";
import { Hint, PageHead, ToneBadge, type Tone } from "../../components/primitives";
import { daysSince, timeAgo } from "../../lib/format";

/** The approvals queue for above-baseline capability grants (real, M4+). */

const RISK_META: Record<ApprovalRequest["risk"], [Tone, string]> = {
  high: ["bad", "HIGH RISK"],
  med: ["warn", "ELEVATED"],
  low: ["info", "ROUTINE"],
};

/** Tone + short label for a decided (or sibling-pending) request in the history log. */
const STATUS_META: Record<ApprovalStatus, [Tone, string]> = {
  pending: ["info", "PENDING"],
  approved: ["live", "APPROVED"],
  denied: ["bad", "DENIED"],
  withdrawn: ["neutral", "WITHDRAWN"],
  needs_changes: ["warn", "CHANGES"],
};

/**
 * Staleness signal. Pending requests never expire (ADR-0039) — nothing sweeps
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

/** How each landed status reads in "someone else already …" (docs/design/approvals.md §5). */
const LANDED: Record<string, string> = {
  approved: "approved",
  denied: "denied",
  withdrawn: "withdrawn (the requester pulled it)",
  needs_changes: "sent back for changes",
};

/**
 * A decision that lost a race answers 409 and carries the status that actually
 * landed. Two admins deciding the same row at once is the ordinary way to hit it,
 * and it is not a failure worth an alarming message — the transition simply went
 * the other way, and the queue has already refetched (mutations use `onSettled`).
 */
function landedStatus(err: unknown): string | null {
  if (!(err instanceof PortalApiError) || err.status !== 409) return null;
  const details: unknown = err.details;
  if (typeof details !== "object" || details === null) return null;
  const status: unknown = (details as { status?: unknown }).status;
  return typeof status === "string" ? status : null;
}

/** Membership deltas (`mcp[+x]`) are self-describing; scalar deltas show from → to. */
function diffLine(d: Delta): string {
  return d.path.includes("[") ? d.path : `${d.path}: ${fmt(d.from)} → ${fmt(d.to)}`;
}
function diffText(deltas: Delta[]): string {
  return deltas.map(diffLine).join("\n");
}

/**
 * The one-line prior-decision signal (issue #26). The exact grant denied before
 * is loud (amber); a related grant in the same area is quiet (muted). First-time
 * requests carry no `priorDecisions`, so this renders nothing. All the detail —
 * the notes, the deciders, the full log — lives under the Details expander, so
 * the card face stays a signal, not a wall of text.
 */
function priorSignal(
  prior: ApprovalRequest["priorDecisions"],
): { text: string; loud: boolean } | null {
  if (!prior) return null;
  if (prior.deniedSameGrant > 0)
    return { text: `Denied ${prior.deniedSameGrant}× before`, loud: true };
  if (prior.deniedSameArea > 0) return { text: "Related grant denied before", loud: false };
  return null;
}

/** The lazy-loaded log of prior requests on this app, shown inside Details. */
function PriorHistory({ appSlug, currentId }: { appSlug: string; currentId: string }) {
  const history = useQuery(approvalsQuery({ app: appSlug }));
  const rows = (history.data ?? []).filter((r) => r.id !== currentId);

  return (
    <Stack gap={12}>
      {history.isPending && <Loader size="xs" />}
      {history.isError && (
        <Text fz={12} style={{ color: "var(--az-bad)" }}>
          Couldn't load history: {history.error.message}
        </Text>
      )}
      {!history.isPending && !history.isError && rows.length > 0 && (
        <Text fz={11.5} c="dark.2" tt="uppercase" fw={600} style={{ letterSpacing: ".04em" }}>
          Prior requests ({rows.length})
        </Text>
      )}
      {rows.map((r) => {
        const [tone, label] = STATUS_META[r.status];
        return (
          <div key={r.id}>
            <Group gap={9} wrap="wrap">
              <ToneBadge tone={tone}>{label}</ToneBadge>
              <Text className="az-mono" fz={11.5} c="dark.2">
                {timeAgo(r.decidedAt ?? r.createdAt)}
              </Text>
              {r.decidedBy && (
                <Text fz={11.5} c="dark.1">
                  {r.decidedBy}
                </Text>
              )}
            </Group>
            <Code block mt={7} style={{ fontSize: 11.5 }}>
              {diffText(r.deltas)}
            </Code>
            {r.decisionNote && (
              <Text fz={12} c="dark.2" mt={5} fs="italic">
                “{r.decisionNote}”
              </Text>
            )}
          </div>
        );
      })}
    </Stack>
  );
}

/** The demoted metadata + full history, revealed on demand (below the fold). */
function DetailsPanel({ request: a }: { request: ApprovalRequest }) {
  const hasHistory = !!a.priorDecisions && a.priorDecisions.total > 0 && !!a.appSlug;
  return (
    <Stack gap={12} mt={12} pl={12} style={{ borderLeft: "2px solid var(--az-line-2)" }}>
      <Text fz={12} c="dark.2">
        Requested by{" "}
        <Text span c="dark.1">
          {a.requestedBy}
        </Text>{" "}
        · filed {timeAgo(a.createdAt)}
      </Text>
      {/* The ask line shows only a count when a submission bundles several deltas. */}
      {a.deltas.length > 1 && (
        <Code block style={{ fontSize: 12 }}>
          {diffText(a.deltas)}
        </Code>
      )}
      {hasHistory && a.appSlug && <PriorHistory appSlug={a.appSlug} currentId={a.id} />}
    </Stack>
  );
}

function ApprovalCard({ request: a }: { request: ApprovalRequest }) {
  const approve = useApproveRequest();
  const deny = useDenyRequest();
  const requestChanges = useRequestChanges();

  // Inline note capture for deny / request-changes (both require a note).
  const [noteFor, setNoteFor] = useState<"deny" | "needs_changes" | null>(null);
  const [note, setNote] = useState("");
  const [showDetails, setShowDetails] = useState(false);

  const busy = approve.isPending || deny.isPending || requestChanges.isPending;

  const submitNote = () => {
    if (!noteFor || !note.trim()) return;
    (noteFor === "deny" ? deny : requestChanges).mutate({ id: a.id, note: note.trim() });
    setNoteFor(null);
    setNote("");
  };

  const [kindIcon, kindLabel] = kindMeta(a.deltas);
  const [riskTone, riskLabel] = RISK_META[a.risk];
  const days = daysSince(a.createdAt);
  const ask = a.deltas.length === 1 ? diffLine(a.deltas[0]!) : `${a.deltas.length} changes`;
  const signal = priorSignal(a.priorDecisions);

  // Surface a failed decision instead of just stopping the spinner. A 409 means
  // someone else decided this row first — the mutations refetch the queue on
  // settle, so the message reads as "already handled", not an error to retry.
  const decisionError = approve.error ?? deny.error ?? requestChanges.error;
  const landed = landedStatus(decisionError);

  return (
    <Card>
      <Grid gap={20}>
        <Grid.Col span={{ base: 12, sm: 9 }}>
          {/* Identity + risk — the "what am I looking at" line. */}
          <Group justify="space-between" wrap="nowrap" align="flex-start" mb={10}>
            <Group gap={9} align="baseline" wrap="wrap">
              <Text ff="heading" fw={600} fz={16} lh={1.2}>
                {a.appDisplayName ?? a.appSlug ?? a.appId}
              </Text>
              {a.appSlug && (
                <Text className="az-mono" fz={12} c="dark.2">
                  {a.appSlug}
                </Text>
              )}
            </Group>
            {/* Staleness (never expires, ADR-0039) rides alongside risk. */}
            <Group gap={9} wrap="nowrap" align="center">
              <ToneBadge tone={ageTone(days)} icon="clock">
                {ageLabel(days)}
              </ToneBadge>
              <ToneBadge tone={riskTone} icon={a.risk === "high" ? "alert" : undefined}>
                {riskLabel}
              </ToneBadge>
            </Group>
          </Group>

          {/* The ask: kind + the delta being requested. */}
          <Group gap={8} mb={a.reason ? 8 : 0} wrap="wrap">
            <Icon name={kindIcon} size={14} style={{ color: "var(--mantine-color-dark-2)" }} />
            <Text fz={13} c="dark.1">
              {kindLabel}
            </Text>
            <Text className="az-mono" fz={12.5} c="accent.4">
              {ask}
            </Text>
          </Group>

          {a.reason && (
            <Text size="sm" c="dark.2" maw={620} lh={1.5} fs="italic">
              “{a.reason}”
            </Text>
          )}

          {/* Prior-decision signal (left) + the Details expander (right). */}
          <Group justify="space-between" wrap="nowrap" align="center" mt={12}>
            <Group gap={7} wrap="nowrap">
              {signal && (
                <>
                  <Icon
                    name="alert"
                    size={14}
                    style={{
                      color: signal.loud ? "var(--az-warn)" : "var(--mantine-color-dark-2)",
                    }}
                  />
                  <Text
                    fz={12.5}
                    fw={signal.loud ? 600 : 500}
                    style={{
                      color: signal.loud ? "var(--az-warn)" : "var(--mantine-color-dark-2)",
                    }}
                  >
                    {signal.text}
                  </Text>
                </>
              )}
            </Group>
            <Button
              variant="subtle"
              size="compact-xs"
              leftSection={
                <Icon
                  name="chevR"
                  size={13}
                  style={{
                    transform: showDetails ? "rotate(90deg)" : undefined,
                    transition: "transform .15s",
                  }}
                />
              }
              onClick={() => setShowDetails((v) => !v)}
            >
              Details
            </Button>
          </Group>

          {showDetails && <DetailsPanel request={a} />}

          {noteFor && (
            <Stack gap={8} mt={12}>
              <Textarea
                autosize
                minRows={2}
                placeholder={`Note (required to ${noteFor === "deny" ? "deny" : "request changes"})`}
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

          {decisionError && (
            <div style={{ marginTop: 12 }}>
              <Hint icon="alert" tone={landed ? "warn" : "bad"}>
                {landed
                  ? `Someone else already ${LANDED[landed] ?? landed} this request — the queue has been refreshed.`
                  : `Couldn't record that decision: ${decisionError.message}`}
              </Hint>
            </div>
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
                setNoteFor("needs_changes");
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
                setNoteFor("deny");
              }}
            >
              Deny
            </Button>
          </Stack>
        </Grid.Col>
      </Grid>
    </Card>
  );
}

export function ApprovalsPage() {
  const queue = useQuery(approvalsQuery({ status: "pending" }));

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

      {decisionError && (
        <Hint icon="alert" tone={landed ? "warn" : "bad"}>
          {landed
            ? `Someone else already ${LANDED[landed] ?? landed} this request — the queue has been refreshed.`
            : `Couldn't record that decision: ${decisionError.message}`}
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
        {requests.map((a) => (
          <ApprovalCard key={a.id} request={a} />
        ))}
      </Stack>
    </div>
  );
}
