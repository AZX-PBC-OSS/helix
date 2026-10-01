import { Fragment, useState } from "react";
import { ActionIcon, Box, Code, Group, Stack, Table, Text } from "@mantine/core";
import type { GatewayCall, GatewayOutcome } from "@azx-pbc/shared";
import { Icon } from "./Icon";
import { Eyebrow, Principal, ToneBadge, type Tone } from "./primitives";
import { fmtUsd, principalLabel, timeAgo } from "../lib/format";

/**
 * The gateway-call table shared by the admin Audit Log and the app Usage tab's
 * "Recent calls" card. The table is the scan row — who did what, when, and
 * whether it delivered — and the per-call record (the failure reason, the
 * request line, token/cost accounting, the raw subject) lives behind each row's
 * chevron, which turns the row and its detail into one darker band. Rows open
 * independently of each other: comparing two failures side by side is the
 * admin screen's job, so opening a row must never close another.
 *
 * `showApp` adds the App column for cross-app readers; the Usage tab passes
 * `false`, since every row there is the same app. Rows carry captured claims —
 * whoever the server gated this data to, the cells render them the same way.
 */

export const OUT_META: Record<GatewayOutcome, [Tone, string]> = {
  ok: ["live", "ok"],
  error: ["bad", "error"],
  refusal: ["warn", "refusal"],
  // The delegated-consent outcome — violet, matching the provider-bound badge
  // in the Capabilities tab. Kept distinct from `refusal` in both word and tone:
  // "user not connected" asks for a Connect action, policy refusal does not
  // (criterion 50).
  connection_required: ["violet", "connect required"],
  quota_blocked: ["warn", "quota"],
  conflict: ["warn", "conflict"],
  forbidden: ["bad", "forbidden"],
};

/**
 * Cap on the model/origin cell. Its values are curated model ids,
 * manifest-approved origins and app-data verbs, so this is a guard against one
 * long hostname dragging the whole table wide, not a load-bearing clamp: the
 * full value stays on the cell's `title` and in the expanded record.
 */
const MODEL_CELL_MAX = 260;

export function GatewayCallTable({
  rows,
  showApp = false,
  emptyText = "No gateway calls match these filters.",
}: {
  rows: GatewayCall[];
  /** Cross-app readers need the App column; a per-app feed does not. */
  showApp?: boolean;
  emptyText?: string;
}) {
  // A set, not Data tab's single `string | null`: this screen's actual job is
  // comparing failures — two rows open side by side, one held open while the
  // list scrolls.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const colSpan = showApp ? 7 : 6;

  return (
    <Table verticalSpacing={10} horizontalSpacing="lg" className="az-mono" fz={12}>
      <Table.Thead style={{ background: "var(--mantine-color-dark-6)" }}>
        <Table.Tr>
          <Table.Th w={40} />
          <Table.Th>Time</Table.Th>
          {showApp && <Table.Th>App</Table.Th>}
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
                {showApp && (
                  <Table.Td>
                    <Text component="span" className="az-mono" fz={12} c="accent.4">
                      {r.slug ?? "—"}
                    </Text>
                  </Table.Td>
                )}
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
                  <Table.Td colSpan={colSpan} p={0}>
                    <CallDetail r={r} />
                  </Table.Td>
                </Table.Tr>
              )}
            </Fragment>
          );
        })}
        {rows.length === 0 && (
          <Table.Tr>
            <Table.Td colSpan={colSpan}>
              <Text ta="center" c="dark.2" py={24} ff="text" fz={13}>
                {emptyText}
              </Text>
            </Table.Td>
          </Table.Tr>
        )}
      </Table.Tbody>
    </Table>
  );
}

/**
 * The lossless record of one call, rendered only while its row is open.
 *
 * Everything here is text, always — `errorDetail` carries upstream and vendor
 * error strings, which can quote request content and, on an auth failure, the
 * key (which is why the ledger keeps them for the admin-only audience and the
 * app-scoped feed nulls it for non-admin owners — apps/edge/src/gateway/llm.ts),
 * and any affordance that interpreted them as markup would be an XSS sink on the
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
