import { useState } from "react";
import { Alert, Box, Button, Group, Radio, Stack, Text, TextInput } from "@mantine/core";
import { SLUG_PATTERN, type App, type Visibility, type VisibilityMode } from "@azx-pbc/shared";
import { useCreateApp } from "../api/mutations";
import { GroupPicker } from "./GroupPicker";
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
    desc: "Sign-in, narrowed to members of the directory groups you choose, including any nested inside them. Set the groups on the Access tab once the app exists.",
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
 *
 * `group` is a different case, and the reason has changed — the old one is
 * fixed. The gate (`visibilityAllows`, `apps/edge/src/auth/validate.ts`), the
 * `groups` claim, the group picker and the Access tab are all real and shipped
 * (ADR-0040). What remains is **per-deployment**: a tenant only starts emitting
 * security-group claims once an operator applies
 * `docs/runbooks/entra-group-claims-rollout.md`, and until then the claim is
 * empty and a `group` app denies everyone *including its owner*.
 *
 * That is why it stays locked here but is offered on the Access tab. Choosing
 * `group` at create means the very first thing a brand-new app does is lock its
 * creator out, with nothing yet deployed to explain it — the worst possible first
 * impression of a working feature. On the Access tab the app already exists, the
 * owner can see what it was, and the change is one click to undo.
 *
 * Unlike `password`/`public` there is no deployment flag for it, so it always
 * renders, disabled. Re-enabling is a one-line removal from this list once
 * emitting the claim is the norm rather than a rollout step; the picker below is
 * already wired for it.
 */
const UNAVAILABLE_AT_CREATE: readonly VisibilityMode[] = ["group", "password", "public"];

/**
 * Whether to ask about visibility at all. Off while `internal` is the only
 * selectable option: a four-row control where three rows are locked reads as a
 * choice, and offering a choice with one answer is worse than stating the
 * answer. Flip to `true` when a second mode becomes selectable (see
 * {@link UNAVAILABLE_AT_CREATE}) and the control returns as it was.
 *
 * Typed `boolean` rather than inferred `false` on purpose — it keeps both
 * branches type-checked, so the hidden control can't rot while it's off.
 */
const SHOW_VISIBILITY_AT_CREATE: boolean = false;

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
  const [groupIds, setGroupIds] = useState<string[]>([]);

  const slugValid = SLUG_PATTERN.test(slug);
  const valid =
    slugValid && displayName.trim().length > 0 && (mode !== "group" || groupIds.length > 0);

  function submit() {
    const visibility: Visibility = mode === "group" ? { mode, groupIds } : { mode };
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
      {SHOW_VISIBILITY_AT_CREATE ? (
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
      ) : (
        // Not a control, but don't leave the app's audience unstated either.
        <Text size="sm" c="dark.2" lh={1.5}>
          New apps are <b>Internal</b> by default — anyone who can sign in to your organization can
          open them. You can change this any time on the app&apos;s Access tab.
        </Text>
      )}
      {mode === "group" && <GroupPicker value={groupIds} onChange={setGroupIds} />}

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
            You need to be signed in to create an app.
          </Text>
          <Button variant="default" onClick={login} disabled={!loginAvailable}>
            Sign in
          </Button>
        </Group>
      )}
    </Stack>
  );
}
