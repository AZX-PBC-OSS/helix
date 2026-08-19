import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import {
  AppListItemSchema,
  AppManifestSchema,
  AppSchema,
  ApprovalRequestSchema,
  AuthConfigResponseSchema,
  CollectionItemsPageSchema,
  CollectionSummarySchema,
  CspViolationsPageSchema,
  DeploymentConfigResponseSchema,
  DevTokenMetadataSchema,
  GatewayAuditPageSchema,
  HealthStatusSchema,
  PasswordCredentialResponseSchema,
  PlatformUsageSchema,
  PortalMeResponseSchema,
  SecretMetadataSchema,
  UsageSummarySchema,
  VersionSchema,
  type AppListScope,
  type PlatformRange,
  type UsageRange,
} from "@azx-pbc/shared";
import { fetchJson } from "./client";

/** An app's connection secrets — metadata only (the value is never returned). */
export const appSecretsQuery = (slug: string) =>
  queryOptions({
    queryKey: ["apps", slug, "secrets"],
    queryFn: () =>
      fetchJson(z.array(SecretMetadataSchema), `/api/v1/apps/${encodeURIComponent(slug)}/secrets`),
  });

/** An app's dev-mode tokens — metadata only (the token is shown once, on mint). */
export const devTokensQuery = (slug: string) =>
  queryOptions({
    queryKey: ["apps", slug, "devTokens"],
    queryFn: () =>
      fetchJson(
        z.array(DevTokenMetadataSchema),
        `/api/v1/apps/${encodeURIComponent(slug)}/dev-tokens`,
      ),
  });

/** Global connection secrets (admin) — metadata + the apps each is granted to. */
export const globalSecretsQuery = queryOptions({
  queryKey: ["secrets"],
  queryFn: () => fetchJson(z.array(SecretMetadataSchema), "/api/v1/secrets"),
});

/** Server state, keyed for targeted invalidation after mutations. */

/**
 * The apps list, in one of its two scopes. `mine` is the default the page lands
 * on; `all` is the whole registry, open to any signed-in principal.
 *
 * Keyed `["apps", "list", scope]` rather than `["apps", scope]` so it can never
 * collide with `appQuery`'s `["apps", slug]` — a slug of `all` or `mine` is legal.
 * The extra segment still sits under the `["apps"]` prefix every mutation
 * invalidates, so a create or archive refreshes both scopes.
 */
export const appsQuery = (scope: AppListScope = "mine") =>
  queryOptions({
    queryKey: ["apps", "list", scope],
    queryFn: () =>
      fetchJson(z.array(AppListItemSchema), `/api/v1/apps?scope=${encodeURIComponent(scope)}`),
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

/**
 * An app's capability manifest (M4 gateway grants). Bearer-gated server-side like
 * the rest of `/api/v1` — gate it on `authenticated` via `enabled`, or it 401s in
 * the background for a signed-out visitor.
 */
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
 * Per-app gateway usage over a selectable rolling range. Bearer-gated
 * server-side, so callers should gate this on `authenticated` via `enabled`.
 */
export const usageQuery = (slug: string, range: UsageRange = "24h") =>
  queryOptions({
    queryKey: ["apps", slug, "usage", range],
    queryFn: () =>
      fetchJson(
        UsageSummarySchema,
        `/api/v1/apps/${encodeURIComponent(slug)}/usage?range=${range}`,
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

/**
 * What an app has actually collected, per (collection, env) — drives the picker on
 * the Data tab. Owner-gated server-side, so gate on `authenticated` via `enabled`.
 *
 * Union this with the manifest's declared `data.collections`: this route only
 * knows about names that have rows, so a declared-but-empty collection is absent
 * here, while a collection the manifest no longer declares appears only here.
 */
export const collectionsIndexQuery = (slug: string) =>
  queryOptions({
    queryKey: ["apps", slug, "collections"],
    queryFn: () =>
      fetchJson(
        z.array(CollectionSummarySchema),
        `/api/v1/apps/${encodeURIComponent(slug)}/collections`,
      ),
  });

/**
 * One collection's rows, newest-first. `env` is omitted for "both tiers".
 *
 * v0 shows the newest `limit` rows with no paging — the export covers the
 * complete-data need, and a moving column set (columns are derived from the rows
 * actually loaded) makes incremental paging worse than it looks.
 */
export const collectionItemsQuery = (
  slug: string,
  name: string,
  params: { env?: string; limit?: number } = {},
) =>
  queryOptions({
    queryKey: ["apps", slug, "collections", name, params],
    queryFn: () => {
      const q = new URLSearchParams();
      if (params.env) q.set("env", params.env);
      q.set("limit", String(params.limit ?? 200));
      return fetchJson(
        CollectionItemsPageSchema,
        `/api/v1/apps/${encodeURIComponent(slug)}/collections/${encodeURIComponent(name)}?${q}`,
      );
    },
  });

/** Aggregated runtime CSP violations (admin Violations screen). Admin-gated. */
export const cspViolationsQuery = queryOptions({
  queryKey: ["csp", "violations"],
  queryFn: () => fetchJson(CspViolationsPageSchema, "/api/v1/csp/violations"),
});

/** Platform-wide gateway rollup (admin Platform + workspace /usage). Bearer-gated. */
export const platformUsageQuery = (range: PlatformRange = "30d") =>
  queryOptions({
    queryKey: ["gateway", "usage", range],
    queryFn: () => fetchJson(PlatformUsageSchema, `/api/v1/gateway/usage?range=${range}`),
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

/**
 * This deployment's topology — where apps are served, whether dev mode exists.
 * Public and fetched before sign-in. Fixed for the lifetime of the page, so
 * `staleTime: Infinity`; consume it through `useDeployment()` (lib/deployment.ts)
 * rather than reading it directly.
 */
export const deploymentConfigQuery = queryOptions({
  queryKey: ["config"],
  queryFn: () => fetchJson(DeploymentConfigResponseSchema, "/api/v1/config"),
  staleTime: Infinity,
});
