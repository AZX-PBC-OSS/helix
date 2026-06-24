import { useState } from "react";
import {
  Alert,
  Anchor,
  Box,
  Button,
  Code,
  CopyButton,
  Group,
  Modal,
  Select,
  Stack,
  Tabs,
  Text,
} from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import { useQuery } from "@tanstack/react-query";
import type { UploadVersionResponse } from "@helix/shared";
import { useUploadVersion } from "../api/mutations";
import { appsQuery } from "../api/queries";
import { useAuth } from "../auth/AuthProvider";
import { Icon } from "../components/Icon";
import { Hint, ToneBadge } from "../components/primitives";

/**
 * Deploy = upload a zipped build as a new immutable *preview* version
 * (architecture §5.1 — promotion to live is a separate, human step).
 * CLI-first because that's the real workflow; the drop zone drives the same
 * multipart endpoint from the browser.
 */
export function DeployModal({
  opened,
  initialSlug,
  onClose,
  onCreateApp,
}: {
  opened: boolean;
  initialSlug?: string;
  onClose: () => void;
  onCreateApp: () => void;
}) {
  const apps = useQuery(appsQuery);
  const { authenticated, login, loginAvailable } = useAuth();
  const upload = useUploadVersion();
  const [slug, setSlug] = useState<string | null>(null);
  const [done, setDone] = useState<UploadVersionResponse | null>(null);

  const target = slug ?? initialSlug ?? null;
  const deployable = (apps.data ?? []).filter((a) => !a.archivedAt);
  const cliCmd = `azx deploy${target ? ` --slug ${target}` : ""}`;

  function close() {
    setSlug(null);
    setDone(null);
    upload.reset();
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
      <Stack gap="md">
        <Hint icon="layers" tone="info">
          Deploys land as a <b>preview</b> version — promote it to go live.
        </Hint>

        <Select
          label="App"
          placeholder={apps.isPending ? "Loading…" : "Pick an app"}
          data={deployable.map((a) => ({ value: a.slug, label: `${a.displayName} (${a.slug})` }))}
          value={target}
          onChange={setSlug}
          searchable
          nothingFoundMessage={
            <Anchor size="sm" onClick={onCreateApp}>
              No apps — register one first
            </Anchor>
          }
        />

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
                From your app directory (after <Code>azx login</Code>):
              </Text>
              <Group gap={8} wrap="nowrap">
                <Code block style={{ flex: 1, fontSize: 13 }}>
                  {cliCmd}
                </Code>
                <CopyButton value={cliCmd}>
                  {({ copied, copy }) => (
                    <Button
                      variant="default"
                      size="sm"
                      onClick={copy}
                      leftSection={<Icon name="copy" size={13} />}
                    >
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  )}
                </CopyButton>
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
              <Stack gap="sm">
                <Dropzone
                  onDrop={(files) => {
                    const file = files[0];
                    if (file && target) {
                      upload.mutate({ slug: target, file }, { onSuccess: setDone });
                    }
                  }}
                  accept={["application/zip", "application/x-zip-compressed"]}
                  multiple={false}
                  disabled={!target}
                  loading={upload.isPending}
                >
                  <Stack align="center" gap={6} py={28} style={{ pointerEvents: "none" }}>
                    <Icon
                      name="upload"
                      size={28}
                      style={{ color: "var(--mantine-color-dark-2)" }}
                    />
                    <Text fw={500}>{target ? "Drop a build zip here" : "Pick an app first"}</Text>
                    <Text size="xs" c="dark.2">
                      A zipped static build (what <Code>azx deploy</Code> would send)
                    </Text>
                  </Stack>
                </Dropzone>
                {upload.isError && (
                  <Alert color="red" title="Upload failed">
                    {upload.error.message}
                  </Alert>
                )}
              </Stack>
            )}
          </Tabs.Panel>
        </Tabs>
      </Stack>
    </Modal>
  );
}
