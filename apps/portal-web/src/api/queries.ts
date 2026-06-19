import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import {
  AppManifestSchema,
  AppSchema,
  ApprovalRequestSchema,
  AuthConfigResponseSchema,
  CspViolationsPageSchema,
  GatewayAuditPageSchema,
  HealthStatusSchema,
  PasswordCredentialResponseSchema,
  PlatformUsageSchema,
  PortalMeResponseSchema,
  SecretMetadataSchema,
  UsageSummarySchema,
  VersionSchema,
} from "@helix/shared";
import { fetchJson } from "./client";

/** An app's connection secrets — metadata only (the value is never returned). */
export const appSecretsQuery = (slug: string) =>
  queryOptions({
    queryKey: ["apps", slug, "secrets"],
    queryFn: () =>
      fetchJson(z.array(SecretMetadataSchema), `/api/v1/apps/${encodeURIComponent(slug)}/secrets`),
  });

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

/** An app's capability manifest (M4 gateway grants). Open read. */
export const manifestQuery = (slug: string) =>
  queryOptions({
    queryKey: ["apps", slug, "manifest"],
    queryFn: () =>
      fetchJson(AppManifestSchema, `/api/v1/apps/${encodeURIComponent(slug)}/manifest`),
  });

/**
 * Approval requests (docs/design/approvals.md). `app` scopes to one app's queue
 * (owner or admin); without it, the global admin queue. Bearer-gated server-side
 * — callers gate on `authenticated` via the query's `enabled` option.
 */
export const approvalsQuery = (params: { app?: string; status?: string } = {}) =>
  queryOptions({
    queryKey: ["approvals", params],
    queryFn: () => {
      const q = new URLSearchParams();
      if (params.app) q.set("app", params.app);
      if (params.status) q.set("status", params.status);
      const qs = q.toString();
      return fetchJson(z.array(ApprovalRequestSchema), `/api/v1/approvals${qs ? `?${qs}` : ""}`);
    },
  });

/**
 * The current shared-password credential (cleartext). Bearer-gated server-side —
 * gate it on `authenticated` AND password visibility via the query's `enabled`.
 */
export const passwordCredentialQuery = (slug: string) =>
  queryOptions({
    queryKey: ["apps", slug, "password"],
    queryFn: () =>
      fetchJson(
        PasswordCredentialResponseSchema,
        `/api/v1/apps/${encodeURIComponent(slug)}/access/password`,
      ),
    retry: false,
  });

/**
 * Per-app gateway usage over a rolling day window. Bearer-gated server-side, so
 * callers should gate this on `authenticated` via the query's `enabled` option.
 */
export const usageQuery = (slug: string, windowDays = 1) =>
  queryOptions({
    queryKey: ["apps", slug, "usage", windowDays],
    queryFn: () =>
      fetchJson(
        UsageSummarySchema,
        `/api/v1/apps/${encodeURIComponent(slug)}/usage?window=${windowDays}`,
      ),
  });

/** Cross-app gateway audit log, newest-first. Bearer-gated server-side. */
export const gatewayAuditQuery = (
  params: { app?: string; outcome?: string; limit?: number } = {},
) =>
  queryOptions({
    queryKey: ["gateway", "audit", params],
    queryFn: () => {
      const q = new URLSearchParams();
      if (params.app) q.set("app", params.app);
      if (params.outcome) q.set("outcome", params.outcome);
      if (params.limit) q.set("limit", String(params.limit));
      const qs = q.toString();
      return fetchJson(GatewayAuditPageSchema, `/api/v1/gateway/audit${qs ? `?${qs}` : ""}`);
    },
  });

/** Aggregated runtime CSP violations (admin Violations screen). Admin-gated. */
export const cspViolationsQuery = queryOptions({
  queryKey: ["csp", "violations"],
  queryFn: () => fetchJson(CspViolationsPageSchema, "/api/v1/csp/violations"),
});

/** Platform-wide gateway rollup (admin Platform + workspace /usage). Bearer-gated. */
export const platformUsageQuery = queryOptions({
  queryKey: ["gateway", "usage"],
  queryFn: () => fetchJson(PlatformUsageSchema, "/api/v1/gateway/usage"),
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
