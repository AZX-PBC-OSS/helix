import { useState, type CSSProperties, type ReactNode } from "react";
import { Badge, Box, Button, CopyButton, Group, Stack, Text, Title, Tooltip } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { Visibility } from "@azx-pbc/shared";
import { appVisibilityGroupsQuery } from "../api/queries";
import { Icon, type IconName } from "./Icon";

/** The control-plane vocabulary widgets: eyebrows, status dots, badges, stats. */

export function Eyebrow({ children, mb }: { children: ReactNode; mb?: number }) {
  return (
    <Box className="az-eyebrow" mb={mb} style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <Icon name="chevR" size={11} style={{ color: "var(--az-acc)", flexShrink: 0 }} />
      {children}
    </Box>
  );
}

export type StatusKind = "live" | "preview" | "archived" | "empty";

const STATUS_META: Record<StatusKind, { color: string; label: string; pulse: boolean }> = {
  live: { color: "var(--az-live)", label: "Live", pulse: true },
  preview: { color: "var(--az-slate)", label: "Preview", pulse: false },
  archived: { color: "var(--az-bad)", label: "Archived", pulse: false },
  empty: { color: "var(--mantine-color-dark-3)", label: "Not deployed", pulse: false },
};

export function statusLabel(kind: StatusKind): string {
  return STATUS_META[kind].label;
}

export function StatusDot({ kind, size = 8 }: { kind: StatusKind; size?: number }) {
  const s = STATUS_META[kind];
  return (
    <span
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        background: s.color,
        boxShadow: `0 0 0 3px color-mix(in srgb, ${s.color} 18%, transparent)`,
        animation: s.pulse ? "az-pulse 2.4s ease-in-out infinite" : "none",
        flexShrink: 0,
      }}
    />
  );
}

export function StatusLine({ kind }: { kind: StatusKind }) {
  return (
    <Group gap={7} wrap="nowrap">
      <StatusDot kind={kind} />
      <Text size="sm" c="dark.1" fw={500} style={{ whiteSpace: "nowrap" }}>
        {STATUS_META[kind].label}
      </Text>
    </Group>
  );
}

export type Tone =
  | "neutral"
  | "live"
  | "warn"
  | "bad"
  | "info"
  | "violet"
  | "acc"
  | "mag"
  | "slate";

const TONE_STYLE: Record<Tone, { color: string; bg: string; border: string }> = {
  neutral: {
    color: "var(--mantine-color-dark-1)",
    bg: "rgba(255,255,255,.06)",
    border: "var(--az-line-2)",
  },
  live: { color: "var(--az-live)", bg: "var(--az-live-dim)", border: "transparent" },
  warn: { color: "var(--az-warn)", bg: "var(--az-warn-dim)", border: "transparent" },
  bad: { color: "var(--az-bad)", bg: "var(--az-bad-dim)", border: "transparent" },
  info: { color: "var(--az-info)", bg: "var(--az-info-dim)", border: "transparent" },
  violet: { color: "var(--az-violet)", bg: "var(--az-violet-dim)", border: "transparent" },
  acc: { color: "var(--az-acc)", bg: "var(--az-acc-dim)", border: "transparent" },
  mag: { color: "var(--az-mag)", bg: "var(--az-mag-dim)", border: "transparent" },
  slate: { color: "var(--az-slate)", bg: "var(--az-slate-dim)", border: "transparent" },
};

