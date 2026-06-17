import { useState } from "react";
import { Button, Card, Center, Grid, Group, Stack, Text } from "@mantine/core";
import type { App, VisibilityMode } from "@helix/shared";
import { useArchiveApp } from "../../api/mutations";
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
    mode: "private",
    icon: "lock",
    label: "Private",
    desc: "SSO via the IdP. Unauthenticated users are redirected to login.",
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

export function SettingsTab({ app }: { app: App }) {
  const { authenticated, login, loginAvailable } = useAuth();
  const archive = useArchiveApp();
  const [confirming, setConfirming] = useState(false);
  const archived = app.archivedAt !== null;

  return (
    <Grid gap={18} align="flex-start" className="az-stagger">
      <Grid.Col span={{ base: 12, md: 7 }}>
        <Card>
          <Group justify="space-between" mb={4}>
            <Eyebrow>Visibility</Eyebrow>
            <PreviewBadge milestone="M4" />
          </Group>
          <Text size="sm" c="dark.2" mb={16}>
            Auth is terminated at the edge proxy — the app ships zero auth code. Password access is
            managed on the right; switching between SSO modes is an M4 portal action (going public
            will require approval).
          </Text>
          <Stack gap={10}>
            {VISIBILITY_ROWS.map((row) => {
              const on = app.visibility.mode === row.mode;
              return (
                <Group
                  key={row.mode}
                  gap={13}
                  p="13px 14px"
                  align="flex-start"
                  wrap="nowrap"
                  style={{
                    borderRadius: "var(--mantine-radius-md)",
                    background: on ? "var(--az-acc-dim)" : "var(--mantine-color-dark-6)",
                    border: `1px solid ${on ? "color-mix(in srgb, var(--az-acc) 34%, transparent)" : "var(--az-line)"}`,
                    opacity: on ? 1 : 0.6,
                  }}
                >
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
                  <div>
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
                </Group>
              );
            })}
          </Stack>
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
