import { useState, type ReactNode } from "react";
import { Button, Card, Grid, Group, SimpleGrid, Stack, Text, Textarea } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { APP_DESCRIPTION_MAX, visibilityLabel, type App, type Version } from "@azx-pbc/shared";
import { Bars } from "../../components/charts";
import { Eyebrow, Hint, KV, Stat } from "../../components/primitives";
import { approvalsQuery, manifestQuery, usageQuery } from "../../api/queries";
import { useUpdateApp } from "../../api/mutations";
import { useAuth } from "../../auth/AuthProvider";
import { daysSince, fmtCount, fmtUsd, timeAgo } from "../../lib/format";
import { appStatus, awaitingPromoteNumber, deployFacts } from "../../lib/appStatus";

/**
 * A window's error-outcome share above which the Overview shouts. Below it a
 * stray upstream failure is noise — one flaky call in a hundred shouldn't open
 * the tab with a red band; the Usage tab still shows the exact rate either way.
 * The policy refusals (`forbidden`, `connection_required`, `quota_blocked`)
 * shout at any count: they mean users are being turned away, not that a call
 * flaked.
 */
const ERROR_RATE_HINT = 0.05;

/**
 * The owner's triage surface: does anything need me, is the app alive, what is
 * it. Runtime signals come from the gateway ledger; the deploy pipeline's own
 * detail lives on the Versions tab and metering's on Usage — this tab summarizes
 * both and links there rather than repeating them at depth.
 */
