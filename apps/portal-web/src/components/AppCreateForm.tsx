import { useState } from "react";
import { Alert, Button, Group, Radio, Stack, Text, TextInput } from "@mantine/core";
import { SLUG_PATTERN, type App, type Visibility, type VisibilityMode } from "@azx-pbc/shared";
import { useCreateApp } from "../api/mutations";
import { useAuth } from "../auth/AuthProvider";
import { Icon } from "./Icon";
import { useDeployment } from "../lib/deployment";

/**
 * Registering an app: slug + display name + how it's gated. Shared by the
 * standalone "Register an app" modal and step 1 of the deploy flow, so the two
 * can't drift on what a registration means — the caller only decides what
 * happens *after* the create (navigate to the app, or keep going and deploy).
 */

const VISIBILITY_OPTIONS: Array<{
  mode: VisibilityMode;
  label: string;
  desc: string;
}> = [
  {
    mode: "internal",
    label: "Internal",
    desc: "SSO — any signed-in directory user, guests included. The default.",
  },
  {
    mode: "group",
    label: "Group-restricted",
    desc: "SSO plus a directory-group membership check.",
  },
  { mode: "password", label: "Password", desc: "Shared password gate for external demos (M4)." },
  {
    mode: "public",
    label: "Public",
    desc: "No gate; anonymous quotas. Needs admin approval (M4).",
  },
];

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
  const { appHost } = useDeployment();
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
      <TextInput
        label="Slug"
        description={
          // Falls back to the generic description until the deployment config
          // arrives — we don't preview a host we can't name yet.
          (slug && slugValid && appHost(slug) ? `Will serve at ${appHost(slug)}` : null) ??
          "Lowercase DNS label — it becomes the subdomain and the isolation boundary"
        }
        placeholder="cost-explorer"
        value={slug}
        onChange={(e) => setSlug(e.currentTarget.value.toLowerCase())}
        error={slug && !slugValid ? "a-z, 0-9, hyphens; must start/end alphanumeric" : undefined}
        classNames={{ input: "az-mono" }}
      />
      <TextInput
        label="Display name"
        placeholder="Cost Explorer"
        value={displayName}
        onChange={(e) => setDisplayName(e.currentTarget.value)}
      />
      <Radio.Group
        label="Visibility"
        description="Auth is terminated at the edge — the app ships zero auth code"
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
              disabled={o.mode === "password" || o.mode === "public"}
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
