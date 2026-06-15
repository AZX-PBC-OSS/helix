import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import {
  AppSchema,
  AuthConfigResponseSchema,
  HealthStatusSchema,
  PortalMeResponseSchema,
  VersionSchema,
} from "@helix/shared";
import { fetchJson } from "./client";

/** Server state, keyed for targeted invalidation after mutations. */

export const appsQuery = queryOptions({
  queryKey: ["apps"],
  queryFn: () => fetchJson(z.array(AppSchema), "/api/v1/apps"),
});

export const appQuery = (slug: string) =>
  queryOptions({
    queryKey: ["apps", slug],
    queryFn: () => fetchJson(AppSchema, `/api/v1/apps/${encodeURIComponent(slug)}`),
  });

export const versionsQuery = (slug: string) =>
  queryOptions({
    queryKey: ["apps", slug, "versions"],
    queryFn: () =>
      fetchJson(z.array(VersionSchema), `/api/v1/apps/${encodeURIComponent(slug)}/versions`),
  });

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: () => fetchJson(PortalMeResponseSchema, "/api/v1/me"),
  retry: false,
});

/** Polled for the header's live "all systems" indicator. */
export const healthQuery = queryOptions({
  queryKey: ["health"],
  queryFn: () => fetchJson(HealthStatusSchema, "/health"),
  refetchInterval: 30_000,
  retry: false,
});

export const authConfigQuery = queryOptions({
  queryKey: ["auth", "config"],
  queryFn: () => fetchJson(AuthConfigResponseSchema, "/api/v1/auth/config"),
  staleTime: Infinity,
});
