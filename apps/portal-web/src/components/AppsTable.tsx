import { Box, Center, Group, Table, Text } from "@mantine/core";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { AppListItem } from "@azx-pbc/shared";
import { platformUsageQuery } from "../api/queries";
import { Principal, StatusLine, VisibilityBadge } from "./primitives";
import { fmtUsd, timeAgo } from "../lib/format";
import { useDeployment } from "../lib/deployment";
import { appStatus, awaitingPromoteNumber, deployFacts } from "../lib/appStatus";

/**
 * The apps list, in table form — the one presentation of the registry.
 *
 * This replaced a 3-up card grid that showed the same rows with a monogram, a
 * sparkline and two counters per card. The grid read well at three apps and got
 * worse from there, and its differentiating content was the weakest on the page:
 * the sparkline plotted *deploy cadence* from version timestamps because there
 * was no metering API when it was built, and there is one now — so the column
 * a reader actually wants next to an app is what it costs.
 *
 * Every column here comes from the list endpoint's own projection, so the table
 * costs a fixed number of queries no matter how many apps it renders. The card
 * grid fetched `GET /versions` per card.
 */

/** Spend over the range the platform rollup reports; keyed by slug. */
const SPEND_RANGE = "30d" as const;

function AppRow({ app, spendUsd }: { app: AppListItem; spendUsd: number | undefined }) {
  const { hostFor } = useDeployment();
  const facts = deployFacts(app);
  const status = appStatus(app, facts);
  const pending = awaitingPromoteNumber(facts);

  return (
    <Table.Tr>
      <Table.Td>
        <Group
          gap={11}
          wrap="nowrap"
          component={Link}
          {...{ to: `/apps/${app.slug}` }}
          style={{ color: "inherit", textDecoration: "none" }}
        >
          <Center
            w={32}
            h={32}
            style={{
              borderRadius: 8,
              background: "var(--mantine-color-dark-5)",
              border: "1px solid var(--az-line-2)",
              flexShrink: 0,
            }}
          >
            <Text ff="heading" fw={600} fz={13} c="dark.1">
              {app.displayName[0]?.toUpperCase()}
            </Text>
          </Center>
          <Box style={{ minWidth: 0 }}>
            <Text fz={13.5} fw={600} truncate>
              {app.displayName}
            </Text>
            <Text className="az-mono" fz={11} c="dark.2" truncate>
              {hostFor(app)}
            </Text>
          </Box>
        </Group>
      </Table.Td>
      <Table.Td>
        <Principal id={app.ownerId} name={app.ownerName} email={app.ownerEmail} />
      </Table.Td>
      <Table.Td>
        <VisibilityBadge visibility={app.visibility} />
      </Table.Td>
      <Table.Td>
        <StatusLine kind={status} />
      </Table.Td>
      <Table.Td>
        <Text className="az-mono az-tnum" fz={12}>
          {facts.liveNumber === null ? (
            <Text span c="dark.3">
              —
            </Text>
          ) : (
            `v${facts.liveNumber}`
          )}
        </Text>
        {/* The signal the card grid carried as its own badge: something is built
            and waiting on a promote (§5.1). It belongs next to what is live. */}
        {pending !== null && (
          <Text fz={10.5} c="violet.4" mt={2} style={{ whiteSpace: "nowrap" }}>
            v{pending} awaiting promote
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        <Text className="az-mono az-tnum" fz={12} c="dark.2">
          {app.versionCount}
        </Text>
      </Table.Td>
      <Table.Td>
        <Text className="az-mono" fz={12} c="dark.2" style={{ whiteSpace: "nowrap" }}>
          {facts.lastDeployAt ? timeAgo(facts.lastDeployAt) : "—"}
        </Text>
      </Table.Td>
      <Table.Td>
        <Text className="az-mono az-tnum" fz={12} c={spendUsd ? "dark.1" : "dark.3"}>
          {spendUsd === undefined ? "—" : fmtUsd(spendUsd)}
        </Text>
      </Table.Td>
    </Table.Tr>
  );
}

export function AppsTable({ rows }: { rows: AppListItem[] }) {
  // One query for the whole table's spend column, joined by slug. The rollup is
  // range-scoped and covers every app, so this is the same cost at any row count.
  const usage = useQuery(platformUsageQuery(SPEND_RANGE));
  const spendBySlug = new Map(
    (usage.data?.byApp ?? []).flatMap((a) => (a.slug ? [[a.slug, a.costUsd] as const] : [])),
  );

  return (
    <Box
      style={{
        border: "1px solid var(--az-line)",
        borderRadius: "var(--mantine-radius-lg)",
        overflow: "hidden",
        background: "var(--mantine-color-dark-7)",
      }}
    >
      {/* Eight columns is wider than a phone: let the table scroll inside its
          own frame rather than the page scrolling sideways. */}
      <Table.ScrollContainer minWidth={880}>
        {/* `table-layout: fixed` is what makes the widths below authoritative and
            the App cell's `truncate` actually engage. On `auto`, the app host
            sets the column's minimum from its own content and the table grows
            past its container, pushing spend out of sight. */}
        <Table
          verticalSpacing="sm"
          horizontalSpacing="lg"
          highlightOnHover
          style={{ tableLayout: "fixed" }}
        >
          <Table.Thead style={{ background: "var(--mantine-color-dark-6)" }}>
            {/* Explicit widths, because the app host is by far the longest string
                here and left to itself it takes the width every other column
                needs — headers and timestamps wrap, and the spend column gets
                pushed out of view. The App cell truncates instead. */}
            <Table.Tr>
              <Table.Th w="24%">App</Table.Th>
              <Table.Th w="16%">Owner</Table.Th>
              <Table.Th w="11%">Visibility</Table.Th>
              <Table.Th w="10%">Status</Table.Th>
              <Table.Th w="12%">Live</Table.Th>
              <Table.Th w="7%">Deploys</Table.Th>
              <Table.Th w="10%">Last deploy</Table.Th>
              <Table.Th w="10%">Spend · {SPEND_RANGE}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((a) => (
              <AppRow key={a.id} app={a} spendUsd={spendBySlug.get(a.slug)} />
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Box>
  );
}