export function ToneBadge({
  tone = "neutral",
  icon,
  children,
  style,
}: {
  tone?: Tone;
  icon?: IconName;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const t = TONE_STYLE[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        color: t.color,
        background: t.bg,
        border: `1px solid ${t.border}`,
        padding: "3px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        fontFamily: "var(--mantine-font-family-monospace)",
        letterSpacing: ".02em",
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}

/**
 * The `group` arm of {@link VisibilityBadge}, which needs more than a `switch`
 * case for two reasons.
 *
 * The pill is a **fixed label** — and a short one. What it used to print was a
 * group id, which is a 36-character GUID in every real deployment (ADR-0040 §1
 * accepts GUIDs as the cost of not needing an infra deploy per group); in a
 * `table-layout: fixed` cell that painted straight over the two columns to its
 * right. The dev fixtures' readable ids (`eng-team`) are why it never showed up
 * locally.
 *
 * Both labels are kept about as short as `Internal` and `Password`, the widest
 * pills this vocabulary already ships, and that is the whole budget. Measured:
 * the Visibility column is 11% of an 880px minimum and `horizontalSpacing="lg"`
 * spends 40px of it, leaving a ~66px content box — so `Internal` at ~90px, and
 * every other label here, already overflows into the cell padding. The table has
 * always worked that way and it reads fine.
 *
 * Which is why "make the pill truncate at its content box" is *not* the fix, and
 * was tried: clamping `ToneBadge` to `max-width: 100%` ellipsised `Public` into
 * `Pub…` in a cell with 30px to spare, and made every badge in the app narrower.
 * Keeping the label shorter than the ones that already fit is the fix.
 *
 * And the names those ids resolve to are fetched **on hover**, never on render.
 * The resolver is app-scoped by design — a general `?ids=` resolver was rejected
 * as a "what is this GUID called" oracle — so naming a whole table eagerly would
 * be one request per row, spent on detail nobody has asked to see. The old
 * comment here said names "aren't available"; they are, one hover at a time.
 *
 * `armed` latches on the first hover or focus and never clears: the fetch has to
 * outlive the pointer, and re-arming would refetch nothing anyway because the
 * answer is cached under the app's own query key.
 */
function GroupVisibilityBadge({ groupIds, slug }: { groupIds: string[]; slug: string }) {
  const [armed, setArmed] = useState(false);
  const resolved = useQuery({ ...appVisibilityGroupsQuery(slug), enabled: armed });

  const answer = resolved.data;
  const byId = new Map((answer?.available ? answer.groups : []).map((g) => [g.id, g]));
  // Until the resolver has actually answered, an id is just an id. Calling it an
  // *unknown* group before we have asked would be a claim we cannot back — and it
  // is the difference between "this group was deleted" and "you haven't hovered
  // long enough yet".
  const answered = answer !== undefined || resolved.isError;

  const label =
    groupIds.length === 0 ? (
      // Same sentence the Access tab uses, because it is the same fact: an app
      // scoped to no groups admits nobody, and from the outside it is
      // indistinguishable from a working one.
      <Text fz={11.5}>No groups selected — nobody can open this app.</Text>
    ) : (
      <Stack gap={3}>
        {answer && !answer.available && (
          <Text fz={10.5} c="dimmed">
            Group names are unavailable on this deployment
            {answer.reason === "no-consent" && answer.missingPermission
              ? ` — the portal's identity is missing ${answer.missingPermission}.`
              : ` — ${answer.detail}`}
          </Text>
        )}
        {groupIds.map((id) => {
          const g = byId.get(id);
          return (
            <Box key={id}>
              <Text fz={11.5}>
                {g
                  ? // Only an explicit `false` earns the caveat — absent means
                    // nobody told us, which is not the same thing (ADR-0040 §3).
                    g.securityEnabled === false
                    ? `${g.displayName} — not a security group`
                    : g.displayName
                  : answered
                    ? "unknown group"
                    : "resolving…"}
              </Text>
              {/* The id is kept beside the name, not replaced by it: the id is
                  the authorization value, and it is what an operator needs when
                  they have to go and look the group up in the directory. */}
              <Text className="az-mono" fz={10} c="dimmed">
                {id}
              </Text>
            </Box>
          );
        })}
        {/* ADR-0040 §9: membership in the claim is transitive, so scoping to a
            parent group admits its children. Saying "these groups" alone
            under-specifies in the direction that silently over-admits. */}
        <Text fz={10} c="dimmed">
          Members of these groups — including members of nested groups — can open this app.
        </Text>
      </Stack>
    );

  return (
    <Tooltip
      label={label}
      color="dark"
      multiline
      maw={320}
      position="top"
      // `focus` is off in Mantine's defaults, so without this the `tabIndex`
      // below would be a tab stop that does nothing.
      events={{ hover: true, focus: true, touch: true }}
    >
      {/* The wrapper is not decoration: `ToneBadge` takes a fixed prop list and
          forwards neither ref nor the handlers Mantine clones onto its target, so
          a Tooltip wrapped straight around it would silently never open. This
          plain span is the element Mantine can hold on to — and it is where the
          hover/focus arming lives. `tabIndex` because a tooltip is the only place
          this detail exists, and mouse-only would mean it does not exist at all
          for some readers. */}
      <span
        tabIndex={0}
        onMouseEnter={() => setArmed(true)}
        onFocus={() => setArmed(true)}
        style={{ display: "inline-flex", borderRadius: 999 }}
      >
        <ToneBadge tone="info" icon="user">
          {groupIds.length === 0 ? "No groups" : "Group"}
        </ToneBadge>
      </span>
    </Tooltip>
  );
}

export function VisibilityBadge({
  visibility,
  slug,
}: {
  visibility: Visibility;
  /** The app these ids belong to — the only thing that can resolve them to names. */
  slug: string;
}) {
  switch (visibility.mode) {
    case "internal":
      return <ToneBadge icon="lock">Internal</ToneBadge>;
    case "group":
      return <GroupVisibilityBadge groupIds={visibility.groupIds} slug={slug} />;
    case "password":
      return (
        <ToneBadge tone="warn" icon="key">
          Password
        </ToneBadge>
      );
    case "public":
      return (
        <ToneBadge tone="acc" icon="globe">
          Public
        </ToneBadge>
      );
  }
}

/**
 * A person, as the control plane recorded them.
 *
 * Every attribution the portal renders is a bare string a route stamped at write
 * time — an app's owner, an approval's `requestedBy`, a secret's `createdBy` —
 * and none of them are resolved against the directory. So there is exactly one
 * rendering question, answered here: prefer a captured display name, then a
 * captured email, and only then the raw identity, which is human-readable today
 * only because the portal verifier collapses the subject to
 * `email ?? preferred_username ?? sub`.
 *
 * Never compare what this renders. The identity is `ownerId` and it is slated to
 * be re-based onto an opaque directory id.
 */
export function Principal({
  id,
  name,
  email,
  fz = 12.5,
}: {
  id?: string | undefined;
  name?: string | undefined;
  email?: string | undefined;
  fz?: number;
}) {
  const label = name ?? email ?? id;
  if (!label) {
    return (
      <Text fz={fz} c="dark.3">
        —
      </Text>
    );
  }
  // Show the address under a display name, but never the same string twice.
  const secondary = name && email && email !== name ? email : undefined;
  return (
    <Box>
      <Text fz={fz} c="dark.1" truncate>
        {label}
      </Text>
      {secondary && (
        <Text className="az-mono" fz={10.5} c="dark.3" truncate>
          {secondary}
        </Text>
      )}
    </Box>
  );
}

/**
 * The one consistent "not wired yet" marker. Everything it tags is mock
 * surface shipping ahead of its milestone — unmissable, and honest.
 */
export function PreviewBadge({ milestone = "M4" }: { milestone?: string }) {
  return (
    <Tooltip label={`Mock data — this lands in milestone ${milestone}`}>
      <Badge
        variant="light"
        color="violet"
        radius="sm"
        size="sm"
        styles={{ root: { background: "var(--az-violet-dim)", color: "var(--az-violet)" } }}
      >
        PREVIEW · {milestone}
      </Badge>
    </Tooltip>
  );
}

export function Stat({
  label,
  value,
  unit,
  sub,
  icon,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
  icon?: IconName;
  tone?: string;
}) {
  return (
    <Stack gap={6}>
      <Group gap={6} className="az-eyebrow">
        {icon && <Icon name={icon} size={12} />}
        {label}
      </Group>
      <Group gap={6} align="baseline">
        <Text
          component="span"
          className="az-mono az-tnum"
          style={{
            fontSize: 26,
            fontWeight: 600,
            letterSpacing: "-.02em",
            color: tone ?? "var(--mantine-color-dark-0)",
          }}
        >
          {value}
        </Text>
        {unit && (
          <Text component="span" className="az-mono" size="xs" c="dark.2">
            {unit}
          </Text>
        )}
      </Group>
      {sub && (
        <Text size="xs" c="dark.2">
          {sub}
        </Text>
      )}
    </Stack>
  );
}

export function KV({ k, children, mono }: { k: string; children: ReactNode; mono?: boolean }) {
  return (
    <Group
      justify="space-between"
      gap="md"
      py={9}
      style={{ borderBottom: "1px solid var(--az-line)" }}
      wrap="nowrap"
    >
      <Text size="sm" c="dark.2" style={{ whiteSpace: "nowrap" }}>
        {k}
      </Text>
      <Text size="sm" className={mono ? "az-mono" : undefined} ta="right">
        {children}
      </Text>
    </Group>
  );
}

export function PageHead({
  eyebrow,
  title,
  sub,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Group justify="space-between" align="flex-end" mb={24} gap="lg" wrap="wrap">
      <Box>
        {eyebrow && <Eyebrow mb={8}>{eyebrow}</Eyebrow>}
        <Title order={1} style={{ fontSize: 27 }}>
          {title}
        </Title>
        {sub && (
          <Text c="dark.2" size="sm" mt={8} maw={560}>
            {sub}
          </Text>
        )}
      </Box>
      {actions && <Group gap={10}>{actions}</Group>}
    </Group>
  );
}

export function Hint({
  icon = "shield",
  tone = "info",
  children,
  action,
}: {
  icon?: IconName;
  tone?: Tone;
  children: ReactNode;
  action?: ReactNode;
}) {
  const t = TONE_STYLE[tone];
  return (
    <Group
      gap={12}
      p="12px 14px"
      wrap="nowrap"
      style={{
        borderRadius: "var(--mantine-radius-md)",
        background: t.bg,
        border: `1px solid color-mix(in srgb, ${t.color} 22%, transparent)`,
      }}
    >
      <Icon name={icon} size={17} style={{ color: t.color, flexShrink: 0 }} />
      <Text size="sm" c="dark.1" style={{ flex: 1 }}>
        {children}
      </Text>
      {action}
    </Group>
  );
}

/**
 * Copy-to-clipboard button with the copied acknowledgement. The control plane
 * hands out a lot of values that only exist to be pasted somewhere else — base
 * URLs, tokens, passphrases, the agent skill — so this is the one spelling of it.
 */
export function CopyBtn({
  value,
  label,
  size = "xs",
  variant = "default",
  color,
}: {
  value: string;
  label: string;
  size?: string;
  variant?: string;
  /** Off-primary hue, for a copy that shouldn't compete with a nearby orange CTA. */
  color?: string;
}) {
  return (
    <CopyButton value={value}>
      {({ copied, copy }) => (
        <Button
          variant={variant}
          size={size}
          color={color}
          onClick={copy}
          leftSection={<Icon name={copied ? "check" : "copy"} size={12} />}
        >
          {copied ? "Copied" : label}
        </Button>
      )}
    </CopyButton>
  );
}
