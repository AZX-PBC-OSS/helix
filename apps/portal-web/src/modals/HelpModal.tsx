import { Box, Button, Code, Divider, Group, List, Modal, Stack, Tabs, Text } from "@mantine/core";
import { MODEL_PRICING } from "@azx-pbc/shared";
import { renderSkill, SKILL_FILENAME } from "@azx-pbc/deploy-skill";
import skillTemplate from "@azx-pbc/deploy-skill/SKILL.md?raw";
import { Icon } from "../components/Icon";
import { CopyBtn, Eyebrow, Hint } from "../components/primitives";
import { useDeployment } from "../lib/deployment";
import { downloadText } from "../lib/download";

/**
 * The onboarding surface: how to go from an account to a deployed app, for the
 * two audiences that actually exist — someone building in a browser IDE, and
 * someone with a terminal.
 *
 * This modal is the **summary**; `packages/deploy-skill/SKILL.md` is the
 * **reference**. Anything longer than a couple of lines belongs in the skill, so
 * the two can't drift into different stories — and the skill is what leaves this
 * modal via Copy/Download, rendered for *this* deployment (the hosts here differ
 * per install, and the dev gateway is opt-in).
 */

/** The deployment's own docs live in the repo, so link nothing — name paths instead. */
function CliBlock({ children }: { children: string }) {
  return (
    <Code block style={{ fontSize: 12.5, lineHeight: 1.65 }}>
      {children}
    </Code>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <Group gap={12} wrap="nowrap" align="flex-start">
      <Box
        className="az-mono"
        style={{
          flexShrink: 0,
          width: 22,
          height: 22,
          borderRadius: 7,
          display: "grid",
          placeItems: "center",
          fontSize: 11,
          color: "var(--az-acc)",
          background: "color-mix(in srgb, var(--az-acc) 14%, transparent)",
        }}
      >
        {n}
      </Box>
      <Box>
        <Text size="sm" fw={600} c="dark.0">
          {title}
        </Text>
        <Text size="sm" c="dark.2" lh={1.55}>
          {children}
        </Text>
      </Box>
    </Group>
  );
}

