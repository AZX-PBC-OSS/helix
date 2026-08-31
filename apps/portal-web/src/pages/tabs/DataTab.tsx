import { Fragment, useMemo, useState } from "react";
import {
  ActionIcon,
  Box,
  Button,
  Card,
  Center,
  Code,
  Group,
  Loader,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import {
  collectionRowCells,
  columnHeader,
  deriveCollectionColumns,
  type App,
  type CollectionItem,
} from "@azx-pbc/shared";
import { collectionItemsQuery, collectionsIndexQuery, manifestQuery } from "../../api/queries";
import { useDeleteCollectionItem } from "../../api/mutations";
import { useAuth } from "../../auth/AuthProvider";
import { Eyebrow, Hint, Principal, ToneBadge } from "../../components/primitives";
import { Icon } from "../../components/Icon";
import { ScrollFade } from "../../components/ScrollFade";
import { ConfirmDialog } from "../../modals/ConfirmDialog";
import { fetchText } from "../../api/client";
import { downloadText } from "../../lib/download";
import { fmtCount, principalLabel, timeAgo } from "../../lib/format";

/**
 * The owner's read side of a write-only collection (app-data design §3.2).
 *
 * The app that gathered these rows cannot read them back — that asymmetry is the
 * whole point of the scope — so this tab is the only place the data surfaces.
 * Columns are *derived* from the rows, because `item` is opaque app-supplied JSON
 * with no declared schema (§9); the derivation lives in `@azx-pbc/shared` so the
 * CSV export applies the same rules. Note it derives from the rows on screen while
 * the export derives from up to 10,000, so the two column sets can differ.
 */

const ROW_LIMIT = 200;
/** A single collected value can be 64 KB; a whole cell of it would wreck the row. */
const CELL_CHARS = 200;

type EnvView = "all" | "prod" | "dev";
type ExportFormat = "csv" | "json";

export function DataTab({ app }: { app: App }) {
  const { authenticated, login, loginAvailable } = useAuth();
  // Prod by default: dev-mode submissions are the developer's own test traffic and
  // must not read as real leads. The API returns both tiers when unfiltered — the
  // narrowing is presentation, and the hint below keeps it from hiding anything.
  const [envView, setEnvView] = useState<EnvView>("prod");
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CollectionItem | null>(null);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  // A capped export is a warning about a file the owner *did* get; a failed one
  // means there is no file at all. Rendering both through one slot presented an
  // outright failure as a footnote, so they are separate state and separate tone.
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const index = useQuery({ ...collectionsIndexQuery(app.slug), enabled: authenticated });
  const manifest = useQuery({ ...manifestQuery(app.slug), enabled: authenticated });
  const del = useDeleteCollectionItem();

  // The `?? []` fallbacks are memoized so the empty-state identity is stable —
  // otherwise every render hands the memos below a brand-new array and they
  // recompute for nothing.
  const summaries = useMemo(() => index.data ?? [], [index.data]);
  const declared = useMemo(
    () => manifest.data?.capabilities.data?.collections ?? [],
    [manifest.data],
  );

  /**
   * Every collection worth offering: the ones with rows (from the index) unioned
   * with the ones the manifest declares. Neither source alone is complete — a
   * brand-new app has declared-but-empty collections, and a name removed from the
   * manifest still has rows nothing will ever delete.
   */
  const names = useMemo(() => {
    const withRows = [...new Set(summaries.map((s) => s.name))];
    return [...new Set([...withRows, ...declared])].sort();
  }, [summaries, declared]);

  const collection = selected && names.includes(selected) ? selected : (names[0] ?? null);

  const rowsQuery = useQuery({
    ...collectionItemsQuery(app.slug, collection ?? "", {
      ...(envView === "all" ? {} : { env: envView }),
      limit: ROW_LIMIT,
    }),
    enabled: authenticated && !!collection,
  });

  const items = useMemo(() => rowsQuery.data?.rows ?? [], [rowsQuery.data]);
  const columns = useMemo(() => deriveCollectionColumns(items), [items]);

  /** Rows the current env filter is holding back, so the tab can say so. */
  const hiddenByEnv = summaries
    .filter((s) => s.name === collection && envView !== "all" && s.env !== envView)
    .reduce((n, s) => n + s.count, 0);

  const countFor = (name: string) =>
    summaries.filter((s) => s.name === name).reduce((n, s) => n + s.count, 0);

  function clearExportState() {
    setExportNote(null);
    setExportError(null);
  }

  async function onExport(format: ExportFormat) {
    if (!collection) return;
    setExporting(format);
    clearExportState();
    try {
      const q = new URLSearchParams({ format });
      if (envView !== "all") q.set("env", envView);
      const { body, headers } = await fetchText(
        `/api/v1/apps/${encodeURIComponent(app.slug)}/collections/${encodeURIComponent(
          collection,
        )}/export?${q}`,
      );
      downloadText(
        `${app.slug}-${collection}.${format}`,
        body,
        format === "csv" ? "text/csv" : "application/json",
      );
      // Never present a capped file as a complete one. Both caps can fire at once,
      // so they accumulate — two sequential setters would be last-writer-wins and
      // the row cap (the one that actually loses data) is the likelier casualty.
      // Spelled out rather than abbreviated: "10.0k" is not a number you can
      // reason about a cap with.
      const notes: string[] = [];
      const rowCap = headers.get("x-helix-export-truncated");
      if (rowCap) {
        notes.push(
          `Export capped at ${Number(rowCap).toLocaleString()} rows — the oldest rows are omitted.`,
        );
      }
      const colCap = headers.get("x-helix-export-columns-truncated");
      if (colCap) {
        notes.push(
          `Only the ${Number(colCap).toLocaleString()} most common fields got their own column — the rest are in the raw item column.`,
        );
      }
      setExportNote(notes.length ? notes.join(" ") : null);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "export failed");
    } finally {
      setExporting(null);
    }
  }

  if (!authenticated) {
    return (
      <Hint
        icon="user"
        tone="neutral"
        action={
          <Button variant="default" size="xs" onClick={login} disabled={!loginAvailable}>
            Sign in
          </Button>
        }
      >
        Sign in to view what this app has collected.
      </Hint>
    );
  }
  // Both, because `names` unions the index with the manifest's declared list: a
  // brand-new app whose index resolves first would otherwise be told to grant a
  // capability it already has, and then flip to the table. Costs the slower of two
  // parallel requests, which is the right trade against showing wrong advice.
  //
  // MUST stay below the `!authenticated` return above — a disabled react-query
  // query reports `pending`, so a signed-out visitor would spin here forever.
  if (index.isPending || manifest.isPending) {
    return (
      <Center py={60}>
        <Loader size="sm" />
      </Center>
    );
  }
  if (index.isError) {
    return (
      <Hint icon="alert" tone="bad">
        Couldn't load collections: {index.error.message}
      </Hint>
    );
  }
  if (names.length === 0) {
    return (
      <Hint icon="db" tone="info">
        This app has no collections. Grant one under <b>Capabilities</b> — the app can then append
        to it with <Code>POST /_api/data/collections/&lt;name&gt;</Code>, and submissions appear
        here.
      </Hint>
    );
  }

  // Only once the manifest has actually loaded: `declared` is empty while that
  // query is in flight, and warning that a perfectly normal collection is
  // undeclared every time the tab opens would train the owner to ignore it.
  const undeclared = manifest.isSuccess && collection !== null && !declared.includes(collection);
  // chevron + when + [env, only in the All view] + derived keys + actions.
  const totalCols = columns.keys.length + (envView === "all" ? 4 : 3);

  return (
    <Stack gap={18} className="az-stagger">
      <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
        <Group gap={12} align="flex-end">
          <Select
            label={<Eyebrow>Collection</Eyebrow>}
            data={names.map((n) => ({ value: n, label: `${n} · ${fmtCount(countFor(n))}` }))}
            value={collection}
            onChange={(v) => {
              setSelected(v);
              setExpanded(null);
              clearExportState();
            }}
            allowDeselect={false}
            w={260}
            className="az-mono"
          />
          <SegmentedControl
            size="xs"
            value={envView}
            onChange={(v) => setEnvView(v as EnvView)}
            data={[
              { value: "prod", label: "Prod" },
              { value: "dev", label: "Dev" },
              { value: "all", label: "All" },
            ]}
          />
        </Group>
        <Group gap={8}>
          {/* Only the clicked format spins, but both are disabled while either is
              in flight: concurrent exports would race the shared note state and
              double the server's peak memory for a 10,000-row pull. */}
          {(["csv", "json"] as const).map((format) => (
            <Button
              key={format}
              variant="default"
              size="xs"
              leftSection={<Icon name="download" size={14} />}
              loading={exporting === format}
              disabled={exporting !== null}
              onClick={() => void onExport(format)}
            >
              {format.toUpperCase()}
            </Button>
          ))}
        </Group>
      </Group>

      {exportError && (
        <Hint icon="alert" tone="bad">
          Export failed: {exportError}
        </Hint>
      )}

      {exportNote && (
        <Hint icon="alert" tone="warn">
          {exportNote}
        </Hint>
      )}

      {undeclared && (
        <Hint icon="alert" tone="warn">
          <Code>{collection}</Code> is no longer declared in this app's manifest, but still holds
          rows. The app can't append to it any more; you can still export or erase what's here.
        </Hint>
      )}

      {hiddenByEnv > 0 && (
        <Hint
          icon="terminal"
          tone="info"
          action={
            <Button variant="default" size="xs" onClick={() => setEnvView("all")}>
              Show all
            </Button>
          }
        >
          {fmtCount(hiddenByEnv)} more {hiddenByEnv === 1 ? "row" : "rows"} in the other tier —
          hidden so dev-mode test submissions don't mix with real ones.
        </Hint>
      )}

      {rowsQuery.isPending ? (
        <Center py={60}>
          <Loader size="sm" />
        </Center>
      ) : rowsQuery.isError ? (
        <Hint icon="alert" tone="bad">
          Couldn't load rows: {rowsQuery.error.message}
        </Hint>
      ) : (
        <Box
          style={{
            border: "1px solid var(--az-line)",
            borderRadius: "var(--mantine-radius-lg)",
            overflow: "hidden",
            background: "var(--mantine-color-dark-7)",
          }}
        >
          {/* A collection's columns come from the submitted data, so there is
              no width to design against — whatever the app writes, the table
              scrolls inside its frame rather than pushing the page sideways. */}
          <ScrollFade>
            <Table verticalSpacing={10} horizontalSpacing="lg" className="az-mono" fz={12}>
              <Table.Thead style={{ background: "var(--mantine-color-dark-6)" }}>
                <Table.Tr>
                  <Table.Th w={40} />
                  <Table.Th>When</Table.Th>
                  {envView === "all" && <Table.Th>Env</Table.Th>}
                  {columns.keys.map((k) => (
                    <Table.Th key={k}>{columnHeader(k)}</Table.Th>
                  ))}
                  <Table.Th w={44} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {items.map((it) => {
                  const cells = collectionRowCells(it, columns);
                  const open = expanded === it.id;
                  return (
                    <Fragment key={it.id}>
                      <Table.Tr>
                        <Table.Td>
                          <ActionIcon
                            variant="subtle"
                            color="gray"
                            size="sm"
                            aria-label={open ? "Hide raw item" : "Show raw item"}
                            onClick={() => setExpanded(open ? null : it.id)}
                          >
                            <Icon
                              name="chevR"
                              size={13}
                              style={{ transform: open ? "rotate(90deg)" : undefined }}
                            />
                          </ActionIcon>
                        </Table.Td>
                        <Table.Td c="dark.2" style={{ whiteSpace: "nowrap" }}>
                          {timeAgo(it.createdAt)}
                        </Table.Td>
                        {envView === "all" && (
                          <Table.Td>
                            {it.env === "dev" ? (
                              <ToneBadge tone="slate">dev</ToneBadge>
                            ) : (
                              <Text component="span" c="dark.3" fz={11}>
                                prod
                              </Text>
                            )}
                          </Table.Td>
                        )}
                        {cells.map((v, i) => (
                          <Table.Td key={columns.keys[i]} c={v === null ? "dark.3" : "dark.1"}>
                            {v === null ? "—" : truncate(String(v))}
                          </Table.Td>
                        ))}
                        <Table.Td>
                          <ActionIcon
                            variant="subtle"
                            color="red"
                            size="sm"
                            aria-label="Erase this item"
                            onClick={() => setPendingDelete(it)}
                          >
                            <Icon name="x" size={13} />
                          </ActionIcon>
                        </Table.Td>
                      </Table.Tr>
                      {/* Rendered only when open — 200 hidden detail cards, each
                          holding a pretty-printed 64 KB item, is real DOM cost. */}
                      {open && (
                        <Table.Tr style={{ background: "transparent" }}>
                          <Table.Td colSpan={totalCols} p={0} style={{ borderBottom: "none" }}>
                            <RawDetail item={it} />
                          </Table.Td>
                        </Table.Tr>
                      )}
                    </Fragment>
                  );
                })}
                {items.length === 0 && (
                  <Table.Tr>
                    <Table.Td colSpan={totalCols}>
                      <Text ta="center" c="dark.2" py={24} ff="text" fz={13}>
                        Nothing collected {envView === "all" ? "yet" : `in ${envView} yet`}.
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          </ScrollFade>
        </Box>
      )}

      <Group gap={6} c="dark.3">
        <Icon name="shield" size={12} />
        <Text size="xs" c="dark.3">
          {columns.truncated ? "Some keys have no column — expand a row for the full item. " : ""}
          {rowsQuery.data?.nextBefore
            ? `Showing the newest ${ROW_LIMIT} rows; use Export for the full set. `
            : ""}
          Columns are derived from the rows shown — collected items have no declared schema. The app
          that gathered this data cannot read it back.
        </Text>
      </Group>

      <ConfirmDialog
        opened={pendingDelete !== null}
        icon="x"
        tone="var(--az-bad)"
        toneDim="var(--az-bad-dim)"
        title="Erase this item?"
        body={
          <>
            This permanently deletes one collected submission. Use it to answer an erasure request —
            it cannot be undone, and the export will no longer include it.
          </>
        }
        confirmLabel="Erase"
        confirmColor="red"
        loading={del.isPending}
        error={del.error ? del.error.message : null}
        onClose={() => {
          setPendingDelete(null);
          del.reset();
        }}
        onConfirm={() => {
          if (!pendingDelete || !collection) return;
          del.mutate(
            { slug: app.slug, collection, id: pendingDelete.id },
            { onSuccess: () => setPendingDelete(null) },
          );
        }}
      />
    </Stack>
  );
}

function truncate(s: string): string {
  return s.length > CELL_CHARS ? `${s.slice(0, CELL_CHARS)}…` : s;
}

/**
 * The lossless view of one row: whatever the app actually sent, plus the triage
 * metadata the app itself never sees.
 *
 * Rendered as text, always. `item` is anonymous-visitor input, so any affordance
 * that interpreted it as markup would be a direct XSS sink on the owner's own
 * control plane.
 */
function RawDetail({ item }: { item: CollectionItem }) {
  return (
    <Card m={12} p={14} bg="var(--mantine-color-dark-8)">
      <Stack gap={10}>
        <Box>
          <Eyebrow mb={6}>Raw item</Eyebrow>
          <Code block fz={11.5} style={{ maxHeight: 260, overflow: "auto" }}>
            {JSON.stringify(item.item, null, 2)}
          </Code>
        </Box>
        <Group gap={24} wrap="wrap">
          <Box>
            <Eyebrow mb={4}>Submitted by</Eyebrow>
            {item.userOid === null ? (
              <Text className="az-mono" fz={12} c="dark.3">
                anonymous
              </Text>
            ) : (
              // Same split as the audit log: captured claims lead, the raw
              // subject is the fallback and stays on `title` for correlation.
              <Box title={item.userOid}>
                <Principal
                  name={item.userName ?? undefined}
                  email={item.userEmail ?? undefined}
                  id={principalLabel(item.userOid, item.userKind)}
                  fz={12}
                />
              </Box>
            )}
          </Box>
          <Box>
            <Eyebrow mb={4}>Collected</Eyebrow>
            <Text className="az-mono" fz={12} c="dark.1">
              {new Date(item.createdAt).toISOString()}
            </Text>
          </Box>
          <Box>
            <Eyebrow mb={4}>Tier</Eyebrow>
            <Text className="az-mono" fz={12} c="dark.1">
              {item.env}
            </Text>
          </Box>
          {item.meta != null && (
            <Box>
              <Eyebrow mb={4}>Abuse triage</Eyebrow>
              <Text className="az-mono" fz={11.5} c="dark.3">
                {JSON.stringify(item.meta)}
              </Text>
            </Box>
          )}
        </Group>
      </Stack>
    </Card>
  );
}
