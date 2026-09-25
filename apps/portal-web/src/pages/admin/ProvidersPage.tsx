import { useEffect, useState } from "react";
import {
  Anchor,
  Box,
  Button,
  Card,
  Center,
  Group,
  Loader,
  SegmentedControl,
  Stack,
  Text,
} from "@mantine/core";
import { Link, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProviderMetadata } from "@azx-pbc/shared";
import { providersQuery } from "../../api/queries";
import { CopyBtn } from "../../components/primitives";
import { Icon } from "../../components/Icon";
import { Eyebrow, Hint, PageHead, ToneBadge } from "../../components/primitives";
import { describeTokenPlacement } from "../../lib/providerForm";

/**
 * Provider administration list (`/admin/providers`, I-02 T-0026) — the
 * administrator's vendor OAuth registrations (spec §Provider administration).
 *
 * Refresh cadence (criterion 13): page entry, after every completed action
 * (each mutation invalidates the list key), the explicit Refresh, and every
 * 30 s while visible — paused while hidden, refreshed on return. A failed
 * refresh keeps the loaded rows with a polite stale indication; without prior
 * data the page shows an error, never an empty successful list.
 */

const ENV_BADGE: Record<ProviderMetadata["env"], { label: string; tone: "info" | "warn" }> = {
  dev: { label: "DEV", tone: "info" },
  prod: { label: "PROD", tone: "warn" },
};

type EnvFilter = "all" | "dev" | "prod";

function ProviderCard({ provider: p }: { provider: ProviderMetadata }) {
  const env = ENV_BADGE[p.env];
  return (
    <Card padding="lg" withBorder>
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
        <Stack gap={6} style={{ minWidth: 0 }}>
          <Group gap={8} wrap="wrap">
            <Text className="az-mono" fz={14} fw={600}>
              {p.ref}
            </Text>
            <ToneBadge tone={env.tone} icon="dot">
              {env.label}
            </ToneBadge>
            <ToneBadge tone="slate">{p.kind}</ToneBadge>
          </Group>
          <Text fw={500} fz={13.5} truncate>
            {p.displayName}
          </Text>
          <Text fz={12} c="dark.2" style={{ wordBreak: "break-word" }}>
            {p.apiOrigins.join(", ")} · {describeTokenPlacement(p.tokenPlacement)}
            {p.requestedScopes.length > 0 &&
              ` · ${p.requestedScopes.length} permission${p.requestedScopes.length === 1 ? "" : "s"}`}
          </Text>
          <Text fz={11.5} c="dark.3">
            Updated {new Date(p.updatedAt).toLocaleString()} · revision {p.revision}
          </Text>
        </Stack>
        <Button
          component={Link}
          to={`/admin/providers/${p.id}`}
          variant="default"
          size="compact-xs"
          leftSection={<Icon name="chevR" size={12} />}
        >
          Edit
        </Button>
      </Group>
    </Card>
  );
}

/**
 * The import card's mount point — the import UI itself (file picker → preview
 * → apply) is T-0027's; this stub holds the card's place so the page layout
 * and its tests don't move when it lands.
 */
function ImportCardStub() {
  return (
    <Card padding="lg" withBorder>
      <Eyebrow mb={8}>Import</Eyebrow>
      <Text fz={12.5} c="dark.2">
        Bring a provider's credential-free JSON into this deployment — preview it, choose create or
        update, then apply.
      </Text>
      <Group mt={10}>
        <Button size="xs" variant="default" disabled>
          Import from JSON
        </Button>
        <Text fz={11.5} c="dark.3">
          Not available yet — the import flow lands in an upcoming release.
        </Text>
      </Group>
    </Card>
  );
}

