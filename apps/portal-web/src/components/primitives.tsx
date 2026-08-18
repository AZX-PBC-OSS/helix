import type { CSSProperties, ReactNode } from "react";
import { Badge, Box, Button, CopyButton, Group, Stack, Text, Title, Tooltip } from "@mantine/core";
import type { Visibility } from "@azx-pbc/shared";
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

export function VisibilityBadge({ visibility }: { visibility: Visibility }) {
  switch (visibility.mode) {
    case "internal":
      return <ToneBadge icon="lock">Internal</ToneBadge>;
    case "group":
      return (
        <ToneBadge tone="info" icon="user">
          Group · {visibility.groupId}
        </ToneBadge>
      );
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
