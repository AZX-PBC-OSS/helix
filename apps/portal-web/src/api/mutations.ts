import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AppManifestSchema,
  AppSchema,
  UploadVersionResponseSchema,
  type Capabilities,
  type CreateAppRequest,
  type App,
  type UploadVersionResponse,
} from "@helix/shared";
import { fetchJson, uploadFile } from "./client";

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

/** Replace an app's capability manifest (M4 gateway grants). */
export function useSetManifest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, capabilities }: { slug: string; capabilities: Capabilities }) =>
      fetchJson(AppManifestSchema, `/api/v1/apps/${encodeURIComponent(slug)}/manifest`, {
        method: "PUT",
        body: { capabilities },
      }),
    onSuccess: (_manifest, { slug }) =>
      void queryClient.invalidateQueries({ queryKey: ["apps", slug, "manifest"] }),
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
