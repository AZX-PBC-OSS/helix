import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AppSchema,
  ApprovalRequestSchema,
  ManifestUpdateResultSchema,
  PasswordCredentialResponseSchema,
  UploadVersionResponseSchema,
  type ApprovalRequest,
  type Capabilities,
  type CreateAppRequest,
  type App,
  type ManifestUpdateResult,
  type PasswordCredentialResponse,
  type UploadVersionResponse,
} from "@helix/shared";
import { fetchJson, requestVoid, uploadFile } from "./client";

/**
 * Mutations against the portal registry. All of them invalidate the affected
 * query keys rather than patching caches — the registry is small and a
 * refetch keeps the UI honest about what the server actually did.
 */

function useAppMutation<Args>(mutationFn: (args: Args) => Promise<App>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (app) => {
      void queryClient.invalidateQueries({ queryKey: ["apps"] });
      void queryClient.invalidateQueries({ queryKey: ["apps", app.slug] });
    },
  });
}

export function useCreateApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAppRequest) =>
      fetchJson(AppSchema, "/api/v1/apps", { method: "POST", body }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["apps"] }),
  });
}

export function usePromoteVersion() {
  return useAppMutation(({ slug, number }: { slug: string; number: number }) =>
    fetchJson(AppSchema, `/api/v1/apps/${encodeURIComponent(slug)}/versions/${number}/promote`, {
      method: "POST",
    }),
  );
}

export function useRollback() {
  return useAppMutation(({ slug, toNumber }: { slug: string; toNumber?: number }) =>
    fetchJson(AppSchema, `/api/v1/apps/${encodeURIComponent(slug)}/rollback`, {
      method: "POST",
      body: toNumber !== undefined ? { toNumber } : {},
    }),
  );
}

export function useArchiveApp() {
  return useAppMutation(({ slug, archive }: { slug: string; archive: boolean }) =>
    fetchJson(
      AppSchema,
      `/api/v1/apps/${encodeURIComponent(slug)}/${archive ? "archive" : "unarchive"}`,
      { method: "POST" },
    ),
  );
}

/**
 * Replace an app's capability manifest, through the approvals write-gate
 * (docs/design/approvals.md §3). Baseline deltas apply immediately; elevated
 * ones open a pending request — the result reports which via `applied`/`pending`.
 */
export function useSetManifest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      slug,
      capabilities,
      reason,
    }: {
      slug: string;
      capabilities: Capabilities;
      reason?: string;
    }): Promise<ManifestUpdateResult> =>
      fetchJson(ManifestUpdateResultSchema, `/api/v1/apps/${encodeURIComponent(slug)}/manifest`, {
        method: "PUT",
        body: { capabilities, ...(reason !== undefined ? { reason } : {}) },
      }),
    onSuccess: (_result, { slug }) => {
      void queryClient.invalidateQueries({ queryKey: ["apps", slug, "manifest"] });
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
    },
  });
}

/**
 * Reviewer/requester decisions on an approval request. Approve applies the
 * deltas (so it can change a manifest or visibility — invalidate `apps` too);
 * deny / needs_changes carry a required note; withdraw is the requester's.
 */
function useApprovalDecision(suffix: "approve" | "deny" | "needs_changes" | "withdraw") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }): Promise<ApprovalRequest> =>
      fetchJson(ApprovalRequestSchema, `/api/v1/approvals/${encodeURIComponent(id)}/${suffix}`, {
        method: "POST",
        ...(note !== undefined ? { body: { note } } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
      void queryClient.invalidateQueries({ queryKey: ["apps"] });
    },
  });
}

export const useApproveRequest = () => useApprovalDecision("approve");
export const useDenyRequest = () => useApprovalDecision("deny");
export const useRequestChanges = () => useApprovalDecision("needs_changes");
export const useWithdrawRequest = () => useApprovalDecision("withdraw");

/** One-click origin grant from the Violations screen — opens an approval request. */
export function useGrantOrigin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      slug,
      origin,
    }: {
      slug: string;
      origin: string;
    }): Promise<ManifestUpdateResult> =>
      fetchJson(
        ManifestUpdateResultSchema,
        `/api/v1/apps/${encodeURIComponent(slug)}/access/origin`,
        {
          method: "POST",
          body: { origin },
        },
      ),
    onSuccess: (_result, { slug }) => {
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
      void queryClient.invalidateQueries({ queryKey: ["csp", "violations"] });
      void queryClient.invalidateQueries({ queryKey: ["apps", slug, "manifest"] });
    },
  });
}

/* ------------------------------------------------------------------------- *
 * Shared-password access (`password` visibility). Enable/disable flip the app's
 * visibility (invalidate the app), so they refetch the app + credential.
 * ------------------------------------------------------------------------- */

function invalidatePassword(queryClient: ReturnType<typeof useQueryClient>, slug: string) {
  void queryClient.invalidateQueries({ queryKey: ["apps"] });
  void queryClient.invalidateQueries({ queryKey: ["apps", slug] });
  void queryClient.invalidateQueries({ queryKey: ["apps", slug, "password"] });
}

/** Enable password access (mints a passphrase) — returns the credential. */
export function useEnablePassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug }: { slug: string }): Promise<PasswordCredentialResponse> =>
      fetchJson(
        PasswordCredentialResponseSchema,
        `/api/v1/apps/${encodeURIComponent(slug)}/access/password`,
        { method: "POST" },
      ),
    onSuccess: (_res, { slug }) => invalidatePassword(queryClient, slug),
  });
}

/** Rotate the password — reroll (no body) or set a manual one (≥12 chars). */
export function useRotatePassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      slug,
      password,
    }: {
      slug: string;
      password?: string;
    }): Promise<PasswordCredentialResponse> =>
      fetchJson(
        PasswordCredentialResponseSchema,
        `/api/v1/apps/${encodeURIComponent(slug)}/access/password/rotate`,
        { method: "POST", body: password !== undefined ? { password } : {} },
      ),
    onSuccess: (_res, { slug }) => invalidatePassword(queryClient, slug),
  });
}

/** Disable password access — reverts the app to private. */
export function useDisablePassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug }: { slug: string }) =>
      requestVoid(`/api/v1/apps/${encodeURIComponent(slug)}/access/password`, { method: "DELETE" }),
    onSuccess: (_res, { slug }) => invalidatePassword(queryClient, slug),
  });
}

export function useUploadVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, file }: { slug: string; file: File }): Promise<UploadVersionResponse> =>
      uploadFile(
        UploadVersionResponseSchema,
        `/api/v1/apps/${encodeURIComponent(slug)}/versions`,
        "bundle",
        file,
      ),
    onSuccess: (_res, { slug }) => {
      void queryClient.invalidateQueries({ queryKey: ["apps", slug, "versions"] });
    },
  });
}
