import { useState } from "react";
import { Button, Card, Grid, Group, Stack, Text, Textarea } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { APP_DESCRIPTION_MAX, visibilityLabel, type App, type Version } from "@azx-pbc/shared";
import { Bars } from "../../components/charts";
import { Eyebrow, Hint, KV } from "../../components/primitives";
import { approvalsQuery } from "../../api/queries";
import { useUpdateApp } from "../../api/mutations";
import { useAuth } from "../../auth/AuthProvider";
import { daysSince, timeAgo } from "../../lib/format";
import { awaitingPromoteNumber, deployCadence, deployFacts } from "../../lib/appStatus";

/** All real: registry + version history, no metering required. */
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

  return (
    <Grid gap={18} className="az-stagger">
      <Grid.Col span={{ base: 12, md: 7 }}>
        <Stack gap={18}>
          <Card>
            <Group justify="space-between" mb={14}>
              <Eyebrow>Deploy cadence · since first version</Eyebrow>
            </Group>
            <Bars data={deployCadence(versions)} h={92} />
          </Card>

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
          {versions.length === 0 && (
            <Hint icon="upload" tone="info">
              No versions yet — run <span className="az-mono">helix deploy</span> from the app
              directory, or drop a zip in the Deploy dialog.
            </Hint>
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
        </Stack>
      </Grid.Col>
    </Grid>
  );
}
