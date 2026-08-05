import { useState } from "react";
import { Button, Card, Group, PasswordInput, Select, Stack, Text, TextInput } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { INJECTION_KINDS, type App } from "@azx-pbc/shared";
import {
  EMPTY_INJECTION_FORM,
  INJECTION_DEFAULTS,
  INJECTION_LABELS,
  buildInjection,
  describeInjection,
  packHmacValue,
  usesCredentialPair,
} from "../../lib/injection";
import { appSecretsQuery } from "../../api/queries";
import { useCreateSecret, useDeleteSecret, useRotateSecret } from "../../api/mutations";
import { useAuth } from "../../auth/AuthProvider";
import { Icon } from "../../components/Icon";
import { Eyebrow, Hint, ToneBadge } from "../../components/primitives";

/**
 * App-scoped connection secrets (secrets design §5). The owner stores third-party
 * credentials here so the app never holds them; a proxied origin then references
 * one by name (Fetch proxy block below). Write-only: the value is sent on
 * create/rotate and never shown again — there is no reveal, unlike the password.
 */

export function SecretsCard({ app }: { app: App }) {
  const { authenticated, login, loginAvailable } = useAuth();
  const secrets = useQuery({ ...appSecretsQuery(app.slug), enabled: authenticated });
  const create = useCreateSecret();
  const rotate = useRotateSecret();
  const del = useDeleteSecret();

  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [env, setEnv] = useState<"prod" | "dev">("prod");
  const [kind, setKind] = useState<string>("header-bearer");
  const [form, setForm] = useState({ ...EMPTY_INJECTION_FORM });
  // `hmac-timestamp` needs both halves of a key pair; the public half is not a
  // secret, so it gets a plain input and only the private half is masked.
  const [credential, setCredential] = useState("");
  const setField = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const pair = usesCredentialPair(kind);
  const valueReady = pair ? credential.length > 0 && value.length > 0 : value.length > 0;
  // Keyed by secret id — a name is no longer unique (it can exist per tier).
  const [rotating, setRotating] = useState<{ id: string; value: string } | null>(null);

  const mutationError = create.error ?? rotate.error ?? del.error;
  const nameValid = /^[a-z0-9][a-z0-9-]*$/.test(name);

  if (!authenticated) {
    return (
      <Card>
        <Eyebrow mb={4}>Connection secrets</Eyebrow>
        <Hint
          icon="user"
          tone="neutral"
          action={
            <Button variant="default" size="xs" onClick={login} disabled={!loginAvailable}>
              Sign in
            </Button>
          }
        >
          Managing connection secrets needs a signed-in actor.
        </Hint>
      </Card>
    );
  }

  return (
    <Card>
      <Eyebrow mb={4}>Connection secrets</Eyebrow>
      <Text size="sm" c="dark.2" mb={14} lh={1.5}>
        Third-party credentials the platform holds so your app never does. Reference one by name
        from a proxied origin below — the egress service injects it server-side. Write-only: a value
        is set or rotated, never shown again.
      </Text>

      <Stack gap={10} mb={16}>
        {/* Without this the card renders nothing at all on a load failure —
            `data` is undefined, so both branches below are falsy and even the
            empty state disappears. Mirrors SecretsPage. */}
        {secrets.isError && (
          <Hint icon="alert" tone="bad">
            Couldn&apos;t load secrets: {secrets.error.message}
          </Hint>
        )}
        {secrets.data?.length === 0 && (
          <Text size="xs" c="dark.2">
            No secrets yet.
          </Text>
        )}
        {secrets.data?.map((s) => (
          <Card key={s.id} withBorder padding="xs">
            <Group justify="space-between" wrap="nowrap">
              <div style={{ minWidth: 0 }}>
                <Group gap={8}>
                  <Text className="az-mono" fz={13} fw={600}>
                    {s.name}
                  </Text>
                  {s.env === "dev" && (
                    <ToneBadge tone="violet" icon="terminal">
                      dev
                    </ToneBadge>
                  )}
                  <ToneBadge
                    tone={s.injection ? "neutral" : "bad"}
                    icon={s.injection ? "key" : "alert"}
                  >
                    {describeInjection(s.injection)}
                  </ToneBadge>
                </Group>
                <Text size="xs" c="dark.2" mt={2}>
                  {s.lastUsedAt
                    ? `last used ${new Date(s.lastUsedAt).toLocaleString()}`
                    : "never used"}
                </Text>
              </div>
              <Group gap={6} wrap="nowrap">
                {/* An unreadable recipe can't be rotated — the server 409s — so
                    don't offer it. Delete stays enabled: it is the recovery. */}
                <Button
                  variant="default"
                  size="compact-xs"
                  disabled={!s.injection}
                  onClick={() =>
                    setRotating((r) => (r?.id === s.id ? null : { id: s.id, value: "" }))
                  }
                >
                  Rotate
                </Button>
                <Button
                  variant="subtle"
                  color="red"
                  size="compact-xs"
                  loading={del.isPending}
                  onClick={() => del.mutate({ slug: app.slug, name: s.name, env: s.env })}
                >
                  Delete
                </Button>
              </Group>
            </Group>
            {rotating?.id === s.id && (
              <Group gap={8} mt={10} align="flex-end" wrap="nowrap">
                <PasswordInput
                  label="New value"
                  description={
                    s.injection?.kind === "hmac-timestamp"
                      ? 'both halves as JSON: {"credential":"…","key":"…"}'
                      : undefined
                  }
                  value={rotating.value}
                  onChange={(e) => setRotating({ id: s.id, value: e.currentTarget.value })}
                  style={{ flex: 1 }}
                  size="xs"
                />
                <Button
                  size="xs"
                  disabled={!rotating.value}
                  loading={rotate.isPending}
                  onClick={() =>
                    rotate.mutate(
                      { slug: app.slug, name: s.name, value: rotating.value, env: s.env },
                      { onSuccess: () => setRotating(null) },
                    )
                  }
                >
                  Save
                </Button>
              </Group>
            )}
          </Card>
        ))}
      </Stack>

      <Eyebrow mb={8}>Add a secret</Eyebrow>
      <Stack gap={10}>
        <Group gap={8} grow>
          <TextInput
            label="Name"
            placeholder="e.g. github-pat"
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
          <Select
            label="Tier"
            description="dev = the env=dev partition"
            data={[
              { value: "prod", label: "prod" },
              { value: "dev", label: "dev" },
            ]}
            value={env}
            onChange={(v) => setEnv(v === "dev" ? "dev" : "prod")}
            size="xs"
            allowDeselect={false}
          />
        </Group>
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
              Egress signs the timestamp with the private key on every request and injects both
              headers — the app never sees either. Use{" "}
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
                  slug: app.slug,
                  name,
                  value: pair ? packHmacValue(credential, value) : value,
                  env,
                  injection: buildInjection(kind, form),
                },
                {
                  onSuccess: () => {
                    setName("");
                    setValue("");
                    setCredential("");
                    setForm({ ...EMPTY_INJECTION_FORM });
                    setKind("header-bearer");
                    setEnv("prod");
                  },
                },
              )
            }
          >
            Add secret
          </Button>
        </Group>
      </Stack>

      {mutationError && (
        <Text size="xs" c="red" mt={10}>
          {mutationError.message}
        </Text>
      )}
    </Card>
  );
}
