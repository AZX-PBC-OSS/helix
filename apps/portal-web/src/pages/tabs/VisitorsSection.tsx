import { useState } from "react";
import { Anchor, Card, Center, Group, Loader, SimpleGrid, Stack, Text } from "@mantine/core";
import { AreaChart } from "@mantine/charts";
import { useQuery } from "@tanstack/react-query";
import {
  VISIT_IDLE_MINUTES,
  VISITOR_RANGES,
  type VisitorLocation,
  type VisitorRange,
  type VisitorSummary,
  type VisitorTotals,
} from "@azx-pbc/shared";
import { visitorsQuery } from "../../api/queries";
import { Meter } from "../../components/charts";
import { RangeControl } from "../../components/usageCharts";
import { Eyebrow, Hint, Stat } from "../../components/primitives";
import { Icon } from "../../components/Icon";
import { fmtCount } from "../../lib/format";

/**
 * Visits, unique visitors and approximate location for one app (ADR-0050).
 * Rendered only for the owner or an admin; the endpoint enforces the same gate.
 */
export function VisitorsSection({ slug }: { slug: string }) {
  const [range, setRange] = useState<VisitorRange>("30d");
  const q = useQuery(visitorsQuery(slug, range));

  return (
    <Stack gap={18}>
      <Group justify="space-between" align="center">
        <Eyebrow>Visitors</Eyebrow>
        <RangeControl value={range} onChange={setRange} options={VISITOR_RANGES} />
      </Group>
      {q.isPending ? (
        <Center py={40}>
          <Loader size="sm" />
        </Center>
      ) : q.isError ? (
        <Hint icon="alert" tone="bad">
          Couldn't load visitors: {q.error.message}
        </Hint>
      ) : (
        <VisitorsBody v={q.data} range={range} />
      )}
    </Stack>
  );
}

function VisitorsBody({ v, range }: { v: VisitorSummary; range: VisitorRange }) {
  const perVisitor = ratio(v.current);
  const priorPerVisitor = ratio(v.prior);
  const vs = `vs prior ${range}`;

  return (
    <>
      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing={18}>
        <Card>
          <Stat
            icon="activity"
            label="Visits"
            value={fmtCount(v.current.visits)}
            sub={`${pctDelta(v.current.visits, v.prior.visits)} ${vs}`}
          />
        </Card>
        <Card>
          <Stat
            icon="user"
            label="Unique visitors"
            value={fmtCount(v.current.uniqueVisitors)}
            sub={`${pctDelta(v.current.uniqueVisitors, v.prior.uniqueVisitors)} ${vs}`}
          />
        </Card>
        <Card>
          <Stat
            icon="rotate"
            label="Visits per visitor"
            value={perVisitor === null ? "—" : perVisitor.toFixed(2)}
            sub={
              perVisitor === null || priorPerVisitor === null
                ? `no prior data ${vs}`
                : `${signed(perVisitor - priorPerVisitor, 2)} ${vs}`
            }
          />
        </Card>
      </SimpleGrid>

      {v.current.visits === 0 ? (
        <Hint icon="globe" tone="info">
          No visits in this window yet. A visit is counted when someone opens the app in a browser.
        </Hint>
      ) : (
        <>
          <Card>
            <Eyebrow>Daily visits</Eyebrow>
            <AreaChart
              mt={14}
              h={220}
              data={v.series.map((p) => ({
                label: new Date(p.bucket).toLocaleDateString([], {
                  month: "short",
                  day: "numeric",
                }),
                visits: p.visits,
                visitors: p.uniqueVisitors,
              }))}
              dataKey="label"
              series={[
                { name: "visits", label: "Visits", color: "var(--az-info)" },
                {
                  name: "visitors",
                  label: "Unique visitors (per day)",
                  color: "var(--az-acc)",
                  strokeDasharray: "5 5",
                },
              ]}
              valueFormatter={fmtCount}
              curveType="monotone"
              withDots={false}
              withLegend
              gridAxis="y"
              tickLine="y"
              areaProps={{ fillOpacity: 0.12 }}
            />
          </Card>
          <LocationCard v={v} />
        </>
      )}

      <Group gap={6} c="dark.3" wrap="nowrap" align="flex-start">
        <Icon name="shield" size={12} />
        <Text size="xs" c="dark.3">
          A visit is one or more page loads with no gap over {VISIT_IDLE_MINUTES} minutes. Visitors
          are counted by IP address, so people sharing a network count once. Raw IP addresses are
          not stored.
        </Text>
      </Group>
    </>
  );
}

