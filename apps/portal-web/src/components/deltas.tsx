import { Fragment, type ReactNode } from "react";
import { Stack, Text, Tooltip } from "@mantine/core";
import { deltaHelp, parseArrayDeltaPath, type Delta, type Risk } from "@azx-pbc/shared";
import { fmtBytes, fmtCount, fmtUsd } from "../lib/format";
import { Icon, type IconName } from "./Icon";
import type { Tone } from "./primitives";

/**
 * Human renderings of capability deltas. The wire carries path strings
 * (`mcp[+pagerduty]`, `llm.dollarsPerDay: 50 → 200`); these components split
 * those paths back into structure and render them as labeled chips with a
 * per-delta risk badge and a help tooltip (`deltaHelp` in `@azx-pbc/shared`).
 */

/** Tone + short label for a risk level. Shared by the queue cards and the per-delta chips. */
export const RISK_META: Record<Risk, [Tone, string]> = {
  high: ["bad", "HIGH RISK"],
  med: ["warn", "ELEVATED"],
  low: ["info", "ROUTINE"],
};

/** Icon for a delta, by the capability it touches. Mirrors `deltaHelp`'s matching. */
function deltaIcon(d: Delta): IconName {
  if (d.path === "visibility") return "globe";
  if (d.path === "llm.dollarsPerDay" || d.path.startsWith("llm.models")) return "cpu";
  if (d.path === "data.writesPerDay" || d.path === "data.bytesPerDay") return "gauge";
  if (d.path.startsWith("data.")) return "db";
  const fetchAdd = parseArrayDeltaPath(d.path);
  if (fetchAdd?.field === "fetch.origins") {
    if (d.path.includes("→provider:")) return "bolt";
    if (d.path.includes("→secret:")) return "key";
    return "ext";
  }
  if (d.path.startsWith("fetch") || d.path.startsWith("shim")) return "ext";
  if (d.path.startsWith("mcp")) return "key";
  if (d.path.startsWith("offline")) return "download";
  return "shield";
}

/**
 * Visibility values travel as `internal` / `group:<id>,<id>` — spaced for
 * reading, not parsed. A group set is the one list-valued delta; long id lists
 * (GUIDs in a real deployment) abbreviate to the first three with a count,
 * because the chip is a summary — the full, unabridged list stays in the
 * tooltip's raw path line, and the from-side of a queue-visible visibility
 * delta is the *prior* state, not the grant being decided.
 */
const VISIBILITY_IDS_SHOWN = 3;

function fmtVisibility(v: string): string {
  if (!v.startsWith("group:")) return v;
  const ids = v.slice("group:".length).split(",");
  const shown = ids.slice(0, VISIBILITY_IDS_SHOWN).join(", ");
  return ids.length > VISIBILITY_IDS_SHOWN
    ? `group: ${shown} …+${ids.length - VISIBILITY_IDS_SHOWN} more`
    : `group: ${shown}`;
}

/** A delta value, in the field's own unit. Raw identifiers (origins, model ids) pass through. */
function fmtValue(field: string, v: string | number | boolean | undefined): string {
  if (v === undefined) return "∅";
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "number") {
    if (field === "llm.dollarsPerDay") return `${fmtUsd(v)}/day`;
    if (field === "data.writesPerDay") return `${fmtCount(v)} writes/day`;
    if (field === "data.bytesPerDay") return `${fmtBytes(v)}/day`;
    if (field === "fetch.requestsPerDay") return `${fmtCount(v)} reqs/day`;
    return String(v);
  }
  if (field === "visibility") return fmtVisibility(v);
  return v;
}

/** The scalar field a delta changes — membership deltas are keyed by their array field. */
function scalarField(path: string): string {
  const i = path.indexOf("[");
  return i === -1 ? path : path.slice(0, i);
}

/**
 * A fetch-origin item's credential half, split from the origin so the chip can
 * show what will be attached without a wall of `→provider:` syntax.
 */
function originCredential(item: string): string | null {
  const i = item.indexOf("→");
  return i === -1 ? null : item.slice(i + "→".length);
}

/** The credential source attached to a proxied-origin item, in words ("via asana", "secret gh-pat"). */
function FetchCredential({ item }: { item: string }) {
  const cred = originCredential(item);
  if (!cred) return null;
  const provider = cred.startsWith("provider:");
  const secret = cred.startsWith("secret:");
  if (!provider && !secret) return null;
  return (
    <Text fz={10.5} c="dark.2" style={{ whiteSpace: "nowrap" }}>
      {provider ? "via " : "secret "}
      <Text span className="az-mono" fz={10.5} c="dark.1">
        {cred.slice((provider ? "provider:" : "secret:").length)}
      </Text>
    </Text>
  );
}

/**
 * One segment of the row. The `.az-chip` class (global.css) strips corners and
 * collapses seams with its siblings; the row (`.az-chiprow`) rounds the ends.
 */
function Chip({ children }: { children: ReactNode }) {
  return <span className="az-chip">{children}</span>;
}

