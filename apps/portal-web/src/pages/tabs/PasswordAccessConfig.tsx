import { useState } from "react";
import { Button, Code, Group, Stack, Text, TextInput } from "@mantine/core";
import { MIN_PASSWORD_LENGTH, type App } from "@azx-pbc/shared";
import { useQuery } from "@tanstack/react-query";
import { passwordCredentialQuery } from "../../api/queries";
import { useRotatePassword } from "../../api/mutations";
import { useAuth } from "../../auth/AuthProvider";
import { CopyBtn } from "../../components/primitives";

/**
 * The `password` state's own config panel in the Access tab's selector — the
 * type-specific half of shared-password access (minting/reverting the state is
 * the selector's confirm step; this manages the credential once it exists).
 * The cleartext credential is fetched from an authenticated endpoint — it never
 * rides the open app/manifest reads.
 *
 * Re-roll and manual set touch the credential, not visibility, so they stay
 * direct actions. The panel only renders while the app IS a password app.
 */
export function PasswordAccessConfig({ app, disabled }: { app: App; disabled?: boolean }) {
  const { allowPasswordApps } = useAuth();
  const rotate = useRotatePassword();
  const cred = useQuery(passwordCredentialQuery(app.slug));

  const [revealed, setRevealed] = useState(false);
  const [manual, setManual] = useState("");

  // Prefer the live query, but fall back to the just-rotated result so the
  // credential shows instantly after rotate (before the refetch).
  const credential = cred.data ?? rotate.data ?? null;
  const manualTooShort = manual.length > 0 && manual.length < MIN_PASSWORD_LENGTH;
  const error = cred.error ?? rotate.error;
  // The deployment has withdrawn password apps entirely (the tab's banner says
  // the app isn't being served): the owner can still see and copy the
  // credential to migrate away, but rotation offers nothing.
  const manageCredential = allowPasswordApps !== false;

  if (error) {
    return (
      <Text size="xs" c="red" mt={10}>
        {error.message}
      </Text>
    );
  }

  return (
    <Stack gap={14}>
      {/* App URL */}
      <div>
        <Text size="xs" c="dark.2" mb={5}>
          App URL
        </Text>
        <Group gap={8} wrap="nowrap">
          <Code style={{ flex: 1, overflowX: "auto", whiteSpace: "nowrap" }}>
            {credential?.url ?? `https://${app.slug}.…`}
          </Code>
          {credential && <CopyBtn value={credential.url} label="Copy" />}
        </Group>
      </div>

      {/* Password */}
      <div>
        <Text size="xs" c="dark.2" mb={5}>
          Password
        </Text>
        <Group gap={8} wrap="nowrap">
          <Code style={{ flex: 1, overflowX: "auto", whiteSpace: "nowrap" }}>
            {cred.isLoading && !credential
              ? "loading…"
              : credential
                ? revealed
                  ? credential.password
                  : "•".repeat(Math.max(12, credential.password.length))
                : "unavailable"}
          </Code>
          <Button
            variant="default"
            size="xs"
            disabled={disabled}
            onClick={() => setRevealed((r) => !r)}
          >
            {revealed ? "Hide" : "Show"}
          </Button>
          {credential && <CopyBtn value={credential.password} label="Copy" />}
        </Group>
      </div>

      {credential && manageCredential && (
        <Group gap={8}>
          <CopyBtn
            value={`URL: ${credential.url}\nPassword: ${credential.password}`}
            label="Copy URL + password"
          />
          <Button
            variant="default"
            size="xs"
            loading={rotate.isPending}
            disabled={disabled}
            onClick={() =>
              rotate.mutate({ slug: app.slug }, { onSuccess: () => setRevealed(true) })
            }
          >
            Re-roll
          </Button>
        </Group>
      )}

      {/* Manual set */}
      {manageCredential && (
        <Group gap={8} align="flex-end" wrap="nowrap">
          <TextInput
            label="Or set a password"
            placeholder={`at least ${MIN_PASSWORD_LENGTH} characters`}
            value={manual}
            onChange={(e) => setManual(e.currentTarget.value)}
            error={manualTooShort ? `Minimum ${MIN_PASSWORD_LENGTH} characters` : undefined}
            style={{ flex: 1 }}
            size="xs"
          />
          <Button
            variant="default"
            size="xs"
            disabled={disabled || manual.length < MIN_PASSWORD_LENGTH || rotate.isPending}
            loading={rotate.isPending}
            onClick={() =>
              rotate.mutate(
                { slug: app.slug, password: manual },
                {
                  onSuccess: () => {
                    setManual("");
                    setRevealed(true);
                  },
                },
              )
            }
          >
            Set
          </Button>
        </Group>
      )}
    </Stack>
  );
}
