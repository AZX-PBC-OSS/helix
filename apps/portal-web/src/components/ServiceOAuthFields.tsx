import { Alert, PasswordInput, Select, Stack, Text, TextInput } from "@mantine/core";
import {
  SERVICE_ACCOUNT_WARNING,
  ServiceOAuthCredentialSchema,
  type ServiceOAuthRecipe,
  type SecretMetadata,
} from "@azx-pbc/shared";

export { EMPTY_SERVICE_OAUTH } from "../lib/injection";

export function ServiceOAuthConfiguration({
  value,
  onChange,
}: {
  value: ServiceOAuthRecipe;
  onChange(value: ServiceOAuthRecipe): void;
}) {
  return (
    <Stack gap="xs">
      <Alert color="yellow">{SERVICE_ACCOUNT_WARNING}</Alert>
      <Text size="xs">
        Configuration is fixed after creation. Replace the secret and request approval to change it.
        Prefer client credentials when supported.
      </Text>
      <TextInput
        label="Token endpoint"
        value={value.tokenEndpoint}
        onChange={(e) => onChange({ ...value, tokenEndpoint: e.currentTarget.value })}
        placeholder="https://identity.example.com/oauth/token"
      />
      <Select
        label="Grant"
        value={value.grantType}
        allowDeselect={false}
        data={[
          { value: "client_credentials", label: "Client credentials" },
          { value: "password", label: "Password (legacy)" },
        ]}
        onChange={(grant) =>
          onChange({
            ...value,
            grantType: grant === "password" ? "password" : "client_credentials",
            clientAuthentication: grant === "password" ? "none" : "client_secret_basic",
          })
        }
      />
      {value.grantType === "password" && (
        <Text size="xs" c="orange">
          Legacy compatibility only. This grant requires storing the service account's password.
        </Text>
      )}
      <Select
        label="Client authentication"
        value={value.clientAuthentication}
        allowDeselect={false}
        data={[
          { value: "client_secret_basic", label: "Client secret in Basic header" },
          { value: "client_secret_post", label: "Client secret in form" },
          ...(value.grantType === "password"
            ? [{ value: "none", label: "No separate client authentication" }]
            : []),
        ]}
        onChange={(mode) =>
          onChange({
            ...value,
            clientAuthentication: mode as ServiceOAuthRecipe["clientAuthentication"],
          })
        }
      />
      <TextInput
        label="Required scopes"
        description="Space-separated; leave empty when the API needs none."
        value={value.scopes.join(" ")}
        onChange={(e) => onChange({ ...value, scopes: e.currentTarget.value.split(" ") })}
      />
      <TextInput
        label="Replay-safe POST paths"
        description="Optional, space-separated exact paths. Only include documented read-only operations; a rejected request can be sent twice. Maximum replay body: 256 KiB."
        value={value.replaySafePostPaths.join(" ")}
        onChange={(e) =>
          onChange({ ...value, replaySafePostPaths: e.currentTarget.value.split(" ") })
        }
      />
    </Stack>
  );
}

export function ServiceOAuthCredentials({
  recipe,
  value,
  onChange,
}: {
  recipe: ServiceOAuthRecipe;
  value: string;
  onChange(value: string): void;
}) {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    raw = {};
  }
  const parsed = ServiceOAuthCredentialSchema.safeParse(raw);
  const c = parsed.success ? parsed.data : { kind: "oauth-service-account" as const };
  const field = (name: "clientId" | "clientSecret" | "username" | "password", text: string) => {
    const next = { ...c, [name]: text || undefined };
    if (recipe.clientAuthentication === "none") delete next.clientSecret;
    if (recipe.grantType !== "password") {
      delete next.username;
      delete next.password;
    }
    onChange(JSON.stringify(next));
  };
  return (
    <Stack gap="xs" style={{ flex: 1 }}>
      <TextInput
        label={recipe.clientAuthentication === "none" ? "Client ID (optional)" : "Client ID"}
        value={c.clientId ?? ""}
        onChange={(e) => field("clientId", e.currentTarget.value)}
        autoComplete="off"
      />
      {recipe.clientAuthentication !== "none" && (
        <PasswordInput
          label="Client secret"
          value={c.clientSecret ?? ""}
          onChange={(e) => field("clientSecret", e.currentTarget.value)}
          autoComplete="new-password"
        />
      )}
      {recipe.grantType === "password" && (
        <>
          <TextInput
            label="Service account username"
            value={c.username ?? ""}
            onChange={(e) => field("username", e.currentTarget.value)}
            autoComplete="off"
          />
          <PasswordInput
            label="Service account password"
            value={c.password ?? ""}
            onChange={(e) => field("password", e.currentTarget.value)}
            autoComplete="new-password"
          />
        </>
      )}
    </Stack>
  );
}

export function ServiceOAuthDetails({
  recipe,
  status,
}: {
  recipe: ServiceOAuthRecipe;
  status?: SecretMetadata["oauthStatus"];
}) {
  return (
    <Stack gap={4} mt="xs">
      <Text size="xs">{SERVICE_ACCOUNT_WARNING}</Text>
      <Text size="xs">Token endpoint: {recipe.tokenEndpoint}</Text>
      <Text size="xs">
        Grant: {recipe.grantType === "password" ? "Password (legacy)" : "Client credentials"} ·
        Client authentication: {recipe.clientAuthentication}
      </Text>
      <Text size="xs">Required scopes: {recipe.scopes.join(", ") || "None configured"}</Text>
      <Text size="xs">
        Replay-safe POST paths: {recipe.replaySafePostPaths.join(", ") || "None"}
      </Text>
      {status && (
        <Text size="xs">
          Status: {status.status.replaceAll("_", " ")}
          {status.retryAfter
            ? ` · Retry after ${new Date(status.retryAfter).toLocaleString()}`
            : ""}
          .{" "}
          {status.status === "needs_attention"
            ? "Rotate the credentials to retry. Configuration changes require replacement and approval."
            : "Status reflects observed use."}
        </Text>
      )}
    </Stack>
  );
}