/** The ? affordance — the row's last segment. Hover, focus or tap to open. */
function HelpTip({ children }: { children: ReactNode }) {
  return (
    <Tooltip
      label={children}
      color="dark"
      multiline
      maw={380}
      position="top"
      // `focus` off in Mantine defaults; see primitives.tsx GroupVisibilityBadge.
      events={{ hover: true, focus: true, touch: true }}
    >
      {/* Wrapper span is load-bearing — Mantine clones handlers onto this element. */}
      <span
        className="az-chip"
        tabIndex={0}
        aria-label="What this change means"
        style={{ cursor: "help" }}
      >
        <Icon name="help" size={14} style={{ color: "var(--mantine-color-dark-2)" }} />
      </span>
    </Tooltip>
  );
}

/** The tooltip body: what the capability grants, why it is gated, this change's rating. */
function HelpBody({ d }: { d: Delta }) {
  const help = deltaHelp(d);
  return (
    <Stack gap={7}>
      <Text fz={12.5} fw={600}>
        {help.title}
      </Text>
      <div>
        <Text
          fz={10.5}
          c="dimmed"
          tt="uppercase"
          fw={600}
          style={{ letterSpacing: ".04em" }}
          mb={2}
        >
          What this grants
        </Text>
        <Text fz={12} lh={1.45}>
          {help.grants}
        </Text>
      </div>
      {help.risks.length > 0 && (
        <div>
          <Text
            fz={10.5}
            c="dimmed"
            tt="uppercase"
            fw={600}
            style={{ letterSpacing: ".04em" }}
            mb={2}
          >
            Why it can be risky
          </Text>
          <Stack gap={3}>
            {help.risks.map((r, i) => (
              <Text key={i} fz={12} lh={1.45}>
                • {r}
              </Text>
            ))}
          </Stack>
        </div>
      )}
      {d.risk && (
        <div>
          <Text
            fz={10.5}
            c="dimmed"
            tt="uppercase"
            fw={600}
            style={{ letterSpacing: ".04em" }}
            mb={2}
          >
            This change
          </Text>
          <Text fz={12} lh={1.45}>
            Rated {RISK_META[d.risk][1]}. {help.riskWhy}
          </Text>
        </div>
      )}
      <Text className="az-mono" fz={10} c="dimmed">
        {d.path}
      </Text>
    </Stack>
  );
}

/** One delta as a row of chips: capability, the change itself, its risk, and help. */
export function DeltaRow({ delta: d }: { delta: Delta }) {
  const membership = parseArrayDeltaPath(d.path);
  const field = membership ? membership.field : scalarField(d.path);
  const risk = d.risk ? (
    <span className="az-chip" data-risk={d.risk}>
      {d.risk === "high" && <Icon name="alert" size={12} />}
      {RISK_META[d.risk][1]}
    </span>
  ) : null;

  return (
    <span className="az-chiprow">
      <Chip>
        <Icon name={deltaIcon(d)} size={12} style={{ color: "var(--mantine-color-dark-2)" }} />
        <Text fz={12} c="dark.1">
          {deltaHelp(d).title}
        </Text>
      </Chip>
      {membership ? (
        <Chip>
          <Text
            className="az-mono"
            fz={12}
            style={{
              color: membership.op === "+" ? "var(--az-live)" : "var(--mantine-color-dark-2)",
            }}
          >
            {membership.op === "+" ? "+" : "−"}
          </Text>
          {membership.field === "fetch.origins" ? (
            <>
              <Text className="az-mono" fz={12} c="dark.1">
                {membership.item.split("→")[0]}
              </Text>
              <FetchCredential item={membership.item} />
            </>
          ) : (
            <Text className="az-mono" fz={12} c="dark.1">
              {membership.item}
            </Text>
          )}
        </Chip>
      ) : (
        <Chip>
          <Text className="az-mono" fz={12} c="dark.2">
            {fmtValue(field, d.from)}
          </Text>
          <Text className="az-mono" fz={12} c="dark.3">
            →
          </Text>
          <Text className="az-mono" fz={12} c="dark.1">
            {fmtValue(field, d.to)}
          </Text>
        </Chip>
      )}
      {risk}
      <HelpTip>
        <HelpBody d={d} />
      </HelpTip>
    </span>
  );
}

/** Every delta of a request, expanded — the approval card's default view. */
export function DeltaList({ deltas }: { deltas: Delta[] }) {
  return (
    <Stack gap={8} align="flex-start">
      {deltas.map((d, i) => (
        <Fragment key={`${d.path}-${i}`}>
          <DeltaRow delta={d} />
        </Fragment>
      ))}
    </Stack>
  );
}

/**
 * One-line explanation of how a request's aggregate rating relates to its
 * per-delta chips — "highest of", not a sum. Null when no delta carries a
 * risk (rows filed before the field existed), so the tooltip simply doesn't
 * appear rather than making a claim it can't back.
 */
export function riskBreakdown(deltas: Delta[]): string | null {
  const counts: Record<Risk, number> = { high: 0, med: 0, low: 0 };
  let known = 0;
  for (const d of deltas) {
    if (!d.risk) continue;
    known += 1;
    counts[d.risk] += 1;
  }
  if (known === 0) return null;
  const parts: string[] = [];
  if (counts.high > 0) parts.push(`${counts.high} high risk`);
  if (counts.med > 0) parts.push(`${counts.med} elevated`);
  if (counts.low > 0) parts.push(`${counts.low} routine`);
  return `Rated by the highest of this request's ${known} change${known === 1 ? "" : "s"}: ${parts.join(", ")}.`;
}
