import { useState } from "react";
import { Box, Button, Card, Code, Collapse, Group, Stack, Text, TextInput } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import {
  BranchNameSchema,
  EnvironmentNameSchema,
  RepoFullNameSchema,
  WorkflowRefSchema,
  type App,
  type RepoBinding,
  type SetRepoBindingRequest,
} from "@azx-pbc/shared";
import { repoBindingQuery } from "../../api/queries";
import { useDeleteRepoBinding, useSetRepoBinding } from "../../api/mutations";
import { PortalApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { Icon } from "../../components/Icon";
import { CopyBtn, Eyebrow, Hint, ToneBadge } from "../../components/primitives";
import { ConfirmDialog } from "../../modals/ConfirmDialog";

/**
 * Repository — connect the app to a GitHub repo and branch so a push lands a
 * preview (ADR-0051). The owner sets the binding here or with `helix ci init`;
 * the job's own OIDC token authenticates each deploy, so there is no secret to
 * show or rotate. The first deploy pins the repo's numeric ids, and the tab says
 * whether that has happened yet.
 */

interface Draft {
  repoFullName: string;
  branch: string;
  workflowRef: string;
  environment: string;
}

const fromBinding = (b: RepoBinding | null): Draft => ({
  repoFullName: b?.repoFullName ?? "",
  branch: b?.branch ?? "main",
  workflowRef: b?.workflowRef ?? "",
  environment: b?.environment ?? "",
});

/**
 * The first schema issue for a field, or undefined when it's valid. An empty
 * field shows no error: optional ones may stay empty, and the submit button
 * stays disabled for an empty required one.
 */
function fieldError(
  schema: {
    safeParse(v: unknown): { success: boolean; error?: { issues: { message: string }[] } };
  },
  value: string,
): string | undefined {
  if (value === "") return undefined;
  const r = schema.safeParse(value);
  return r.success ? undefined : r.error?.issues[0]?.message;
}

export function starterWorkflow(branch: string): string {
  return `on:
  push:
    branches: [${JSON.stringify(branch)}]
  workflow_dispatch:
permissions:
  contents: read
  id-token: write # the job's own token authenticates the deploy
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci && npm run build
      # \`helix ci init\` pins the exact CLI version instead, for reproducible deploys.
      - run: npx --yes @azx-pbc/helix-cli@latest deploy
`;
}

export function RepositoryTab({ app }: { app: App }) {
  const { authenticated, login, loginAvailable } = useAuth();
  const binding = useQuery({ ...repoBindingQuery(app.slug), enabled: authenticated });

  if (!authenticated) {
    return (
      <Card>
        <Eyebrow mb={4}>Repository</Eyebrow>
        <Hint
          icon="user"
          tone="neutral"
          action={
            <Button variant="default" size="xs" onClick={login} disabled={!loginAvailable}>
              Sign in
            </Button>
          }
        >
          You need to be signed in to see this app&apos;s repository connection.
        </Hint>
      </Card>
    );
  }
  if (binding.isError) {
    const forbidden = binding.error instanceof PortalApiError && binding.error.status === 403;
    return (
      <Card>
        <Eyebrow mb={4}>Repository</Eyebrow>
        <Hint tone={forbidden ? "neutral" : "bad"} icon={forbidden ? "lock" : "alert"}>
          {forbidden
            ? "Only the app's owner can see or change which repository deploys it."
            : binding.error.message}
        </Hint>
      </Card>
    );
  }
  if (binding.isPending) return null;
  // Keyed on the binding's last update, so the form's draft resets after a save
  // or a disconnect.
  return (
    <RepositoryCard key={binding.data?.updatedAt ?? "none"} app={app} binding={binding.data} />
  );
}

function RepositoryCard({ app, binding }: { app: App; binding: RepoBinding | null }) {
  const save = useSetRepoBinding();
  const remove = useDeleteRepoBinding();
  const [editing, setEditing] = useState(binding === null);
  const [draft, setDraft] = useState<Draft>(fromBinding(binding));
  const [advanced, setAdvanced] = useState(Boolean(binding?.workflowRef || binding?.environment));
  const [disconnecting, setDisconnecting] = useState(false);

  // The inputs hold what was typed; validation and the request use the
  // trimmed values, so an environment name like "Prod env" can be typed.
  const clean: Draft = {
    repoFullName: draft.repoFullName.trim(),
    branch: draft.branch.trim(),
    workflowRef: draft.workflowRef.trim(),
    environment: draft.environment.trim(),
  };
  const errors = {
    repoFullName: fieldError(RepoFullNameSchema, clean.repoFullName),
    branch: fieldError(BranchNameSchema, clean.branch),
    workflowRef: fieldError(WorkflowRefSchema, clean.workflowRef),
    environment: fieldError(EnvironmentNameSchema, clean.environment),
  };
  const valid =
    clean.repoFullName !== "" && clean.branch !== "" && Object.values(errors).every((e) => !e);
  const repoChanges =
    binding !== null &&
    binding.repositoryId !== undefined &&
    clean.repoFullName.toLowerCase() !== binding.repoFullName.toLowerCase();

  function submit() {
    const body: SetRepoBindingRequest = {
      repoFullName: clean.repoFullName,
      branch: clean.branch,
      ...(clean.workflowRef ? { workflowRef: clean.workflowRef } : {}),
      ...(clean.environment ? { environment: clean.environment } : {}),
    };
    save.mutate({ slug: app.slug, binding: body }, { onSuccess: () => setEditing(false) });
  }

  // Read the value now: the updater runs after React has cleared currentTarget.
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.currentTarget.value;
    setDraft((d) => ({ ...d, [k]: value }));
  };

  return (
    <Card>
      <Group justify="space-between" mb={4}>
        <Eyebrow>Repository</Eyebrow>
        {binding && (
          <ToneBadge
            tone={binding.repositoryId ? "live" : "slate"}
            icon={binding.repositoryId ? "check" : "clock"}
          >
            {binding.repositoryId ? "pinned" : "awaiting first deploy"}
          </ToneBadge>
        )}
      </Group>
      <Text size="sm" c="dark.2" mb={14} lh={1.5}>
        Connect a GitHub repository and branch, and every push to it lands a preview version here.
        Your repo&apos;s workflow authenticates with its own GitHub token, so there&apos;s no secret
        to add. A preview goes live only when someone promotes it.
      </Text>

      {binding && !editing && (
        <Stack gap={6} mb={16}>
          <Row label="Repository" value={binding.repoFullName} />
          <Row label="Branch" value={binding.branch} />
          {binding.workflowRef && <Row label="Workflow" value={binding.workflowRef} />}
          {binding.environment && <Row label="Environment" value={binding.environment} />}
          <Text size="xs" c="dark.2" lh={1.5}>
            {binding.repositoryId
              ? `Pinned to repository id ${binding.repositoryId} (owner id ${binding.repositoryOwnerId ?? "?"}). Renaming the repo keeps deploying; transferring it to another account stops until you reconnect.`
              : "The first deploy pins the repository's numeric ids, so a later rename keeps working and a reclaimed name doesn't."}
          </Text>
          <Group gap={8} mt={6}>
            <Button
              variant="default"
              size="xs"
              onClick={() => setEditing(true)}
              disabled={Boolean(app.archivedAt)}
            >
              Edit
            </Button>
            <Button variant="subtle" color="red" size="xs" onClick={() => setDisconnecting(true)}>
              Disconnect
            </Button>
          </Group>
        </Stack>
      )}

      {editing && (
        <Stack gap={10} mb={16}>
          <TextInput
            label="Repository"
            placeholder="owner/name"
            value={draft.repoFullName}
            onChange={set("repoFullName")}
            error={errors.repoFullName}
            classNames={{ input: "az-mono" }}
          />
          <TextInput
            label="Branch"
            description="Pushes to this branch deploy. Without refs/heads/."
            value={draft.branch}
            onChange={set("branch")}
            error={errors.branch}
            classNames={{ input: "az-mono" }}
          />
          <Button
            variant="subtle"
            size="compact-xs"
            w="fit-content"
            onClick={() => setAdvanced((a) => !a)}
          >
            {advanced ? "Hide" : "Show"} optional limits
          </Button>
          <Collapse expanded={advanced}>
            <Stack gap={10}>
              <TextInput
                label="Only this workflow"
                description="The exact job_workflow_ref a deploy must come from, e.g. owner/repo/.github/workflows/helix-deploy.yml@refs/heads/main."
                value={draft.workflowRef}
                onChange={set("workflowRef")}
                error={errors.workflowRef}
                classNames={{ input: "az-mono" }}
              />
              <TextInput
                label="Only this environment"
                description="A GitHub environment the job must run in. Its protection rules (required reviewers, wait timers) then gate every deploy."
                value={draft.environment}
                onChange={set("environment")}
                error={errors.environment}
                classNames={{ input: "az-mono" }}
              />
            </Stack>
          </Collapse>
          {repoChanges && (
            <Hint tone="warn" icon="alert">
              Changing the repository clears the pinned ids. The next deploy from the new repo pins
              it afresh.
            </Hint>
          )}
          {save.error && (
            <Hint tone="bad" icon="alert">
              {save.error.message}
            </Hint>
          )}
          <Group justify="flex-end" gap={8}>
            {binding && (
              <Button
                variant="default"
                size="xs"
                onClick={() => {
                  setDraft(fromBinding(binding));
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            )}
            <Button
              size="xs"
              leftSection={<Icon name="check" size={12} />}
              disabled={!valid || Boolean(app.archivedAt)}
              loading={save.isPending}
              onClick={submit}
            >
              {binding ? "Save" : "Connect"}
            </Button>
          </Group>
        </Stack>
      )}

      <Eyebrow mb={4}>Workflow</Eyebrow>
      <Text size="xs" c="dark.2" mb={6} lh={1.5}>
        From the app&apos;s directory, <Code>npx -y @azx-pbc/helix-cli@latest ci init</Code>{" "}
        connects the repo and writes a workflow tailored to its build, with the build kept apart
        from the job that can request a token. For an npm app at the repository root with a{" "}
        <Code>package-lock.json</Code>, the minimum is this as{" "}
        <Code>.github/workflows/helix-deploy.yml</Code>, plus a <Code>helix.json</Code> naming the
        app&apos;s slug and this portal. For anything else, run <Code>helix ci init</Code>.
      </Text>
      <Box pos="relative">
        <Code block className="az-mono" fz={11.5}>
          {starterWorkflow(binding?.branch ?? (clean.branch || "main"))}
        </Code>
        <Box pos="absolute" top={6} right={6}>
          <CopyBtn
            value={starterWorkflow(binding?.branch ?? (clean.branch || "main"))}
            label="Copy"
          />
        </Box>
      </Box>

      <ConfirmDialog
        opened={disconnecting}
        icon="x"
        title="Disconnect the repository?"
        body={
          <Text size="sm">
            Deploys from <Code>{binding?.repoFullName}</Code> stop being accepted. Versions it
            already deployed stay. You can reconnect later; the repo is pinned again on its next
            deploy.
          </Text>
        }
        confirmLabel="Disconnect"
        confirmColor="red"
        loading={remove.isPending}
        error={remove.error?.message ?? null}
        onConfirm={() =>
          remove.mutate({ slug: app.slug }, { onSuccess: () => setDisconnecting(false) })
        }
        onClose={() => setDisconnecting(false)}
      />
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <Group gap={10} wrap="nowrap">
      <Text size="xs" c="dark.3" w={96}>
        {label}
      </Text>
      <Code style={{ overflowX: "auto", whiteSpace: "nowrap" }}>{value}</Code>
    </Group>
  );
}
