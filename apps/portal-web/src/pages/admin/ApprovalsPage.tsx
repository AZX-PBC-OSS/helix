import { useMemo, useState } from "react";
import {
  Box,
  Button,
  Card,
  Center,
  Grid,
  Group,
  Loader,
  Stack,
  Text,
  Textarea,
  Tooltip,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import {
  parseFetchOriginKey,
  type ApprovalRequest,
  type ApprovalStatus,
  type Delta,
} from "@azx-pbc/shared";
import { PortalApiError } from "../../api/client";
import { approvalsQuery } from "../../api/queries";
import { useApproveRequest, useDenyRequest, useRequestChanges } from "../../api/mutations";
import { DeltaList, riskBreakdown, RISK_META } from "../../components/deltas";
import { Icon } from "../../components/Icon";
import { Hint, PageHead, ToneBadge, type Tone } from "../../components/primitives";
import { daysSince, timeAgo } from "../../lib/format";

/** The approvals queue for above-baseline capability grants (real, M4+). */

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

/**
 * The provider ref a delta binds, when it is a provider-bound fetch-origin add —
 * the path form `fetch.origins[+origin→provider:ref]` (fetchOriginKey's key, so
 * the parse stays its exact inverse). Anchored greedy like shared's ARRAY_PATH,
 * so an origin containing brackets still splits at the last `]`.
 */
function providerBoundFetchOrigin(d: Delta): string | null {
  const m = /^fetch\.origins\[\+(.+)\]$/.exec(d.path);
  if (!m) return null;
  return parseFetchOriginKey(m[1]!).provider ?? null;
}

/**
 * How each landed status reads in "this request was already …"
 * (docs/design/approvals.md §5). Deliberately not phrased as "someone else did
 * X": `needs_changes` can be the approve path's own automatic stale-snapshot
 * bounce, so naming another actor would be a guess, and sometimes a wrong one.
 */
const LANDED: Record<string, string> = {
  approved: "approved by another admin",
  denied: "denied by another admin",
  withdrawn: "withdrawn by the requester",
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

/**
 * The apply-time provider conflict: the approve answered 409 `conflict`
 * with the stamped ref in `details` — the shape `assertProviderStampsCurrent`
 * throws, and nothing else 409s approve with a `ref`. Nothing landed and nothing
 * was applied; the request stays pending for the owner to withdraw or resubmit,
 * so like a lost decision race this reads as guidance, not failure.
 */
function providerConflict(err: unknown): boolean {
  if (!(err instanceof PortalApiError) || err.status !== 409 || err.code !== "conflict")
    return false;
  const details: unknown = err.details;
  if (typeof details !== "object" || details === null) return false;
  return typeof (details as { ref?: unknown }).ref === "string";
}

/**
 * The one-line prior-decision signal. The exact grant denied before
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
            <DeltaList deltas={r.deltas} />
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

  // Mutation error state is per-hook and sticky until that hook is reset, and the
  // banner carries no row identity — so without this a lost approve keeps warning
  // over a later successful deny, reading as though the deny had failed.
  const clearDecisionErrors = () => {
    approve.reset();
    deny.reset();
    requestChanges.reset();
  };

  const submitNote = () => {
    if (!noteFor || !note.trim()) return;
    clearDecisionErrors();
    (noteFor === "deny" ? deny : requestChanges).mutate({ id: a.id, note: note.trim() });
    setNoteFor(null);
    setNote("");
  };

  const [riskTone, riskLabel] = RISK_META[a.risk];
  const days = daysSince(a.createdAt);
  const signal = priorSignal(a.priorDecisions);
  // The filing-time warning is data stamped at filing, so the card
  // renders it with no extra fetch. Advisory only — it qualifies the ask for
  // delegated requests and never disables the approve action or re-grades risk.
  const publicAppWarning =
    a.deltas.some((d) => providerBoundFetchOrigin(d) !== null) &&
    a.deltas.some((d) => d.publicApp === true);

  // Surface a failed decision instead of just stopping the spinner. A 409 means
  // someone else decided this row first — the mutations refetch the queue on
  // settle, so the message reads as "already handled", not an error to retry.
  // The provider conflict is the other expected 409: nothing approved, the
  // request stays pending, and the owner must resubmit against the new config.
  const decisionError = approve.error ?? deny.error ?? requestChanges.error;
  const landed = landedStatus(decisionError);
  const staleProvider = decisionError !== undefined && providerConflict(decisionError);

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
              {(() => {
                // The aggregate is "highest of" — for bundles, say so and break
                // it down; the per-delta chips carry the levels themselves.
                const breakdown = a.deltas.length > 1 ? riskBreakdown(a.deltas) : null;
                const badge = (
                  <ToneBadge tone={riskTone} icon={a.risk === "high" ? "alert" : undefined}>
                    {riskLabel}
                  </ToneBadge>
                );
                if (!breakdown) return badge;
                return (
                  <Tooltip label={breakdown} position="top" withArrow>
                    <span tabIndex={0} style={{ display: "inline-flex", borderRadius: 999 }}>
                      {badge}
                    </span>
                  </Tooltip>
                );
              })()}
            </Group>
          </Group>

          {/* The ask: every delta, expanded — one chip row per change, each with
              its own risk level and a help tooltip. */}
          <Box mb={a.reason || publicAppWarning ? 8 : 0}>
            <DeltaList deltas={a.deltas} />
          </Box>

          {publicAppWarning && (
            <div style={{ marginBottom: a.reason ? 8 : 0 }}>
              <Hint icon="alert" tone="warn">
                This app is public — its anonymous visitors can never connect a vendor account.
              </Hint>
            </div>
          )}

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
              <Hint icon="alert" tone={landed || staleProvider ? "warn" : "bad"}>
                {staleProvider
                  ? "The provider changed after this request was filed — the app owner must resubmit."
                  : landed
                    ? `This request was already ${LANDED[landed] ?? landed} — the queue has been refreshed.`
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
              onClick={() => {
                clearDecisionErrors();
                approve.mutate({ id: a.id });
              }}
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
