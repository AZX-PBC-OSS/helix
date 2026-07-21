import { useState } from "react";
import { useNavigate } from "react-router";
import { Alert, Button, Group, Modal, Radio, Stack, Text, TextInput } from "@mantine/core";
import { SLUG_PATTERN, type Visibility, type VisibilityMode } from "@azx-pbc/shared";
import { useCreateApp } from "../api/mutations";
import { useAuth } from "../auth/AuthProvider";
import { Icon } from "../components/Icon";
import { appHost } from "../lib/format";

const VISIBILITY_OPTIONS: Array<{
  mode: VisibilityMode;
  label: string;
  desc: string;
}> = [
  { mode: "private", label: "Private", desc: "SSO — any authenticated user. The default." },
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

export function CreateAppModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const { authenticated, login, loginAvailable, allowPublicApps, allowPasswordApps } = useAuth();
  // Drop an open-surface option entirely when the deployment forbids it (the
  // remaining ones keep their existing at-create disabled state).
  const options = VISIBILITY_OPTIONS.filter((o) => {
    if (o.mode === "public" && !allowPublicApps) return false;
    if (o.mode === "password" && !allowPasswordApps) return false;
    return true;
  });
  const create = useCreateApp();
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [mode, setMode] = useState<VisibilityMode>("private");
  const [groupId, setGroupId] = useState("");

  const slugValid = SLUG_PATTERN.test(slug);
  const valid = slugValid && displayName.trim().length > 0 && (mode !== "group" || groupId.trim());

  function reset() {
    setSlug("");
    setDisplayName("");
    setMode("private");
    setGroupId("");
    create.reset();
  }

  function submit() {
    const visibility: Visibility = mode === "group" ? { mode, groupId: groupId.trim() } : { mode };
    create.mutate(
      { slug, displayName: displayName.trim(), visibility },
      {
        onSuccess: (app) => {
          reset();
          onClose();
          void navigate(`/apps/${app.slug}`);
        },
      },
    );
  }

  return (
    <Modal
      opened={opened}
      onClose={() => {
        reset();
        onClose();
      }}
      title={
        <Text ff="heading" fw={600}>
          Register an app
        </Text>
      }
      size="lg"
    >
      <Stack gap="md">
        <TextInput
          label="Slug"
          description={
            slug && slugValid
              ? `Will serve at ${appHost(slug)}`
              : "Lowercase DNS label — it becomes the subdomain and the isolation boundary"
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
            <Button variant="subtle" color="gray" onClick={onClose}>
              Cancel
            </Button>
            <Button
              leftSection={<Icon name="plus" size={14} />}
              disabled={!valid}
              loading={create.isPending}
              onClick={submit}
            >
              Create app
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
    </Modal>
  );
}
