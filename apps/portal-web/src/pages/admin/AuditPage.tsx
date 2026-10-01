import { useState } from "react";
import {
  Box,
  Card,
  Center,
  Group,
  Loader,
  SegmentedControl,
  SimpleGrid,
  TextInput,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { GatewayCall, GatewayOutcome } from "@azx-pbc/shared";
import { gatewayAuditQuery } from "../../api/queries";
import { Icon } from "../../components/Icon";
import { ScrollFade } from "../../components/ScrollFade";
import { OUT_META, GatewayCallTable } from "../../components/GatewayCallTable";
import { Hint, PageHead, Stat } from "../../components/primitives";
import { fmtCount, fmtUsd } from "../../lib/format";

/**
 * The M4 gateway audit log, over the shared {@link GatewayCallTable}. This
 * page supplies the cross-app chrome: the frame, the filter box (which matches
 * what the columns render *and* what only the expand shows), the stats, and
 * the App column.
 */

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
            { value: "connection_required", label: "Connect" },
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
            <GatewayCallTable rows={rows} showApp />
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
