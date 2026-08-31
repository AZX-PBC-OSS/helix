import { useState } from "react";
import { Box, Button, Group, Table, Text, Tooltip } from "@mantine/core";
import type { App, DeployReport, Version } from "@azx-pbc/shared";
import { usePromoteVersion, useRollback } from "../../api/mutations";
import { useAuth } from "../../auth/AuthProvider";
import { ScrollFade } from "../../components/ScrollFade";
import { Hint, ToneBadge, type Tone } from "../../components/primitives";
import { timeAgo } from "../../lib/format";
import { ConfirmDialog } from "../../modals/ConfirmDialog";

const STATUS_TONE: Record<Version["status"], Tone> = {
  live: "live",
  preview: "slate",
  archived: "neutral",
};

type PendingAction = { kind: "promote" | "rollback"; version: Version } | null;

/** Real version history + the two pointer flips (promote / rollback). */
export function VersionsTab({ app, versions }: { app: App; versions: Version[] }) {
  const { authenticated, login, loginAvailable } = useAuth();
  const promote = usePromoteVersion();
  const rollback = useRollback();
  const [pending, setPending] = useState<PendingAction>(null);

  const liveNumber = versions.find((v) => v.id === app.currentVersionId)?.number;

  function confirm() {
    if (!pending) return;
    const args = {
      slug: app.slug,
      number: pending.version.number,
      toNumber: pending.version.number,
    };
    const m = pending.kind === "promote" ? promote : rollback;
    m.mutate(args, { onSuccess: () => setPending(null) });
  }

  const active = pending?.kind === "promote" ? promote : rollback;

  return (
    <div className="az-stagger">
      <Hint icon="layers" tone="info">
        Every deploy is an <b>immutable version</b> in Blob storage. Promote flips the registry
        pointer; rollback flips it back — no rebuild, effective at the edge within seconds.
      </Hint>

      {!authenticated && versions.length > 0 && (
        <Box mt={18}>
          <Hint
            icon="user"
            tone="neutral"
            action={
              <Button variant="default" size="xs" onClick={login} disabled={!loginAvailable}>
                Sign in
              </Button>
            }
          >
            You need to be signed in to promote or roll back — every change is recorded in the audit
            log against the person who made it.
          </Hint>
        </Box>
      )}

      <Box
        mt={18}
        style={{
          border: "1px solid var(--az-line)",
          borderRadius: "var(--mantine-radius-lg)",
          overflow: "hidden",
          background: "var(--mantine-color-dark-7)",
        }}
      >
        {/* Five columns, one of them an unbounded blob prefix: on the app
            detail pane's width that overflows, so it scrolls in its frame like
            every other table rather than stretching the page. */}
        <ScrollFade>
          <Table verticalSpacing="sm" horizontalSpacing="lg">
            <Table.Thead style={{ background: "var(--mantine-color-dark-6)" }}>
              <Table.Tr>
                <Table.Th>Version</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Deployed</Table.Th>
                <Table.Th>Blob prefix</Table.Th>
                <Table.Th style={{ textAlign: "right" }}>Action</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {versions.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={5}>
                    <Text c="dark.2" size="sm" ta="center" py={24}>
                      No versions yet — <span className="az-mono">helix deploy</span> creates v1.
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
              {versions.map((v) => {
                const isLive = v.id === app.currentVersionId;
                return (
                  <Table.Tr
                    key={v.id}
                    style={isLive ? { background: "var(--az-acc-dim)" } : undefined}
                  >
                    <Table.Td>
                      <Group gap={8}>
                        <Text className="az-mono" fw={600} fz={13}>
                          v{v.number}
                        </Text>
                        {isLive && (
                          <ToneBadge tone="live" style={{ padding: "1px 6px", fontSize: 9.5 }}>
                            LIVE
                          </ToneBadge>
                        )}
                        <SalvageBadge report={v.deployReport} />
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <ToneBadge tone={STATUS_TONE[v.status]}>{v.status}</ToneBadge>
                    </Table.Td>
                    <Table.Td>
                      <Text className="az-mono" fz={12} c="dark.1">
                        {timeAgo(v.createdAt)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text className="az-mono" fz={12} c="dark.2">
                        {v.blobPrefix}
                      </Text>
                    </Table.Td>
                    <Table.Td style={{ textAlign: "right" }}>
                      {isLive ? (
                        <Text className="az-mono" fz={11} c="dark.3">
                          serving
                        </Text>
                      ) : app.archivedAt ? (
                        <Text className="az-mono" fz={11} c="dark.3">
                          app archived
                        </Text>
                      ) : (
                        <Button
                          variant="default"
                          size="compact-sm"
                          disabled={!authenticated}
                          onClick={() =>
                            setPending({
                              kind: v.status === "preview" ? "promote" : "rollback",
                              version: v,
                            })
                          }
                        >
                          {v.status === "preview" ? "Promote" : "Rollback to"}
                        </Button>
                      )}
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </ScrollFade>
      </Box>

      <ConfirmDialog
        opened={pending !== null}
        icon={pending?.kind === "promote" ? "arrowU" : "rotate"}
        tone={pending?.kind === "promote" ? "var(--az-acc)" : "var(--az-warn)"}
        toneDim={pending?.kind === "promote" ? "var(--az-acc-dim)" : "var(--az-warn-dim)"}
        title={
          pending?.kind === "promote"
            ? `Promote v${pending.version.number} to live?`
            : `Roll back to v${pending?.version.number}?`
        }
        body={
          <>
            This flips the live pointer from{" "}
            <span className="az-mono">
              {liveNumber !== undefined ? `v${liveNumber}` : "nothing"}
            </span>{" "}
            to <span className="az-mono">v{pending?.version.number}</span> instantly. The bundle is
            already in storage — nothing rebuilds.
          </>
        }
        confirmLabel={
          pending?.kind === "promote" ? "Promote" : `Flip to v${pending?.version.number}`
        }
        loading={active.isPending}
        error={active.isError ? active.error.message : null}
        onConfirm={confirm}
        onClose={() => {
          setPending(null);
          promote.reset();
          rollback.reset();
        }}
      />
    </div>
  );
}

/**
 * A quiet marker that the portal SPA re-rooted or trimmed this upload before
 * sending it (ADR-0038). Client-asserted provenance — shown only to explain a
 * version's file list, never load-bearing — so a `canonical` (untouched) deploy
 * shows nothing.
 */
function SalvageBadge({ report }: { report?: DeployReport }) {
  if (!report || report.outcome === "canonical") return null;
  const dropped = Object.values(report.drops).reduce((n, c) => n + c, 0);
  const detail = [
    report.root ? `rooted at ${report.root}` : "kept at the archive root",
    `${report.fileCount} file${report.fileCount === 1 ? "" : "s"} kept`,
    dropped > 0 ? `${dropped} dropped` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Tooltip label={detail} withArrow multiline maw={280}>
      <span>
        <ToneBadge tone="slate" icon="layers" style={{ padding: "1px 6px", fontSize: 9.5 }}>
          salvaged
        </ToneBadge>
      </span>
    </Tooltip>
  );
}
