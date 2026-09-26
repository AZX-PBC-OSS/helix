import { useRef, useState } from "react";
import {
  Box,
  Button,
  Card,
  FileInput,
  Group,
  Loader,
  PasswordInput,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { z } from "zod";
import {
  ProviderImportPreviewResponseSchema,
  type ProviderConfig,
  type ProviderExportDocument,
  type ProviderImportPreviewDiffEntry,
  type ProviderImportPreviewResponse,
  type ProviderImportResponse,
  type ProviderMetadata,
} from "@azx-pbc/shared";
import { fetchJson, PortalApiError } from "../../api/client";
import { useImportProvider } from "../../api/mutations";
import { Eyebrow, Hint } from "../../components/primitives";
import { PROVIDER_FIELD_LABELS, describeTokenPlacement } from "../../lib/providerForm";
import { SENSITIVE_WARNING } from "./ProviderFormPage";

/**
 * The providers page's import card (I-02 T-0027, design.md §Import/export):
 * file picker → parse + validate → preview panel → apply.
 *
 * Validation is the shared schema's own, never a client-side restatement: the
 * picked file goes to the import preview endpoint, which parses it against
 * `ProviderExportDocumentSchema` — the same definition the export emits and the
 * apply accepts — and a 400's issues are the blocking errors. The panel only
 * ever displays configuration fields; credentials are entered for the
 * destination at apply time and never reconstructed, displayed, or imported.
 *
 * Mode is an explicit choice (create-new with environment + required
 * credential entry, or update with an administrator-selected target) — a name
 * collision in create mode is surfaced before apply and blocks it rather than
 * silently becoming an update. A rejected apply leaves the list unchanged; a
 * lost apply response renders outcome not confirmed, with retry gated on a
 * refresh (criterion 10).
 */

type CreatePreview = Extract<ProviderImportPreviewResponse, { mode: "create" }>;
type UpdatePreview = Extract<ProviderImportPreviewResponse, { mode: "update" }>;

type Picked =
  | { phase: "ready"; document: ProviderExportDocument; provider: ProviderConfig }
  | { phase: "blocked"; problems: string[] };

/** The zod issues a 400 preview carries in its error envelope's `details`. */
const PreviewIssuesSchema = z
  .array(
    z.object({
      path: z.array(z.union([z.string(), z.number()])).default([]),
      message: z.string(),
    }),
  )
  .catch([]);

function previewProblems(err: unknown): string[] {
  if (err instanceof PortalApiError) {
    const issues = PreviewIssuesSchema.safeParse(err.details);
    if (issues.success && issues.data.length > 0) {
      return issues.data.map((i) =>
        i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message,
      );
    }
    return [err.message];
  }
  return ["the portal API didn't answer, so the file couldn't be validated"];
}

function diffValue(v: ProviderImportPreviewDiffEntry["current"]): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.join(", ");
  return describeTokenPlacement(v);
}

/** The document's parsed configuration — credential-free by the schema, so nothing here can leak one. */
function ParsedFields({ provider }: { provider: ProviderConfig }) {
  const rows: Array<[string, string]> = [
    ["Reference", provider.ref],
    ["Kind", provider.kind],
    ["Display name", provider.displayName],
    ["Authorize endpoint", provider.authorizeEndpoint],
    ["Token endpoint", provider.tokenEndpoint],
    ["Requested permissions", provider.requestedScopes.join(", ")],
    ["API destinations", provider.apiOrigins.join(", ")],
    ["Token placement", describeTokenPlacement(provider.tokenPlacement)],
  ];
  return (
    <Stack gap={4}>
      {rows.map(([k, v]) => (
        <Text key={k} fz={12.5} lh={1.5} style={{ wordBreak: "break-word" }}>
          {k}:{" "}
          <span className="az-mono" style={{ wordBreak: "break-word" }}>
            {v === "" ? "(none)" : v}
          </span>
        </Text>
      ))}
    </Stack>
  );
}

