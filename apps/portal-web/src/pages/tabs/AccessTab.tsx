import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Box, Button, Card, Center, Group, Stack, Text, Textarea } from "@mantine/core";
import { visibilityLabel, type App } from "@azx-pbc/shared";
import {
  useArchiveApp,
  useDisablePassword,
  useEnablePassword,
  useSetVisibility,
} from "../../api/mutations";
import { GroupPicker } from "../../components/GroupPicker";
import { useAuth } from "../../auth/AuthProvider";
import { Icon, type IconName } from "../../components/Icon";
import { Eyebrow, Hint, ToneBadge } from "../../components/primitives";
import { ConfirmDialog } from "../../modals/ConfirmDialog";
import { PasswordAccessConfig } from "./PasswordAccessConfig";
import {
  accessStateOf,
  planTransition,
  type AccessState,
  type TransitionPlan,
} from "./accessTransition";

/**
 * The Access tab: one unified selector over the app's five access states —
 * internal, group, password, public, archived — instead of separate switcher,
 * password and lifecycle cards. Archived is the lifecycle flag surfaced as a
 * state (`accessStateOf`); the four visibility modes are the registry's own.
 *
 * Interaction follows the capabilities tab's draft-then-save shape (Aug 2026 UX
 * review — "re-use selection/confirm flow from capabilities", "no one-click
 * actions"): selecting a row drafts it and expands the state's own config
 * panel, and a pending-change bar at the top of the card — present exactly
 * while the draft is dirty, so its appearance is itself the dirty indicator —
 * carries the confirm affordance. Confirming opens a dialog that states who
 * gains, who loses, the live-session consequence, and whether an
 * admin-approval request will be opened. Nothing applies on a single click.
 *
 * The dispatch itself lives in `accessTransition.ts` (pure, unit-tested): the
 * server's endpoints are per-concern, so some transitions — password → group,
 * archived → anything — run as a short sequence of calls.
 */

/**
 * Descriptions answer "who gets in", in the user's terms — not how the platform
 * achieves it. Keep them parallel with the create form's shorter versions in
 * `components/AppCreateForm.tsx`. Avoid claims that depend on how the directory
 * itself is configured (whether guests exist and can sign in is a tenant
 * decision, not this app's).
 */
const VISIBILITY_ROWS: Array<{ mode: AccessState; icon: IconName; label: string; desc: string }> = [
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
  {
    mode: "archived",
    icon: "x",
    label: "Archived",
    desc: "Takes the app offline: the address stops serving and each visitor's stored data for it is cleared from their browser. The subdomain is never handed to another app. Unarchive puts it back exactly as it was.",
  },
];

/** The row icon for a state — the confirm dialog reuses the row's own icon. */
function rowIcon(mode: AccessState): IconName {
  return VISIBILITY_ROWS.find((row) => row.mode === mode)?.icon ?? "shield";
}

