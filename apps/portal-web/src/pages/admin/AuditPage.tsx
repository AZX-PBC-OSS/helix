import { Fragment, useState } from "react";
import {
  ActionIcon,
  Box,
  Card,
  Center,
  Code,
  Group,
  Loader,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { GatewayCall, GatewayOutcome } from "@azx-pbc/shared";
import { gatewayAuditQuery } from "../../api/queries";
import { Icon } from "../../components/Icon";
import { ScrollFade } from "../../components/ScrollFade";
import {
  Eyebrow,
  Hint,
  PageHead,
  Principal,
  Stat,
  ToneBadge,
  type Tone,
} from "../../components/primitives";
import { fmtCount, fmtUsd, principalLabel, timeAgo } from "../../lib/format";

/**
 * The M4 gateway audit log. The table is the scan row — who did what, when,
 * and whether it delivered — and the per-call record (the failure reason, the
 * request line, token/cost accounting, the raw subject) lives behind each
 * row's chevron, which turns the row and its detail into one darker band.
 * Rows open independently of each other: comparing two failures side by side
 * is this screen's job.
 */

const OUT_META: Record<GatewayOutcome, [Tone, string]> = {
  ok: ["live", "ok"],
  error: ["bad", "error"],
  refusal: ["warn", "refusal"],
  quota_blocked: ["warn", "quota"],
  conflict: ["warn", "conflict"],
  forbidden: ["bad", "forbidden"],
};

const AUDIT_LIMIT = 200;

/**
 * Width below which the table scrolls horizontally rather than crushing its
 * six content columns plus the chevron. Sized the way its ten-column
 * predecessor was: every column holds its content on one line at 12px mono —
 * the widest regular cell is the user's captured email, and the model/origin
 * cell is capped below.
 */
const MIN_TABLE_WIDTH = 800;

/**
 * Cap on the model/origin cell. Its values are curated model ids,
 * manifest-approved origins and app-data verbs, so this is a guard against one
 * long hostname dragging the whole table wide, not a load-bearing clamp: the
 * full value stays on the cell's `title` and in the expanded record.
 */
const MODEL_CELL_MAX = 260;

/**
 * Per-outcome split of the failed rows, in `OUT_META` order — derived from the
 * same `!== "ok"` stance as the count itself, so a newly added outcome cannot
 * fall out of the breakdown the way it would from a hand-kept list.
 */
function failureBreakdown(rows: GatewayCall[]): string {
  const counts = new Map<GatewayOutcome, number>();
  for (const r of rows) {
    if (r.outcome === "ok") continue;
    counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
  }
  return (Object.keys(OUT_META) as GatewayOutcome[])
    .map((o) => {
      const n = counts.get(o) ?? 0;
      return n > 0 ? `${n} ${OUT_META[o][1]}` : null;
    })
    .filter((s) => s !== null)
    .join(" · ");
}

export function AuditPage() {
  const [q, setQ] = useState("");
  const [out, setOut] = useState("all");
  // A set, not Data tab's single `string | null`: over there one raw item at a
  // time is all that fits, but this screen's actual job is comparing failures —
  // two rows open side by side, one held open while the list scrolls — so
  // opening a row must never close another.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const audit = useQuery(
    gatewayAuditQuery({
      ...(out !== "all" ? { outcome: out } : {}),
      limit: AUDIT_LIMIT,
    }),
  );

  const head = (
    <PageHead
      eyebrow="Admin"
      title="Gateway Audit Log"
      sub="Gateway calls: app, user, capability, target, outcome. Expand a row for the failure reason, request line and token/cost accounting; query strings are not recorded."
    />
  );

  const all = audit.data?.rows ?? [];
  const rows = all.filter((r) => {
    if (!q) return true;
    // Match the captured labels as well as the raw id: an operator looking for a
    // colleague types their name, and the id they would otherwise have to paste
    // is precisely the thing this screen no longer makes them read. The error
    // text and request line match too, even though they render only in the
    // expanded detail — filter finds, expand reveals.
    return `${r.slug ?? ""}${r.userOid}${r.userName ?? ""}${r.userEmail ?? ""}${r.capability}${r.model}${r.method ?? ""}${r.path ?? ""}${r.errorDetail ?? ""}${r.stopReason ?? ""}`
      .toLowerCase()
      .includes(q.toLowerCase());
  });
  const totalTokens = rows.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
  const totalCost = rows.reduce((s, r) => s + r.costUsd, 0);
  // Everything that did not deliver. Stated as "not ok" rather than a hand-kept
  // list of failure outcomes, so a newly added outcome can't silently fall out
  // of the count the way it would from an `=== "error" || …` chain.
  const failed = rows.filter((r) => r.outcome !== "ok");
  const breakdown = failureBreakdown(rows);

  return (
    <div className="az-stagger">
      {head}

      <Group gap={10} mb={18} wrap="wrap">
        <TextInput
          placeholder="Filter by app, user, capability, target, path, error…"
          leftSection={<Icon name="search" size={14} />}
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          style={{ flex: 1, minWidth: 220 }}
          classNames={{ input: "az-mono" }}
        />
        <SegmentedControl
          value={out}
          onChange={setOut}
          data={[
            { value: "all", label: "All" },
            { value: "ok", label: "OK" },
            { value: "error", label: "Error" },
            { value: "refusal", label: "Refusal" },
            { value: "quota_blocked", label: "Quota" },
            { value: "forbidden", label: "Forbidden" },
            { value: "conflict", label: "Conflict" },
          ]}
        />
      </Group>

      <SimpleGrid cols={{ base: 2, md: 4 }} spacing={18} mb={18}>
        <Card p="14px 18px">
          <Stat label="Events shown" value={rows.length} icon="list" />
        </Card>
        <Card p="14px 18px">
          <Stat label="Tokens" value={fmtCount(totalTokens)} icon="cpu" />
        </Card>
        <Card p="14px 18px">
          <Stat label="Spend" value={fmtUsd(totalCost)} icon="db" />
        </Card>
        <Card p="14px 18px">
          <Stat
            label="Not delivered"
            value={failed.length}
            tone={failed.length > 0 ? "var(--az-bad)" : undefined}
            icon="shield"
            sub={failed.length > 0 ? breakdown : undefined}
          />
        </Card>
      </SimpleGrid>

      {audit.isPending ? (
        <Center py={60}>
          <Loader size="sm" />
        </Center>
      ) : audit.isError ? (
        <Hint icon="alert" tone="bad">
          Couldn't load the audit log: {audit.error.message}
        </Hint>
      ) : (
        <Box
          style={{
            border: "1px solid var(--az-line)",
            borderRadius: "var(--mantine-radius-lg)",
            overflow: "hidden",
            background: "var(--mantine-color-dark-7)",
          }}
        >
          {/* Six content columns plus the chevron still don't fit a phone, and
              the user's captured email sets a real minimum — so the table
              scrolls inside its own frame (the Data tab's stance) rather than
              the page scrolling sideways. `auto` layout, as before: an operator
              reading an audit row wants the whole slug, not a truncated one,
              and the one variable-length cell is capped instead. */}
          <ScrollFade minWidth={MIN_TABLE_WIDTH}>
            <Table verticalSpacing={10} horizontalSpacing="lg" className="az-mono" fz={12}>
              <Table.Thead style={{ background: "var(--mantine-color-dark-6)" }}>
                <Table.Tr>
                  <Table.Th w={40} />
                  <Table.Th>Time</Table.Th>
                  <Table.Th>App</Table.Th>
                  <Table.Th>User</Table.Th>
                  <Table.Th>Capability</Table.Th>
                  <Table.Th>Model / target</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Outcome</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((r) => {
                  const [tone, label] = OUT_META[r.outcome];
                  const open = expanded.has(r.id);
                  return (
                    <Fragment key={r.id}>
                      {/* The open row and its detail below share one darker
                          band — no frame between them — so the detail reads as
                          part of the row it belongs to, not a panel floating
                          under it. That includes killing the row hairline:
                          Mantine 9 defaults `Table` to `withRowBorders`, a 1px
                          dark-4 border-bottom on every tbody row, and on the
                          open row it lands exactly between the pair — the
                          "line" that severed the detail from its row through
                          every revision of this expand. Suppressed here; the
                          detail row keeps its own hairline as the pair's lower
                          bound, and the rows above/below are untouched. */}
                      <Table.Tr
                        style={
                          open
                            ? {
                                background: "var(--mantine-color-dark-8)",
                                borderBottom: "none",
                              }
                            : undefined
                        }
                      >
                        <Table.Td>
                          <ActionIcon
                            variant="subtle"
                            color="gray"
                            size="sm"
                            aria-label={open ? "Hide call detail" : "Show call detail"}
                            onClick={() =>
                              setExpanded((prev) => {
                                const next = new Set(prev);
                                if (next.has(r.id)) {
                                  next.delete(r.id);
                                } else {
                                  next.add(r.id);
                                }
                                return next;
                              })
                            }
                          >
                            <Icon
                              name="chevR"
                              size={13}
                              style={{ transform: open ? "rotate(90deg)" : undefined }}
                            />
                          </ActionIcon>
                        </Table.Td>
                        <Table.Td c="dark.2">{timeAgo(r.createdAt)}</Table.Td>
                        <Table.Td>
                          <Text component="span" className="az-mono" fz={12} c="accent.4">
                            {r.slug ?? "—"}
                          </Text>
                        </Table.Td>
                        {/* The raw subject stays on `title` — it is what the row
                          is keyed by and what a support thread would quote, but it
                          identifies nobody, so it is not what the cell leads with. */}
                        <Table.Td c="dark.1" title={r.userOid}>
                          <Principal
                            name={r.userName ?? undefined}
                            email={r.userEmail ?? undefined}
                            id={principalLabel(r.userOid, r.userKind)}
                            fz={12}
                          />
                        </Table.Td>
                        <Table.Td>{r.capability}</Table.Td>
                        {/* Model for `llm`, origin for `fetch`, verb for `data`.
                            The request line that used to share this cell renders
                            in the expanded record, where there is room for it. */}
                        <Table.Td style={{ maxWidth: MODEL_CELL_MAX }}>
                          <Text
                            component="div"
                            className="az-mono"
                            fz={12}
                            c="dark.2"
                            truncate
                            title={r.model}
                          >
                            {r.model}
                          </Text>
                        </Table.Td>
                        <Table.Td style={{ textAlign: "right" }}>
                          <ToneBadge tone={tone} style={{ padding: "2px 7px", fontSize: 10 }}>
                            {label}
                          </ToneBadge>
                        </Table.Td>
                      </Table.Tr>
                      {/* Rendered only when open — 200 hidden detail rows is
                          real DOM cost for detail nobody has asked to see. The
                          band continues here: same background as the open row,
                          whose hairline is suppressed above, so the pair is
                          one shape; this row keeps its own hairline as the
                          pair's lower bound. */}
                      {open && (
                        <Table.Tr style={{ background: "var(--mantine-color-dark-8)" }}>
                          <Table.Td colSpan={7} p={0}>
                            <CallDetail r={r} />
                          </Table.Td>
                        </Table.Tr>
                      )}
                    </Fragment>
                  );
                })}
                {rows.length === 0 && (
                  <Table.Tr>
                    <Table.Td colSpan={7}>
                      <Text ta="center" c="dark.2" py={24} ff="text" fz={13}>
                        No gateway calls match these filters.
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          </ScrollFade>
        </Box>
      )}

      <Box mt={18}>
        <Hint icon="shield" tone="info">
          {audit.data?.nextBefore
            ? `Showing the latest ${AUDIT_LIMIT} calls. Older history is paginated server-side.`
            : "The edge writes this ledger; the portal only reads it (architecture §8)."}
        </Hint>
      </Box>
    </div>
  );
}

/**
 * The lossless record of one call, rendered only while its row is open.
 *
 * Everything here is text, always — `errorDetail` carries upstream and vendor
 * error strings, which can quote request content and, on an auth failure, the
 * key (which is why the ledger keeps them for this admin-only audience while
 * the app-facing error never echoes them — apps/edge/src/gateway/llm.ts), and
 * any affordance that interpreted them as markup would be an XSS sink on the
 * control plane.
 */
function CallDetail({ r }: { r: GatewayCall }) {
  const cache = [
    r.cacheReadInputTokens > 0 ? `${r.cacheReadInputTokens.toLocaleString()} cache read` : null,
    r.cacheCreationInputTokens > 0
      ? `${r.cacheCreationInputTokens.toLocaleString()} cache write`
      : null,
  ]
    .filter((s) => s !== null)
    .join(" · ");
  return (
    // Unframed on purpose: the theme's Card default (`withBorder: true`) turns
    // any boxed detail into a panel with a margin, which reads as floating
    // *under* the table rather than belonging to the row — the band above is
    // the containment. The left pad puts the content under the Time column,
    // past the chevron.
    <Box p="2px 14px 16px 60px">
      <Stack gap={10}>
        {r.errorDetail != null && (
          <Box>
            <Eyebrow mb={6}>Why it failed</Eyebrow>
            {/* The edge caps this at ~300 chars at write time, so the block
                wraps rather than scrolls; `anywhere` because upstream errors
                can carry long unbroken tokens. The bg is overridden because
                the default Code bg (dark.6) is LIGHTER than the band — a
                raised slab fighting the row it belongs to. One step darker
                than the band recesses it instead: wrapper dark.7 > band
                dark.8 > code dark.9. */}
            <Code
              block
              fz={11.5}
              style={{
                background: "var(--mantine-color-dark-9)",
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
              }}
            >
              {r.errorDetail}
            </Code>
          </Box>
        )}
        <Group gap={24} wrap="wrap" align="flex-start">
          {r.path != null && (
            <Box>
              <Eyebrow mb={4}>Request</Eyebrow>
              <Text className="az-mono" fz={12} c="dark.1">
                {r.method ? `${r.method} ` : ""}
                {r.path}
              </Text>
            </Box>
          )}
          {r.statusCode != null && (
            <Box>
              <Eyebrow mb={4}>Status</Eyebrow>
              <Text className="az-mono" fz={12} c="dark.1">
                {r.statusCode}
              </Text>
            </Box>
          )}
          {r.stopReason != null && (
            <Box>
              <Eyebrow mb={4}>Stop reason</Eyebrow>
              <Text className="az-mono" fz={12} c="dark.1">
                {r.stopReason}
              </Text>
            </Box>
          )}
          <Box>
            <Eyebrow mb={4}>Tokens</Eyebrow>
            <Text className="az-mono" fz={12} c="dark.1">
              {r.inputTokens.toLocaleString()} in · {r.outputTokens.toLocaleString()} out
            </Text>
            {cache && (
              <Text className="az-mono" fz={11} c="dark.3">
                {cache}
              </Text>
            )}
          </Box>
          <Box>
            <Eyebrow mb={4}>Cost</Eyebrow>
            <Text className="az-mono" fz={12} c="dark.1">
              {fmtUsd(r.costUsd)}
            </Text>
          </Box>
          <Box>
            <Eyebrow mb={4}>Latency</Eyebrow>
            <Text className="az-mono" fz={12} c="dark.1">
              {r.durationMs > 0 ? `${r.durationMs}ms` : "—"}
            </Text>
          </Box>
          <Box>
            <Eyebrow mb={4}>Called at</Eyebrow>
            <Text className="az-mono" fz={12} c="dark.1">
              {new Date(r.createdAt).toISOString()}
            </Text>
          </Box>
          <Box>
            <Eyebrow mb={4}>Subject</Eyebrow>
            {/* Copyable, not just hoverable: this is the identity a support
                thread would quote, and the user cell renders the claims. */}
            <Text className="az-mono" fz={12} c="dark.3">
              {r.userOid}
            </Text>
          </Box>
        </Group>
      </Stack>
    </Box>
  );
}
