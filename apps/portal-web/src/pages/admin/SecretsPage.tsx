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
import { INJECTION_KINDS, type InjectionRecipe } from "@helix/shared";
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
 * Global connection secrets (secrets design §5) — the admin-only half. Shared
 * across apps via grants; the app-scoped half lives on each app's Capabilities
 * tab. Write-only: a value is set/rotated, never shown again.
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

  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [kind, setKind] = useState("header-bearer");
  const [headerName, setHeaderName] = useState("");
  const [queryParam, setQueryParam] = useState("");
  const [rotating, setRotating] = useState<{ id: string; value: string } | null>(null);
  const [granting, setGranting] = useState<{ id: string; slug: string } | null>(null);

  const nameValid = /^[a-z0-9][a-z0-9-]*$/.test(name);
  const err = create.error ?? rotate.error ?? del.error ?? grant.error ?? revoke.error;

  return (
    <div className="az-stagger">
      <PageHead
        eyebrow="Control plane · admin"
        title="Secrets"
        sub="Global connection secrets the platform holds so apps never do — shared across apps via grants and injected server-side by the egress plane. Write-only; values are never shown again."
      />

      {!authenticated && (
        <Card py={48} style={{ textAlign: "center" }}>
          <Stack align="center" gap={10}>
            <Text c="dark.2" size="sm">
              Sign in as a platform admin to manage global secrets.
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
            <Eyebrow mb={10}>Create a global secret</Eyebrow>
            <Stack gap={10}>
              <Group gap={8} grow>
                <TextInput
                  label="Name"
                  placeholder="e.g. stripe-live"
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
                      { name, value, injection: buildInjection(kind, headerName, queryParam) },
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
                  Create secret
                </Button>
              </Group>
            </Stack>
          </Card>

          {secrets.data.length === 0 && (
            <Text size="sm" c="dark.2">
              No global secrets yet.
            </Text>
          )}

          {secrets.data.map((s) => (
            <Card key={s.id}>
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
                    {s.lastUsedAt
                      ? `last used ${new Date(s.lastUsedAt).toLocaleString()}`
                      : "never used"}{" "}
                    · created by {s.createdBy}
                  </Text>
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
                </div>
                <Group gap={6} wrap="nowrap">
                  <Button
                    variant="default"
                    size="compact-xs"
                    onClick={() =>
                      setGranting((g) => (g?.id === s.id ? null : { id: s.id, slug: "" }))
                    }
                  >
                    Grant
                  </Button>
                  <Button
                    variant="default"
                    size="compact-xs"
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
                    onClick={() => del.mutate({ id: s.id })}
                  >
                    Delete
                  </Button>
                </Group>
              </Group>

              {granting?.id === s.id && (
                <Group gap={8} mt={12} align="flex-end" wrap="nowrap">
                  <TextInput
                    label="Grant to app (slug)"
                    placeholder="acme-dashboard"
                    value={granting.slug}
                    onChange={(e) => setGranting({ id: s.id, slug: e.currentTarget.value })}
                    style={{ flex: 1 }}
                    size="xs"
                    classNames={{ input: "az-mono" }}
                  />
                  <Button
                    size="xs"
                    disabled={!granting.slug}
                    loading={grant.isPending}
                    onClick={() =>
                      grant.mutate(
                        { id: s.id, appSlug: granting.slug },
                        { onSuccess: () => setGranting(null) },
                      )
                    }
                  >
                    Grant
                  </Button>
                </Group>
              )}

              {rotating?.id === s.id && (
                <Group gap={8} mt={12} align="flex-end" wrap="nowrap">
                  <PasswordInput
                    label="New value"
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
                        { id: s.id, value: rotating.value },
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
