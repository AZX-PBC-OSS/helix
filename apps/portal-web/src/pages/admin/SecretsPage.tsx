import { useState } from "react";
import {
  Button,
  Card,
  Center,
  Group,
  Loader,
  PasswordInput,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { INJECTION_KINDS, type InjectionRecipe, type SecretMetadata } from "@helix/shared";
import { globalSecretsQuery } from "../../api/queries";
import {
  useCreateGlobalSecret,
  useDeleteGlobalSecret,
  useGrantSecret,
  useRevokeSecret,
  useRotateGlobalSecret,
} from "../../api/mutations";
import { useAuth } from "../../auth/AuthProvider";
import { Icon } from "../../components/Icon";
import { Eyebrow, Hint, PageHead, ToneBadge } from "../../components/primitives";

/**
 * Admin-managed connection secrets (secrets design §5). Two scopes here:
 *  - **platform** — platform vendor credentials (the LLM key). Resolved by egress
 *    only on the `llm` capability path; not grantable, not bindable from a
 *    manifest, so there is no grant UI.
 *  - **global** — shared across apps via grants.
 * The app-scoped half lives on each app's Capabilities tab. All write-only: a
 * value is set/rotated, never shown again.
 */

function buildInjection(kind: string, headerName: string, queryParam: string): InjectionRecipe {
  if (kind === "header") return { kind: "header", name: headerName || "X-Api-Key", template: "{}" };
  if (kind === "query") return { kind: "query", param: queryParam || "api_key" };
  return { kind: "header-bearer" };
}

function describeInjection(r: InjectionRecipe): string {
  if (r.kind === "header-bearer") return "Authorization: Bearer …";
  if (r.kind === "header") return `${r.name}: ${r.template}`;
  return `?${r.param}=…`;
}

export function SecretsPage() {
  const { authenticated, login, loginAvailable } = useAuth();
  const secrets = useQuery({ ...globalSecretsQuery, enabled: authenticated });
  const create = useCreateGlobalSecret();
  const rotate = useRotateGlobalSecret();
  const del = useDeleteGlobalSecret();
  const grant = useGrantSecret();
  const revoke = useRevokeSecret();

  const [scope, setScope] = useState<"global" | "platform">("global");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [kind, setKind] = useState("header-bearer");
  const [headerName, setHeaderName] = useState("");
  const [queryParam, setQueryParam] = useState("");

  const nameValid = /^[a-z0-9][a-z0-9-]*$/.test(name);
  const err = create.error ?? rotate.error ?? del.error ?? grant.error ?? revoke.error;

  // Switching to a platform secret pre-fills the vendor-key recipe (the LLM key
  // is injected as `x-api-key`); switching back resets to the common case.
  const onScopeChange = (next: "global" | "platform") => {
    setScope(next);
    if (next === "platform") {
      setKind("header");
      setHeaderName("x-api-key");
    } else {
      setKind("header-bearer");
      setHeaderName("");
    }
  };

  const platform = (secrets.data ?? []).filter((s) => s.scope === "platform");
  const global = (secrets.data ?? []).filter((s) => s.scope === "global");

  const cardMutations = { rotate, del, grant, revoke };

  return (
    <div className="az-stagger">
      <PageHead
        eyebrow="Admin"
        title="Secrets"
        sub="Platform vendor keys (e.g. the LLM key) and global connection secrets. Write-only — values are never shown again."
      />

      {!authenticated && (
        <Card py={48} style={{ textAlign: "center" }}>
          <Stack align="center" gap={10}>
            <Text c="dark.2" size="sm">
              Sign in as a platform admin to manage secrets.
            </Text>
            <Button
              onClick={login}
              disabled={!loginAvailable}
              leftSection={<Icon name="user" size={14} />}
            >
              Sign in
            </Button>
          </Stack>
        </Card>
      )}

      {authenticated && secrets.isPending && (
        <Center py={60}>
          <Loader size="sm" />
        </Center>
      )}

      {authenticated && secrets.isError && (
        <Hint icon="alert" tone="bad">
          Couldn't load secrets: {secrets.error.message}. This requires the platform-admin role.
        </Hint>
      )}

      {authenticated && secrets.data && (
        <Stack gap={18}>
          {/* Create */}
          <Card>
            <Eyebrow mb={10}>Create a secret</Eyebrow>
            <Stack gap={10}>
              <Group gap={8} grow>
                <Select
                  label="Scope"
                  data={[
                    { value: "global", label: "Global (shared via grants)" },
                    { value: "platform", label: "Platform (vendor key, e.g. LLM)" },
                  ]}
                  value={scope}
                  onChange={(v) => onScopeChange((v as "global" | "platform") ?? "global")}
                  size="xs"
                  allowDeselect={false}
                />
                <TextInput
                  label="Name"
                  placeholder={scope === "platform" ? "e.g. anthropic" : "e.g. stripe-live"}
                  value={name}
                  onChange={(e) => setName(e.currentTarget.value)}
                  error={name.length > 0 && !nameValid ? "lowercase, digits, hyphens" : undefined}
                  size="xs"
                  classNames={{ input: "az-mono" }}
                />
                <Select
                  label="Injection"
                  data={INJECTION_KINDS.map((k) => ({ value: k, label: k }))}
                  value={kind}
                  onChange={(v) => setKind(v ?? "header-bearer")}
                  size="xs"
                  allowDeselect={false}
                />
              </Group>
              {scope === "platform" && (
                <Hint icon="key" tone="neutral">
                  The edge resolves this by name via{" "}
                  <span className="az-mono">EDGE_LLM_ANTHROPIC_CONNECTION</span> (default{" "}
                  <span className="az-mono">anthropic</span>) and routes the LLM call through egress
                  — the edge never holds the key.
                </Hint>
              )}
              {kind === "header" && (
                <TextInput
                  label="Header name"
                  placeholder="X-Api-Key"
                  value={headerName}
                  onChange={(e) => setHeaderName(e.currentTarget.value)}
                  size="xs"
                />
              )}
              {kind === "query" && (
                <TextInput
                  label="Query parameter"
                  placeholder="api_key"
                  value={queryParam}
                  onChange={(e) => setQueryParam(e.currentTarget.value)}
                  size="xs"
                />
              )}
              <PasswordInput
                label="Value"
                placeholder="paste the credential — stored sealed, never shown again"
                value={value}
                onChange={(e) => setValue(e.currentTarget.value)}
                size="xs"
              />
              <Group justify="flex-end">
                <Button
                  size="xs"
                  leftSection={<Icon name="key" size={12} />}
                  disabled={!nameValid || !value}
                  loading={create.isPending}
                  onClick={() =>
                    create.mutate(
                      {
                        name,
                        value,
                        injection: buildInjection(kind, headerName, queryParam),
                        scope,
                      },
                      {
                        onSuccess: () => {
                          setName("");
                          setValue("");
                          setQueryParam("");
                          onScopeChange(scope);
                        },
                      },
                    )
                  }
                >
                  Create secret
                </Button>
              </Group>
            </Stack>
          </Card>

          {/* Platform vendor secrets — not grantable, resolved on the llm path. */}
          <Eyebrow>Platform vendor keys</Eyebrow>
          {platform.length === 0 && (
            <Text size="sm" c="dark.2">
              No platform secrets yet — create one (e.g. <span className="az-mono">anthropic</span>)
              to back the LLM gateway.
            </Text>
          )}
          {platform.map((s) => (
            <SecretCard key={s.id} secret={s} allowGrant={false} {...cardMutations} />
          ))}

          {/* Global secrets — shared to apps via grants. */}
          <Eyebrow>Global secrets</Eyebrow>
          {global.length === 0 && (
            <Text size="sm" c="dark.2">
              No global secrets yet.
            </Text>
          )}
          {global.map((s) => (
            <SecretCard key={s.id} secret={s} allowGrant {...cardMutations} />
          ))}

          {err && (
            <Text size="xs" c="red">
              {err.message}
            </Text>
          )}
        </Stack>
      )}
    </div>
  );
}

type CardMutations = {
  rotate: ReturnType<typeof useRotateGlobalSecret>;
  del: ReturnType<typeof useDeleteGlobalSecret>;
  grant: ReturnType<typeof useGrantSecret>;
  revoke: ReturnType<typeof useRevokeSecret>;
};

function SecretCard({
  secret: s,
  allowGrant,
  rotate,
  del,
  grant,
  revoke,
}: { secret: SecretMetadata; allowGrant: boolean } & CardMutations) {
  const [rotating, setRotating] = useState<string | null>(null);
  const [granting, setGranting] = useState<string | null>(null);

  return (
    <Card>
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <div style={{ minWidth: 0 }}>
          <Group gap={8}>
            <Text className="az-mono" fz={14} fw={600}>
              {s.name}
            </Text>
            <ToneBadge tone="neutral" icon="key">
              {describeInjection(s.injection)}
            </ToneBadge>
          </Group>
          <Text size="xs" c="dark.2" mt={3}>
            {s.lastUsedAt ? `last used ${new Date(s.lastUsedAt).toLocaleString()}` : "never used"} ·
            created by {s.createdBy}
          </Text>
          {allowGrant && (
            <Group gap={6} mt={8}>
              {s.boundApps.length === 0 && (
                <Text size="xs" c="dark.2">
                  not granted to any app
                </Text>
              )}
              {s.boundApps.map((slug) => (
                <ToneBadge key={slug} tone="violet" icon="layers">
                  {slug}
                  <Button
                    variant="transparent"
                    size="compact-xs"
                    c="red"
                    px={4}
                    loading={revoke.isPending}
                    onClick={() => revoke.mutate({ id: s.id, appSlug: slug })}
                    aria-label={`revoke ${slug}`}
                  >
                    ×
                  </Button>
                </ToneBadge>
              ))}
            </Group>
          )}
        </div>
        <Group gap={6} wrap="nowrap">
          {allowGrant && (
            <Button
              variant="default"
              size="compact-xs"
              onClick={() => setGranting((g) => (g === null ? "" : null))}
            >
              Grant
            </Button>
          )}
          <Button
            variant="default"
            size="compact-xs"
            onClick={() => setRotating((r) => (r === null ? "" : null))}
          >
            Rotate
          </Button>
          <Button
            variant="subtle"
            color="red"
            size="compact-xs"
            loading={del.isPending}
            onClick={() => del.mutate({ id: s.id })}
          >
            Delete
          </Button>
        </Group>
      </Group>

      {allowGrant && granting !== null && (
        <Group gap={8} mt={12} align="flex-end" wrap="nowrap">
          <TextInput
            label="Grant to app (slug)"
            placeholder="acme-dashboard"
            value={granting}
            onChange={(e) => setGranting(e.currentTarget.value)}
            style={{ flex: 1 }}
            size="xs"
            classNames={{ input: "az-mono" }}
          />
          <Button
            size="xs"
            disabled={!granting}
            loading={grant.isPending}
            onClick={() =>
              grant.mutate({ id: s.id, appSlug: granting }, { onSuccess: () => setGranting(null) })
            }
          >
            Grant
          </Button>
        </Group>
      )}

      {rotating !== null && (
        <Group gap={8} mt={12} align="flex-end" wrap="nowrap">
          <PasswordInput
            label="New value"
            value={rotating}
            onChange={(e) => setRotating(e.currentTarget.value)}
            style={{ flex: 1 }}
            size="xs"
          />
          <Button
            size="xs"
            disabled={!rotating}
            loading={rotate.isPending}
            onClick={() =>
              rotate.mutate({ id: s.id, value: rotating }, { onSuccess: () => setRotating(null) })
            }
          >
            Save
          </Button>
        </Group>
      )}
    </Card>
  );
}