export function ProviderImportCard({
  providers,
  refreshList,
}: {
  /** The full (unfiltered) provider rows — the update mode's target select. */
  providers: ProviderMetadata[];
  /** Refetch the list; this is what re-enables retry after an unknown outcome. */
  refreshList: () => Promise<unknown>;
}) {
  const importApply = useImportProvider();

  const [file, setFile] = useState<File | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [mode, setMode] = useState<"" | "create" | "update">("");
  const [env, setEnv] = useState<"" | "dev" | "prod">("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [replaceSecret, setReplaceSecret] = useState("");
  const [targetId, setTargetId] = useState<string | null>(null);
  const [createPreview, setCreatePreview] = useState<CreatePreview | null>(null);
  const [updatePreview, setUpdatePreview] = useState<UpdatePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);
  const [notConfirmed, setNotConfirmed] = useState(false);
  // Persistent live region — an announcement inserted together with its region
  // is not reliably announced; a persistent empty one is.
  const [announcement, setAnnouncement] = useState("");
  // A newer pick or choice supersedes an older in-flight preview's answer.
  const previewSeq = useRef(0);

  const clearFlow = () => {
    setFile(null);
    setPicked(null);
    setMode("");
    setEnv("");
    setClientId("");
    setClientSecret("");
    setReplaceSecret("");
    setTargetId(null);
    setCreatePreview(null);
    setUpdatePreview(null);
    setAlert(null);
    setNotConfirmed(false);
    setSubmitAttempted(false);
  };

  const previewCall = (body: {
    document: ProviderExportDocument;
    mode?: "create" | "update";
    env?: "dev" | "prod";
    targetId?: string;
  }) =>
    fetchJson(ProviderImportPreviewResponseSchema, "/api/v1/providers/import/preview", {
      method: "POST",
      body,
    });

  const onFile = async (next: File | null) => {
    clearFlow();
    setFile(next);
    setAnnouncement("");
    if (!next) return;
    const seq = ++previewSeq.current;
    setPreviewing(true);
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(await next.text());
      } catch {
        setPicked({ phase: "blocked", problems: ["the file is not JSON text"] });
        return;
      }
      // Validate-only preview (no mode): the shared schema's parse, server-side.
      const res = await previewCall({ document: raw as ProviderExportDocument });
      if (seq !== previewSeq.current) return;
      if (res.mode !== null) return;
      setPicked({
        phase: "ready",
        // The endpoint validated this document against the shared schema.
        document: raw as ProviderExportDocument,
        provider: res.provider,
      });
    } catch (err) {
      if (seq !== previewSeq.current) return;
      setPicked({ phase: "blocked", problems: previewProblems(err) });
    } finally {
      if (seq === previewSeq.current) setPreviewing(false);
    }
  };

  const runModePreview = async (body: {
    mode: "create" | "update";
    env?: "dev" | "prod";
    targetId?: string;
  }) => {
    if (picked?.phase !== "ready") return;
    const seq = ++previewSeq.current;
    setPreviewing(true);
    setCreatePreview(null);
    setUpdatePreview(null);
    try {
      const res = await previewCall({ document: picked.document, ...body });
      if (seq !== previewSeq.current) return;
      if (res.mode === "create") setCreatePreview(res);
      if (res.mode === "update") setUpdatePreview(res);
    } catch (err) {
      if (seq !== previewSeq.current) return;
      setAlert(
        err instanceof PortalApiError
          ? err.message
          : "the portal API didn't answer, so nothing was proposed",
      );
    } finally {
      if (seq === previewSeq.current) setPreviewing(false);
    }
  };

  const onModeChange = (value: string | null) => {
    setMode(value === "create" || value === "update" ? value : "");
    setSubmitAttempted(false);
    setAlert(null);
    setCreatePreview(null);
    setUpdatePreview(null);
    setEnv("");
    setClientId("");
    setClientSecret("");
    setReplaceSecret("");
    setTargetId(null);
  };

  const onEnvChange = (value: string | null) => {
    const next = value === "dev" || value === "prod" ? value : "";
    setEnv(next);
    setAlert(null);
    setCreatePreview(null);
    if (next !== "") void runModePreview({ mode: "create", env: next });
  };

  const onTargetChange = (value: string | null) => {
    setTargetId(value);
    setAlert(null);
    setUpdatePreview(null);
    if (value) void runModePreview({ mode: "update", targetId: value });
  };

  const credentialError = (value: string, field: string) =>
    mode === "create" && submitAttempted && value === ""
      ? `a client ${field} is required`
      : undefined;

  const ready = picked?.phase === "ready";
  const applyDisabled =
    !ready ||
    mode === "" ||
    previewing ||
    notConfirmed ||
    (mode === "create" && createPreview === null) ||
    // A ref+env collision never becomes an implicit update: applying in this
    // state would conflict, so the admin switches modes or environments.
    (mode === "create" && createPreview?.collision != null) ||
    (mode === "update" && updatePreview === null);

  const onApplied = (result: ProviderImportResponse) => {
    clearFlow();
    setAnnouncement(
      result.outcome === "created"
        ? `Provider created — "${result.provider.ref}" is now in the provider list.`
        : `Provider updated — "${result.provider.ref}" now runs the imported configuration.`,
    );
  };

  const onApplyError = (err: unknown) => {
    if (err instanceof PortalApiError) {
      // A distinguishable rejection (422 validation, 409 conflict or
      // confirmation_required): reported, nothing applied, list untouched.
      setAlert(err.message);
      return;
    }
    // No well-formed answer came back — the outcome is unknown. Nothing is
    // resubmitted automatically; retry waits for a refresh (criterion 10).
    setNotConfirmed(true);
  };

  const apply = () => {
    if (picked?.phase !== "ready" || importApply.isPending || notConfirmed) return;
    setSubmitAttempted(true);
    setAlert(null);
    if (mode === "create") {
      // Client-side credential gate: credentials are never imported, so create
      // mode has no document to fall back on. The server re-runs this rule.
      if (env === "" || clientId === "" || clientSecret === "") {
        setAlert(
          "A new provider needs an environment and both credentials — they are never imported. Enter them and apply again.",
        );
        return;
      }
      if (!createPreview || createPreview.collision) return;
      importApply.mutate(
        { mode: "create", document: picked.document, env, clientId, clientSecret },
        { onSuccess: onApplied, onError: onApplyError },
      );
      return;
    }
    if (mode === "update") {
      if (!targetId || !updatePreview) {
        setAlert(
          "Choose the provider to update first — a matching name is never selected for you.",
        );
        return;
      }
      const sensitive = updatePreview.sensitiveFields.length > 0;
      importApply.mutate(
        {
          mode: "update",
          document: picked.document,
          targetId,
          revision: updatePreview.target.revision,
          ...(replaceSecret !== "" ? { clientSecret: replaceSecret } : {}),
          ...(sensitive ? { confirmInvalidation: true } : {}),
        },
        { onSuccess: onApplied, onError: onApplyError },
      );
    }
  };

  const targetOptions = providers.map((p) => ({
    value: p.id,
    label: `${p.ref} · ${p.env.toUpperCase()} · ${p.displayName}`,
  }));

  return (
    <Card padding="lg" withBorder>
      <Stack gap={12}>
        <Box>
          <Eyebrow mb={8}>Import</Eyebrow>
          <Text fz={12.5} c="dark.2">
            Bring a provider's credential-free JSON into this deployment — preview it, choose create
            or update, then apply. Credentials are never imported: you enter them for the
            destination.
          </Text>
        </Box>

        <Box role="status" mih={0}>
          {announcement && <Text fz={13.5}>{announcement}</Text>}
        </Box>

        {notConfirmed && (
          <Hint
            icon="alert"
            tone="bad"
            action={
              <Button
                size="compact-xs"
                variant="default"
                onClick={() => void refreshList().then(() => setNotConfirmed(false))}
              >
                Refresh the list
              </Button>
            }
          >
            Outcome not confirmed — refresh to see current state before trying again.
          </Hint>
        )}

        {alert && (
          <Box role="alert">
            <Hint icon="alert" tone="bad">
              {alert}
            </Hint>
          </Box>
        )}

        <FileInput
          label="Provider export (JSON)"
          description="pick the file an Export action downloaded — it carries no credentials"
          placeholder="Choose a .json file"
          accept=".json,application/json"
          value={file}
          onChange={(next) => void onFile(next)}
          clearable
          size="xs"
          disabled={importApply.isPending}
        />

        {previewing && (
          <Group gap={8}>
            <Loader size="xs" />
            <Text fz={12.5} c="dark.2">
              Checking the file with the portal API…
            </Text>
          </Group>
        )}

        {picked?.phase === "blocked" && (
          <Box role="alert">
            <Hint icon="alert" tone="bad">
              This file can't be imported — {picked.problems.join(" ")} Nothing was applied.
            </Hint>
          </Box>
        )}

        {picked?.phase === "ready" && (
          <Box role="region" aria-label="Import preview">
            <Stack gap={12}>
              <Stack gap={6}>
                <Eyebrow>Parsed configuration</Eyebrow>
                <ParsedFields provider={picked.provider} />
              </Stack>

              <Select
                label="Import mode"
                description="create a new provider, or update one you pick explicitly"
                placeholder="Choose create or update"
                data={[
                  { value: "create", label: "Create a new provider" },
                  { value: "update", label: "Update an existing provider" },
                ]}
                value={mode === "" ? null : mode}
                onChange={onModeChange}
                allowDeselect={false}
                required
                size="xs"
              />

              {mode === "create" && (
                <Stack gap={12}>
                  <Select
                    label="Environment"
                    description="fixed at create; user consent and app approvals never transfer"
                    placeholder="Choose environment"
                    data={[
                      { value: "dev", label: "Dev" },
                      { value: "prod", label: "Prod" },
                    ]}
                    value={env === "" ? null : env}
                    onChange={onEnvChange}
                    allowDeselect={false}
                    error={
                      env === "" && submitAttempted
                        ? "choose an environment — a provider never moves between them"
                        : undefined
                    }
                    required
                    size="xs"
                  />
                  <Group grow align="flex-start" wrap="wrap">
                    <TextInput
                      label="Client ID"
                      description="from the vendor's app registration — stored sealed, never shown again"
                      value={clientId}
                      onChange={(e) => setClientId(e.currentTarget.value)}
                      error={credentialError(clientId, "ID")}
                      autoComplete="off"
                      size="xs"
                    />
                    <PasswordInput
                      label="Client secret"
                      description="stored sealed, never shown again"
                      value={clientSecret}
                      onChange={(e) => setClientSecret(e.currentTarget.value)}
                      error={credentialError(clientSecret, "secret")}
                      autoComplete="new-password"
                      size="xs"
                    />
                  </Group>
                  {createPreview && !createPreview.collision && (
                    <Text fz={12.5} c="dark.2">
                      No existing provider is named "{createPreview.provider.ref}" in{" "}
                      {createPreview.env.toUpperCase()} — applying creates a new one there.
                    </Text>
                  )}
                  {createPreview?.collision && (
                    <Hint icon="alert" tone="warn">
                      A provider named "{createPreview.collision.ref}" already exists in{" "}
                      {createPreview.collision.env.toUpperCase()} — creating it would conflict.
                      Switch the mode to "Update an existing provider" and select that row
                      explicitly, or choose a different environment.
                    </Hint>
                  )}
                </Stack>
              )}

              {mode === "update" && (
                <Stack gap={12}>
                  <Select
                    label="Update target"
                    description="the provider to apply this document to — a matching name is never selected for you"
                    placeholder="Choose the provider to update"
                    data={targetOptions}
                    value={targetId}
                    onChange={onTargetChange}
                    size="xs"
                  />
                  {updatePreview && (
                    <Stack gap={6}>
                      <Eyebrow>
                        Changes for {updatePreview.target.displayName} ({updatePreview.target.ref} ·{" "}
                        {updatePreview.target.env.toUpperCase()} · revision{" "}
                        {updatePreview.target.revision})
                      </Eyebrow>
                      {updatePreview.diff.length === 0 ? (
                        <Text fz={12.5} c="dark.2">
                          No differences — the document matches the target's current configuration.
                        </Text>
                      ) : (
                        updatePreview.diff.map((line) => (
                          <Text
                            key={line.field}
                            fz={12.5}
                            lh={1.5}
                            style={{ wordBreak: "break-word" }}
                          >
                            {PROVIDER_FIELD_LABELS[line.field] ?? line.field}:{" "}
                            <span className="az-mono" style={{ wordBreak: "break-word" }}>
                              {diffValue(line.current) || "(none)"}
                            </span>{" "}
                            →{" "}
                            <span className="az-mono" style={{ wordBreak: "break-word" }}>
                              {diffValue(line.imported)}
                            </span>
                          </Text>
                        ))
                      )}
                      {updatePreview.sensitiveFields.length > 0 && (
                        <Hint icon="alert" tone="warn">
                          {SENSITIVE_WARNING}
                        </Hint>
                      )}
                    </Stack>
                  )}
                  <PasswordInput
                    label="Replace client secret"
                    description="leave blank to keep the target's existing credential"
                    value={replaceSecret}
                    onChange={(e) => setReplaceSecret(e.currentTarget.value)}
                    autoComplete="new-password"
                    size="xs"
                  />
                </Stack>
              )}
            </Stack>
          </Box>
        )}

        <Group justify="flex-end">
          <Button
            size="xs"
            onClick={apply}
            loading={importApply.isPending}
            disabled={applyDisabled}
          >
            Apply import
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
