import { useState } from "react";
import {
  Box,
  Button,
  Card,
  Center,
  Code,
  Group,
  Loader,
  SegmentedControl,
  Stack,
  Text,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { CspViolation } from "@azx-pbc/shared";
import { cspViolationsQuery } from "../../api/queries";
import { useGrantOrigin } from "../../api/mutations";
import { Icon } from "../../components/Icon";
import { Hint, PageHead, ToneBadge } from "../../components/primitives";
import { timeAgo } from "../../lib/format";

/** Reduce a blocked URL to its origin; null if it isn't a grantable http(s) URL. */
function grantableOrigin(blockedUri: string): string | null {
  try {
    const u = new URL(blockedUri);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null; // "inline", "eval", "data", … — not an origin grant
  }
}

const keyOf = (v: CspViolation) => `${v.appSlug ?? v.appId}:${v.blockedUri}`;

/** CSP violation reports become one-click origin-grant requests (§6.2). */
export function ViolationsPage() {
  const violations = useQuery(cspViolationsQuery);
  const grant = useGrantOrigin();
  const [filed, setFiled] = useState<Record<string, boolean>>({});
  const [view, setView] = useState<"active" | "resolved">("active");

  const rows = violations.data?.violations ?? [];
  // A "resolved" violation is one whose origin the app's current manifest already
  // permits (derived server-side) — kept for history but out of the actionable queue.
  const active = rows.filter((v) => !v.resolved);
  const resolved = rows.filter((v) => v.resolved);
  const visible = view === "active" ? active : resolved;
  const unhandled = active.filter((v) => grantableOrigin(v.blockedUri) && !filed[keyOf(v)]).length;

  return (
    <div className="az-stagger">
      <PageHead
        eyebrow="Admin"
        title="CSP Violations"
        sub="App requests blocked by Content Security Policy."
        actions={
          <ToneBadge tone="bad" icon="shield">
            {unhandled} unhandled
          </ToneBadge>
        }
      />

      {violations.isPending && (
        <Center py={60}>
          <Loader size="sm" />
        </Center>
      )}

      {violations.isError && (
        <Hint icon="alert" tone="bad">
          Couldn't load violations: {violations.error.message}
        </Hint>
      )}

      {!violations.isPending && !violations.isError && rows.length === 0 && (
        <Card py={56} style={{ textAlign: "center" }}>
          <Stack align="center" gap={6}>
            <Icon name="check" size={26} style={{ color: "var(--az-live)" }} />
            <Text ff="heading" fw={600} fz={17}>
              No violations reported
            </Text>
            <Text c="dark.2" size="sm">
              Apps are staying inside their content-security policy.
            </Text>
          </Stack>
        </Card>
      )}

      {!violations.isPending && !violations.isError && rows.length > 0 && (
        <Group justify="flex-end" mb={4}>
          <SegmentedControl
            size="xs"
            value={view}
            onChange={(v) => setView(v as "active" | "resolved")}
            data={[
              { label: `Active (${active.length})`, value: "active" },
              { label: `Resolved (${resolved.length})`, value: "resolved" },
            ]}
          />
        </Group>
      )}

      <Stack gap={18}>
        {rows.length > 0 && visible.length === 0 && (
          <Text c="dark.2" size="sm" ta="center" py={32}>
            {view === "active"
              ? "No active violations — every blocked origin is already permitted by its manifest."
              : "No resolved violations yet."}
          </Text>
        )}
        {visible.map((v) => {
          const origin = grantableOrigin(v.blockedUri);
          const handled = filed[keyOf(v)];
          const busy = grant.isPending && grant.variables?.origin === origin;
          return (
            <Card key={keyOf(v)} style={v.resolved ? { opacity: 0.65 } : undefined}>
              <Group justify="space-between" gap={20} wrap="nowrap" align="center">
                <Box>
                  <Group gap={10} mb={9} wrap="wrap">
                    <ToneBadge tone={v.resolved ? "neutral" : "warn"} icon="alert">
                      {v.directive}
                    </ToneBadge>
                    <Group gap={6}>
                      <Icon name="box" size={13} style={{ color: "var(--mantine-color-dark-2)" }} />
                      <Text className="az-mono" fz={12.5} c="accent.4">
                        {v.appSlug ?? v.appId}
                      </Text>
                    </Group>
                    <Text className="az-mono" fz={11.5} c="dark.2">
                      {v.count}× · last seen {timeAgo(v.lastSeen)}
                    </Text>
                  </Group>
                  <Text fz={14} fw={500} mb={6}>
                    {v.resolved
                      ? `App reached ${origin ?? v.blockedUri} — now permitted by the manifest.`
                      : origin
                        ? `App tried to reach ${origin} but the CSP blocked it.`
                        : `Blocked ${v.directive} request — not an origin that can be granted.`}
                  </Text>
                  <Code style={{ fontSize: 12 }}>blocked → {v.blockedUri}</Code>
                </Box>
                <Box style={{ flexShrink: 0 }}>
                  {v.resolved ? (
                    <ToneBadge tone="live" icon="check">
                      Now permitted
                    </ToneBadge>
                  ) : handled ? (
                    <ToneBadge tone="violet" icon="check">
                      Request filed
                    </ToneBadge>
                  ) : origin && v.appSlug ? (
                    <Button
                      leftSection={<Icon name="plus" size={14} />}
                      loading={busy}
                      onClick={() =>
                        grant.mutate(
                          { slug: v.appSlug as string, origin },
                          { onSuccess: () => setFiled((f) => ({ ...f, [keyOf(v)]: true })) },
                        )
                      }
                    >
                      Request this origin
                    </Button>
                  ) : (
                    <ToneBadge tone="neutral" icon="x">
                      Not grantable
                    </ToneBadge>
                  )}
                </Box>
              </Group>
            </Card>
          );
        })}
      </Stack>

      <Box mt={18}>
        <Hint icon="shield" tone="info">
          Granting an origin adds a <span className="az-mono">connect-src</span> exception once an
          admin approves the request — or route the call through the gateway{" "}
          <span className="az-mono">fetch-proxy</span> instead for auditing, metering, and
          server-side secrets.
        </Hint>
      </Box>
    </div>
  );
}
