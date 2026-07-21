import { useState } from "react";
import { Button, Card, Code, CopyButton, Group, Stack, Text, TextInput } from "@mantine/core";
import { MIN_PASSWORD_LENGTH, type App } from "@azx-pbc/shared";
import { useQuery } from "@tanstack/react-query";
import { passwordCredentialQuery } from "../../api/queries";
import { useDisablePassword, useEnablePassword, useRotatePassword } from "../../api/mutations";
import { useAuth } from "../../auth/AuthProvider";
import { Icon } from "../../components/Icon";
import { Eyebrow, Hint } from "../../components/primitives";

/**
 * Shared-password access management (`password` visibility). Owners enable it,
 * copy the URL + passphrase to hand out for external demos, reroll or set a
 * manual one, and disable it. The cleartext credential is fetched from an
 * authenticated endpoint — it never rides the open app/manifest reads.
 */

function CopyBtn({ value, label }: { value: string; label: string }) {
  return (
    <CopyButton value={value}>
      {({ copied, copy }) => (
        <Button
          variant="default"
          size="xs"
          onClick={copy}
          leftSection={<Icon name={copied ? "check" : "copy"} size={12} />}
        >
          {copied ? "Copied" : label}
        </Button>
      )}
    </CopyButton>
  );
}

export function PasswordAccessCard({ app }: { app: App }) {
  const { authenticated, login, loginAvailable, allowPasswordApps } = useAuth();
  const isPassword = app.visibility.mode === "password";

  const enable = useEnablePassword();
  const rotate = useRotatePassword();
  const disable = useDisablePassword();
  const cred = useQuery({
    ...passwordCredentialQuery(app.slug),
    enabled: authenticated && isPassword,
  });

  const [revealed, setRevealed] = useState(false);
  const [manual, setManual] = useState("");

  // Prefer the live query, but fall back to a just-returned mutation result so
  // the credential shows instantly after enable/rotate (before the refetch).
  const credential = cred.data ?? rotate.data ?? enable.data ?? null;
  const busy = enable.isPending || rotate.isPending || disable.isPending;
  const mutationError = enable.error ?? rotate.error ?? disable.error;
  const manualTooShort = manual.length > 0 && manual.length < MIN_PASSWORD_LENGTH;

  // Operator policy: when password apps are forbidden, hide the card entirely
  // for a non-password app (nothing to offer). An app already on password keeps
  // the card so the owner can migrate away — but only the Disable action, not
  // re-roll/set (which would keep it a password app the edge won't serve).
  if (!allowPasswordApps && !isPassword) return null;

  if (!authenticated) {
    return (
      <Card>
        <Eyebrow mb={4}>Shared password access</Eyebrow>
        <Text size="sm" c="dark.2" mb={14} lh={1.5}>
          A single shared password for external demos — hand out the URL and password, no SSO
          required. Each visitor gets a pseudonymous, isolated session.
        </Text>
        <Hint
          icon="user"
          tone="neutral"
          action={
            <Button variant="default" size="xs" onClick={login} disabled={!loginAvailable}>
              Sign in
            </Button>
          }
        >
          Managing access needs a signed-in actor.
        </Hint>
      </Card>
    );
  }

  return (
    <Card>
      <Group justify="space-between" mb={4}>
        <Eyebrow>Shared password access</Eyebrow>
        {isPassword && (
          <Button
            variant="subtle"
            color="red"
            size="compact-xs"
            loading={disable.isPending}
            onClick={() => disable.mutate({ slug: app.slug })}
          >
            Disable
          </Button>
        )}
      </Group>

      {!isPassword ? (
        <>
          <Text size="sm" c="dark.2" mb={14} lh={1.5}>
            Put a single shared password on the app for external demos — give out the URL and
            password (e.g. at a conference) without making the app public. Each visitor gets a
            pseudonymous, isolated session.
          </Text>
          <Button
            leftSection={<Icon name="key" size={14} />}
            loading={enable.isPending}
            onClick={() =>
              enable.mutate({ slug: app.slug }, { onSuccess: () => setRevealed(true) })
            }
          >
            Enable password access
          </Button>
        </>
      ) : (
        <Stack gap={14}>
          {allowPasswordApps ? (
            <Text size="sm" c="dark.2" lh={1.5}>
              Anyone with this URL and password can open the app. Re-roll if it leaks.
            </Text>
          ) : (
            <Hint icon="shield" tone="bad">
              Password apps are disabled on this deployment — the edge is refusing to serve this
              one. Disable password access to revert to private.
            </Hint>
          )}

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
              <Button variant="default" size="xs" onClick={() => setRevealed((r) => !r)}>
                {revealed ? "Hide" : "Show"}
              </Button>
              {credential && <CopyBtn value={credential.password} label="Copy" />}
            </Group>
          </div>

          {credential && (
            <Group gap={8}>
              <CopyBtn
                value={`URL: ${credential.url}\nPassword: ${credential.password}`}
                label="Copy URL + password"
              />
              {allowPasswordApps && (
                <Button
                  variant="default"
                  size="xs"
                  leftSection={<Icon name="rotate" size={12} />}
                  loading={rotate.isPending}
                  onClick={() =>
                    rotate.mutate({ slug: app.slug }, { onSuccess: () => setRevealed(true) })
                  }
                >
                  Re-roll
                </Button>
              )}
            </Group>
          )}

          {/* Manual set */}
          {allowPasswordApps && (
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
                disabled={manual.length < MIN_PASSWORD_LENGTH || busy}
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
      )}

      {mutationError && (
        <Text size="xs" c="red" mt={10}>
          {mutationError.message}
        </Text>
      )}
    </Card>
  );
}
