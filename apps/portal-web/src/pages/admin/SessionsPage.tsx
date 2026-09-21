import { useMemo, useState } from "react";
import {
  Box,
  Button,
  Card,
  Center,
  Group,
  Loader,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { SessionSummary } from "@azx-pbc/shared";
import { sessionsQuery } from "../../api/queries";
import { useRevokeSessions } from "../../api/mutations";
import { ConfirmDialog } from "../../modals/ConfirmDialog";
import { Icon } from "../../components/Icon";
import { Hint, PageHead, Principal, Stat, ToneBadge } from "../../components/primitives";
import { principalLabel, timeAgo, timeUntil } from "../../lib/format";

/**
 * The admin Sessions screen (architecture §5.7): every live app-user session,
 * grouped by user, with one user-level kill.
 *
 * Sessions are server-side (Appendix A.4), so the kill is a table delete — the
 * edge's uncached per-request lookup misses on the *next* request and the
 * browser's still-present cookie becomes a key to nothing. Nothing else needs
 * to happen, which is why this page is a list and a button rather than a
 * dashboard: the mechanism is one DELETE, and the value here is *aiming* it —
 * which is also why the rows carry the display half (name, address) captured at
 * login: `userOid` is a pairwise `sub` and identifies nobody.
 *
 * Grouping is client-side because the operation is user-level: one revoke
 * deletes every row of the subject, across apps. The group snapshot rides each
 * *session* row, not the user — a user's snapshots can differ across apps until
 * each one's silent refresh — so it renders per session, and an admin looking
 * at a group that was just revoked in Entra can *see* the staleness they are
 * about to kill.
 */

/** One user's sessions, folded from the flat list. */
interface UserGroup {
  userOid: string;
  userName: string | null;
  userEmail: string | null;
  userKind: SessionSummary["userKind"];
  sessions: SessionSummary[];
  /** Unique app slugs, insertion order. */
  apps: string[];
}

/** Fold the flat rows into per-user groups, most recent sign-in first. */
function groupByUser(rows: SessionSummary[]): UserGroup[] {
  const byUser = new Map<string, UserGroup>();
  for (const r of rows) {
    let g = byUser.get(r.userOid);
    if (!g) {
      g = {
        userOid: r.userOid,
        userName: r.userName,
        userEmail: r.userEmail,
        userKind: r.userKind,
        sessions: [],
        apps: [],
      };
      byUser.set(r.userOid, g);
    }
    // Rows of one subject hold the same captured claims; keep the first
    // non-null rather than assuming any single row had them.
    g.userName = g.userName ?? r.userName;
    g.userEmail = g.userEmail ?? r.userEmail;
    g.sessions.push(r);
    if (!g.apps.includes(r.slug)) g.apps.push(r.slug);
  }
  // Most recent sign-in first: on an incident, the person who just logged in
  // is the one an operator is looking for.
  const latest = (g: UserGroup) =>
    g.sessions.reduce((max, s) => (s.createdAt > max ? s.createdAt : max), "");
  return [...byUser.values()].sort((a, b) => latest(b).localeCompare(latest(a)));
}

/**
 * A group chip: the resolved name when the directory gave one, else the raw id
 * — which is always correct, because the id is the fact and the name is a
 * courtesy. The id stays on `title` for copying into a support thread.
 */
function GroupChip({ id, name }: { id: string; name: string | null }) {
  return (
    <span
      title={id}
      style={{
        display: "inline-block",
        padding: "2px 7px",
        borderRadius: 999,
        border: "1px solid var(--az-line-2)",
        background: "rgba(255,255,255,.06)",
        color: name ? "var(--mantine-color-dark-1)" : "var(--mantine-color-dark-3)",
        fontFamily: "var(--mantine-font-family-monospace)",
        fontSize: 10.5,
        letterSpacing: ".02em",
        whiteSpace: "nowrap",
      }}
    >
      {name ?? id}
    </span>
  );
}

export function SessionsPage() {
  const sessions = useQuery(sessionsQuery);
  const revoke = useRevokeSessions();
  const [q, setQ] = useState("");
  const [confirming, setConfirming] = useState<UserGroup | null>(null);

  // Memoized, not derived inline: `?? []` builds a fresh array each render,
  // which would churn the `groups` memo below on every keystroke in the filter.
  const rows = useMemo(() => sessions.data?.rows ?? [], [sessions.data]);
  const groupNames = useMemo(() => sessions.data?.groupNames ?? {}, [sessions.data]);
  const groups = useMemo(() => groupByUser(rows), [rows]);

  const filtered = useMemo(() => {
    if (!q) return groups;
    const term = q.toLowerCase();
    return groups.filter((g) =>
      `${g.userName ?? ""}${g.userEmail ?? ""}${g.userOid}${g.apps.join("")}${g.sessions
        .flatMap((s) => s.groups)
        .join("")}`
        .toLowerCase()
        .includes(term),
    );
  }, [groups, q]);

  const appsInUse = new Set(rows.map((r) => r.slug)).size;
  const refreshOverdue = rows.filter((r) => r.refreshDueAt <= new Date().toISOString()).length;

  const label = (g: UserGroup) =>
    g.userName ?? g.userEmail ?? principalLabel(g.userOid, g.userKind);

  return (
    <div className="az-stagger">
      <PageHead
        eyebrow="Admin"
        title="Sessions"
        sub="Live app-user sessions, grouped by user. Revoking kills every session of that user, on every app, on its next request."
        actions={
          refreshOverdue > 0 ? (
            <ToneBadge tone="warn" icon="clock">
              {refreshOverdue} refresh overdue
            </ToneBadge>
          ) : undefined
        }
      />

      <SimpleGrid cols={{ base: 2, md: 4 }} spacing={18} mb={18}>
        <Card p="14px 18px">
          <Stat label="Live sessions" value={rows.length} icon="user" />
        </Card>
        <Card p="14px 18px">
          <Stat label="Signed-in users" value={groups.length} icon="globe" />
        </Card>
        <Card p="14px 18px">
          <Stat label="Apps in use" value={appsInUse} icon="box" />
        </Card>
        <Card p="14px 18px">
          <Stat
            label="Refresh overdue"
            value={refreshOverdue}
            icon="clock"
            tone={refreshOverdue > 0 ? "var(--az-warn)" : undefined}
            sub={
              refreshOverdue > 0
                ? "Group snapshots may be stale — re-checked at refresh"
                : undefined
            }
          />
        </Card>
      </SimpleGrid>

      <Group gap={10} mb={18} wrap="wrap">
        <TextInput
          placeholder="Filter by user, app, group…"
          leftSection={<Icon name="search" size={14} />}
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          style={{ flex: 1, minWidth: 220 }}
          classNames={{ input: "az-mono" }}
        />
      </Group>

      {sessions.isPending ? (
        <Center py={60}>
          <Loader size="sm" />
        </Center>
      ) : sessions.isError ? (
        <Hint icon="alert" tone="bad">
          Couldn't load sessions: {sessions.error.message}
        </Hint>
      ) : rows.length === 0 ? (
        <Card py={56} style={{ textAlign: "center" }}>
          <Stack align="center" gap={6}>
            <Icon name="user" size={26} style={{ color: "var(--az-live)" }} />
            <Text ff="heading" fw={600} fz={17}>
              No live sessions
            </Text>
            <Text c="dark.2" size="sm">
              Every session has expired or been revoked. New sign-ins appear here immediately.
            </Text>
          </Stack>
        </Card>
      ) : (
        <Stack gap={18}>
          {sessions.data && !sessions.data.groupsResolved && (
            <Hint icon="globe" tone="info">
              Group names are unavailable on this deployment, so the snapshot renders as raw group
              ids — the ids are the authorization values the edge checks.
            </Hint>
          )}
          {filtered.length === 0 && (
            <Text c="dark.2" size="sm" ta="center" py={24}>
              No sessions match this filter.
            </Text>
          )}
          {filtered.map((g) => (
            <Card key={g.userOid} p={0}>
              <Group
                justify="space-between"
                gap={20}
                wrap="wrap"
                align="center"
                px={18}
                py={14}
                style={{ borderBottom: "1px solid var(--az-line)" }}
              >
                <Box title={g.userOid}>
                  <Principal
                    name={g.userName ?? undefined}
                    email={g.userEmail ?? undefined}
                    id={principalLabel(g.userOid, g.userKind)}
                  />
                </Box>
                <Group gap={16} wrap="nowrap">
                  <Text className="az-mono" fz={11.5} c="dark.2">
                    {`${g.sessions.length} session${g.sessions.length === 1 ? "" : "s"} · ${g.apps.length} app${g.apps.length === 1 ? "" : "s"}`}
                  </Text>
                  <Button
                    size="xs"
                    variant="light"
                    color="red"
                    leftSection={<Icon name="x" size={13} />}
                    aria-label={`Revoke all sessions for ${label(g)}`}
                    onClick={() => setConfirming(g)}
                  >
                    Revoke
                  </Button>
                </Group>
              </Group>
              <Table verticalSpacing={8} horizontalSpacing="lg" className="az-mono" fz={12}>
                <Table.Thead style={{ background: "var(--mantine-color-dark-6)" }}>
                  <Table.Tr>
                    <Table.Th>App</Table.Th>
                    <Table.Th>Groups</Table.Th>
                    <Table.Th>Signed in</Table.Th>
                    <Table.Th>Refresh due</Table.Th>
                    <Table.Th style={{ textAlign: "right" }}>Expires</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {g.sessions.map((s) => {
                    const overdue = s.refreshDueAt <= new Date().toISOString();
                    return (
                      <Table.Tr key={s.id}>
                        <Table.Td c="accent.4">{s.slug}</Table.Td>
                        <Table.Td>
                          {s.groups.length === 0 ? (
                            <Text c="dark.3">—</Text>
                          ) : (
                            <Group gap={6} wrap="wrap">
                              {s.groups.map((id) => (
                                <GroupChip key={id} id={id} name={groupNames[id] ?? null} />
                              ))}
                            </Group>
                          )}
                        </Table.Td>
                        <Table.Td c="dark.2">{timeAgo(s.createdAt)}</Table.Td>
                        <Table.Td>
                          {overdue ? (
                            <ToneBadge
                              tone="warn"
                              icon="clock"
                              style={{ padding: "2px 7px", fontSize: 10 }}
                            >
                              overdue
                            </ToneBadge>
                          ) : (
                            <Text c="dark.2">{timeUntil(s.refreshDueAt)}</Text>
                          )}
                        </Table.Td>
                        <Table.Td style={{ textAlign: "right" }} c="dark.2">
                          {timeUntil(s.expiresAt)}
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </Card>
          ))}
        </Stack>
      )}

      <Box mt={18}>
        <Hint icon="shield" tone="info">
          Sessions are server-side: a revoke takes effect on the user's next request — navigations
          bounce to sign-in, app API calls get 401. It kills sessions, not entitlements: anyone
          whose access still stands can simply sign in again (and sign-in re-checks group
          membership). Every revoke is written to the audit log.
        </Hint>
      </Box>

      <ConfirmDialog
        opened={confirming !== null}
        icon="x"
        tone="var(--az-bad)"
        toneDim="var(--az-bad-dim)"
        title={confirming ? `Revoke all sessions for ${label(confirming)}?` : ""}
        body={
          confirming
            ? `Every live session of this user — ${confirming.sessions.length} across ${
                confirming.apps.length
              } app${confirming.apps.length === 1 ? "" : "s"} — stops working on its next request. They will be asked to sign in again; this does not change what they are allowed to access. The action is recorded in the audit log.`
            : ""
        }
        confirmLabel="Revoke sessions"
        confirmColor="red"
        loading={revoke.isPending}
        error={revoke.isError ? revoke.error.message : null}
        onConfirm={() => {
          if (confirming) {
            revoke.mutate(
              { userOid: confirming.userOid },
              { onSuccess: () => setConfirming(null) },
            );
          }
        }}
        onClose={() => setConfirming(null)}
      />
    </div>
  );
}
