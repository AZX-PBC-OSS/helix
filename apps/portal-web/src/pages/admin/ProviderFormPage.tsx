import { useRef, useState } from "react";
import {
  Alert,
  Anchor,
  Box,
  Button,
  Card,
  Center,
  Group,
  Loader,
  Modal,
  PasswordInput,
  Select,
  Stack,
  TagsInput,
  Text,
  TextInput,
} from "@mantine/core";
import { Link, useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ConfirmationRequiredDetailsSchema,
  type ProviderImpact,
  type ProviderMetadata,
  type ProviderUpdateRequest,
} from "@azx-pbc/shared";
import { providerImpactQuery, providerQuery } from "../../api/queries";
import { useCreateProvider, useDeleteProvider, useUpdateProvider } from "../../api/mutations";
import { PortalApiError } from "../../api/client";
import { Icon } from "../../components/Icon";
import { Eyebrow, Hint, PageHead, ToneBadge } from "../../components/primitives";
import {
  EMPTY_PROVIDER_FORM,
  buildCreateBody,
  buildUpdateBody,
  diffLines,
  fieldErrors,
  formValuesFromMetadata,
  isFormValid,
  sensitiveDeltaFromForm,
  type ProviderDiffLine,
  type ProviderFormValues,
} from "../../lib/providerForm";

/**
 * Provider create + edit (`/admin/providers/new` and `/admin/providers/:id`,
 * I-02 T-0026) — the dedicated edit route (design decision 14): the draft is
 * page state, seeded on load and reseeded only by the page's own actions
 * (save success, explicit Reload), so a background list refresh can never
 * discard it.
 *
 * Save outcomes (design.md §Provider create/edit table): a non-sensitive edit
 * applies with a success banner and a reseed; a sensitive delta fetches the
 * impact counts and opens the review panel before anything is sent; a stale
 * save (409 revision) shows the reload-review-confirm message with the draft
 * preserved; a lost response is "outcome not confirmed" and disables retry
 * until a refresh. Deletion shares the review panel with its impact counts.
 */

type ReviewState =
  | { mode: "edit"; body: ProviderUpdateRequest; diff: ProviderDiffLine[]; impact: ProviderImpact }
  | { mode: "delete"; impact: ProviderImpact };

/** The criterion-7 warning sentence, verbatim in meaning. */
const SENSITIVE_WARNING =
  "Existing connections and pending consent attempts become invalid, and affected apps need approval again. Helix does not create reapproval requests for them.";
/** The criterion-9 statement for deletion. */
const DELETE_WARNING =
  "Deleting invalidates the provider's existing user connections and pending consent attempts, and affected apps need approval again. Recreating a provider with the same reference restores neither old consent nor old approvals.";

function ImpactList({ impact }: { impact: ProviderImpact }) {
  return (
    <Stack gap={4}>
      <Text fz={12.5}>
        Apps bound:{" "}
        {impact.boundApps.length === 0 ? "none" : impact.boundApps.map((a) => a.slug).join(", ")}
      </Text>
      <Text fz={12.5}>User connections: {impact.connections.toLocaleString()}</Text>
      <Text fz={12.5}>Pending consent attempts: {impact.pendingAttempts.toLocaleString()}</Text>
    </Stack>
  );
}

