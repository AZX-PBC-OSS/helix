import { useState } from "react";
import {
  Box,
  Button,
  Card,
  Center,
  Grid,
  Group,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import type { App, Visibility, VisibilityMode } from "@azx-pbc/shared";
import { useArchiveApp, useSetVisibility } from "../../api/mutations";
import { useAuth } from "../../auth/AuthProvider";
import { Icon, type IconName } from "../../components/Icon";
import { Eyebrow, Hint, PreviewBadge, ToneBadge } from "../../components/primitives";
import { ConfirmDialog } from "../../modals/ConfirmDialog";
import { PasswordAccessCard } from "./PasswordAccessCard";

const VISIBILITY_ROWS: Array<{
  mode: VisibilityMode;
  icon: IconName;
  label: string;
  desc: string;
}> = [
  {
    mode: "internal",
    icon: "lock",
    label: "Internal",
    desc: "SSO via the IdP — any signed-in directory user, guests included. Unauthenticated visitors are redirected to login.",
  },
  {
    mode: "group",
    icon: "user",
    label: "Group-restricted",
    desc: "SSO plus a directory-group membership check, re-checked per request.",
  },
  {
    mode: "password",
    icon: "key",
    label: "Password",
    desc: "Shared password gate for external demos. Pseudonymous identity.",
  },
  {
    mode: "public",
    icon: "globe",
    label: "Public",
    desc: "No gate. Anonymous-tier quotas + per-IP limits. Requires admin approval.",
  },
];

export function AccessTab({ app }: { app: App }) {
  const { authenticated, login, loginAvailable, allowPublicApps, allowPasswordApps } = useAuth();
  const archive = useArchiveApp();
  const setVisibility = useSetVisibility();
  const [confirming, setConfirming] = useState(false);
  const [goingPublic, setGoingPublic] = useState(false);
  const [reason, setReason] = useState("");
  // Inline group-id editor, opened from the group row.
  const [groupOpen, setGroupOpen] = useState(false);
  const [groupId, setGroupId] = useState(
    app.visibility.mode === "group" ? app.visibility.groupId : "",
  );
  const archived = app.archivedAt !== null;
  const current = app.visibility.mode;
  // Leaving `password` mode goes through the password card's Disable (it wipes
  // the minted credential); the switcher steps aside while it's active.
  const passwordActive = current === "password";
  // Operator policy: hide an open-surface row when the deployment forbids that
  // mode — unless the app is already in it, in which case we keep the row (so
  // the owner can see the state) and offer the reductions that migrate it away.
  const rows = VISIBILITY_ROWS.filter((row) => {
    if (row.mode === "public" && !allowPublicApps && current !== "public") return false;
    if (row.mode === "password" && !allowPasswordApps && current !== "password") return false;
    return true;
  });
  // The app sits in a mode this deployment no longer permits — the edge is
  // refusing to serve it, so nudge the owner to migrate down.
  const currentModeDisallowed =
    (current === "public" && !allowPublicApps) || (current === "password" && !allowPasswordApps);

  // The last public request opened an approval (result.pending is the id).
  const requested = setVisibility.data?.pending != null;

  const apply = (visibility: Visibility, reason?: string) =>
    setVisibility.mutate({ slug: app.slug, visibility, ...(reason ? { reason } : {}) });

  return (
    <Grid gap={18} align="flex-start" className="az-stagger">
      <Grid.Col span={{ base: 12, md: 7 }}>
        <Card>
          <Group justify="space-between" mb={4}>
            <Eyebrow>Visibility</Eyebrow>
          </Group>
          <Text size="sm" c="dark.2" mb={16}>
            Auth is terminated at the edge proxy — the app ships zero auth code. Switching to
            internal or group applies immediately, including from public; only going public is an
            elevated change that pauses for admin approval. Shared-password access is managed on the
            right.
          </Text>

          {!authenticated && (
            <Hint
              icon="user"
              tone="neutral"
              action={
                <Button variant="default" size="xs" onClick={login} disabled={!loginAvailable}>
                  Sign in
                </Button>
              }
            >
              Changing visibility needs a signed-in actor.
            </Hint>
          )}
          {passwordActive && authenticated && (
            <Hint icon="key" tone="neutral">
              This app uses shared-password access. Disable it on the right to switch to another
              mode.
            </Hint>
          )}
          {currentModeDisallowed && (
            <Box mb={12}>
              <Hint icon="shield" tone="bad">
                {current === "public" ? "Public" : "Password"} apps are disabled on this deployment,
                so the edge is refusing to serve this one. Switch to Internal or a group to restore
                serving.
              </Hint>
            </Box>
          )}

          <Stack gap={10} mt={authenticated && !passwordActive ? 0 : 12}>
            {rows.map((row) => {
              const on = current === row.mode;
              // An action is offered only to a signed-in actor, only on a row
              // that isn't already current, and only while not in password mode
              // (password is owned by the card on the right). The `password` row
              // itself never gets a switcher button — enabling it mints a
              // credential, so it lives in PasswordAccessCard.
              const actionable = authenticated && !passwordActive && !on && row.mode !== "password";
              return (
                <div
                  key={row.mode}
                  style={{
                    borderRadius: "var(--mantine-radius-md)",
                    background: on ? "var(--az-acc-dim)" : "var(--mantine-color-dark-6)",
                    border: `1px solid ${on ? "color-mix(in srgb, var(--az-acc) 34%, transparent)" : "var(--az-line)"}`,
                    opacity: on || actionable ? 1 : 0.6,
                  }}
                >
                  <Group gap={13} p="13px 14px" align="flex-start" wrap="nowrap">
                    <Center
                      w={30}
                      h={30}
                      style={{
                        borderRadius: 8,
                        background: on ? "var(--az-acc)" : "var(--mantine-color-dark-5)",
                        color: on ? "var(--az-acc-ink)" : "var(--mantine-color-dark-1)",
                        flexShrink: 0,
                      }}
                    >
                      <Icon name={row.icon} size={15} />
                    </Center>
                    <div style={{ flex: 1 }}>
                      <Group gap={8}>
                        <Text fw={600} fz={13.5}>
                          {row.label}
                        </Text>
                        {on && (
                          <ToneBadge tone="acc" style={{ fontSize: 8.5, padding: "1px 6px" }}>
                            CURRENT
                          </ToneBadge>
                        )}
                        {row.mode === "public" && (
                          <ToneBadge tone="violet" style={{ fontSize: 8.5, padding: "1px 6px" }}>
                            NEEDS APPROVAL
                          </ToneBadge>
                        )}
                      </Group>
                      <Text size="xs" c="dark.2" mt={3} lh={1.45}>
                        {row.desc}
                        {on && app.visibility.mode === "group" && (
                          <>
                            {" "}
                            Group: <span className="az-mono">{app.visibility.groupId}</span>
                          </>
                        )}
                      </Text>
                    </div>
                    {actionable && row.mode === "internal" && (
                      <Button
                        variant="default"
                        size="xs"
                        loading={setVisibility.isPending}
                        onClick={() => apply({ mode: "internal" })}
                      >
                        Make internal
                      </Button>
                    )}
                    {actionable && row.mode === "group" && (
                      <Button variant="default" size="xs" onClick={() => setGroupOpen((o) => !o)}>
                        Restrict to group
                      </Button>
                    )}
                    {actionable && row.mode === "public" && (
                      <Button
                        variant="default"
                        size="xs"
                        leftSection={<Icon name="globe" size={13} />}
                        onClick={() => {
                          setReason("");
                          setGoingPublic(true);
                        }}
                      >
                        Request public access
                      </Button>
                    )}
                  </Group>
                  {actionable && row.mode === "group" && groupOpen && (
                    <Group gap={8} px={14} pb={13} align="flex-end" wrap="nowrap">
                      <TextInput
                        label="Directory group id"
                        placeholder="e.g. eng-team or an Entra group GUID"
                        value={groupId}
                        onChange={(e) => setGroupId(e.currentTarget.value)}
                        style={{ flex: 1 }}
                        size="xs"
                        classNames={{ input: "az-mono" }}
                      />
                      <Button
                        size="xs"
                        disabled={groupId.trim().length === 0 || setVisibility.isPending}
                        loading={setVisibility.isPending}
                        onClick={() => apply({ mode: "group", groupId: groupId.trim() })}
                      >
                        Apply
                      </Button>
                    </Group>
                  )}
                </div>
              );
            })}
          </Stack>

          {requested && (
            <Box mt={12}>
              <Hint icon="shield" tone="violet">
                Request opened — going public is awaiting admin approval. The app stays at its
                current visibility until a reviewer approves.
              </Hint>
            </Box>
          )}
          {setVisibility.isError && !goingPublic && (
            <Text size="xs" c="red" mt={10}>
              {setVisibility.error.message}
            </Text>
          )}
        </Card>
      </Grid.Col>

      <Grid.Col span={{ base: 12, md: 5 }}>
        <Stack gap={18}>
          <PasswordAccessCard app={app} />

          <Card style={{ borderColor: "var(--az-bad-dim)" }}>
            <Eyebrow mb={4}>Lifecycle</Eyebrow>
            <Text size="sm" c="dark.2" mb={14} lh={1.5}>
              Archiving makes the edge serve <span className="az-mono">410 + Clear-Site-Data</span>{" "}
              for the subdomain immediately. Slugs are never reused; unarchive restores serving.
            </Text>
            {!authenticated ? (
              <Hint
                icon="user"
                tone="neutral"
                action={
                  <Button variant="default" size="xs" onClick={login} disabled={!loginAvailable}>
                    Sign in
                  </Button>
                }
              >
                Lifecycle actions need a signed-in actor.
              </Hint>
            ) : archived ? (
              <Button
                variant="default"
                leftSection={<Icon name="rotate" size={15} />}
                loading={archive.isPending}
                onClick={() => archive.mutate({ slug: app.slug, archive: false })}
                fullWidth
              >
                Unarchive — resume serving
              </Button>
            ) : (
              <Button
                color="red"
                variant="outline"
                leftSection={<Icon name="x" size={15} />}
                onClick={() => setConfirming(true)}
                fullWidth
              >
                Archive app
              </Button>
            )}
            {archive.isError && (
              <Text size="xs" c="red" mt={8}>
                {archive.error.message}
              </Text>
            )}
          </Card>

          <Card>
            <Group justify="space-between" mb={12}>
              <Eyebrow>Access (RBAC)</Eyebrow>
              <PreviewBadge milestone="v1" />
            </Group>
            <Text size="sm" c="dark.2" lh={1.5}>
              Per-app roles (owner / editor / viewer) are a v1 portal feature — today any
              authenticated portal actor may mutate, and every action is attributed in the audit
              trail.
            </Text>
          </Card>
        </Stack>
      </Grid.Col>

      <ConfirmDialog
        opened={goingPublic}
        icon="globe"
        tone="var(--az-violet)"
        toneDim="var(--az-violet-dim)"
        title={`Request public access for ${app.displayName}?`}
        body={
          <Stack gap={10}>
            <Text size="sm" c="dark.2" lh={1.5}>
              Public apps serve to anyone with no sign-in — an anonymous tier with per-app quotas
              and per-IP limits. This is a high-risk change, so it opens an approval request rather
              than applying now; an admin must approve before the app goes live publicly.
            </Text>
            <Textarea
              label="Reason for review (optional)"
              placeholder="Why does this app need to be public?"
              value={reason}
              onChange={(e) => setReason(e.currentTarget.value)}
              rows={3}
            />
          </Stack>
        }
        confirmLabel="Request approval"
        loading={setVisibility.isPending}
        error={setVisibility.isError ? setVisibility.error.message : null}
        onConfirm={() =>
          setVisibility.mutate(
            {
              slug: app.slug,
              visibility: { mode: "public" },
              ...(reason.trim() ? { reason: reason.trim() } : {}),
            },
            { onSuccess: () => setGoingPublic(false) },
          )
        }
        onClose={() => {
          setGoingPublic(false);
          setVisibility.reset();
        }}
      />

      <ConfirmDialog
        opened={confirming}
        icon="x"
        tone="var(--az-bad)"
        toneDim="var(--az-bad-dim)"
        title={`Archive ${app.displayName}?`}
        body={
          <>
            The edge will serve <span className="az-mono">410 + Clear-Site-Data</span> for{" "}
            <span className="az-mono">{app.slug}</span> immediately and the registry record is
            frozen. This is reversible — unarchive restores the live pointer as it was.
          </>
        }
        confirmLabel="Archive"
        confirmColor="red"
        loading={archive.isPending}
        error={archive.isError ? archive.error.message : null}
        onConfirm={() =>
          archive.mutate(
            { slug: app.slug, archive: true },
            { onSuccess: () => setConfirming(false) },
          )
        }
        onClose={() => {
          setConfirming(false);
          archive.reset();
        }}
      />
    </Grid>
  );
}