function LocationCard({ v }: { v: VisitorSummary }) {
  if (!v.geo.available) {
    return (
      <Hint icon="globe" tone="neutral">
        Approximate location is unavailable. {v.geo.reason}
      </Hint>
    );
  }
  const total = Math.max(v.current.uniqueVisitors, 1);
  return (
    <Card>
      <Eyebrow>Approximate location · from IP</Eyebrow>
      <Group gap={14} mt={14} mb={6} wrap="nowrap">
        <Text size="xs" c="dark.3" w={220} style={{ flexShrink: 0 }}>
          Location
        </Text>
        <Text size="xs" c="dark.3" style={{ flex: 1 }}>
          Share of unique visitors
        </Text>
        <Text size="xs" c="dark.3" w={70} ta="right">
          Visitors
        </Text>
        <Text size="xs" c="dark.3" w={70} ta="right">
          Visits
        </Text>
      </Group>
      {v.locations.map((l) => (
        <LocationRow
          key={`${l.country}:${l.region ?? ""}`}
          label={placeLabel(l)}
          pct={(l.visitors / total) * 100}
          visitors={l.visitors}
          visits={l.visits}
        />
      ))}
      {v.otherLocations.visits > 0 && (
        <LocationRow
          label="Other locations"
          pct={(v.otherLocations.uniqueVisitors / total) * 100}
          visitors={v.otherLocations.uniqueVisitors}
          visits={v.otherLocations.visits}
          muted
        />
      )}
      {v.unresolved.visits > 0 && (
        <LocationRow
          label="Unresolved or private network"
          pct={(v.unresolved.uniqueVisitors / total) * 100}
          visitors={v.unresolved.uniqueVisitors}
          visits={v.unresolved.visits}
          muted
        />
      )}
      <Text size="xs" c="dark.3" mt={12}>
        Region from IP is right less often than country. VPNs, mobile carriers and corporate
        networks can place visitors in the wrong region.
        {v.geo.attribution && (
          <>
            {" "}
            <Anchor href={v.geo.attribution.url} target="_blank" rel="noreferrer" fz="xs">
              {v.geo.attribution.text}
            </Anchor>
            .
          </>
        )}
      </Text>
    </Card>
  );
}

function LocationRow(props: {
  label: string;
  pct: number;
  visitors: number;
  visits: number;
  muted?: boolean;
}) {
  return (
    <Group gap={14} py={7} wrap="nowrap">
      <Text
        fz={13}
        c={props.muted ? "dark.2" : "dark.0"}
        w={220}
        truncate
        style={{ flexShrink: 0 }}
      >
        {props.label}
      </Text>
      <div style={{ flex: 1 }}>
        <Meter
          pct={props.pct}
          tone={props.muted ? "var(--mantine-color-dark-3)" : "var(--az-info)"}
        />
      </div>
      <Text className="az-mono az-tnum" fz={12.5} c="dark.1" w={70} ta="right">
        {fmtCount(props.visitors)}
      </Text>
      <Text className="az-mono az-tnum" fz={12.5} c="dark.2" w={70} ta="right">
        {fmtCount(props.visits)}
      </Text>
    </Group>
  );
}

function placeLabel(l: VisitorLocation): string {
  const country = l.countryName ?? l.country;
  return l.region ? `${l.region}, ${l.country}` : country;
}

function ratio(t: VisitorTotals): number | null {
  return t.uniqueVisitors > 0 ? t.visits / t.uniqueVisitors : null;
}

/** "+7.9%", "-3.0%", or "new" when there was nothing to compare against. */
export function pctDelta(current: number, prior: number): string {
  if (prior === 0) return current === 0 ? "±0%" : "new";
  return `${signed(((current - prior) / prior) * 100, 1)}%`;
}

function signed(n: number, digits: number): string {
  const s = n.toFixed(digits);
  // A change that rounds to zero reads as none, never as "-0.00".
  if (Number(s) === 0) return `±${(0).toFixed(digits)}`;
  return n > 0 ? `+${s}` : s;
}
