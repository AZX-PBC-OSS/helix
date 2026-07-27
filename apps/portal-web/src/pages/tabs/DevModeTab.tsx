import { useState } from "react";
import { Box, Button, Card, Code, CopyButton, Group, Stack, TagsInput, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { isValidDevOrigin, type App, type DevTokenMetadata } from "@azx-pbc/shared";
import { devTokensQuery } from "../../api/queries";
import { useMintDevToken, useRevokeDevToken, useRotateDevToken } from "../../api/mutations";
import { useAuth } from "../../auth/AuthProvider";
import { useDeployment } from "../../lib/deployment";
import { Icon } from "../../components/Icon";
import { Eyebrow, Hint, ToneBadge } from "../../components/primitives";
import { ConfirmDialog } from "../../modals/ConfirmDialog";

/**
 * Dev mode — the control-plane surface for developing an app against its env=dev
 * partition from a foreign origin (Lovable, a cloud IDE). The owner registers the
 * exact origins a token may be used from and mints a scoped bearer; the token is
 * shown ONCE (stored only as a hash) and carried by the dev-gateway later. Rotate
 * re-rolls the secret; revoke is immediate. `env=dev` is implicit — a dev token
 * can never reach production data or the live budget (dev-mode design §4, §10).
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

function statusBadge(t: DevTokenMetadata) {
  if (t.revokedAt)
    return (
      <ToneBadge tone="bad" icon="x">
        revoked
      </ToneBadge>
    );
  if (new Date(t.expiresAt).getTime() <= Date.now())
    return (
      <ToneBadge tone="slate" icon="clock">
        expired
      </ToneBadge>
    );
  return (
    <ToneBadge tone="live" icon="check">
      active
    </ToneBadge>
  );
}

export function DevModeTab({ app }: { app: App }) {
  const { authenticated, login, loginAvailable } = useAuth();
  const { devApiBaseUrl } = useDeployment();
  const tokens = useQuery({ ...devTokensQuery(app.slug), enabled: authenticated });
  const mint = useMintDevToken();
  const rotate = useRotateDevToken();
  const revoke = useRevokeDevToken();

  const [origins, setOrigins] = useState<string[]>([]);
  // The plaintext token from the most recent mint/rotate — shown once, in memory only.
  const [minted, setMinted] = useState<{ id: string; token: string } | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [revoking, setRevoking] = useState<DevTokenMetadata | null>(null);

  const devApiBase = devApiBaseUrl(app.slug);
  const invalidOrigins = origins.filter((o) => !isValidDevOrigin(o));
  const canMint = origins.length > 0 && invalidOrigins.length === 0;
  const mutationError = mint.error ?? rotate.error ?? revoke.error;

  if (!authenticated) {
    return (
      <Card>
        <Eyebrow mb={4}>Dev mode</Eyebrow>
        <Hint
          icon="user"
          tone="neutral"
          action={
            <Button variant="default" size="xs" onClick={login} disabled={!loginAvailable}>
              Sign in
            </Button>
          }
        >
          Managing dev tokens needs a signed-in actor.
        </Hint>
      </Card>
    );
  }

  return (
    <Card>
      <Eyebrow mb={4}>Dev mode</Eyebrow>
      <Text size="sm" c="dark.2" mb={14} lh={1.5}>
        Develop against this app's isolated <Code>env=dev</Code> partition from a cloud IDE or
        localhost. Register the exact origins your dev environment loads from, mint a token, and
        paste it into your app's config. A dev token only ever reaches dev data and the dev budget —
        never production.
      </Text>

      {/* The dev-gateway base URL — not a secret, so shown persistently (the app
          slug is in the path, the host is fixed). Append /_api/llm/chat,
          /_api/data/*, /_api/fetch/<url>.

          The dev gateway is an opt-in deployment (deployDevGateway in the Bicep),
          so its base can be absent: say so rather than print an unreachable host
          that would fail at request time with no explanation. */}
      <Eyebrow mb={4}>API base URL</Eyebrow>
      {devApiBase ? (
        <>
          <Text size="xs" c="dark.2" mb={6} lh={1.5}>
            Point your app's Helix calls here (append <Code>/_api/llm/chat</Code>,{" "}
            <Code>/_api/data/…</Code>, <Code>/_api/fetch/…</Code>) and send your dev token as a
            bearer.
          </Text>
          <Group gap={8} wrap="nowrap" mb={18}>
            <Code style={{ flex: 1, overflowX: "auto", whiteSpace: "nowrap" }}>{devApiBase}</Code>
            <CopyBtn value={devApiBase} label="Copy" />
          </Group>
        </>
      ) : (
        <Box mb={18}>
          <Hint tone="slate" icon="alert">
            The dev gateway isn&apos;t enabled on this deployment, so there&apos;s no cross-origin
            API base to point a dev environment at. Tokens minted here still work once an operator
            deploys it.
          </Hint>
        </Box>
      )}

      {/* Just-minted token — shown once, never retrievable again. */}
      {minted && (
        <Card withBorder mb={16} style={{ borderColor: "var(--az-warn)" }}>
          <Group justify="space-between" mb={6}>
            <Eyebrow>New dev token</Eyebrow>
            <ToneBadge tone="warn" icon="alert">
              copy now — shown once
            </ToneBadge>
          </Group>
          <Group gap={8} wrap="nowrap">
            <Code style={{ flex: 1, overflowX: "auto", whiteSpace: "nowrap" }}>
              {revealed ? minted.token : "•".repeat(40)}
            </Code>
            <Button variant="default" size="xs" onClick={() => setRevealed((r) => !r)}>
              {revealed ? "Hide" : "Show"}
            </Button>
            <CopyBtn value={minted.token} label="Copy" />
          </Group>
          <Button
            variant="subtle"
            size="compact-xs"
            mt={8}
            onClick={() => {
              setMinted(null);
              setRevealed(false);
            }}
          >
            Done
          </Button>
        </Card>
      )}

      {/* Mint form */}
      <Stack gap={10} mb={18}>
        <TagsInput
          label="Allowed origins"
          description="Exact origins your dev environment loads from — e.g. https://myapp.lovable.app, http://localhost:5173. No paths or wildcards."
          placeholder="add origin"
          value={origins}
          onChange={setOrigins}
          error={
            invalidOrigins.length > 0
              ? `Not an exact origin: ${invalidOrigins.join(", ")}`
              : undefined
          }
          classNames={{ input: "az-mono" }}
        />
        <Group justify="flex-end">
          <Button
            size="xs"
            leftSection={<Icon name="bolt" size={12} />}
            disabled={!canMint}
            loading={mint.isPending}
            onClick={() =>
              mint.mutate(
                { slug: app.slug, origins },
                {
                  onSuccess: (res) => {
                    setMinted({ id: res.metadata.id, token: res.token });
                    setRevealed(true);
                    setOrigins([]);
                  },
                },
              )
            }
          >
            Mint dev token
          </Button>
        </Group>
      </Stack>

      {/* Existing tokens */}
      <Eyebrow mb={8}>Tokens</Eyebrow>
      <Stack gap={10}>
        {tokens.data?.length === 0 && (
          <Text size="xs" c="dark.2">
            No dev tokens yet.
          </Text>
        )}
        {tokens.data?.map((t) => (
          <Card key={t.id} withBorder padding="xs">
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <div style={{ minWidth: 0 }}>
                <Group gap={8}>
                  <Text className="az-mono" fz={13} fw={600}>
                    {t.id.slice(0, 8)}
                  </Text>
                  {statusBadge(t)}
                </Group>
                <Text
                  className="az-mono"
                  fz={12}
                  c="dark.2"
                  mt={4}
                  style={{ wordBreak: "break-all" }}
                >
                  {t.origins.join(", ")}
                </Text>
                <Text size="xs" c="dark.2" mt={2}>
                  by {t.developerOid} · expires {new Date(t.expiresAt).toLocaleString()}
                </Text>
              </div>
              <Group gap={6} wrap="nowrap">
                {!t.revokedAt && (
                  <Button
                    variant="default"
                    size="compact-xs"
                    loading={rotate.isPending}
                    onClick={() =>
                      rotate.mutate(
                        { slug: app.slug, id: t.id },
                        {
                          onSuccess: (res) => {
                            setMinted({ id: res.metadata.id, token: res.token });
                            setRevealed(true);
                          },
                        },
                      )
                    }
                  >
                    Rotate
                  </Button>
                )}
                {!t.revokedAt && (
                  <Button
                    variant="subtle"
                    color="red"
                    size="compact-xs"
                    onClick={() => setRevoking(t)}
                  >
                    Revoke
                  </Button>
                )}
              </Group>
            </Group>
          </Card>
        ))}
      </Stack>

      {mutationError && (
        <Text size="xs" c="red" mt={10}>
          {mutationError.message}
        </Text>
      )}

      <ConfirmDialog
        opened={revoking !== null}
        icon="x"
        tone="var(--az-bad)"
        toneDim="var(--az-bad-dim)"
        title="Revoke this dev token?"
        body="It stops working immediately — any dev environment using it gets 401 on its next request. This can't be undone; mint a new token to continue."
        confirmLabel="Revoke"
        confirmColor="red"
        loading={revoke.isPending}
        error={revoke.isError ? revoke.error.message : null}
        onConfirm={() => {
          if (revoking) {
            revoke.mutate(
              { slug: app.slug, id: revoking.id },
              { onSuccess: () => setRevoking(null) },
            );
          }
        }}
        onClose={() => setRevoking(null)}
      />
    </Card>
  );
}