export function OverviewTab({ app, versions }: { app: App; versions: Version[] }) {
  const facts = deployFacts(app, versions);
  const pending = awaitingPromoteNumber(facts);
  const { authenticated, me, isAdmin } = useAuth();
  // Mirror of the server's `ownsApp` (owner-id match, or admin; a legacy row
  // with no ownerId admits only admins) — so the edit affordance appears for
  // exactly the people the PATCH route would admit. The server stays the gate.
  const canEdit =
    authenticated && (isAdmin || (app.ownerId !== undefined && app.ownerId === me?.oid));
  const update = useUpdateApp();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  function startEdit() {
    setDraft(app.description ?? "");
    setEditing(true);
  }

  function save() {
    update.mutate(
      // Empty string clears — the server stores null and the key is omitted.
      { slug: app.slug, body: { description: draft.trim() || null } },
      { onSuccess: () => setEditing(false) },
    );
  }
  // Pending capability/visibility approvals for this app (docs/design/approvals.md).
  const approvals = useQuery({
    ...approvalsQuery({ app: app.slug, status: "pending" }),
    enabled: authenticated,
  });
  const pendingApprovals = approvals.data ?? [];
  // Nothing expires these (ADR-0039), so the age of the oldest one is the signal
  // that a request has stopped being looked at.
  const oldestApprovalDays = pendingApprovals.length
    ? Math.max(...pendingApprovals.map((a) => daysSince(a.createdAt)))
    : 0;

  // Runtime state, off the same ledger the Usage tab reads. Two windows from
  // one endpoint: 7d drives the activity strip, 24h drives the outcome hints —
  // the budgets the edge enforces are daily, so a stale week-old refusal must
  // not shout about a problem that already reset. Bearer-gated server-side, so
  // both wait for sign-in; before they land the tab simply shows less.
  const usage7 = useQuery({ ...usageQuery(app.slug, "7d"), enabled: authenticated });
  const usage24 = useQuery({ ...usageQuery(app.slug, "24h"), enabled: authenticated });
  // Open read — same manifest the Capabilities tab edits, summarized here.
  const manifest = useQuery(manifestQuery(app.slug));

  const u24 = usage24.data;
  const outcomeCount = (outcome: string) => u24?.byOutcome[outcome] ?? 0;
  const refused = outcomeCount("quota_blocked");
  const forbidden = outcomeCount("forbidden");
  const noConnection = outcomeCount("connection_required");
  const errors = outcomeCount("error");
  const errRate = u24?.errorRate ?? 0;
  const errPct = Math.round(errRate * 1000) / 10;
  const live = appStatus(app, facts) === "live";

  const u7 = usage7.data;

  // The capabilities summary: the manifest's grants compressed to one line per
  // capability. The Capabilities tab is the editor; this is the read-only
  // answer to "what can this app do" — worth saying even to the owner, because
  // a usage surprise usually starts with one of these numbers.
  const caps = manifest.data?.capabilities;
  const capLines: Array<[string, ReactNode]> = [];
  if (caps?.llm?.models.length) {
    capLines.push([
      "Models",
      <>
        {caps.llm.models.join(", ")}
        {caps.llm.dollarsPerDay ? ` · ${fmtUsd(caps.llm.dollarsPerDay)}/day` : ""}
      </>,
    ]);
  }
  const data = caps?.data;
  if (data && (data.user || data.collections.length)) {
    capLines.push([
      "Data",
      [
        data.user ? "user store" : null,
        data.collections.length
          ? `${data.collections.length} collection${data.collections.length === 1 ? "" : "s"}`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
    ]);
  }
  if (caps?.externalOrigins.length) {
    capLines.push(["Direct origins", `${caps.externalOrigins.length} via CSP`]);
  }
  if (caps?.fetch?.origins.length) {
    capLines.push([
      "Proxied origins",
      `${caps.fetch.origins.length}${caps.fetch.requestsPerDay ? ` · ${caps.fetch.requestsPerDay}/day` : ""}`,
    ]);
  }
  if (caps?.mcp.length) {
    capLines.push(["MCP servers", caps.mcp.join(", ")]);
  }
  if (caps?.offline) {
    capLines.push(["Offline", caps.offline.scope]);
  }

  return (
    <Grid gap={18} className="az-stagger">
      <Grid.Col span={{ base: 12, md: 7 }}>
        <Stack gap={18}>
          {refused > 0 && (
            <Hint
              icon="gauge"
              tone="warn"
              action={
                <Button
                  variant="default"
                  size="xs"
                  component={Link}
                  to={`/apps/${app.slug}?tab=usage`}
                >
                  View usage
                </Button>
              }
            >
              <b>
                {refused} call{refused === 1 ? "" : "s"}
              </b>{" "}
              refused today — the app hit its daily budget. Users are being turned away until it
              resets or you raise the cap.
            </Hint>
          )}
          {forbidden > 0 && (
            <Hint
              icon="shield"
              tone="bad"
              action={
                <Button
                  variant="default"
                  size="xs"
                  component={Link}
                  to={`/apps/${app.slug}?tab=capabilities`}
                >
                  Review capabilities
                </Button>
              }
            >
              <b>
                {forbidden} call{forbidden === 1 ? "" : "s"}
              </b>{" "}
              refused by policy — the app asked for an origin its manifest doesn't grant.
            </Hint>
          )}
          {noConnection > 0 && (
            <Hint icon="user" tone="violet">
              <b>
                {noConnection} call{noConnection === 1 ? "" : "s"}
              </b>{" "}
              couldn't run — the caller isn't connected to the app's provider. Users connect their
              own account before those calls can succeed.
            </Hint>
          )}
          {u24 && errors > 0 && errRate >= ERROR_RATE_HINT && (
            <Hint
              icon="alert"
              tone="warn"
              action={
                <Button
                  variant="default"
                  size="xs"
                  component={Link}
                  to={`/apps/${app.slug}?tab=usage`}
                >
                  View usage
                </Button>
              }
            >
              <b>
                {errors} of {u24.requests} calls failed
              </b>{" "}
              in the last 24h ({errPct}%).
            </Hint>
          )}
          {pending !== null && (
            <Hint
              icon="layers"
              tone="slate"
              action={
                <Button
                  variant="default"
                  size="xs"
                  component={Link}
                  to={`/apps/${app.slug}?tab=versions`}
                >
                  Review preview
                </Button>
              }
            >
              <b>v{pending}</b> is deployed to preview and awaiting promotion. Live traffic is
              unaffected until you promote.
            </Hint>
          )}
          {pendingApprovals.length > 0 && (
            <Hint
              icon="shield"
              tone="violet"
              action={
                <Button variant="default" size="xs" component={Link} to="/admin/approvals">
                  Review
                </Button>
              }
            >
              <b>
                {pendingApprovals.length} elevated change
                {pendingApprovals.length > 1 ? "s" : ""}
              </b>{" "}
              awaiting admin approval
              {oldestApprovalDays > 0 && ` — oldest pending ${oldestApprovalDays}d`}. Baseline edits
              already applied; these grants stay off until approved.
            </Hint>
          )}
          {live && u7 && u7.requests === 0 && (
            <Hint icon="bolt" tone="info">
              <b>No gateway calls in 7 days</b> — nobody has exercised the app this week.
            </Hint>
          )}
          {versions.length === 0 && (
            <Hint icon="upload" tone="info">
              No versions yet — run <span className="az-mono">helix deploy</span> from the app
              directory, or drop a zip in the Deploy dialog.
            </Hint>
          )}

          {authenticated && u7 && (
            <Card>
              <Group justify="space-between" mb={14}>
                <Eyebrow>Gateway activity · last 7 days</Eyebrow>
                <Button
                  variant="subtle"
                  size="xs"
                  component={Link}
                  to={`/apps/${app.slug}?tab=usage`}
                >
                  Usage
                </Button>
              </Group>
              <SimpleGrid cols={3} mb={16}>
                <Stat
                  icon="bolt"
                  label="Requests"
                  value={fmtCount(u7.requests)}
                  sub="gateway calls"
                />
                <Stat
                  icon="alert"
                  label="Error rate"
                  value={`${u7.requests ? (Math.round(u7.errorRate * 1000) / 10).toFixed(1) : "0.0"}%`}
                  tone={u7.errorRate > 0.01 ? "var(--az-warn)" : undefined}
                  sub="non-ok outcomes"
                />
                <Stat
                  icon="db"
                  label="Spend"
                  value={fmtUsd(u7.costUsd)}
                  sub="estimated, current rates"
                />
              </SimpleGrid>
              {/* One bar per day of the window — the shape of the week, not the
                  Usage tab's explorable chart. */}
              <Bars data={u7.series.map((p) => p.requests)} h={56} />
            </Card>
          )}
        </Stack>
      </Grid.Col>

      <Grid.Col span={{ base: 12, md: 5 }}>
        <Stack gap={18}>
          <Card>
            <Group justify="space-between" mb={4}>
              <Eyebrow>Registry record</Eyebrow>
              {canEdit && !editing && (
                <Button variant="subtle" size="xs" onClick={startEdit}>
                  {app.description ? "Edit description" : "Add description"}
                </Button>
              )}
            </Group>
            {editing ? (
              <Stack gap={10} mb={10}>
                <Textarea
                  label="Description"
                  description="What is this app for? One sentence — it appears under the app's name."
                  value={draft}
                  onChange={(e) => setDraft(e.currentTarget.value)}
                  minRows={2}
                  maxRows={5}
                  maxLength={APP_DESCRIPTION_MAX}
                  data-autofocus
                />
                <Group justify="flex-end">
                  <Button variant="subtle" color="gray" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                  <Button onClick={save} loading={update.isPending}>
                    Save
                  </Button>
                </Group>
                {update.isError && (
                  <Text size="sm" c="red.4">
                    {update.error.message}
                  </Text>
                )}
              </Stack>
            ) : (
              // The description lives at the top of the record card — it is the
              // part a colleague reads. An app without one says so plainly
              // rather than hiding the row; the empty state is the invitation.
              <Text size="sm" c={app.description ? "dark.1" : "dark.3"} lh={1.5} mb={10}>
                {app.description ?? "No description yet."}
              </Text>
            )}
            <KV k="Visibility" mono>
              {visibilityLabel(app.visibility)}
            </KV>
            <KV k="Created" mono>
              {new Date(app.createdAt).toLocaleDateString()}
            </KV>
            <KV k="Updated" mono>
              {timeAgo(app.updatedAt)}
            </KV>
          </Card>

          {caps && (
            <Card>
              <Group justify="space-between" mb={4}>
                <Eyebrow>Granted capabilities</Eyebrow>
                <Button
                  variant="subtle"
                  size="xs"
                  component={Link}
                  to={`/apps/${app.slug}?tab=capabilities`}
                >
                  Edit
                </Button>
              </Group>
              {capLines.length === 0 ? (
                <Text size="sm" c="dark.3" lh={1.5} py={6}>
                  No gateway capabilities granted yet — the app serves fine without them; grants are
                  what let it call models, store data, or reach other services.
                </Text>
              ) : (
                capLines.map(([k, v]) => (
                  <KV key={k} k={k} mono>
                    {v}
                  </KV>
                ))
              )}
            </Card>
          )}
        </Stack>
      </Grid.Col>
    </Grid>
  );
}
