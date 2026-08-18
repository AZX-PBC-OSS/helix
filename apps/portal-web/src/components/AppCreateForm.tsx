import { useState } from "react";
import { Alert, Box, Button, Group, Radio, Stack, Text, TextInput } from "@mantine/core";
import { SLUG_PATTERN, type App, type Visibility, type VisibilityMode } from "@azx-pbc/shared";
import { useCreateApp } from "../api/mutations";
import { useAuth } from "../auth/AuthProvider";
import { Icon } from "./Icon";
import { useDeployment } from "../lib/deployment";

/**
 * Registering an app: slug + display name + how it's gated. Lives apart from
 * `CreateAppModal` so the form stays testable on its own and a second creation
 * surface (an empty-state page, say) can mount it without the modal chrome —
 * the caller only decides what happens *after* the create.
 */

/**
 * Descriptions answer "who gets in", in the user's terms — not how the platform
 * achieves it. Avoid claims that depend on how the directory itself is set up
 * (whether guest accounts exist and can sign in is a tenant decision, not this
 * app's), and avoid milestone labels, which mean nothing outside the repo.
 */
const VISIBILITY_OPTIONS: Array<{
  mode: VisibilityMode;
  label: string;
  desc: string;
}> = [
  {
    mode: "internal",
    label: "Internal",
    desc: "Anyone who can sign in to your organization. No further check.",
  },
  {
    mode: "group",
    label: "Group-restricted",
    desc: "Sign-in, narrowed to members of one directory group. Not yet available.",
  },
  {
    mode: "password",
    label: "Password",
    desc: "One shared password instead of sign-in, for people outside your organization. Set the password on the Access tab once the app exists.",
  },
  {
    mode: "public",
    label: "Public",
    desc: "No sign-in at all — anyone with the link. Request it from the Access tab once the app exists; an admin has to approve it.",
  },
];

/**
 * Modes you can see but not pick at create time, for two different reasons.
 *
 * `password`/`public` are deferred features whose *rendering* is already gated
 * on deployment policy (`allowPasswordApps`/`allowPublicApps` below) — they're
 * listed-but-locked so the set of surfaces an app can have stays legible.
 * `group` is here because the edge's directory-group check isn't implemented,
 * so offering it would register apps against a gate that never runs. It has no
 * deployment flag and so always renders, disabled. Re-enabling is a one-line
 * removal from this list — the group id field and its validation are kept below
 * for exactly that reason. A follow-up covers the other screens that still
 * offer `group` (the app's Access tab); this list only governs create.
 */
const UNAVAILABLE_AT_CREATE: readonly VisibilityMode[] = ["group", "password", "public"];

export function AppCreateForm({
  onCreated,
  onCancel,
  submitLabel = "Create app",
}: {
  onCreated: (app: App) => void;
  onCancel?: () => void;
  submitLabel?: string;
}) {
  const { authenticated, login, loginAvailable, allowPublicApps, allowPasswordApps } = useAuth();
  // Drop an open-surface option entirely when the deployment forbids it (the
  // remaining ones keep their existing at-create disabled state).
  const options = VISIBILITY_OPTIONS.filter((o) => {
    if (o.mode === "public" && !allowPublicApps) return false;
    if (o.mode === "password" && !allowPasswordApps) return false;
    return true;
  });
  const { appsHost } = useDeployment();
  const create = useCreateApp();
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [mode, setMode] = useState<VisibilityMode>("internal");
  const [groupId, setGroupId] = useState("");

  const slugValid = SLUG_PATTERN.test(slug);
  const valid = slugValid && displayName.trim().length > 0 && (mode !== "group" || groupId.trim());

  function submit() {
    const visibility: Visibility = mode === "group" ? { mode, groupId: groupId.trim() } : { mode };
    create.mutate({ slug, displayName: displayName.trim(), visibility }, { onSuccess: onCreated });
  }

  return (
    <Stack gap="md">
      <Stack gap={6}>
        <TextInput
          label="Subdomain"
          description="Pick the web address for your app. Lowercase letters, numbers, and hyphens."
          placeholder="cost-explorer"
          value={slug}
          onChange={(e) => setSlug(e.currentTarget.value.toLowerCase())}
          error={
            slug && !slugValid
              ? "a-z, 0-9, hyphens; must start and end with a letter or number"
              : undefined
          }
          classNames={{ input: "az-mono" }}
        />
        {/* Live preview of the address they're building. The suffix is fixed by
            the deployment; only the leading label is theirs to choose — showing
            it assembled makes the subdomain concept legible without the word. */}
        {appsHost && (
          <Box className="az-mono" style={{ fontSize: "0.8rem", wordBreak: "break-all" }}>
            <Text span c="dark.2" inherit>
              https://
            </Text>
            <Text
              span
              c={slug && !slugValid ? "red.4" : slug ? "teal.4" : "dark.2"}
              fw={600}
              inherit
            >
              {slug || "cost-explorer"}
            </Text>
            <Text span c="dark.2" inherit>
              .{appsHost}
            </Text>
          </Box>
        )}
      </Stack>
      <TextInput
        label="Display name"
        placeholder="Cost Explorer"
        value={displayName}
        onChange={(e) => setDisplayName(e.currentTarget.value)}
      />
      <Radio.Group
        label="Visibility"
        description="Who can open the app. You can change this later on the app's Access tab."
        value={mode}
        onChange={(v) => setMode(v as VisibilityMode)}
      >
        <Stack gap={8} mt={8}>
          {options.map((o) => (
            <Radio
              key={o.mode}
              value={o.mode}
              label={o.label}
              description={o.desc}
              disabled={UNAVAILABLE_AT_CREATE.includes(o.mode)}
            />
          ))}
        </Stack>
      </Radio.Group>
      {mode === "group" && (
        <TextInput
          label="Group id"
          placeholder="eng-team"
          value={groupId}
          onChange={(e) => setGroupId(e.currentTarget.value)}
          classNames={{ input: "az-mono" }}
        />
      )}

      {create.isError && (
        <Alert color="red" title="Create failed">
          {create.error.message}
        </Alert>
      )}

      {authenticated ? (
        <Group justify="flex-end">
          {onCancel && (
            <Button variant="subtle" color="gray" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button
            leftSection={<Icon name="plus" size={14} />}
            disabled={!valid}
            loading={create.isPending}
            onClick={submit}
          >
            {submitLabel}
          </Button>
        </Group>
      ) : (
        <Group justify="space-between">
          <Text size="sm" c="dark.2">
            Creating an app needs a signed-in actor.
          </Text>
          <Button variant="default" onClick={login} disabled={!loginAvailable}>
            Sign in
          </Button>
        </Group>
      )}
    </Stack>
  );
}
