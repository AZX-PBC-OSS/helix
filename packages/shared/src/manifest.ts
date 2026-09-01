import { z } from "zod";
import { VisibilitySchema } from "./visibility.js";

/**
 * The per-app manifest (architecture §6.3) — editable in the portal, versioned.
 * It declares the capabilities the gateway will enforce. Grants above a baseline
 * (arbitrary MCP servers / external origins, high LLM budgets) require admin
 * approval; that policy lives in the control plane, not in this shape.
 *
 * Mirrors the YAML in §6.3:
 *
 *   app: cost-explorer
 *   visibility: internal
 *   capabilities:
 *     llm: { models: [claude-haiku-4-5, claude-fable-5], dollars_per_day: 5.00 }
 *     data: { user: true, collections: [contacts] }
 *     mcp: [azure-billing]
 *     external_origins: []
 */
export const LlmCapabilitySchema = z.object({
  models: z.array(z.string()).default([]),
  /**
   * Per-app daily LLM spend cap in USD; unset ⇒ unbounded. Denominated in
   * dollars (not tokens) so the cap means the same thing across models — the
   * edge prices each call via `@azx-pbc/shared` pricing and enforces a daily +
   * rolling-hour burst window off the frozen `costMicroUsd` ledger column.
   */
  dollarsPerDay: z.number().positive().optional(),
});
export type LlmCapability = z.infer<typeof LlmCapabilitySchema>;

/**
 * App-data grants (app-data design §3/§4). The three scopes are named access
 * patterns, not a symmetric KV — the writer and reader can be different
 * principals, so read and write are independent grants:
 *  - `user`: per-user private store, auto-partitioned by the session user (§3.1).
 *  - `collections`: append-only from the app; the owner drains them via the
 *    portal. There is deliberately NO app-facing read (§3.2) — the absence is
 *    the security property.
 *  - `sharedRead` / `sharedWrite`: app-scoped, world-readable keys (§3.3). Rare,
 *    explicit, and dangerous; a write grant never implies a read grant.
 * `writesPerDay` / `bytesPerDay` bound abuse on the open append surface (§7).
 */
export const DataCapabilitySchema = z.object({
  user: z.boolean().default(false),
  collections: z.array(z.string().min(1)).default([]),
  sharedRead: z.array(z.string().min(1)).default([]),
  sharedWrite: z.array(z.string().min(1)).default([]),
  writesPerDay: z.int().positive().optional(),
  bytesPerDay: z.int().positive().optional(),
});
export type DataCapability = z.infer<typeof DataCapabilitySchema>;

/**
 * A proxied outbound origin (fetch-proxy design §4/§5). An origin listed here is
 * reached **through `/_api/fetch`** (the `helix-egress` mechanism plane) — audited,
 * metered, SSRF-controlled — as opposed to a `direct` browser call widened into
 * CSP via `externalOrigins`. `connection` names a stored secret
 * (`docs/design/secrets-and-connections.md`) injected server-side; absent ⇒ a
 * keyless proxied call.
 */
export const FetchConnectionSchema = z.object({
  origin: z.url(),
  connection: z.string().min(1).optional(),
});
export type FetchConnection = z.infer<typeof FetchConnectionSchema>;

/** The fetch-proxy capability: proxied origins + ergonomics + abuse budget. */
export const FetchCapabilitySchema = z.object({
  /** Opt-in transparent `fetch` shim injected at serve time (fetch-proxy §3.2). */
  shim: z.boolean().default(false),
  /** Origins reached through the proxy (mode `proxy`); direct stays in `externalOrigins`. */
  origins: z.array(FetchConnectionSchema).default([]),
  /** Per-app daily proxied-request budget; unset ⇒ unbounded (fetch-proxy §7). */
  requestsPerDay: z.int().positive().optional(),
});
export type FetchCapability = z.infer<typeof FetchCapabilitySchema>;