export function ProvidersPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Criterion 13: 30 s while visible; TanStack pauses the interval while the
  // document is hidden (refetchIntervalInBackground defaults false), and the
  // effect below refetches when the tab becomes visible again.
  const providers = useQuery({
    ...providersQuery,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  const [envFilter, setEnvFilter] = useState<EnvFilter>("all");

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void queryClient.refetchQueries({ queryKey: ["providers", "list"] });
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [queryClient]);

  const list = providers.data?.providers ?? [];
  const filtered = envFilter === "all" ? list : list.filter((p) => p.env === envFilter);
  const callbackUrl = providers.data?.callbackUrl;

  const staleHint =
    providers.isError && providers.data ? (
      // Polite live region: a failed background refresh is announced without
      // moving focus, and the last loaded rows stay on screen.
      <Box role="status" mb={18}>
        <Hint
          icon="alert"
          tone="warn"
          action={
            <Button size="compact-xs" variant="default" onClick={() => void providers.refetch()}>
              Retry
            </Button>
          }
        >
          Couldn't refresh — showing providers as of{" "}
          {new Date(providers.dataUpdatedAt).toLocaleString()} ({providers.error.message}).
        </Hint>
      </Box>
    ) : null;

  let body;
  if (providers.isPending) {
    body = (
      <Center py={60}>
        <Loader size="sm" />
      </Center>
    );
  } else if (providers.isError && !providers.data) {
    // Without prior data a failure is an error — never an empty successful list.
    body = (
      <Hint
        icon="alert"
        tone="bad"
        action={
          <Button size="compact-xs" variant="default" onClick={() => void providers.refetch()}>
            Retry
          </Button>
        }
      >
        Couldn't load providers: {providers.error.message}
      </Hint>
    );
  } else if (filtered.length === 0 && envFilter === "all") {
    body = (
      <Text c="dark.2" fz={13} py={8}>
        No providers yet — create one to let apps connect vendor accounts.
      </Text>
    );
  } else if (filtered.length === 0) {
    body = (
      <Text c="dark.2" fz={13} py={8}>
        No providers in this environment.
      </Text>
    );
  } else {
    body = (
      <Stack gap={14}>
        {filtered.map((p) => (
          <ProviderCard key={p.id} provider={p} />
        ))}
      </Stack>
    );
  }

  return (
    <div className="az-stagger">
      <PageHead
        eyebrow="Admin"
        title="Providers"
        sub="Vendor OAuth registrations apps connect through. Changes take effect without a Helix redeploy — vendor registration stays an out-of-band task."
        actions={
          <Group gap={10}>
            <Button
              variant="default"
              leftSection={<Icon name="rotate" size={14} />}
              onClick={() => void providers.refetch()}
            >
              Refresh
            </Button>
            <Button
              leftSection={<Icon name="plus" size={14} />}
              onClick={() => navigate("/admin/providers/new")}
            >
              New provider
            </Button>
          </Group>
        }
      />

      {/* The fixed OAuth callback (criterion 2) — served at runtime beside the
          rows, never a build-time variable; the administrator registers this
          exact value with the vendor. */}
      {callbackUrl && (
        <Box mb={18}>
          <Hint
            icon="globe"
            tone="info"
            action={<CopyBtn value={callbackUrl} label="Copy callback URL" />}
          >
            Vendor callback URL:{" "}
            <span className="az-mono" style={{ wordBreak: "break-all" }}>
              {callbackUrl}
            </span>{" "}
            — register this exact value with the vendor.
          </Hint>
        </Box>
      )}

      {staleHint}

      {/* The env filter wraps above the list (design.md §Responsive Behavior). */}
      <Group justify="space-between" align="center" mb={16} wrap="wrap" gap="md">
        <SegmentedControl
          aria-label="Filter by environment"
          size="xs"
          data={[
            { value: "all", label: "All" },
            { value: "dev", label: "Dev" },
            { value: "prod", label: "Prod" },
          ]}
          value={envFilter}
          onChange={(v) => setEnvFilter((v as EnvFilter) ?? "all")}
        />
        <Anchor component={Link} to="/admin/providers/new" fz={12.5}>
          Create a provider
        </Anchor>
      </Group>

      {body}

      <Box mt={18}>
        <ImportCardStub />
      </Box>
    </div>
  );
}