export function HelpModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { appsHost, devApiBase, devModeAvailable, deployMaxFileMb, deployMaxBundleMb } =
    useDeployment();

  // Null until GET /api/v1/config lands — the buttons stay disabled rather than
  // handing an agent a skill with a placeholder host or size cap still in it.
  const skill =
    appsHost && deployMaxFileMb !== null && deployMaxBundleMb !== null
      ? renderSkill(skillTemplate, {
          portalOrigin: window.location.origin,
          appsHost,
          devApiBase,
          llmModels: Object.keys(MODEL_PRICING),
          maxFileMb: deployMaxFileMb,
          maxBundleMb: deployMaxBundleMb,
        })
      : null;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size={780}
      title={
        <Group gap={9}>
          <Icon name="book" size={17} style={{ color: "var(--az-acc)" }} />
          <Text fw={650}>How to develop on Helix</Text>
        </Group>
      }
    >
      <Stack gap={20}>
        <Text size="sm" c="dark.2" lh={1.6}>
          Helix hosts your app behind sign-in and gives it a model, storage, and outbound HTTP
          without you running a server or holding an API key. You write a <b>static frontend</b>;
          everything dynamic goes through the platform&apos;s same-origin gateway at{" "}
          <Code>/_api/*</Code>. What the app is allowed to reach is declared in its{" "}
          <b>capability manifest</b> and enforced on every request — so a capability you
          haven&apos;t granted returns <Code>403</Code> by design.
        </Text>

        {/* The one thing most people actually want out of this modal. */}
        <Box
          p="14px 16px"
          style={{
            borderRadius: "var(--mantine-radius-md)",
            border: "1px solid var(--az-line-2)",
            background: "color-mix(in srgb, var(--az-acc) 6%, transparent)",
          }}
        >
          <Eyebrow mb={6}>Building with an AI agent?</Eyebrow>
          <Text size="sm" c="dark.2" lh={1.55} mb={12}>
            Hand it these instructions first. They cover the manifest, the gateway API, the CSP you
            have to build within, and the deploy flow — with this deployment&apos;s real hostnames
            already filled in. Save as <Code>.claude/skills/helix/{SKILL_FILENAME}</Code>, or just
            paste it into the chat.
          </Text>
          <Group gap={8}>
            {skill ? (
              <CopyBtn value={skill} label="Copy agent instructions" size="sm" variant="filled" />
            ) : (
              <Button size="sm" disabled leftSection={<Icon name="copy" size={13} />}>
                Copy agent instructions
              </Button>
            )}
            <Button
              variant="default"
              size="sm"
              disabled={!skill}
              leftSection={<Icon name="download" size={13} />}
              onClick={() => skill && downloadText(SKILL_FILENAME, skill, "text/markdown")}
            >
              Download {SKILL_FILENAME}
            </Button>
          </Group>
        </Box>

        <Divider />

        <Box>
          <Eyebrow mb={12}>The four steps</Eyebrow>
          <Stack gap={13}>
            <Step n={1} title="Create the app">
              <b>Create app</b> on <b>My Apps</b>, or <Code>helix create</Code>. You get a slug; the
              app can exist with no code in it at all.
            </Step>
            <Step n={2} title="Grant its capabilities">
              On the app&apos;s <b>Capabilities</b> tab: which models it may call and a daily dollar
              budget, which app-data scopes it may use, which outbound origins it may fetch. Grants
              are enforced immediately, deployed code or not. Anything beyond the baseline — a new
              external origin, a public app, a big budget — queues for admin approval.
            </Step>
            <Step n={3} title="Build it against the real platform">
              Two ways, below. Either way the request shapes are identical to production, so nothing
              changes when you ship.
            </Step>
            <Step n={4} title="Deploy, then promote">
              A deploy always lands as an immutable <b>preview</b> version; promoting it to live is
              a separate, deliberate flip you can roll back. Live apps are served at{" "}
              <Code>https://&lt;slug&gt;.{appsHost ?? "…"}</Code>.
            </Step>
          </Stack>
        </Box>

        <Box>
          <Eyebrow mb={10}>Step 3, two ways</Eyebrow>
          <Tabs defaultValue={devModeAvailable ? "builder" : "cli"} variant="outline">
            <Tabs.List>
              <Tabs.Tab value="builder" leftSection={<Icon name="globe" size={14} />}>
                In a browser builder
              </Tabs.Tab>
              <Tabs.Tab value="cli" leftSection={<Icon name="terminal" size={14} />}>
                On your machine
              </Tabs.Tab>
            </Tabs.List>

            {/* Lovable, Bolt, v0, a cloud IDE — anything that runs your app on an
                origin the platform doesn't serve. */}
            <Tabs.Panel value="builder" pt="md">
              {devApiBase ? (
                <Stack gap={12}>
                  <Text size="sm" c="dark.2" lh={1.6}>
                    Build wherever you like and call Helix through the <b>dev gateway</b>. It serves
                    an isolated <Code>dev</Code> partition of your app — its own data, budget, and
                    credentials — so you develop against the real LLM proxy, real app-data, and real
                    manifest enforcement without touching production.
                  </Text>
                  <List size="sm" c="dark.2" spacing={6} withPadding>
                    <List.Item>
                      On the app&apos;s <b>Dev mode</b> tab, register the exact origins your builder
                      previews from (no wildcards) and mint a dev token — it&apos;s shown once.
                    </List.Item>
                    <List.Item>
                      Point your calls at the base below with the slug in the path, and send the
                      token as <Code>Authorization: Bearer azxdev_…</Code>.
                    </List.Item>
                    <List.Item>
                      Everything else is identical to production, so keep the base in one constant
                      and swap it at build time.
                    </List.Item>
                  </List>
                  <Group gap={8} wrap="nowrap">
                    <Code style={{ flex: 1, overflowX: "auto", whiteSpace: "nowrap" }}>
                      {devApiBase}/&lt;slug&gt;/_api/llm/chat
                    </Code>
                    <CopyBtn value={`${devApiBase}/`} label="Copy base" />
                  </Group>
                </Stack>
              ) : (
                <Hint tone="slate" icon="alert">
                  The dev gateway isn&apos;t enabled on this deployment, so there&apos;s no
                  cross-origin API base for a browser builder to call. Develop with the CLI instead,
                  or ask an operator to deploy it.
                </Hint>
              )}
            </Tabs.Panel>

            <Tabs.Panel value="cli" pt="md">
              <Stack gap={12}>
                <Text size="sm" c="dark.2" lh={1.6}>
                  The <Code>helix</Code> CLI deploys any build directory. Install it with npm (needs
                  Node 24+):
                </Text>
                <CliBlock>{INSTALL_CMD}</CliBlock>
                <Text size="sm" c="dark.2" lh={1.6}>
                  Then, from your app directory — with a{" "}
                  <Code>{'helix.json: { "slug": "my-app", "dir": "dist" }'}</Code>:
                </Text>
                <Group gap={8} wrap="nowrap" align="flex-start">
                  <Box style={{ flex: 1, minWidth: 0 }}>
                    <CliBlock>{DEPLOY_CMD}</CliBlock>
                  </Box>
                  <CopyBtn value={DEPLOY_CMD} label="Copy" />
                </Group>
                <Text size="xs" c="dark.3">
                  <Code>helix deploy --promote</Code> does both in one step. For CI, set{" "}
                  <Code>HELIX_TOKEN</Code> instead of running <Code>helix login</Code>.
                </Text>
              </Stack>
            </Tabs.Panel>
          </Tabs>
        </Box>

        <Box>
          <Eyebrow mb={8}>Start from an example</Eyebrow>
          <Text size="sm" c="dark.2" lh={1.6} mb={8}>
            The repo&apos;s <Code>examples/</Code> directory has deployable apps, each demonstrating
            one capability — clone one and change it rather than starting from nothing.
          </Text>
          <List size="sm" c="dark.2" spacing={4} withPadding>
            <List.Item>
              <Code>hello-world</Code> — the smallest thing that deploys.
            </List.Item>
            <List.Item>
              <Code>chatbot</Code> — streams a model through <Code>/_api/llm/chat</Code>.
            </List.Item>
            <List.Item>
              <Code>waitlist</Code> — a public form writing to a write-only collection.
            </List.Item>
            <List.Item>
              <Code>fetch-proxy</Code> — a third-party API through <Code>/_api/fetch</Code>, with
              and without an injected credential.
            </List.Item>
            <List.Item>
              <Code>github-stars</Code> — walks the CSP origin-approval loop on purpose.
            </List.Item>
          </List>
        </Box>
      </Stack>
    </Modal>
  );
}

/**
 * Published to public npm from CI with provenance (ADR-0032), so the install is
 * the one-liner it should be. Node 24+ — the bundle is emitted at that target.
 * `npm i -g git+…` still cannot resolve this package (workspace `catalog:`
 * specifiers, no prepack step), so don't "helpfully" offer that as a fallback.
 */
const INSTALL_CMD = `npm i -g @azx-pbc/helix-cli`;

const DEPLOY_CMD = `helix login
helix create --display-name "My App"
helix deploy
helix promote <n>`;
