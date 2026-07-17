import { useState } from "react";
import { Button, Card, Group, PasswordInput, Select, Stack, Text, TextInput } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { INJECTION_KINDS, type App, type InjectionRecipe } from "@azx-pbc/shared";
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

export function SecretsCard({ app }: { app: App }) {
  const { authenticated, login, loginAvailable } = useAuth();
  const secrets = useQuery({ ...appSecretsQuery(app.slug), enabled: authenticated });
  const create = useCreateSecret();
  const rotate = useRotateSecret();
  const del = useDeleteSecret();

  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [kind, setKind] = useState<string>("header-bearer");
  const [headerName, setHeaderName] = useState("");
  const [queryParam, setQueryParam] = useState("");
  const [rotating, setRotating] = useState<{ name: string; value: string } | null>(null);

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
                  <ToneBadge tone="neutral" icon="key">
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
                <Button
                  variant="default"
                  size="compact-xs"
                  onClick={() =>
                    setRotating((r) => (r?.name === s.name ? null : { name: s.name, value: "" }))
                  }
                >
                  Rotate
                </Button>
                <Button
                  variant="subtle"
                  color="red"
                  size="compact-xs"
                  loading={del.isPending}
                  onClick={() => del.mutate({ slug: app.slug, name: s.name })}
                >
                  Delete
                </Button>
              </Group>
            </Group>
            {rotating?.name === s.name && (
              <Group gap={8} mt={10} align="flex-end" wrap="nowrap">
                <PasswordInput
                  label="New value"
                  value={rotating.value}
                  onChange={(e) => setRotating({ name: s.name, value: e.currentTarget.value })}
                  style={{ flex: 1 }}
                  size="xs"
                />
                <Button
                  size="xs"
                  disabled={!rotating.value}
                  loading={rotate.isPending}
                  onClick={() =>
                    rotate.mutate(
                      { slug: app.slug, name: s.name, value: rotating.value },
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
            data={INJECTION_KINDS.map((k) => ({ value: k, label: k }))}
            value={kind}
            onChange={(v) => setKind(v ?? "header-bearer")}
            size="xs"
            allowDeselect={false}
          />
        </Group>
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
                  slug: app.slug,
                  name,
                  value,
                  injection: buildInjection(kind, headerName, queryParam),
                },
                {
                  onSuccess: () => {
                    setName("");
                    setValue("");
                    setHeaderName("");
                    setQueryParam("");
                    setKind("header-bearer");
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
