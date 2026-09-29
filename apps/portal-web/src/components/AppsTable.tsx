import { useState } from "react";
import { Anchor, Box, Center, Group, Table, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { AppListItem } from "@azx-pbc/shared";
import { platformUsageQuery } from "../api/queries";
import { Icon } from "./Icon";
import { ScrollFade } from "./ScrollFade";
import { Principal, StatusLine, VisibilityBadge } from "./primitives";
import { fmtUsd, timeAgo } from "../lib/format";
import { useDeployment } from "../lib/deployment";
import { appStatus, awaitingPromoteNumber, deployFacts, type DeployFacts } from "../lib/appStatus";

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
 * A lifetime deploy count came across from those cards and went back out again:
 * it is a number nobody acts on in a list, and "when did this last ship" already
 * answers the question it was standing in for. The count is on the app's own
 * Versions tab, where the history it summarises actually lives.
 *
 * Every column here comes from the list endpoint's own projection, so the table
 * costs a fixed number of queries no matter how many apps it renders. The card
 * grid fetched `GET /versions` per card.
 *
 * The app's hostname is deliberately absent as text: it is long, identical up to
 * the slug on every row, and was costing a quarter of the table's width to say
 * something the name already says. It lives on the external-link icon beside the
 * name — tooltip and `aria-label` — and in full on the app's own page.
 */

/** Spend over the range the platform rollup reports; keyed by slug. */
const SPEND_RANGE = "30d" as const;

type SortKey = "name" | "owner" | "lastDeploy" | "spend";
type SortDir = "asc" | "desc";

interface SortableRow {
  app: AppListItem;
  facts: DeployFacts;
  spendUsd: number | undefined;
}

function collate(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

/**
 * One comparator per sort key, built for the keys' missing values: an app with
 * no owner, no deploy yet or no spend has nothing to order against, so it sinks
 * below every real value in **both** directions — the direction only flips the
 * comparison of rows that actually have the value. Spending `flip` on the whole
 * result would swing the dash rows between bottom and top on every second click.
 */
function compareSortableRows(a: SortableRow, b: SortableRow, key: SortKey, dir: SortDir): number {
  const flip = dir === "asc" ? 1 : -1;
  switch (key) {
    case "name":
      return collate(a.app.displayName, b.app.displayName) * flip;
    case "owner": {
      // Same resolution the `Principal` cell renders: name, then email, then
      // the raw identity; all absent renders a dash, so all absent sorts last.
      const an = a.app.ownerName ?? a.app.ownerEmail ?? a.app.ownerId;
      const bn = b.app.ownerName ?? b.app.ownerEmail ?? b.app.ownerId;
      if (!an && !bn) return 0;
      if (!an) return 1;
      if (!bn) return -1;
      return collate(an, bn) * flip;
    }
    case "lastDeploy": {
      const at = a.facts.lastDeployAt;
      const bt = b.facts.lastDeployAt;
      if (!at && !bt) return 0;
      if (!at) return 1;
      if (!bt) return -1;
      return (Date.parse(at) - Date.parse(bt)) * flip;
    }
    case "spend": {
      const as = a.spendUsd;
      const bs = b.spendUsd;
      if (as === undefined && bs === undefined) return 0;
      if (as === undefined) return 1;
      if (bs === undefined) return -1;
      return (as - bs) * flip;
    }
  }
}

/**
 * A clickable column header: a button inside the `th` (keyboard-reachable,
 * Mantine's focus ring comes along) with the sort direction read from `aria-sort`
 * on the cell. The arrow — the icon set's one up-arrow, rotated for descending,
 * since a second glyph for the inverse direction buys nothing — is the visual
 * affordance; the button itself must stay invisible:
 *
 * The UA stylesheet gives `button` its own `font` shorthand plus
 * `text-transform: none` and `letter-spacing: normal`, and a UA declaration
 * beats *inherited* values — so without the resets below, every sortable header
 * sheds the theme's `th` treatment (mono, 10.5px, letterspaced caps) piece by
 * piece and renders as a browser-default button label beside its untouched
 * neighbours. Each reset inherits the property back from the cell.
 */
function SortableTh({
  label,
  sortName,
  w,
  active,
  dir,
  onSort,
}: {
  label: string;
  /** The accessible name for the button — set when the visible label carries
   * decoration the sort instruction shouldn't (the spend range suffix). */
  sortName?: string;
  w: string;
  active: boolean;
  dir: SortDir;
  onSort: () => void;
}) {
  return (
    <Table.Th w={w} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <UnstyledButton
        onClick={onSort}
        aria-label={`Sort by ${sortName ?? label}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          font: "inherit",
          textTransform: "inherit",
          letterSpacing: "inherit",
          color: "inherit",
        }}
      >
        {label}
        <Icon
          name="arrowU"
          size={11}
          style={{
            flexShrink: 0,
            opacity: active ? 1 : 0.4,
            transform: active && dir === "desc" ? "rotate(180deg)" : undefined,
          }}
        />
      </UnstyledButton>
    </Table.Th>
  );
}

function AppRow({ app, spendUsd }: { app: AppListItem; spendUsd: number | undefined }) {
  const { hostFor, urlFor } = useDeployment();
  const facts = deployFacts(app);
  const status = appStatus(app, facts);
  const pending = awaitingPromoteNumber(facts);
  // Only a link once the app is actually serving, and only once we know where it
  // is — same rule as the app's own header. Both helpers are null until the
  // deployment config lands, so a guessed host can never render.
  const host = hostFor(app);
  const appLink = status === "live" ? urlFor(app) : null;

  return (
    <Table.Tr>
      <Table.Td>
        {/* The two links are siblings, never nested: the row's name opens the app's
            page in the portal, the icon opens the app itself. */}
        <Group gap={8} wrap="nowrap">
          <Group
            gap={11}
            wrap="nowrap"
            component={Link}
            {...{ to: `/apps/${app.slug}` }}
            style={{ color: "inherit", textDecoration: "none", minWidth: 0 }}
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
            <Box miw={0} flex={1}>
              <Text fz={13.5} fw={600} truncate>
                {app.displayName}
              </Text>
              {/* The description as the row's subtitle, when there is one —
                  "Q3 Tracker" alone is everything a stranger gets. Truncated to
                  one line: it is a hint, not a README, and the fixed table
                  layout keeps the rest of the row intact. */}
              {app.description && (
                <Text fz={12} fw={400} c="dark.2" truncate>
                  {app.description}
                </Text>
              )}
            </Box>
          </Group>
          {/* The host used to sit under the name as a second line. It was the
              longest string in the table and the only reason this column needed
              a quarter of the width — so it moved into this affordance, where the
              tooltip still hands it over on demand. */}
          {appLink && host && (
            <Tooltip label={host} position="top" withArrow>
              <Anchor
                href={appLink}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open ${host}`}
                c="accent.4"
                style={{ display: "inline-flex", flexShrink: 0 }}
              >
                <Icon name="ext" size={13} />
              </Anchor>
            </Tooltip>
          )}
        </Group>
      </Table.Td>
      <Table.Td>
        <Principal id={app.ownerId} name={app.ownerName} email={app.ownerEmail} />
      </Table.Td>
      <Table.Td>
        <VisibilityBadge visibility={app.visibility} slug={app.slug} />
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

  // The sort lives here and not on the page, because two of its keys don't exist
  // on `rows`: last-deploy comes from the list projection via `deployFacts`, and
  // spend only exists after this join — there is nothing for the page to sort by.
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "name", dir: "asc" });
  const toggleSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" },
    );

  // Join first, sort second: the comparator reads the joined spend and the deploy
  // facts together. Sorting a fresh array — `rows` belongs to the page's filter.
  const sorted: SortableRow[] = rows
    .map((app) => ({ app, facts: deployFacts(app), spendUsd: spendBySlug.get(app.slug) }))
    .sort((a, b) => compareSortableRows(a, b, sort.key, sort.dir));

  return (
    <Box
      style={{
        border: "1px solid var(--az-line)",
        borderRadius: "var(--mantine-radius-lg)",
        overflow: "hidden",
        background: "var(--mantine-color-dark-7)",
      }}
    >
      {/* Seven columns is wider than a phone: let the table scroll inside its
          own frame rather than the page scrolling sideways. */}
      <ScrollFade minWidth={880}>
        {/* `table-layout: fixed` is what makes the widths below authoritative and
            the App cell's `truncate` actually engage. On `auto` a long display
            name sets its column's minimum from its own content and the table
            grows past its container, pushing spend out of sight. */}
        <Table
          verticalSpacing="sm"
          horizontalSpacing="lg"
          highlightOnHover
          style={{ tableLayout: "fixed" }}
        >
          <Table.Thead style={{ background: "var(--mantine-color-dark-6)" }}>
            {/* Explicit, because seven columns of auto-width content wrap their
                headers and timestamps and shove the last column off-screen. The
                App cell truncates rather than growing. Widths here double as the
                SortableTh widths, so the sort affordance cannot shift the layout. */}
            <Table.Tr>
              <SortableTh
                label="App"
                w="27%"
                active={sort.key === "name"}
                dir={sort.dir}
                onSort={() => toggleSort("name")}
              />
              <SortableTh
                label="Owner"
                w="18%"
                active={sort.key === "owner"}
                dir={sort.dir}
                onSort={() => toggleSort("owner")}
              />
              <Table.Th w="11%">Visibility</Table.Th>
              <Table.Th w="11%">Status</Table.Th>
              {/* Wide enough for "vN awaiting promote" on one line — it is nowrap,
                  so a narrower column would overflow rather than wrap. */}
              <Table.Th w="12%">Live</Table.Th>
              <SortableTh
                label="Last deploy"
                w="10%"
                active={sort.key === "lastDeploy"}
                dir={sort.dir}
                onSort={() => toggleSort("lastDeploy")}
              />
              <SortableTh
                label={`Spend · ${SPEND_RANGE}`}
                sortName="Spend"
                w="11%"
                active={sort.key === "spend"}
                dir={sort.dir}
                onSort={() => toggleSort("spend")}
              />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {sorted.map(({ app, spendUsd }) => (
              <AppRow key={app.id} app={app} spendUsd={spendUsd} />
            ))}
          </Table.Tbody>
        </Table>
      </ScrollFade>
    </Box>
  );
}
