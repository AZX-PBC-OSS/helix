import { useState } from "react";
import { Alert, Box, Button, Code, Group, Modal, Stack, Tabs, Text } from "@mantine/core";
import type { UploadVersionResponse } from "@azx-pbc/shared";
import { useAuth } from "../auth/AuthProvider";
import { Icon } from "../components/Icon";
import { CopyBtn, Hint, ToneBadge } from "../components/primitives";
import { UploadStep } from "../deploy/UploadStep";

/**
 * Deploy = upload a zipped build as a new immutable *preview* version
 * (architecture §5.1 — promotion to live is a separate, human step).
 *
 * One job, one target. The modal is only ever opened from an app's own page, so
 * it takes the slug it deploys into rather than asking; both halves of the flow
 * (the CLI command and the upload endpoint) address the app by slug anyway.
 *
 * This used to lead with a "pick or create an app" step, which existed to keep
 * registration reachable: it once hid inside the app picker's "nothing found"
 * message, so a single registered app cut off the path to a second. That
 * guarantee now belongs to the **Create app** button on My Apps
 * (`AppsListPage`) — always visible, independent of how many apps exist.
 */
export function DeployModal({
  opened,
  slug,
  onClose,
}: {
  opened: boolean;
  /** The app to deploy into; null only before the modal has ever been opened. */
  slug: string | null;
  onClose: () => void;
}) {
  const { authenticated, login, loginAvailable } = useAuth();
  const [done, setDone] = useState<UploadVersionResponse | null>(null);

  function close() {
    setDone(null);
    onClose();
  }

  if (!slug) return null;
  const cliCmd = `helix deploy --slug ${slug}`;

  return (
    <Modal
      opened={opened}
      onClose={close}
      title={
        <Text ff="heading" fw={600}>
          Deploy · <span className="az-mono">{slug}</span>
        </Text>
      }
      size="lg"
    >
      <Stack gap="lg">
        <Hint icon="layers" tone="info">
          Deploys land as a <b>preview</b> version — promote it to go live.
        </Hint>

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
                  You need to be signed in to upload a build.
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
              <UploadStep key={slug} slug={slug} authenticated={authenticated} onDone={setDone} />
            )}
          </Tabs.Panel>
        </Tabs>
      </Stack>
    </Modal>
  );
}
