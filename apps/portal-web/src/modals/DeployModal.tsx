import { useState } from "react";
import { Alert, Box, Button, Code, Divider, Group, Modal, Stack, Text } from "@mantine/core";
import type { UploadVersionResponse } from "@azx-pbc/shared";
import { useAuth } from "../auth/AuthProvider";
import { Icon } from "../components/Icon";
import { CopyBtn, Eyebrow, Hint, ToneBadge } from "../components/primitives";
import { UploadStep } from "../deploy/UploadStep";

/**
 * Deploy = upload a zipped build as a new immutable *preview* version
 * (architecture §5.1 — promotion to live is a separate, human step).
 *
 * One job, one target. The modal is only ever opened from an app's own page, so
 * it takes the slug it deploys into rather than asking; both halves of the flow
 * (the CLI command and the upload endpoint) address the app by slug anyway.
 *
 * Drag-and-drop leads and the CLI sits under it. That is not a ranking of the
 * two ways to ship — it follows from who is standing here. A developer using
 * `helix` deploys from a terminal without opening the portal, so the person who
 * reaches this modal is overwhelmingly the one who cannot: no checkout, no
 * terminal, an app built in a browser.
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

        <Box>
          <Eyebrow mb={10}>Upload a build</Eyebrow>
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
                Deployed as <b>preview</b>. Promote it from the app&apos;s Versions tab when ready.
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
        </Box>

        {/* Someone who deploys with `helix` does it from a terminal and has
            little reason to open this modal at all — so nearly everyone reading
            this screen is someone the upload is for. The block stays because a
            reminder of the exact command is worth having, but it is a reference,
            not a competing path: hence below the fold, and hence it names its
            audience in the first clause so everyone else can stop reading. Back
            when it was a tab of equal weight, one of those everyone-elses asked
            us where their "app directory" was. Hidden once a build has landed —
            that screen is a receipt, not a menu. */}
        {!done && (
          <Box>
            <Divider mb={16} />
            <Eyebrow mb={10}>Or deploy from the command line</Eyebrow>
            <Stack gap="sm">
              <Text size="sm" c="dark.2" lh={1.55}>
                <Code>helix</Code> is a command-line tool for developers. Install it and sign in
                once with <Code>helix login</Code>, then run this from your app&apos;s project root:
              </Text>
              <Box style={{ position: "relative" }}>
                <Code block style={{ fontSize: 13, paddingRight: 84 }}>
                  {cliCmd}
                </Code>
                <Box style={{ position: "absolute", top: 6, right: 6 }}>
                  <CopyBtn value={cliCmd} label="Copy" size="compact-xs" variant="subtle" />
                </Box>
              </Box>
              <Text size="xs" c="dark.2">
                New to the CLI? <b>How to develop</b> in the sidebar has the install steps and the
                full walkthrough.
              </Text>
            </Stack>
          </Box>
        )}
      </Stack>
    </Modal>
  );
}
