import { useMemo, useState, type ReactNode } from "react";
import {
  Box,
  Button,
  Card,
  Center,
  Code,
  Grid,
  Group,
  Loader,
  NumberInput,
  Stack,
  Switch,
  TagsInput,
  Text,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { App, Capabilities } from "@helix/shared";
import { useSetManifest } from "../../api/mutations";
import { manifestQuery } from "../../api/queries";
import { useAuth } from "../../auth/AuthProvider";
import { Icon, type IconName } from "../../components/Icon";
import { Eyebrow, Hint, ToneBadge } from "../../components/primitives";
import { fmtCount } from "../../lib/format";

/**
 * The §6.3 capability manifest editor, backed by the real
 * `GET`/`PUT /api/v1/apps/:slug/manifest` API. Edits the grants the M4 gateway
 * enforces; saving applies them directly (per-app approval is a v1 control-plane
 * feature — the "needs approval" copy below is informational only).
 */

const DEFAULT_MODEL = "claude-opus-4-8";

function CapBlock({
  icon,
  title,
  desc,
  children,
}: {
  icon: IconName;
  title: string;
  desc: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <Group gap={11} mb={14} align="flex-start" wrap="nowrap">
        <Center
          w={34}
          h={34}
          style={{
            borderRadius: 9,
            background: "var(--mantine-color-dark-5)",
            color: "var(--az-acc)",
            flexShrink: 0,
          }}
        >
          <Icon name={icon} size={17} />
        </Center>
        <Box>
          <Text ff="heading" fw={600} fz={14.5}>
            {title}
          </Text>
          <Text size="xs" c="dark.2" mt={4} lh={1.45}>
            {desc}
          </Text>
        </Box>
      </Group>
      {children}
    </Card>
  );
}

/** Normalized, comparable view of a Capabilities grant for the editor state. */
interface Draft {
  models: string[];
  tokensPerDay: number | undefined;
  /** §3.1 per-user private store. */
  dataUser: boolean;
  /** §3.2 append-only collections (write-from-app, owner reads via portal). */
  collections: string[];
  /** §3.3 world-readable shared keys. */
  sharedRead: string[];
  /** §3.3 app-writable shared keys. */
  sharedWrite: string[];
  mcp: string[];
  externalOrigins: string[];
}

function toDraft(c: Capabilities): Draft {
  return {
    models: c.llm?.models ?? [],
    tokensPerDay: c.llm?.tokensPerDay,
    dataUser: c.data?.user ?? false,
    collections: c.data?.collections ?? [],
    sharedRead: c.data?.sharedRead ?? [],
    sharedWrite: c.data?.sharedWrite ?? [],
    mcp: c.mcp,
    externalOrigins: c.externalOrigins,
  };
}

function hasDataGrant(d: Draft): boolean {
  return (
    d.dataUser || d.collections.length > 0 || d.sharedRead.length > 0 || d.sharedWrite.length > 0
  );
}

/** Build the wire Capabilities from the editor draft, omitting empty blocks. */
function fromDraft(d: Draft): Capabilities {
  return {
    ...(d.models.length || d.tokensPerDay !== undefined
      ? {
          llm: {
            models: d.models,
            ...(d.tokensPerDay !== undefined ? { tokensPerDay: d.tokensPerDay } : {}),
          },
        }
      : {}),
    ...(hasDataGrant(d)
      ? {
          data: {
            user: d.dataUser,
            collections: d.collections,
            sharedRead: d.sharedRead,
            sharedWrite: d.sharedWrite,
          },
        }
      : {}),
    mcp: d.mcp,
    externalOrigins: d.externalOrigins,
  };
}

function renderYaml(app: App, d: Draft): string {
  const lines = [
    `app: ${app.slug}`,
    `visibility: ${app.visibility.mode}${app.visibility.mode === "group" ? `:${app.visibility.groupId}` : ""}`,
    `capabilities:`,
  ];
  if (d.models.length || d.tokensPerDay !== undefined) {
    lines.push(`  llm:`);
    lines.push(`    models: [${d.models.join(", ")}]`);
    if (d.tokensPerDay !== undefined)
      lines.push(`    tokens_per_day: ${d.tokensPerDay.toLocaleString()}`);
  }
  if (hasDataGrant(d)) {
    lines.push(`  data:`);
    if (d.dataUser) lines.push(`    user: true`);
    if (d.collections.length) lines.push(`    collections: [${d.collections.join(", ")}]`);
    if (d.sharedRead.length) lines.push(`    shared_read: [${d.sharedRead.join(", ")}]`);
    if (d.sharedWrite.length) lines.push(`    shared_write: [${d.sharedWrite.join(", ")}]`);
  }
  lines.push(`  mcp: [${d.mcp.join(", ")}]`);
  lines.push(`  external_origins: [${d.externalOrigins.join(", ")}]`);
  return lines.join("\n");
}

export function CapabilitiesTab({ app }: { app: App }) {
  const { authenticated, login, loginAvailable } = useAuth();
  const manifest = useQuery(manifestQuery(app.slug));
  const setManifest = useSetManifest();

  const [draft, setDraft] = useState<Draft | null>(null);
  // Sync the editor to fresh server state by adjusting state during render
  // (React's endorsed alternative to a setState-in-effect): when the fetched
  // capabilities reference changes — first load, or a refetch after save
  // invalidates the query — reseed the draft. react-query's structural sharing
  // keeps the reference stable across unrelated re-renders, so in-progress
  // edits survive.
  const [syncedFrom, setSyncedFrom] = useState<Capabilities | null>(null);
  if (manifest.data && manifest.data.capabilities !== syncedFrom) {
    setSyncedFrom(manifest.data.capabilities);
    setDraft(toDraft(manifest.data.capabilities));
  }

  const dirty = useMemo(() => {
    if (!draft || !manifest.data) return false;
    return JSON.stringify(draft) !== JSON.stringify(toDraft(manifest.data.capabilities));
  }, [draft, manifest.data]);

  if (manifest.isPending || !draft) {
    return (
      <Center py={60}>
        <Loader size="sm" />
      </Center>
    );
  }
  if (manifest.isError) {
    return (
      <Hint icon="alert" tone="bad">
        Couldn't load the manifest: {manifest.error.message}
      </Hint>
    );
  }

  const patch = (next: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...next } : d));

  return (
    <Stack gap={18}>
      <Group>
        <Text size="sm" c="dark.2">
          The §6.3 capability manifest the gateway enforces. Saved changes apply at the edge within
          ~1 min (registry projection). The platform holds vendor keys — your app never sees them.
        </Text>
      </Group>

      <Grid gap={18} className="az-stagger">
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Stack gap={18}>
            <CapBlock
              icon="cpu"
              title="LLM inference"
              desc="Proxied through the gateway — the platform holds vendor keys; your app never sees them."
            >
              <TagsInput
                label="Models"
                description="Allowlist matched against each /_api/llm/chat request."
                placeholder={`add model — e.g. ${DEFAULT_MODEL}`}
                value={draft.models}
                onChange={(models) => patch({ models })}
                classNames={{ input: "az-mono" }}
              />
              <Box mt={14}>
                <Switch
                  checked={draft.tokensPerDay !== undefined}
                  onChange={(e) =>
                    patch({ tokensPerDay: e.currentTarget.checked ? 1_000_000 : undefined })
                  }
                  label="Daily token cap"
                  description="Off = no per-day budget (gateway still meters every call)."
                />
                {draft.tokensPerDay !== undefined && (
                  <Group gap={12} mt={10} align="center">
                    <NumberInput
                      value={draft.tokensPerDay}
                      onChange={(v) =>
                        patch({ tokensPerDay: typeof v === "number" ? v : Number(v) || 0 })
                      }
                      min={1}
                      step={100_000}
                      thousandSeparator=","
                      w={180}
                      classNames={{ input: "az-mono" }}
                    />
                    <Text className="az-mono" c="dark.2" fz={12.5}>
                      = {fmtCount(draft.tokensPerDay)} / day
                    </Text>
                    <ToneBadge tone="violet" icon="shield">
                      large budgets need admin approval (v1)
                    </ToneBadge>
                  </Group>
                )}
              </Box>
            </CapBlock>

            <CapBlock
              icon="db"
              title="App data storage"
              desc="Three named scopes, not a symmetric KV — read and write are independent grants, so a contact harvester can be write-only from the browser."
            >
              <Stack gap={14}>
                <Switch
                  checked={draft.dataUser}
                  onChange={(e) => patch({ dataUser: e.currentTarget.checked })}
                  label="User-scoped store"
                  description="/_api/data/user/* — auto-partitioned per signed-in user (disabled for public apps)"
                />
                <TagsInput
                  label="Collections (append-only)"
                  description="POST /_api/data/collections/:name — the app appends; the owner drains here. No app-facing read."
                  placeholder="add collection — e.g. contacts"
                  value={draft.collections}
                  onChange={(collections) => patch({ collections })}
                  classNames={{ input: "az-mono" }}
                />
                <TagsInput
                  label="Shared keys — readable by every visitor"
                  description="GET /_api/data/shared/:key. Rare and dangerous: any visitor reads everything."
                  placeholder="add shared-read key"
                  value={draft.sharedRead}
                  onChange={(sharedRead) => patch({ sharedRead })}
                  classNames={{ input: "az-mono" }}
                />
                <TagsInput
                  label="Shared keys — writable by the app frontend"
                  description="PUT /_api/data/shared/:key. Usually empty — every visitor could mutate shared state."
                  placeholder="add shared-write key"
                  value={draft.sharedWrite}
                  onChange={(sharedWrite) => patch({ sharedWrite })}
                  classNames={{ input: "az-mono" }}
                />
                {(draft.sharedRead.length > 0 || draft.sharedWrite.length > 0) && (
                  <ToneBadge tone="violet" icon="shield">
                    shared keys on a public app need admin approval (v1)
                  </ToneBadge>
                )}
              </Stack>
            </CapBlock>

            <CapBlock
              icon="key"
              title="MCP servers"
              desc="Platform-registered MCP servers exposed as governed REST endpoints. Any-MCP grants need admin approval."
            >
              <TagsInput
                label="Granted"
                placeholder="request MCP server"
                value={draft.mcp}
                onChange={(mcp) => patch({ mcp })}
                classNames={{ input: "az-mono" }}
              />
            </CapBlock>

            <CapBlock
              icon="globe"
              title="External origins"
              desc="connect-src CSP exceptions. Prefer the gateway fetch-proxy — it adds auditing, metering, and server-side secrets."
            >
              <TagsInput
                label="connect-src"
                description="Full origins, e.g. https://api.example.com"
                placeholder="request origin"
                value={draft.externalOrigins}
                onChange={(externalOrigins) => patch({ externalOrigins })}
                classNames={{ input: "az-mono" }}
              />
            </CapBlock>
          </Stack>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 5 }}>
          <Box style={{ position: "sticky", top: 0 }}>
            <Eyebrow mb={10}>manifest.yaml</Eyebrow>
            <Code block style={{ fontSize: 12, lineHeight: 1.7, padding: "16px 18px" }}>
              {renderYaml(app, draft)}
            </Code>
            <Box mt={14}>
              <Hint icon="shield" tone="info">
                Above-baseline grants (arbitrary MCP servers, external origins, large LLM budgets)
                pause for admin approval. Baseline edits apply immediately on save; elevated ones
                open a request.
              </Hint>
            </Box>
            {setManifest.data?.pending && (
              <Box mt={10}>
                <Hint icon="shield" tone="violet">
                  Baseline changes applied. The elevated grants are now awaiting admin approval.
                </Hint>
              </Box>
            )}
            {!authenticated ? (
              <Button
                fullWidth
                mt={14}
                variant="default"
                onClick={login}
                disabled={!loginAvailable}
                leftSection={<Icon name="user" size={14} />}
              >
                Sign in to edit the manifest
              </Button>
            ) : (
              <Button
                fullWidth
                mt={14}
                disabled={!dirty}
                loading={setManifest.isPending}
                leftSection={<Icon name="check" size={14} />}
                onClick={() =>
                  setManifest.mutate({ slug: app.slug, capabilities: fromDraft(draft) })
                }
              >
                {dirty ? "Save manifest" : "Saved"}
              </Button>
            )}
            {setManifest.isError && (
              <Text size="xs" c="red" mt={8}>
                {setManifest.error.message}
              </Text>
            )}
          </Box>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}
