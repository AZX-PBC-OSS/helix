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
import { ProviderExportDocumentSchema, type ProviderMetadata } from "@azx-pbc/shared";
import { providersQuery } from "../../api/queries";
import { fetchText, PortalApiError } from "../../api/client";
import { CopyBtn } from "../../components/primitives";
import { downloadText } from "../../lib/download";
import { Icon } from "../../components/Icon";
import { Hint, PageHead, ToneBadge } from "../../components/primitives";
import { describeTokenPlacement } from "../../lib/providerForm";
import { ProviderImportCard } from "./ProviderImportCard";

/**
 * Provider administration list (`/admin/providers`, I-02 T-0026) — the
 * administrator's vendor OAuth registrations (spec §Provider administration).
 *
 * Refresh cadence (criterion 13): page entry, after every completed action
 * (each mutation invalidates the list key), the explicit Refresh, and every
 * 30 s while visible — paused while hidden, refreshed on return. A failed
 * refresh keeps the loaded rows with a polite stale indication; without prior
 * data the page shows an error, never an empty successful list.
 *
 * Import/export (I-02 T-0027): each card carries an Export action, and the
 * import card below the list holds the preview-first import flow.
 */

/**
 * The export download's filename convention, pinned: `<ref>.provider.json` —
 * one ref per file, and the name alone never confuses two environments' rows.
 */
const exportFilename = (ref: string): string => `${ref}.provider.json`;

const ENV_BADGE: Record<ProviderMetadata["env"], { label: string; tone: "info" | "warn" }> = {
  dev: { label: "DEV", tone: "info" },
  prod: { label: "PROD", tone: "warn" },
};

type EnvFilter = "all" | "dev" | "prod";

function ProviderCard({ provider: p }: { provider: ProviderMetadata }) {
  const env = ENV_BADGE[p.env];
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  /**
   * Export (criterion 11): an authorized read — a browser navigation carries no
   * bearer header, so the document comes back through fetchText and is handed
   * to the download seam as a Blob. The 200 body is verified to BE a provider
   * export before anything is saved: a drifted or partial read is surfaced as a
   * failed export, never a partial file. The document carries no credentials —
   * the API guarantees it and the strict schema parse re-checks it; the UI
   * neither reconstructs nor displays credential fields.
   */
  const exportProvider = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const { body } = await fetchText(`/api/v1/providers/${encodeURIComponent(p.id)}/export`);
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(body);
      } catch {
        setExportError(
          `Export failed for "${p.ref}" — the response was not JSON, so no file was downloaded.`,
        );
        return;
      }
      if (!ProviderExportDocumentSchema.safeParse(parsedBody).success) {
        setExportError(
          `Export failed for "${p.ref}" — the response was not a complete provider export, so no file was downloaded.`,
        );
        return;
      }
      downloadText(exportFilename(p.ref), body, "application/json");
    } catch (err) {
      setExportError(
        `Export failed for "${p.ref}"${
          err instanceof PortalApiError ? `: ${err.message}` : " — the read didn't complete"
        }. No file was downloaded.`,
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card padding="lg" withBorder>
      <Stack gap={10}>
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
          <Group gap={8} wrap="nowrap">
            <Button
              variant="default"
              size="compact-xs"
              leftSection={<Icon name="download" size={12} />}
              loading={exporting}
              onClick={() => void exportProvider()}
            >
              Export
            </Button>
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
        </Group>
        {exportError && (
          <Box role="alert">
            <Hint icon="alert" tone="bad">
              {exportError}
            </Hint>
          </Box>
        )}
      </Stack>
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
        <ProviderImportCard
          providers={list}
          refreshList={() => providers.refetch().then(() => {})}
        />
      </Box>
    </div>
  );
}
