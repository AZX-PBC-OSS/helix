import { useState, type CSSProperties } from "react";
import {
  Box,
  Card,
  Center,
  Group,
  Loader,
  SegmentedControl,
  SimpleGrid,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { GatewayOutcome } from "@azx-pbc/shared";
import { gatewayAuditQuery } from "../../api/queries";
import { Icon } from "../../components/Icon";
import { ScrollFade } from "../../components/ScrollFade";
import { Hint, PageHead, Stat, ToneBadge, type Tone } from "../../components/primitives";
import { fmtCount, fmtUsd, timeAgo } from "../../lib/format";

/** The M4 gateway audit log: (app, user, capability, model, tokens, cost, latency, outcome). */

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
 * Width below which the table scrolls horizontally rather than crushing its ten
 * columns. Sized so every column holds its content on one line at 12px mono —
 * the numeric columns are right-aligned, and a column that wraps its header
 * shoves the outcome badge off the edge, which is the failure this replaces.
 */
const MIN_TABLE_WIDTH = 1160;

/**
 * Clamp for the target cell's two lines. `path` is app-controlled and capped at
 * 512 chars by the edge, which is far too long to render whole: allowed to wrap
 * freely it turned one row 842px tall, and on a single nowrap line it would drag
 * the table out past any useful scroll width. Two lines with an ellipsis keeps
 * rows uniform; the full value stays on the cell's `title`.
 */
const CLAMP_2: CSSProperties = {
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
  overflowWrap: "anywhere",
};

export function AuditPage() {
  const [q, setQ] = useState("");
  const [out, setOut] = useState("all");

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
      sub="Gateway calls: app, user, capability, target, tokens, outcome. Proxied fetch rows carry the request path; query strings are not recorded."
    />
  );

  const all = audit.data?.rows ?? [];
  const rows = all.filter((r) => {
    if (!q) return true;
    return `${r.slug ?? ""}${r.userOid}${r.capability}${r.model}${r.method ?? ""}${r.path ?? ""}`
      .toLowerCase()
      .includes(q.toLowerCase());
  });
  const totalTokens = rows.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
  const totalCost = rows.reduce((s, r) => s + r.costUsd, 0);
  // Everything that did not deliver. Stated as "not ok" rather than a hand-kept
  // list of failure outcomes, so a newly added outcome can't silently fall out
  // of the count the way it would from an `=== "error" || …` chain.
  const failed = rows.filter((r) => r.outcome !== "ok").length;

  return (
    <div className="az-stagger">
      {head}

      <Group gap={10} mb={18} wrap="wrap">
        <TextInput
          placeholder="Filter by app, user, capability, target, path…"
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
            value={failed}
            tone={failed > 0 ? "var(--az-bad)" : undefined}
            icon="shield"
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
          {/* Ten columns does not fit a laptop, let alone a phone: the table
              scrolls inside its own frame rather than the page scrolling
              sideways or the last columns being clipped away. Unlike AppsTable
              this stays on `auto` layout — an operator reading an audit row
              wants the whole origin, not a truncated one, and the only
              unbounded cell is constrained below instead. */}
          <ScrollFade minWidth={MIN_TABLE_WIDTH}>
            <Table verticalSpacing={10} horizontalSpacing="lg" className="az-mono" fz={12}>
              <Table.Thead style={{ background: "var(--mantine-color-dark-6)" }}>
                <Table.Tr>
                  <Table.Th>Time</Table.Th>
                  <Table.Th>App</Table.Th>
                  <Table.Th>User</Table.Th>
                  <Table.Th>Capability</Table.Th>
                  <Table.Th>Model / target</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Tokens</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Cost</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Latency</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Status</Table.Th>
                  <Table.Th style={{ textAlign: "right" }}>Outcome</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((r) => {
                  const [tone, label] = OUT_META[r.outcome];
                  const tokens = r.inputTokens + r.outputTokens;
                  return (
                    <Table.Tr key={r.id}>
                      <Table.Td c="dark.2">{timeAgo(r.createdAt)}</Table.Td>
                      <Table.Td>
                        <Text component="span" className="az-mono" fz={12} c="accent.4">
                          {r.slug ?? "—"}
                        </Text>
                      </Table.Td>
                      <Table.Td c="dark.1">{r.userOid}</Table.Td>
                      <Table.Td>{r.capability}</Table.Td>
                      {/* The only cell whose content is app-controlled and
                        variable-length, so the one that has to be bounded in
                        both directions — see CLAMP_2. `title` carries the
                        untruncated value for the rows where it matters. */}
                      <Table.Td
                        c="dark.2"
                        style={{ maxWidth: 360, minWidth: 260 }}
                        title={r.path ? `${r.method ?? ""} ${r.model}${r.path}`.trim() : undefined}
                      >
                        <div style={CLAMP_2}>{r.model}</div>
                        {/* `fetch` rows carry the request line too; `llm`/`data`
                          rows have neither and simply render the model alone. */}
                        {r.path !== null && (
                          <Text
                            component="div"
                            className="az-mono"
                            fz={11}
                            c="dark.3"
                            style={CLAMP_2}
                          >
                            {r.method ? `${r.method} ` : ""}
                            {r.path}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td className="az-tnum" style={{ textAlign: "right" }} c="dark.1">
                        {tokens ? tokens.toLocaleString() : "—"}
                      </Table.Td>
                      <Table.Td className="az-tnum" style={{ textAlign: "right" }} c="dark.1">
                        {r.costUsd ? fmtUsd(r.costUsd) : "—"}
                      </Table.Td>
                      <Table.Td className="az-tnum" style={{ textAlign: "right" }} c="dark.2">
                        {r.durationMs ? `${r.durationMs}ms` : "—"}
                      </Table.Td>
                      <Table.Td className="az-tnum" style={{ textAlign: "right" }} c="dark.2">
                        {r.statusCode ?? "—"}
                      </Table.Td>
                      <Table.Td style={{ textAlign: "right" }}>
                        <span title={r.errorDetail ?? r.stopReason ?? undefined}>
                          <ToneBadge tone={tone} style={{ padding: "2px 7px", fontSize: 10 }}>
                            {label}
                          </ToneBadge>
                        </span>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
                {rows.length === 0 && (
                  <Table.Tr>
                    <Table.Td colSpan={10}>
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
