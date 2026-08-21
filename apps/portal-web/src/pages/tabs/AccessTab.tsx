import { useState } from "react";
import { Box, Button, Card, Center, Grid, Group, Stack, Text, Textarea } from "@mantine/core";
import type { App, Visibility, VisibilityMode } from "@azx-pbc/shared";
import { useArchiveApp, useSetVisibility } from "../../api/mutations";
import { GroupPicker } from "../../components/GroupPicker";
import { useAuth } from "../../auth/AuthProvider";
import { Icon, type IconName } from "../../components/Icon";
import { Eyebrow, Hint, PreviewBadge, ToneBadge } from "../../components/primitives";
import { ConfirmDialog } from "../../modals/ConfirmDialog";
import { PasswordAccessCard } from "./PasswordAccessCard";

/**
 * Descriptions answer "who gets in", in the user's terms — not how the platform
 * achieves it. Keep them parallel with the create form's shorter versions in
 * `components/AppCreateForm.tsx`; this is the screen where the choice is
 * actually made, so it earns the extra clause about what each mode implies.
 * Avoid claims that depend on how the directory itself is configured (whether
 * guests exist and can sign in is a tenant decision, not this app's).
 */
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
    desc: "Anyone who can sign in to your organization. No further check; visitors who aren't signed in are sent to sign in first.",
  },
  {
    mode: "group",
    icon: "user",
    label: "Group-restricted",
    desc: "Sign-in, narrowed to members of the directory groups you choose — including members of any groups nested inside them. Anyone in any one of them gets in. Membership is re-read as each visitor's session refreshes, so removing someone from a group cuts off access without waiting for them to sign out.",
  },
  {
    mode: "password",
    icon: "key",
    label: "Password",
    desc: "One shared password instead of sign-in, for people outside your organization. Visitors aren't identified individually, and each gets their own isolated session.",
  },
  {
    mode: "public",
    icon: "globe",
    label: "Public",
    desc: "No sign-in at all — anyone with the link. Usage is capped per app and per visitor IP address.",
  },
];

export function AccessTab({ app }: { app: App }) {
  const { authenticated, login, loginAvailable, allowPublicApps, allowPasswordApps } = useAuth();
  const archive = useArchiveApp();
  const setVisibility = useSetVisibility();
  const [confirming, setConfirming] = useState(false);
  const [goingPublic, setGoingPublic] = useState(false);
  const [reason, setReason] = useState("");
  // Inline group picker, opened from the group row.
  const [groupOpen, setGroupOpen] = useState(false);
  const currentGroupIds = app.visibility.mode === "group" ? app.visibility.groupIds : [];
  const [groupIds, setGroupIds] = useState<string[]>(currentGroupIds);
  /**
   * Whether the draft matches what's stored, compared as a **set** — order is
   * meaningless in an any-of rule, so a reorder is not an edit. The server agrees
   * (`classifyVisibilityChange` sorts before comparing and returns no delta), and
   * disabling the button here means the UI says so before the round trip instead
   * of reporting a successful save that changed nothing.
   */
  const unchanged =
    app.visibility.mode === "group" &&
    groupIds.length === currentGroupIds.length &&
    [...groupIds].sort().join("\u0000") === [...currentGroupIds].sort().join("\u0000");
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
            Who can open the app. Switching to Internal or a group applies immediately — including
            from Public. Going public is the one change that waits for admin approval.
            Shared-password access is managed on the right.
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
              You need to be signed in to change visibility.
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
                {current === "public" ? "Public" : "Password"} apps are turned off for this
                installation, so this app isn&apos;t being served at all. Switch to Internal or a
                group to bring it back.
              </Hint>
            </Box>
          )}

          <Stack gap={10} mt={authenticated && !passwordActive ? 0 : 12}>
            {rows.map((row) => {
              const on = current === row.mode;
              // An action is offered only to a signed-in actor, only while not in
              // password mode (password is owned by the card on the right), and
              // normally only on a row that isn't already current. The `password`
              // row itself never gets a switcher button — enabling it mints a
              // credential, so it lives in PasswordAccessCard.
              //
              // `group` is the exception to the `!on` rule, and it has to be: its
              // action is "edit which groups", which is the one thing an owner
              // wants precisely *because* the app is already group-scoped. While
              // `!on` applied to it, changing an app's groups meant switching to
              // Internal first — briefly widening the app to the whole directory
              // to narrow it.
              const editable = row.mode === "group";
              const actionable =
                authenticated && !passwordActive && row.mode !== "password" && (!on || editable);
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
                            {app.visibility.groupIds.length === 0 ? (
                              // A `group` app with no groups admits nobody. The
                              // edge fails closed on it, so this is inert rather
                              // than dangerous — but it looks identical to a
                              // working app from the outside, so say it plainly.
                              <Text span c="orange.4" fw={600}>
                                No groups selected — nobody can open this app.
                              </Text>
                            ) : (
                              <>
                                {app.visibility.groupIds.length === 1 ? "Group: " : "Groups: "}
                                <span className="az-mono">
                                  {app.visibility.groupIds.join(", ")}
                                </span>
                              </>
                            )}
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
                        {on ? "Edit groups" : "Restrict to groups"}
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
                    <Stack gap={10} px={14} pb={13}>
                      <GroupPicker
                        value={groupIds}
                        onChange={setGroupIds}
                        disabled={setVisibility.isPending}
                        slug={app.slug}
                      />
                      <Group gap={8} justify="flex-end">
                        <Button
                          size="xs"
                          variant="default"
                          onClick={() => {
                            // Discard the draft, don't keep it: a half-edited set
                            // left behind the collapsed panel would be applied by
                            // a later click that looked unrelated.
                            setGroupIds(currentGroupIds);
                            setGroupOpen(false);
                          }}
                          disabled={setVisibility.isPending}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="xs"
                          // An empty set is refused here rather than in the schema:
                          // it IS storable (the edge fails closed on it), but it is
                          // never what someone means to click, so the UI is where
                          // that gets caught.
                          disabled={groupIds.length === 0 || setVisibility.isPending || unchanged}
                          loading={setVisibility.isPending}
                          onClick={() => apply({ mode: "group", groupIds })}
                        >
                          {on ? "Save groups" : "Apply"}
                        </Button>
                      </Group>
                    </Stack>
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
              Archiving takes the app offline immediately: the address stops serving and each
              visitor&apos;s stored data for it is cleared from their browser. The subdomain is
              never handed to another app. Unarchive puts it back exactly as it was.
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
                You need to be signed in to archive or unarchive this app.
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
              Per-app roles (owner / editor / viewer) aren&apos;t built yet. Today anyone signed in
              to the portal can change this app — every change is recorded in the audit log against
              the person who made it.
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
              A public app opens to anyone with the link, with no sign-in — usage is capped per app
              and per visitor IP address. Because that is hard to undo once the link is out, this
              opens an approval request rather than applying now; the app stays as it is until an
              admin approves.
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
            <span className="az-mono">{app.slug}</span> stops serving immediately, and each
            visitor&apos;s stored data for it is cleared from their browser. This is reversible —
            unarchive puts the app back exactly as it was.
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