function ReviewPanel({
  review,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  review: ReviewState;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const deleting = review.mode === "delete";
  return (
    <Modal
      opened
      onClose={onCancel}
      title={deleting ? "Delete provider" : "Review sensitive change"}
      centered
    >
      <Stack gap="sm">
        {review.mode === "edit" && review.diff.length > 0 && (
          <Stack gap={6}>
            <Eyebrow>Changes</Eyebrow>
            {review.diff.map((line) => (
              <Text key={line.field} fz={12.5} lh={1.5} style={{ wordBreak: "break-word" }}>
                {line.label}: <span className="az-mono">{line.current || "(none)"}</span> →{" "}
                <span className="az-mono">{line.proposed}</span>
              </Text>
            ))}
          </Stack>
        )}
        <ImpactList impact={review.impact} />
        {/* Status is never color-only: tone + icon + the sentence itself. */}
        <Hint icon="alert" tone="warn">
          {deleting ? DELETE_WARNING : SENSITIVE_WARNING}
        </Hint>
        {error && (
          <Alert color="red" py={8} role="alert">
            {error}
          </Alert>
        )}
        <Group justify="flex-end" mt="xs">
          <Button variant="subtle" color="gray" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            color={deleting ? "red" : undefined}
            loading={busy}
            onClick={onConfirm}
            data-autofocus
          >
            {deleting ? "Delete provider" : "Confirm change"}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function ProviderFormPage() {
  const { id } = useParams();
  const isEdit = id !== undefined;
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const provider = useQuery({ ...providerQuery(id ?? ""), enabled: isEdit });
  const create = useCreateProvider();
  const update = useUpdateProvider();
  const del = useDeleteProvider();

  // The draft and the metadata it was seeded from travel together: the seed
  // carries the revision the CAS compares against and the values the diff
  // reviews against. Reseeded only on load, save success, and explicit Reload
  // — never by a background refetch of the same provider.
  const [draft, setDraft] = useState<{ seed: ProviderMetadata | null; values: ProviderFormValues }>(
    () => ({ seed: null, values: { ...EMPTY_PROVIDER_FORM } }),
  );
  const [review, setReview] = useState<ReviewState | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [notConfirmed, setNotConfirmed] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [touched, setTouched] = useState<Partial<Record<keyof ProviderFormValues, boolean>>>({});
  const [alert, setAlert] = useState<string | null>(null);
  // Persistent live region (an announcement inserted together with its region
  // is not reliably announced; a persistent empty one is).
  const [announcement, setAnnouncement] = useState("");
  // The control that opened the review panel — focus returns to it on close
  // (the panel is a modal dialog; Mantine's unmount path does not restore).
  const reviewTriggerRef = useRef<HTMLElement | null>(null);

  const mode = isEdit ? "edit" : "create";
  const seed = draft.seed;
  const values = draft.values;

  // Seed once per provider, during render (React's endorsed alternative to a
  // setState-in-effect): the first load, or a different provider after
  // in-place navigation. Background refetches of the SAME provider never pass
  // this gate — the draft survives them untouched.
  if (isEdit && provider.data && (seed === null || seed.id !== provider.data.id)) {
    setDraft({ seed: provider.data, values: formValuesFromMetadata(provider.data) });
  }

  const patch = (next: Partial<ProviderFormValues>) =>
    setDraft((d) => ({ ...d, values: { ...d.values, ...next } }));
  const markTouched = (field: keyof ProviderFormValues) =>
    setTouched((t) => ({ ...t, [field]: true }));

  const errors = fieldErrors(values, mode);
  const showField = (field: keyof ProviderFormValues) =>
    submitAttempted || touched[field] ? errors[field] : undefined;

  const requiredMissing =
    values.displayName.trim() === "" ||
    values.authorizeEndpoint.trim() === "" ||
    values.tokenEndpoint.trim() === "" ||
    values.apiOrigins.length === 0 ||
    (mode === "create" &&
      (values.ref.trim() === "" || values.env === "" || !values.clientId || !values.clientSecret));

  const clearOutcomeState = () => {
    setStale(false);
    setNotConfirmed(false);
    setImpactError(null);
    setReviewError(null);
  };

  /** Explicit refresh: fetch current state and reseed from it — this is also
   * what re-enables retry after an ambiguous failure. */
  const reload = async () => {
    if (!isEdit) return;
    const res = await provider.refetch();
    clearOutcomeState();
    setSubmitAttempted(false);
    setAlert(null);
    if (res.data) setDraft({ seed: res.data, values: formValuesFromMetadata(res.data) });
  };

  /** Close the panel and hand focus back to the control that opened it. */
  const closeReview = () => {
    setReview(null);
    setReviewError(null);
    reviewTriggerRef.current?.focus();
    reviewTriggerRef.current = null;
  };

  const onMutationError = (err: unknown, pendingBody: ProviderUpdateRequest) => {
    if (err instanceof PortalApiError) {
      if (err.status === 409 && err.code === "confirmation_required") {
        // The server is the confirmation gate's other half: a sensitive delta
        // that arrived unacknowledged (the stored row changed since the seed)
        // surfaces the same panel, impact payload included — the client cannot
        // bypass the confirmation by construction.
        const details = ConfirmationRequiredDetailsSchema.safeParse(err.details);
        if (details.success) {
          setReview({
            mode: "edit",
            body: pendingBody,
            diff: diffLines(seed!, values),
            impact: details.data.impact,
          });
          return;
        }
      }
      if (err.status === 409 && err.code === "conflict") {
        // The stale-save rejection — reload, review, confirm again, with the
        // draft preserved while the message is up. (A create's 409 duplicate
        // routes through the generic message below.)
        closeReview();
        setStale(true);
        return;
      }
      closeReview();
      setAlert(err.message);
      return;
    }
    // No well-formed answer came back — the outcome is unknown. Nothing is
    // resubmitted automatically; retry waits for a refresh (criterion 10).
    closeReview();
    setNotConfirmed(true);
  };

  const save = async () => {
    if (isEdit && seed === null) return;
    setSubmitAttempted(true);
    setAlert(null);
    clearOutcomeState();
    if (!isFormValid(fieldErrors(values, mode))) {
      // Submission-time alert — assertive, once, on the summary; the inline
      // field errors stay polite.
      setAlert("Fix the highlighted fields before saving.");
      return;
    }
    if (mode === "create") {
      create.mutate(buildCreateBody(values), {
        onSuccess: (created) => navigate(`/admin/providers/${created.id}`),
        onError: (err) => {
          if (err instanceof PortalApiError) setAlert(err.message);
          else setNotConfirmed(true);
        },
      });
      return;
    }
    const body = buildUpdateBody(seed!, values);
    const delta = sensitiveDeltaFromForm(seed!, values);
    if (delta.length === 0) {
      update.mutate(
        { id: id!, body },
        {
          onSuccess: (result) => {
            clearOutcomeState();
            setDraft({ seed: result, values: formValuesFromMetadata(result) });
            setAnnouncement("Saved — the provider now runs on these settings.");
          },
          onError: (err) => onMutationError(err, body),
        },
      );
      return;
    }
    // Sensitive: the impact counts are fetched BEFORE the panel renders — the
    // panel never opens without them, and nothing is sent yet.
    try {
      const impact = await queryClient.fetchQuery(providerImpactQuery(id!));
      reviewTriggerRef.current = document.activeElement as HTMLElement | null;
      setReview({ mode: "edit", body, diff: diffLines(seed!, values), impact });
    } catch (err) {
      setImpactError(
        `Couldn't load the impact counts${err instanceof PortalApiError ? `: ${err.message}` : ""} — nothing was saved.`,
      );
    }
  };

  const openDeleteReview = async () => {
    if (!id) return;
    setImpactError(null);
    try {
      const impact = await queryClient.fetchQuery(providerImpactQuery(id));
      reviewTriggerRef.current = document.activeElement as HTMLElement | null;
      setReview({ mode: "delete", impact });
    } catch (err) {
      setImpactError(
        `Couldn't load the impact counts${err instanceof PortalApiError ? `: ${err.message}` : ""} — nothing was deleted.`,
      );
    }
  };

  const confirmReview = () => {
    if (!review || !id) return;
    if (review.mode === "delete") {
      del.mutate(
        { id, confirmInvalidation: true },
        {
          onSuccess: (result) => {
            closeReview();
            if (result.outcome === "already_removed") {
              setAnnouncement("Already removed — this provider was already deleted.");
            } else {
              navigate("/admin/providers");
            }
          },
          onError: (err) => {
            closeReview();
            if (err instanceof PortalApiError) setAlert(err.message);
            else setNotConfirmed(true);
          },
        },
      );
      return;
    }
    update.mutate(
      { id, body: { ...review.body, confirmInvalidation: true } },
      {
        onSuccess: (result) => {
          closeReview();
          clearOutcomeState();
          setDraft({ seed: result, values: formValuesFromMetadata(result) });
          setAnnouncement("Saved — the provider now runs on these settings.");
        },
        onError: (err) => onMutationError(err, review.body),
      },
    );
  };

  const cancelReview = () => {
    // Cancellation returns to the form with the draft intact — nothing was
    // sent — and focus back to the control that opened the panel.
    setReview(null);
    setReviewError(null);
    reviewTriggerRef.current?.focus();
    reviewTriggerRef.current = null;
  };

  const notConfirmedHint = isEdit
    ? {
        label: "Refresh",
        action: () => void reload(),
      }
    : {
        label: "Check the list",
        action: () => navigate("/admin/providers"),
      };

  /* ------------------------------------------------------------------ */

  if (!isEdit) {
    return (
      <FormShell
        title="New provider"
        sub="Register a vendor OAuth provider for one environment. The reference and environment are fixed at create."
        envBadge={null}
        backLink={<BackLink />}
        announcement={announcement}
        alert={alert}
        stale={false}
        onReload={() => void reload()}
        notConfirmed={notConfirmed}
        notConfirmedAction={notConfirmedHint}
        form={
          <ProviderFormFields
            values={values}
            mode="create"
            showField={showField}
            patch={patch}
            markTouched={markTouched}
          />
        }
        saveRow={
          <SaveRow
            label="Create provider"
            pending={create.isPending}
            disabled={requiredMissing || notConfirmed}
            onClick={() => void save()}
          />
        }
      />
    );
  }

  if (provider.isPending) {
    return (
      <Center py={120}>
        <Loader />
      </Center>
    );
  }
  if (provider.isError && !provider.data) {
    return (
      <div className="az-stagger">
        <BackLink />
        <Hint
          icon="alert"
          tone="bad"
          action={
            <Button size="compact-xs" variant="default" component={Link} to="/admin/providers">
              Back to the list
            </Button>
          }
        >
          {provider.error instanceof PortalApiError && provider.error.status === 404
            ? "This provider no longer exists — it may have been deleted in another tab."
            : `Couldn't load the provider: ${provider.error.message}`}
        </Hint>
      </div>
    );
  }

  const meta = seed ?? provider.data!;
  return (
    <FormShell
      title={meta.displayName}
      sub={`${meta.ref} · environment ${meta.env === "dev" ? "Dev" : "Prod"} · revision ${meta.revision}. Background list refreshes never touch this draft.`}
      envBadge={meta.env}
      backLink={<BackLink />}
      announcement={announcement}
      alert={alert}
      stale={stale}
      onReload={() => void reload()}
      notConfirmed={notConfirmed}
      notConfirmedAction={notConfirmedHint}
      form={
        <ProviderFormFields
          values={values}
          mode="edit"
          showField={showField}
          patch={patch}
          markTouched={markTouched}
        />
      }
      saveRow={
        <SaveRow
          label="Save changes"
          pending={update.isPending}
          disabled={requiredMissing || notConfirmed}
          onClick={() => void save()}
        />
      }
      deleteCard={
        <Card withBorder mt={18} p="lg">
          <Group justify="space-between" align="center" wrap="wrap" gap="md">
            <Stack gap={4} style={{ minWidth: 0 }}>
              <Text fz={13.5} fw={600}>
                Delete this provider
              </Text>
              <Text fz={12} c="dark.2">
                Removal invalidates its user connections and pending consent attempts, and affected
                apps need approval again. The impact counts are shown before anything is deleted.
              </Text>
            </Stack>
            <Button
              variant="subtle"
              color="red"
              leftSection={<Icon name="x" size={14} />}
              loading={del.isPending}
              disabled={notConfirmed}
              onClick={() => void openDeleteReview()}
            >
              Delete provider
            </Button>
          </Group>
        </Card>
      }
    >
      {review && (
        <ReviewPanel
          review={review}
          busy={update.isPending || del.isPending}
          error={reviewError}
          onConfirm={confirmReview}
          onCancel={cancelReview}
        />
      )}
      {impactError && (
        <Box mb={16}>
          <Hint icon="alert" tone="bad">
            {impactError}
          </Hint>
        </Box>
      )}
    </FormShell>
  );
}

function BackLink() {
  return (
    <Anchor component={Link} to="/admin/providers" size="sm" c="dark.2" mb={16}>
      Providers
    </Anchor>
  );
}

function SaveRow({
  label,
  pending,
  disabled,
  onClick,
}: {
  label: string;
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Group justify="flex-end" mt={18} gap={10}>
      <Button
        onClick={onClick}
        loading={pending}
        disabled={disabled}
        leftSection={<Icon name="check" size={14} />}
      >
        {label}
      </Button>
    </Group>
  );
}

interface ShellProps {
  title: string;
  sub: string;
  envBadge: "dev" | "prod" | null;
  backLink: React.ReactNode;
  announcement: string;
  alert: string | null;
  stale: boolean;
  onReload: () => void;
  notConfirmed: boolean;
  notConfirmedAction: { label: string; action: () => void };
  form: React.ReactNode;
  saveRow: React.ReactNode;
  deleteCard?: React.ReactNode;
  children?: React.ReactNode;
}

function FormShell(props: ShellProps) {
  return (
    <div className="az-stagger">
      {props.backLink}
      <PageHead
        eyebrow="Admin"
        title={props.title}
        sub={props.sub}
        actions={
          props.envBadge && (
            <ToneBadge tone={props.envBadge === "dev" ? "info" : "warn"} icon="dot">
              {props.envBadge === "dev" ? "DEV" : "PROD"}
            </ToneBadge>
          )
        }
      />

      {/* Persistent live region for post-action announcements — they do not move focus. */}
      <Box role="status" mb={14} mih={0}>
        {props.announcement && <Text fz={13.5}>{props.announcement}</Text>}
      </Box>

      {props.stale && (
        <Box mb={16}>
          <Hint
            icon="alert"
            tone="warn"
            action={
              <Button size="compact-xs" variant="default" onClick={props.onReload}>
                Reload
              </Button>
            }
          >
            These settings changed since you loaded them. Reload, review the current settings, and
            confirm again. Your draft is preserved while you review.
          </Hint>
        </Box>
      )}

      {props.notConfirmed && (
        <Box mb={16}>
          <Hint
            icon="alert"
            tone="bad"
            action={
              <Button size="compact-xs" variant="default" onClick={props.notConfirmedAction.action}>
                {props.notConfirmedAction.label}
              </Button>
            }
          >
            Outcome not confirmed — refresh to see current state before trying again.
          </Hint>
        </Box>
      )}

      {props.alert && (
        <Box role="alert" mb={16}>
          <Hint icon="alert" tone="bad">
            {props.alert}
          </Hint>
        </Box>
      )}

      {props.children}
      {props.form}
      {props.saveRow}
      {props.deleteCard}
    </div>
  );
}

/**
 * The field contract (design.md §Provider create/edit): every input visibly
 * labeled, errors rendered on the input (associated and announced — polite
 * inline), the environment and reference immutable on edit, the client secret
 * blank-keeps on rotation, token placement of Bearer or named header only.
 */
function ProviderFormFields({
  values,
  mode,
  showField,
  patch,
  markTouched,
}: {
  values: ProviderFormValues;
  mode: "create" | "edit";
  showField: (field: keyof ProviderFormValues) => string | undefined;
  patch: (next: Partial<ProviderFormValues>) => void;
  markTouched: (field: keyof ProviderFormValues) => void;
}) {
  const editing = mode === "edit";
  return (
    <Card withBorder p="lg">
      <Stack gap={14}>
        <Group grow align="flex-start" wrap="wrap">
          <TextInput
            label="Reference"
            description="lowercase letters, digits, hyphens — how apps and manifests name this provider"
            placeholder="e.g. asana"
            value={values.ref}
            onChange={(e) => patch({ ref: e.currentTarget.value })}
            onBlur={() => markTouched("ref")}
            error={showField("ref")}
            disabled={editing}
            required
            size="xs"
            classNames={{ input: "az-mono" }}
          />
          <Select
            label="Environment"
            description={
              editing
                ? "immutable after create — a provider never moves between environments"
                : "fixed at create; user consent and app approvals never transfer"
            }
            placeholder="Choose environment"
            data={[
              { value: "dev", label: "Dev" },
              { value: "prod", label: "Prod" },
            ]}
            value={values.env === "" ? null : values.env}
            onChange={(v) => patch({ env: (v as "dev" | "prod") ?? "" })}
            onBlur={() => markTouched("env")}
            error={showField("env")}
            disabled={editing}
            allowDeselect={false}
            required
            size="xs"
          />
        </Group>

        <TextInput
          label="Display name"
          description="shown to app authors and connecting users"
          placeholder="e.g. Asana"
          value={values.displayName}
          onChange={(e) => patch({ displayName: e.currentTarget.value })}
          onBlur={() => markTouched("displayName")}
          error={showField("displayName")}
          required
          size="xs"
        />

        <Group grow align="flex-start" wrap="wrap">
          <TextInput
            label="Authorize endpoint"
            placeholder="https://vendor.example/oauth/authorize"
            value={values.authorizeEndpoint}
            onChange={(e) => patch({ authorizeEndpoint: e.currentTarget.value })}
            onBlur={() => markTouched("authorizeEndpoint")}
            error={showField("authorizeEndpoint")}
            required
            size="xs"
            classNames={{ input: "az-mono" }}
          />
          <TextInput
            label="Token endpoint"
            placeholder="https://vendor.example/oauth/token"
            value={values.tokenEndpoint}
            onChange={(e) => patch({ tokenEndpoint: e.currentTarget.value })}
            onBlur={() => markTouched("tokenEndpoint")}
            error={showField("tokenEndpoint")}
            required
            size="xs"
            classNames={{ input: "az-mono" }}
          />
        </Group>

        <Group grow align="flex-start" wrap="wrap">
          <TextInput
            label="Client ID"
            description={
              editing
                ? "leave blank to keep the stored one — supplying a new client ID is a sensitive change"
                : "from the vendor's app registration — stored sealed, never shown again"
            }
            value={values.clientId}
            onChange={(e) => patch({ clientId: e.currentTarget.value })}
            onBlur={() => markTouched("clientId")}
            error={showField("clientId")}
            required={!editing}
            size="xs"
            autoComplete="off"
          />
          <PasswordInput
            label="Client secret"
            description={
              editing
                ? "leave blank to keep the existing secret — a new value rotates it without invalidating connections"
                : "stored sealed, never shown again"
            }
            value={values.clientSecret}
            onChange={(e) => patch({ clientSecret: e.currentTarget.value })}
            onBlur={() => markTouched("clientSecret")}
            error={showField("clientSecret")}
            required={!editing}
            size="xs"
            autoComplete="new-password"
          />
        </Group>

        <TagsInput
          label="Requested permissions"
          description="OAuth scopes requested during consent, e.g. read:tasks"
          value={values.requestedScopes}
          onChange={(v) => patch({ requestedScopes: v })}
          onBlur={() => markTouched("requestedScopes")}
          error={showField("requestedScopes")}
          size="xs"
        />
        <TagsInput
          label="API destinations"
          description="origins the provider's token may be sent to — scheme://host[:port], no path"
          placeholder="https://api.vendor.example"
          value={values.apiOrigins}
          onChange={(v) => patch({ apiOrigins: v })}
          onBlur={() => markTouched("apiOrigins")}
          error={showField("apiOrigins")}
          size="xs"
        />

        <Group grow align="flex-start" wrap="wrap">
          <Select
            label="Token placement"
            description="how the user's access token reaches the vendor's API — query-string and signing recipes are not offered"
            data={[
              { value: "header-bearer", label: "Authorization: Bearer header" },
              { value: "header", label: "Named header" },
            ]}
            value={values.placementKind}
            onChange={(v) =>
              patch({
                placementKind: (v as ProviderFormValues["placementKind"]) ?? "header-bearer",
              })
            }
            allowDeselect={false}
            size="xs"
          />
          {values.placementKind === "header" && (
            <TextInput
              label="Header name"
              description="the header the access token is sent in, verbatim"
              placeholder="x-vendor-token"
              value={values.headerName}
              onChange={(e) => patch({ headerName: e.currentTarget.value })}
              onBlur={() => markTouched("headerName")}
              error={showField("headerName")}
              required
              size="xs"
              classNames={{ input: "az-mono" }}
            />
          )}
        </Group>
      </Stack>
    </Card>
  );
}
