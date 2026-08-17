import { useState, type ReactNode } from "react";
import {
  Alert,
  Box,
  Button,
  Center,
  Code,
  Group,
  Modal,
  SegmentedControl,
  Select,
  Stack,
  Tabs,
  Text,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { UploadVersionResponse } from "@azx-pbc/shared";
import { appsQuery } from "../api/queries";
import { useAuth } from "../auth/AuthProvider";
import { AppCreateForm } from "../components/AppCreateForm";
import { Icon } from "../components/Icon";
import { CopyBtn, Hint, ToneBadge } from "../components/primitives";
import { useDeployment } from "../lib/deployment";
import { UploadStep } from "../deploy/UploadStep";

/**
 * Deploy = upload a zipped build as a new immutable *preview* version
 * (architecture §5.1 — promotion to live is a separate, human step).
 *
 * Two steps, in order: pick the target app — registering one right here if it
 * doesn't exist yet — then ship a build into it. Creating an app used to hide
 * behind the app picker's "nothing found" message, which meant that once you
 * had a single app there was no path to a second one through the UI at all.
 * Step 2 stays inert until there's a target, since both halves of it (the CLI
 * command and the upload endpoint) are addressed by slug.
 */
export function DeployModal({
  opened,
  initialSlug,
  onClose,
}: {
  opened: boolean;
  initialSlug?: string;
  onClose: () => void;
}) {
  const apps = useQuery(appsQuery);
  const { authenticated, login, loginAvailable } = useAuth();
  const { appHost } = useDeployment();
  const [slug, setSlug] = useState<string | null>(null);
  const [source, setSource] = useState<"existing" | "new" | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [done, setDone] = useState<UploadVersionResponse | null>(null);

  const target = slug ?? initialSlug ?? null;
  const deployable = (apps.data ?? []).filter((a) => !a.archivedAt);
  // Nothing to pick from ⇒ start on the create form rather than an empty
  // dropdown, but let an explicit segment choice win once one is made.
  const noApps = apps.isSuccess && deployable.length === 0;
  const mode = source ?? (noApps ? "new" : "existing");
  const cliCmd = `helix deploy${target ? ` --slug ${target}` : ""}`;

  function close() {
    setSlug(null);
    setSource(null);
    setCreated(null);
    setDone(null);
    onClose();
  }

  return (
    <Modal
      opened={opened}
      onClose={close}
      title={
        <Text ff="heading" fw={600}>
          Deploy
        </Text>
      }
      size="lg"
    >
      <Stack gap="lg">
        <Hint icon="layers" tone="info">
          Deploys land as a <b>preview</b> version — promote it to go live.
        </Hint>

        <Step n={1} title="Choose an app" done={Boolean(target)}>
          <Stack gap="sm">
            <SegmentedControl
              fullWidth
              value={mode}
              onChange={(v) => setSource(v as "existing" | "new")}
              data={[
                {
                  value: "existing",
                  label: `Existing app${deployable.length ? ` (${deployable.length})` : ""}`,
                  disabled: noApps,
                },
                { value: "new", label: "New app" },
              ]}
            />

            {mode === "existing" ? (
              <Select
                label="App"
                placeholder={apps.isPending ? "Loading…" : "Pick an app"}
                description={target && appHost(target) ? `Serves at ${appHost(target)}` : undefined}
                data={deployable.map((a) => ({
                  value: a.slug,
                  label: `${a.displayName} (${a.slug})`,
                }))}
                value={target}
                onChange={(v) => {
                  setSlug(v);
                  setDone(null);
                }}
                searchable
                nothingFoundMessage="No match"
              />
            ) : (
              <AppCreateForm
                submitLabel="Create & continue"
                onCreated={(app) => {
                  // Straight into step 2 against the app we just registered.
                  setSlug(app.slug);
                  setCreated(app.slug);
                  setSource("existing");
                }}
              />
            )}

            {created && created === target && (
              <Hint icon="check" tone="live">
                Registered <b>{created}</b>. It has no versions yet — ship a build below.
              </Hint>
            )}
          </Stack>
        </Step>

        <Step n={2} title="Ship a build" disabled={!target}>
          {!target ? (
            <Text size="sm" c="dark.2">
              Pick or create an app first — the CLI command and the upload both address it by slug.
            </Text>
          ) : (
            <Tabs defaultValue="cli" keepMounted={false}>
              <Tabs.List>
                <Tabs.Tab value="cli" leftSection={<Icon name="terminal" size={14} />}>
                  CLI
                </Tabs.Tab>
                <Tabs.Tab value="upload" leftSection={<Icon name="upload" size={14} />}>
                  Upload zip
                </Tabs.Tab>
              </Tabs.List>

              <Tabs.Panel value="cli" pt="md">
                <Stack gap="sm">
                  <Text size="sm" c="dark.2">
                    From your app directory (after <Code>helix login</Code>):
                  </Text>
                  <Group gap={8} wrap="nowrap">
                    <Code block style={{ flex: 1, fontSize: 13 }}>
                      {cliCmd}
                    </Code>
                    <CopyBtn value={cliCmd} label="Copy" size="sm" />
                  </Group>
                </Stack>
              </Tabs.Panel>

              <Tabs.Panel value="upload" pt="md">
                {!authenticated ? (
                  <Group justify="space-between">
                    <Text size="sm" c="dark.2">
                      Uploading needs a signed-in actor.
                    </Text>
                    <Button variant="default" onClick={login} disabled={!loginAvailable}>
                      Sign in
                    </Button>
                  </Group>
                ) : done ? (
                  <Stack gap="sm">
                    <Alert
                      color="green"
                      title={`v${done.version.number} uploaded`}
                      icon={<Icon name="check" size={16} />}
                    >
                      Deployed as <b>preview</b>. Promote it from the app&apos;s Versions tab when
                      ready.
                    </Alert>
                    {done.warnings.length > 0 && (
                      <Box>
                        <Group gap={8} mb={6}>
                          <ToneBadge tone="warn" icon="alert">
                            CSP lint · {done.warnings.length}
                          </ToneBadge>
                        </Group>
                        <Stack gap={4}>
                          {done.warnings.map((w, i) => (
                            <Text key={i} size="xs" className="az-mono" c="dark.2">
                              {w.file}: {w.origin} — {w.hint}
                            </Text>
                          ))}
                        </Stack>
                      </Box>
                    )}
                  </Stack>
                ) : (
                  <UploadStep
                    key={target}
                    slug={target}
                    authenticated={authenticated}
                    onDone={setDone}
                  />
                )}
              </Tabs.Panel>
            </Tabs>
          )}
        </Step>
      </Stack>
    </Modal>
  );
}

/** A numbered section of the flow: ticked once satisfied, dimmed until reachable. */
function Step({
  n,
  title,
  done,
  disabled,
  children,
}: {
  n: number;
  title: string;
  done?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Box style={{ opacity: disabled ? 0.55 : 1 }} aria-disabled={disabled || undefined}>
      <Group gap={10} mb={12} wrap="nowrap">
        <Center
          w={22}
          h={22}
          style={{
            flexShrink: 0,
            borderRadius: 999,
            border: `1px solid ${done ? "transparent" : "var(--az-line-2)"}`,
            background: done ? "var(--az-live-dim)" : "transparent",
          }}
        >
          {done ? (
            <Icon name="check" size={12} style={{ color: "var(--az-live)" }} />
          ) : (
            <Text className="az-mono" fz={11} c="dark.2">
              {n}
            </Text>
          )}
        </Center>
        <Text ff="heading" fw={600} fz={14}>
          {title}
        </Text>
      </Group>
      <Box pl={32}>{children}</Box>
    </Box>
  );
}