export function AccessTab({ app }: { app: App }) {
  const { authenticated, login, loginAvailable, allowPublicApps, allowPasswordApps } = useAuth();
  const setVisibility = useSetVisibility();
  const enablePassword = useEnablePassword();
  const disablePassword = useDisablePassword();
  const archive = useArchiveApp();

  const current = accessStateOf(app);
  const currentGroupIds = app.visibility.mode === "group" ? app.visibility.groupIds : [];

  // The draft: which row is selected (expanded), and that state's own draft
  // fields. It rests on the CURRENT state — the group and password panels hold
  // live information (which groups, which credential), so they are open without
  // any interaction, and selecting re-seeds the fields, so an abandoned pick
  // leaves nothing behind — the same discipline the old group panel's close
  // paths had to enforce.
  const [draft, setDraft] = useState<AccessState | null>(() => accessStateOf(app));
  const [groupIds, setGroupIds] = useState<string[]>(currentGroupIds);
  const [reason, setReason] = useState("");

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  // The last public request opened an approval (result.pending is the id).
  const [requested, setRequested] = useState(false);

  /**
   * Selecting a row. Clicking the drafted row again collapses it and discards
   * the draft — both directions re-seed, so no path can leave a stale group set
   * live behind an Apply button that looks unrelated to it.
   */
  const discard = () => {
    setDraft(null);
    setGroupIds(currentGroupIds);
    setReason("");
    setRequested(false);
  };
  const select = (mode: AccessState) => {
    if (running) return;
    if (draft === mode) {
      discard();
      return;
    }
    setDraft(mode);
    setGroupIds(currentGroupIds);
    setReason("");
    setRequested(false);
  };

  // Operator policy: hide an open-surface row when the deployment forbids that
  // mode — unless the app is already in it, in which case we keep the row (so
  // the owner can see the state) and offer the migrations away from it.
  const rows = VISIBILITY_ROWS.filter((row) => {
    if (row.mode === "public" && !allowPublicApps && current !== "public") return false;
    if (row.mode === "password" && !allowPasswordApps && current !== "password") return false;
    return true;
  });
  // The app sits in a mode this deployment no longer permits — the edge is
  // refusing to serve it, so nudge the owner to migrate down.
  const currentModeDisallowed =
    (current === "public" && !allowPublicApps) || (current === "password" && !allowPasswordApps);

  const plan = draft === null ? null : planTransition(app, draft, groupIds);

  /**
   * Run the planned steps in order, stopping at the first failure. On success
   * the selector rests on the new current state — enabling password, say,
   * expands its credential manager ready to be copied.
   */
  const execute = async (transition: TransitionPlan, target: AccessState) => {
    setRunning(true);
    setRunError(null);
    setRequested(false);
    try {
      let result: Awaited<ReturnType<typeof setVisibility.mutateAsync>> | undefined;
      for (const step of transition.steps) {
        if (step.kind === "setVisibility") {
          result = await setVisibility.mutateAsync({
            slug: app.slug,
            visibility: step.visibility,
            // The reason rides the approval request; a baseline switch has no
            // reviewer to read it.
            ...(transition.elevated && reason.trim() ? { reason: reason.trim() } : {}),
          });
        } else if (step.kind === "enablePassword") {
          await enablePassword.mutateAsync({ slug: app.slug });
        } else if (step.kind === "disablePassword") {
          await disablePassword.mutateAsync({ slug: app.slug });
        } else {
          await archive.mutateAsync({ slug: app.slug, archive: step.archived });
        }
      }
      if (result?.pending != null) setRequested(true);
      setConfirmOpen(false);
      setReason("");
      // A pending approval changed nothing — rest on the state that still is.
      setDraft(result?.pending != null ? current : target);
    } catch (e) {
      // The dialog stays open with the error; every step is idempotent, so
      // confirming again after a partial application is safe.
      setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  /**
   * The confirm body: who gains, who loses, how fast it lands. Branches on
   * direction because the same target mode widens from one state and tightens
   * from another — and every variant carries the live-session consequence,
   * which is the whole reason the dialog exists. The gate re-checks visibility
   * per request against the live registry entry (edge `gate.ts`), so a
   * confirmed change reaches people using the app right now within the
   * projection's refresh interval (~1 min), not at their next login.
   */
  const transitionBody = () => {
    if (plan === null || draft === null) return null;
    const slugMono = <span className="az-mono">{app.slug}</span>;

    if (draft === "archived") {
      return (
        <Text size="sm" c="dark.2" lh={1.5}>
          {slugMono} stops serving immediately, and each visitor&apos;s stored data for it is
          cleared from their browser. This is reversible — unarchive puts the app back exactly as it
          was.
        </Text>
      );
    }

    if (current === "archived") {
      if (plan.steps.length === 1) {
        return (
          <Text size="sm" c="dark.2" lh={1.5}>
            The app resumes serving exactly as it was — {visibilityLabel(app.visibility)} — within
            about a minute.
          </Text>
        );
      }
      if (draft === "public") {
        return (
          <Stack gap={10}>
            <Text size="sm" c="dark.2" lh={1.5}>
              A public app opens to anyone with the link, with no sign-in — usage is capped per app
              and per visitor IP address. Because that is hard to undo once the link is out, this
              opens an approval request rather than applying now.
            </Text>
            <Text size="sm" c="dark.2" lh={1.5}>
              The app stays archived until the approval lands — unarchive after it is approved.
            </Text>
          </Stack>
        );
      }
      return (
        <Stack gap={10}>
          <Text size="sm" c="dark.2" lh={1.5}>
            The app comes back from the archive and moves to{" "}
            {draft === "internal"
              ? "Internal"
              : draft === "group"
                ? "group-restricted"
                : "shared-password"}{" "}
            access. Serving resumes within about a minute of confirming.
          </Text>
          {draft === "group" && (
            <>
              <Text size="sm" c="dark.2" lh={1.5}>
                Only members of the groups below will be able to open it. Everyone else — including
                anyone who was using it before — loses access within about a minute.
              </Text>
              <Text size="sm" c="dark.2" lh={1.5}>
                Groups: <span className="az-mono">{groupIds.join(", ")}</span>
              </Text>
            </>
          )}
        </Stack>
      );
    }

    if (current === "password") {
      if (draft === "internal") {
        return (
          <Text size="sm" c="dark.2" lh={1.5}>
            The shared password stops working for new sign-ins, and the app returns to Internal —
            anyone who can sign in gains access. People who came in with the password keep their
            current session until it expires.
          </Text>
        );
      }
      return (
        <Stack gap={10}>
          <Text size="sm" c="dark.2" lh={1.5}>
            The shared password stops working for new sign-ins; people who came in with it keep
            their current session until it expires.
          </Text>
          {draft === "group" && (
            <>
              <Text size="sm" c="dark.2" lh={1.5}>
                The app then requires membership of the groups below — everyone else loses access
                within about a minute.
              </Text>
              <Text size="sm" c="dark.2" lh={1.5}>
                Groups: <span className="az-mono">{groupIds.join(", ")}</span>
              </Text>
            </>
          )}
          {draft === "public" && (
            <Text size="sm" c="dark.2" lh={1.5}>
              The app then opens to anyone with the link, with no sign-in — usage is capped per app
              and per visitor IP address. Because that is hard to undo once the link is out, this
              opens an approval request rather than applying now.
            </Text>
          )}
        </Stack>
      );
    }

    if (draft === "password") {
      return (
        <Text size="sm" c="dark.2" lh={1.5}>
          Access becomes a shared passphrase instead of sign-in — for people outside your
          organization. Anyone with the passphrase gets in, and people who sign in today keep
          access. Visitors aren&apos;t identified individually, and each gets their own isolated
          session. Confirming mints the passphrase (or hands back the existing one on re-enable).
        </Text>
      );
    }

    if (draft === "public") {
      return (
        <Text size="sm" c="dark.2" lh={1.5}>
          A public app opens to anyone with the link, with no sign-in — usage is capped per app and
          per visitor IP address. Because that is hard to undo once the link is out, this opens an
          approval request rather than applying now; the app stays as it is until an admin approves.
        </Text>
      );
    }

    if (current === "group" && draft === "group") {
      const added = groupIds.filter((id) => !currentGroupIds.includes(id));
      const removed = currentGroupIds.filter((id) => !groupIds.includes(id));
      return (
        <Stack gap={8}>
          {added.length > 0 && (
            <Text size="sm" c="dark.2" lh={1.5}>
              Gain access: <span className="az-mono">{added.join(", ")}</span>
            </Text>
          )}
          {removed.length > 0 && (
            <Text size="sm" c="dark.2" lh={1.5}>
              Lose access: <span className="az-mono">{removed.join(", ")}</span>
            </Text>
          )}
          <Text size="sm" c="dark.2" lh={1.5}>
            This changes who can open the app within about a minute — including for people using it
            right now.
          </Text>
        </Stack>
      );
    }

    if (draft === "internal") {
      return current === "public" ? (
        <Text size="sm" c="dark.2" lh={1.5}>
          Anonymous visitors lose access: the app will require organizational sign-in. People
          currently using it are sent to sign in on their next request — within about a minute, not
          at their next login.
        </Text>
      ) : (
        <Text size="sm" c="dark.2" lh={1.5}>
          Everyone who can sign in to your organization will be able to open this app — anyone not
          in the current groups gains access. This reaches people using the app right now within
          about a minute.
        </Text>
      );
    }

    // draft === "group" from a non-group state.
    return (
      <Stack gap={10}>
        <Text size="sm" c="dark.2" lh={1.5}>
          Only members of the groups below will be able to open this app. Everyone else — including
          anyone using it right now — loses access within about a minute.
        </Text>
        <Text size="sm" c="dark.2" lh={1.5}>
          Groups: <span className="az-mono">{groupIds.join(", ")}</span>
        </Text>
      </Stack>
    );
  };

  return (
    <Stack gap={18}>
      <Card>
        <Group justify="space-between" mb={4}>
          <Eyebrow>Access</Eyebrow>
        </Group>

        {/* The pending-change bar — the tab's dirty indicator, parked at the top
            so the confirm affordance is the first thing on the card, not a
            bottom-right footnote. Rendered only while a change is drafted; the
            space it reserves appearing is itself the signal. */}
        {plan !== null && draft !== null && (
          <Box
            mb={14}
            p="10px 14px"
            style={{
              borderRadius: "var(--mantine-radius-md)",
              background: "var(--az-acc-dim)",
              border: "1px solid color-mix(in srgb, var(--az-acc) 34%, transparent)",
            }}
          >
            <Group justify="space-between" gap={12} wrap="nowrap">
              <Stack gap={2} style={{ flex: 1 }}>
                <Group gap={8} wrap="nowrap">
                  <ToneBadge tone="acc" style={{ fontSize: 8.5, padding: "1px 6px" }}>
                    CHANGE PENDING
                  </ToneBadge>
                  {plan.elevated && (
                    <ToneBadge tone="violet" style={{ fontSize: 8.5, padding: "1px 6px" }}>
                      NEEDS APPROVAL
                    </ToneBadge>
                  )}
                  <Text fw={600} fz={13.5} truncate>
                    {plan.title.replace(/\?$/, "")}
                  </Text>
                </Group>
                <Text size="xs" c="dark.2" lh={1.45}>
                  {plan.elevated
                    ? "Opens an admin-approval request — nothing changes until an admin approves."
                    : "Applies within about a minute after you confirm — including for people using the app right now."}
                </Text>
              </Stack>
              <Group gap={8} wrap="nowrap">
                <Button
                  variant="subtle"
                  color="gray"
                  size="xs"
                  disabled={running}
                  onClick={discard}
                >
                  Discard
                </Button>
                <Button
                  size="xs"
                  // An empty group set is refused here rather than in the
                  // schema: it IS storable (the edge fails closed on it), but
                  // it is never what someone means to confirm, so the UI is
                  // where that gets caught.
                  disabled={running || (draft === "group" && groupIds.length === 0)}
                  loading={running}
                  // The ellipsis is the affordance: this opens the confirm
                  // dialog, it does not apply anything itself.
                  onClick={() => setConfirmOpen(true)}
                >
                  {plan.confirmLabel}…
                </Button>
              </Group>
            </Group>
          </Box>
        )}

        <Text size="sm" c="dark.2" mb={16}>
          Who can open the app. Pick a state, set its details, and confirm — every change states who
          gains access, who loses it, and how fast it reaches people using the app (about a minute).
          Going public is the one change that opens an admin-approval request instead of applying.
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
            You need to be signed in to change who can open this app.
          </Hint>
        )}
        {currentModeDisallowed && (
          <Box mb={12}>
            <Hint icon="shield" tone="bad">
              {current === "public" ? "Public" : "Password"} apps are turned off for this
              installation, so this app isn&apos;t being served at all. Pick Internal or a group to
              bring it back.
            </Hint>
          </Box>
        )}

        <Stack gap={10} mt={12}>
          {rows.map((row) => {
            const on = current === row.mode;
            const drafted = draft === row.mode;
            // Rows are selectable only for a signed-in actor. A deployment-
            // forbidden mode that is nonetheless current is not itself
            // selectable — the way out is picking a permitted state.
            const selectable = authenticated && !(currentModeDisallowed && on);
            return (
              <div
                key={row.mode}
                style={{
                  borderRadius: "var(--mantine-radius-md)",
                  background: drafted ? "var(--az-acc-dim)" : "var(--mantine-color-dark-6)",
                  border: `1px solid ${
                    drafted
                      ? "color-mix(in srgb, var(--az-acc) 34%, transparent)"
                      : "var(--az-line)"
                  }`,
                  opacity: on || drafted || !selectable ? 1 : 0.75,
                }}
              >
                {/* Only the header selects — the config panel below is real
                    form content, and a click in it must never toggle the
                    draft. */}
                <div
                  {...(selectable
                    ? {
                        role: "button" as const,
                        tabIndex: 0,
                        onClick: () => select(row.mode),
                        onKeyDown: (e: ReactKeyboardEvent) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            select(row.mode);
                          }
                        },
                      }
                    : {})}
                  style={{ cursor: selectable ? "pointer" : "default" }}
                >
                  <Group gap={13} p="13px 14px" align="flex-start" wrap="nowrap">
                    <Center
                      w={30}
                      h={30}
                      style={{
                        borderRadius: 8,
                        background: on || drafted ? "var(--az-acc)" : "var(--mantine-color-dark-5)",
                        color: on || drafted ? "var(--az-acc-ink)" : "var(--mantine-color-dark-1)",
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
                        {drafted && !on && (
                          <ToneBadge tone="acc" style={{ fontSize: 8.5, padding: "1px 6px" }}>
                            SELECTED
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
                  </Group>
                </div>

                {drafted && authenticated && row.mode === "group" && (
                  <Stack gap={10} px={14} pb={13}>
                    <GroupPicker
                      value={groupIds}
                      onChange={setGroupIds}
                      disabled={running}
                      slug={app.slug}
                    />
                  </Stack>
                )}
                {drafted && authenticated && row.mode === "password" && (
                  <Stack gap={10} px={14} pb={13}>
                    {on ? (
                      <PasswordAccessConfig app={app} disabled={running} />
                    ) : (
                      <Text size="xs" c="dark.2" lh={1.45}>
                        Confirming mints the passphrase and hands it to you to share, with the
                        app&apos;s address. Re-enabling later returns the existing credential.
                      </Text>
                    )}
                  </Stack>
                )}
              </div>
            );
          })}
        </Stack>

        {requested && (
          <Box mt={12}>
            <Hint icon="shield" tone="violet">
              Request opened — going public is awaiting admin approval. The app stays as it is until
              a reviewer approves.
            </Hint>
          </Box>
        )}
        {runError && !confirmOpen && (
          <Text size="xs" c="red" mt={10}>
            {runError}
          </Text>
        )}
      </Card>

      <ConfirmDialog
        opened={confirmOpen}
        icon={draft === null ? "shield" : rowIcon(draft)}
        title={plan?.title ?? ""}
        body={
          <Stack gap={10}>
            {transitionBody()}
            {plan?.elevated && (
              <Textarea
                label="Reason for review (optional)"
                placeholder="Why does this app need to be public?"
                value={reason}
                onChange={(e) => setReason(e.currentTarget.value)}
                rows={3}
              />
            )}
          </Stack>
        }
        confirmLabel={plan?.confirmLabel ?? "Confirm"}
        loading={running}
        error={confirmOpen ? runError : null}
        onConfirm={() => {
          if (plan !== null && draft !== null) void execute(plan, draft);
        }}
        onClose={() => {
          setConfirmOpen(false);
          setRunError(null);
        }}
      />
    </Stack>
  );
}