/**
 * Is `scope` a legal service-worker scope prefix (ADR-0035 §3)? Exported so the
 * edge can re-run the identical rule when it re-parses the grant fail-closed.
 *
 * Deny-by-default: each segment must be **unreserved URL characters only**
 * (RFC 3986 `A-Za-z0-9-._~`). A positive allowlist rather than a blocklist
 * because this value is used twice in the trusted path — as a path prefix
 * matched against request URLs, and as the `Service-Worker-Allowed` *response
 * header value*, where a stray CR/LF would be header injection. Percent-escapes
 * are refused outright, mirroring `normalizeRequestPath`'s posture: a scope that
 * needs encoding could never match a servable path anyway.
 *
 * Two rules carry the security weight:
 *  - **Root is refused.** A root-scoped worker would see the handoff token on
 *    `/_auth/complete`, which is why service workers were banned at all
 *    (architecture Appendix A.3).
 *  - **Any `_`-leading first segment is refused** — a rule, not an enumeration
 *    of `_auth`/`_api`/`_helix`/`_csp-report`, so it stays correct when a
 *    platform namespace is added.
 */
const SCOPE_SEGMENT = /^[A-Za-z0-9\-._~]+$/;

export function isValidServiceWorkerScope(scope: string): boolean {
  if (!scope.startsWith("/") || !scope.endsWith("/")) return false;
  // Split the interior, WITHOUT filtering empties: an empty segment means a
  // doubled slash, and `/app//` must be refused here rather than silently
  // accepted. The edge rejects it anyway (`normalizeRequestPath` collapses the
  // double slash, so the round-trip comparison in `parseOfflineGrant` fails),
  // and two validators disagreeing on the accepted set is exactly the drift the
  // double validation exists to avoid: the owner would get an approved,
  // elevated grant that projects to nothing, with no diagnostic anywhere.
  // `"/".slice(1, -1)` is `""` → one empty segment → root stays refused.
  const segments = scope.slice(1, -1).split("/");
  const first = segments[0];
  if (first === undefined) return false;
  if (segments.some((s) => s === "" || s === "." || s === ".." || !SCOPE_SEGMENT.test(s))) {
    return false;
  }
  return !first.startsWith("_");
}

/**
 * The offline capability (ADR-0035): the app opts into a **platform-authored**
 * service worker, confined to `scope`. The app ships no worker code — the edge
 * serves the worker and injects its registration — so this grant is a scope
 * declaration, not a pointer at app-supplied bytes.
 *
 * It buys **cold boot** (the document and its static assets answer with no
 * network) and nothing else: durable state, large-asset caching and queued-work
 * drain are ordinary page JS that every app already has without a grant.
 */
export const OfflineCapabilitySchema = z.object({
  /**
   * URL path prefix the worker controls, e.g. `/app/`. Leading and trailing
   * slash required; never root, never a `_`-prefixed platform namespace.
   */
  scope: z.string().refine(isValidServiceWorkerScope, {
    message:
      "scope must be a non-root path prefix with a leading and trailing slash, and must not start with a reserved `_` segment (e.g. `/app/`)",
  }),
});
export type OfflineCapability = z.infer<typeof OfflineCapabilitySchema>;

export const CapabilitiesSchema = z.object({
  llm: LlmCapabilitySchema.optional(),
  data: DataCapabilitySchema.optional(),
  /** Platform-registered MCP servers this app may reach (§6.1, exposed as REST). */
  mcp: z.array(z.string()).default([]),
  /** Extra CSP `connect-src` origins for **direct** browser calls (§4.4). */
  externalOrigins: z.array(z.url()).default([]),
  /** Governed outbound HTTP via the fetch-proxy / egress plane (in build, M4.5). */
  fetch: FetchCapabilitySchema.optional(),
  /** Platform-owned, scope-confined service worker for offline cold boot (ADR-0035). */
  offline: OfflineCapabilitySchema.optional(),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export const AppManifestSchema = z.object({
  /** App slug; matches `App.slug`. */
  app: z.string().min(1),
  visibility: VisibilitySchema,
  capabilities: CapabilitiesSchema.default({ mcp: [], externalOrigins: [] }),
});
export type AppManifest = z.infer<typeof AppManifestSchema>;
