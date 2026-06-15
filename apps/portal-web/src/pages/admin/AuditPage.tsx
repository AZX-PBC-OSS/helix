import { useState } from "react";
import {
  Box,
  Card,
  Group,
  SegmentedControl,
  SimpleGrid,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { Icon } from "../../components/Icon";
import {
  Hint,
  PageHead,
  PreviewBadge,
  Stat,
  ToneBadge,
  type Tone,
} from "../../components/primitives";
import { fmtCount } from "../../lib/format";
import { PREVIEW_AUDIT } from "../../preview/previewData";

/** PREVIEW — the M4 gateway audit log: (app, user, capability, outcome, cost). */

const OUT_META: Record<string, [Tone, string]> = {
  ok: ["live", "ok"],
  blocked: ["bad", "blocked"],
  quota: ["warn", "quota"],
  denied: ["bad", "denied"],
};

export function AuditPage() {
  const [q, setQ] = useState("");
  const [out, setOut] = useState("all");

  const rows = PREVIEW_AUDIT.filter((r) => {
    if (out !== "all" && r.out !== out) return false;
    if (q && !(r.app + r.user + r.cap + r.target).toLowerCase().includes(q.toLowerCase()))
      return false;
    return true;
  });
  const totalCost = rows.reduce((s, r) => s + r.cost, 0);

  return (
    <div className="az-stagger">
      <PageHead
        eyebrow="Control plane"
        title={
          <Group gap={12}>
            Gateway Audit Log <PreviewBadge />
          </Group>
        }
        sub="Every gateway call recorded as (app, user, capability, outcome, cost) — the platform's single source of truth for who did what. Mock events until M4."
      />

      <Group gap={10} mb={18} wrap="wrap">
        <TextInput
          placeholder="Filter by app, user, capability…"
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
            { value: "blocked", label: "Blocked" },
            { value: "quota", label: "Quota" },
            { value: "denied", label: "Denied" },
          ]}
        />
      </Group>

      <SimpleGrid cols={{ base: 2, md: 4 }} spacing={18} mb={18}>
        <Card p="14px 18px">
          <Stat label="Events shown" value={rows.length} icon="list" />
        </Card>
        <Card p="14px 18px">
          <Stat label="Tokens" value={fmtCount(rows.reduce((s, r) => s + r.tok, 0))} icon="cpu" />
        </Card>
        <Card p="14px 18px">
          <Stat label="Cost" value={`$${totalCost.toFixed(3)}`} icon="bolt" />
        </Card>
        <Card p="14px 18px">
          <Stat
            label="Blocked / denied"
            value={rows.filter((r) => r.out === "blocked" || r.out === "denied").length}
            tone="var(--az-bad)"
            icon="shield"
          />
        </Card>
      </SimpleGrid>

      <Box
        style={{
          border: "1px solid var(--az-line)",
          borderRadius: "var(--mantine-radius-lg)",
          overflow: "hidden",
          background: "var(--mantine-color-dark-7)",
        }}
      >
        <Table verticalSpacing={10} horizontalSpacing="lg" className="az-mono" fz={12}>
          <Table.Thead style={{ background: "var(--mantine-color-dark-6)" }}>
            <Table.Tr>
              <Table.Th>Time</Table.Th>
              <Table.Th>App</Table.Th>
              <Table.Th>User</Table.Th>
              <Table.Th>Capability</Table.Th>
              <Table.Th>Model / target</Table.Th>
              <Table.Th style={{ textAlign: "right" }}>Tokens</Table.Th>
              <Table.Th style={{ textAlign: "right" }}>Outcome</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((r, i) => {
              const [tone, label] = OUT_META[r.out] ?? OUT_META["ok"]!;
              return (
                <Table.Tr key={i}>
                  <Table.Td c="dark.2">{r.t}</Table.Td>
                  <Table.Td>
                    <Text component="span" className="az-mono" fz={12} c="accent.4">
                      {r.app}
                    </Text>
                  </Table.Td>
                  <Table.Td c={r.user.startsWith("anon") ? "dark.3" : "dark.1"}>{r.user}</Table.Td>
                  <Table.Td>{r.cap}</Table.Td>
                  <Table.Td c="dark.2">{r.target}</Table.Td>
                  <Table.Td className="az-tnum" style={{ textAlign: "right" }} c="dark.1">
                    {r.tok ? r.tok.toLocaleString() : "—"}
                  </Table.Td>
                  <Table.Td style={{ textAlign: "right" }}>
                    <ToneBadge tone={tone} style={{ padding: "2px 7px", fontSize: 10 }}>
                      {label}
                    </ToneBadge>
                  </Table.Td>
                </Table.Tr>
              );
            })}
            {rows.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={7}>
                  <Text ta="center" c="dark.2" py={24} ff="text" fz={13}>
                    No events match these filters.
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </Box>

      <Box mt={18}>
        <Hint icon="shield" tone="info">
          The audit log streams to a write-only immutable sink, so the gateway&apos;s own DB
          credentials can&apos;t rewrite history.
        </Hint>
      </Box>
    </div>
  );
}
