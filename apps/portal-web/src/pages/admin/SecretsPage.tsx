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
import { INJECTION_KINDS, type SecretMetadata } from "@azx-pbc/shared";
import {
  EMPTY_INJECTION_FORM,
  INJECTION_DEFAULTS,
  INJECTION_LABELS,
  buildInjection,
  describeInjection,
  packHmacValue,
  usesCredentialPair,
} from "../../lib/injection";
import { globalSecretsQuery } from "../../api/queries";
import {
  useCreateGlobalSecret,
  useDeleteGlobalSecret,
  useGrantSecret,
  useRevokeSecret,
  useRotateGlobalSecret,
} from "../../api/mutations";
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

export function SecretsPage() {
  const secrets = useQuery(globalSecretsQuery);
  const create = useCreateGlobalSecret();
  const rotate = useRotateGlobalSecret();
  const del = useDeleteGlobalSecret();
  const grant = useGrantSecret();
  const revoke = useRevokeSecret();

  const [scope, setScope] = useState<"global" | "platform">("global");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [kind, setKind] = useState("header-bearer");
  const [form, setForm] = useState({ ...EMPTY_INJECTION_FORM });
  // `hmac-timestamp` needs both halves of a key pair; the public half is not a
  // secret, so it gets a plain input and only the private half is masked.
  const [credential, setCredential] = useState("");
  const setField = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const pair = usesCredentialPair(kind);
  const valueReady = pair ? credential.length > 0 && value.length > 0 : value.length > 0;

  const nameValid = /^[a-z0-9][a-z0-9-]*$/.test(name);
  const err = create.error ?? rotate.error ?? del.error ?? grant.error ?? revoke.error;

  // Switching to a platform secret pre-fills the vendor-key recipe (the LLM key
  // is injected as `x-api-key`); switching back resets to the common case.
  const onScopeChange = (next: "global" | "platform") => {
    setScope(next);
    setKind(next === "platform" ? "header" : "header-bearer");
    setForm({
      ...EMPTY_INJECTION_FORM,
      ...(next === "platform" ? { headerName: "x-api-key" } : {}),
    });
    setCredential("");
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

      {secrets.isPending && (
        <Center py={60}>
          <Loader size="sm" />
        </Center>
      )}

      {secrets.isError && (
        <Hint icon="alert" tone="bad">
          Couldn't load secrets: {secrets.error.message}
        </Hint>
      )}

      {secrets.data && (
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
                  data={INJECTION_KINDS.map((k) => ({ value: k, label: INJECTION_LABELS[k] ?? k }))}
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
                  placeholder={INJECTION_DEFAULTS.headerName}
                  value={form.headerName}
                  onChange={(e) => setField("headerName", e.currentTarget.value)}
                  size="xs"
                />
              )}
              {kind === "query" && (
                <TextInput
                  label="Query parameter"
                  placeholder={INJECTION_DEFAULTS.queryParam}
                  value={form.queryParam}
                  onChange={(e) => setField("queryParam", e.currentTarget.value)}
                  size="xs"
                />
              )}
              {kind === "hmac-timestamp" && (
                <>
                  <Group grow align="flex-start">
                    <TextInput
                      label="Timestamp header"
                      placeholder={INJECTION_DEFAULTS.timestampHeader}
                      value={form.timestampHeader}
                      onChange={(e) => setField("timestampHeader", e.currentTarget.value)}
                      size="xs"
                    />
                    <TextInput
                      label="Authorization template"
                      placeholder={INJECTION_DEFAULTS.template}
                      value={form.template}
                      onChange={(e) => setField("template", e.currentTarget.value)}
                      size="xs"
                      classNames={{ input: "az-mono" }}
                    />
                  </Group>
                  <Hint icon="key" tone="neutral">
                    Egress signs the timestamp with the private key on every request and injects
                    both headers — the app never sees either. Use{" "}
                    <span className="az-mono">{"{credential}"}</span> and{" "}
                    <span className="az-mono">{"{signature}"}</span> in the template.
                  </Hint>
                </>
              )}
              {pair && (
                <TextInput
                  label="Public key"
                  placeholder="the public / credential half — sent in the clear on every request"
                  value={credential}
                  onChange={(e) => setCredential(e.currentTarget.value)}
                  size="xs"
                  classNames={{ input: "az-mono" }}
                />
              )}
              <PasswordInput
                label={pair ? "Private key" : "Value"}
                placeholder="paste the credential — stored sealed, never shown again"
                value={value}
                onChange={(e) => setValue(e.currentTarget.value)}
                size="xs"
              />
              <Group justify="flex-end">
                <Button
                  size="xs"
                  leftSection={<Icon name="key" size={12} />}
                  disabled={!nameValid || !valueReady}
                  loading={create.isPending}
                  onClick={() =>
                    create.mutate(
                      {
                        name,
                        value: pair ? packHmacValue(credential, value) : value,
                        injection: buildInjection(kind, form),
                        scope,
                      },
                      {
                        onSuccess: () => {
                          setName("");
                          setValue("");
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
            <ToneBadge tone={s.injection ? "neutral" : "bad"} icon={s.injection ? "key" : "alert"}>
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
          {/* An unreadable recipe can't be rotated — the server 409s — so don't
              offer it. Delete stays enabled: it is the documented recovery. */}
          <Button
            variant="default"
            size="compact-xs"
            disabled={!s.injection}
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
            description={
              s.injection?.kind === "hmac-timestamp"
                ? 'both halves as JSON: {"credential":"…","key":"…"}'
                : undefined
            }
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
