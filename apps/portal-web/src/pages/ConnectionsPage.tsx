import { useEffect, useState } from "react";
import { Box, Button, Card, Center, Group, Loader, Stack, Text } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { MyConnection } from "@azx-pbc/shared";
import { myConnectionsQuery } from "../api/queries";
import { useDisconnectConnection } from "../api/mutations";
import { Icon } from "../components/Icon";
import { ConfirmDialog } from "../modals/ConfirmDialog";
import { Hint, PageHead, ToneBadge } from "../components/primitives";

/**
 * My Connections (`/connections`, I-02 T-0024) — the one user-scoped portal
 * surface. Every signed-in principal sees their own provider connections here
 * (criterion 42) and can disconnect one with confirmation (criteria 43, 45).
 *
 * The cards render Helix metadata only: the status line says what Helix knows
 * (Connected / Reconnect needed) and never claims the vendor grant was
 * verified. The refresh cadence is criterion 46's: page entry, after actions
 * (the mutation invalidates the query), an explicit Refresh, 30 s while
 * visible, paused while hidden, and a refetch on return. A failed refresh
 * keeps the last data with a polite stale indication; without prior data the
 * page shows an error, never an empty successful result.
 */

const ENV_LABEL: Record<MyConnection["env"], string> = { dev: "Dev", prod: "Prod" };

function statusBadge(status: MyConnection["status"]) {
  // Text label + icon + tone — never color alone.
  return status === "live" ? (
    <ToneBadge tone="live" icon="dot">
      Connected
    </ToneBadge>
  ) : (
    <ToneBadge tone="warn" icon="alert">
      Reconnect needed
    </ToneBadge>
  );
}

function ConnectionCard({
  connection,
  onDisconnect,
  busy,
}: {
  connection: MyConnection;
  onDisconnect: (c: MyConnection) => void;
  busy: boolean;
}) {
  return (
    <Card padding="lg" withBorder>
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
        <Stack gap={8} style={{ minWidth: 0 }}>
          <Group gap={10} wrap="nowrap">
            <Text fw={600} fz={15} truncate>
              {connection.providerDisplayName}
            </Text>
            <ToneBadge tone="slate">{ENV_LABEL[connection.env]}</ToneBadge>
            {statusBadge(connection.status)}
          </Group>
          <Text fz={12.5} c="dark.2">
            Connected {new Date(connection.grantedAt).toLocaleString()}
          </Text>
          {connection.grantedScopes.length > 0 && (
            <Group gap={6} wrap="wrap">
              {connection.grantedScopes.map((scope) => (
                <ToneBadge key={scope} tone="neutral">
                  {scope}
                </ToneBadge>
              ))}
            </Group>
          )}
        </Stack>
        <Button
          variant="default"
          color="red"
          leftSection={<Icon name="x" size={14} />}
          onClick={() => onDisconnect(connection)}
          disabled={busy}
        >
          Disconnect
        </Button>
      </Group>
    </Card>
  );
}

export function ConnectionsPage() {
  const queryClient = useQueryClient();
  // Criterion 46: 30 s while visible; TanStack pauses the interval while the
  // document is hidden (refetchIntervalInBackground defaults false), and the
  // effect below refetches when the tab becomes visible again.
  const connections = useQuery({
    ...myConnectionsQuery,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const disconnect = useDisconnectConnection();

  const [confirming, setConfirming] = useState<MyConnection | null>(null);
  // The live region is always mounted — an announcement inserted together
  // with its region is not reliably announced; a persistent empty one is.
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void queryClient.refetchQueries({ queryKey: ["connections", "mine"] });
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [queryClient]);

  const onConfirm = () => {
    if (!confirming) return;
    disconnect.mutate(
      { id: confirming.id },
      {
        onSuccess: (result) => {
          setConfirming(null);
          setAnnouncement(
            result.outcome === "already_removed"
              ? "Already removed — this connection was already disconnected."
              : `Disconnected — Helix access to ${confirming.providerDisplayName} has stopped.`,
          );
        },
        // On a failure the dialog stays open with the error: the outcome is
        // not confirmed, nothing is resubmitted automatically (criterion 44).
      },
    );
  };

  const head = (
    <PageHead
      eyebrow="Workspace"
      title="My Connections"
      sub="The provider connections you have granted from apps. Disconnecting ends Helix's access — it does not remove the authorization you gave the vendor."
      actions={
        <Button
          variant="default"
          leftSection={<Icon name="rotate" size={14} />}
          onClick={() => void connections.refetch()}
        >
          Refresh
        </Button>
      }
    />
  );

  const staleHint =
    connections.isError && connections.data ? (
      // Polite live region: a failed background refresh is announced without
      // moving focus, and the last loaded cards stay on screen.
      <Box role="status" mb={18}>
        <Hint icon="alert" tone="warn">
          Couldn't refresh — showing the last loaded connections ({connections.error.message}).
        </Hint>
      </Box>
    ) : null;

  let body;
  if (connections.isPending) {
    body = (
      <Center py={60}>
        <Loader size="sm" />
      </Center>
    );
  } else if (connections.isError && !connections.data) {
    // Without prior data a failure is an error — never an empty successful list.
    body = (
      <Hint icon="alert" tone="bad">
        Couldn't load your connections: {connections.error.message}
      </Hint>
    );
  } else {
    const list = connections.data?.connections ?? [];
    body =
      list.length === 0 ? (
        <Text c="dark.2" fz={13} py={8}>
          No connections yet — connect a provider from an app that uses it.
        </Text>
      ) : (
        <Stack gap={14}>
          {list.map((c) => (
            <ConnectionCard
              key={c.id}
              connection={c}
              onDisconnect={setConfirming}
              busy={disconnect.isPending}
            />
          ))}
        </Stack>
      );
  }

  return (
    <div className="az-stagger">
      {head}
      <Box role="status" mb={14} mih={0}>
        {announcement && <Text fz={13.5}>{announcement}</Text>}
      </Box>
      {staleHint}
      {body}

      <Box mt={18}>
        <Hint icon="shield" tone="info">
          Disconnect ends Helix's access for every app sharing the connection in that environment.
          It does not promise the vendor deauthorizes you, erases data, or cancels operations you
          already dispatched.
        </Hint>
      </Box>

      <ConfirmDialog
        opened={confirming !== null}
        icon="x"
        tone="var(--az-bad)"
        toneDim="var(--az-bad-dim)"
        title={
          confirming
            ? `Disconnect ${confirming.providerDisplayName} (${ENV_LABEL[confirming.env]})?`
            : ""
        }
        body={
          confirming ? (
            <Stack gap="sm">
              <Text size="sm">
                {confirming.sharedApps.length > 0
                  ? `This affects every app sharing the connection in ${ENV_LABEL[confirming.env]}: ${confirming.sharedApps
                      .map((a) => a.displayName)
                      .join(", ")}.`
                  : `No apps currently share this connection in ${ENV_LABEL[confirming.env]}.`}
              </Text>
              <Text size="sm">
                Helix access stops immediately. Vendor operations already dispatched may still
                finish.
              </Text>
              <Text size="sm">
                Vendor-side authorization remains — remove it at the vendor if you want it gone.
              </Text>
            </Stack>
          ) : (
            ""
          )
        }
        confirmLabel="Disconnect"
        confirmColor="red"
        loading={disconnect.isPending}
        error={disconnect.isError ? disconnect.error.message : null}
        onConfirm={onConfirm}
        onClose={() => setConfirming(null)}
      />
    </div>
  );
}
