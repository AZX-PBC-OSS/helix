import { z } from "zod";
import {
  BASELINE_DOLLARS_PER_DAY,
  BASELINE_WRITES_PER_DAY,
  BASELINE_BYTES_PER_DAY,
  BASELINE_FETCH_REQUESTS_PER_DAY,
} from "./approval.js";
import { VisibilityModeSchema, type VisibilityMode } from "./visibility.js";

/**
 * `GET /api/v1/capabilities` (ADR-0036) — the deployment capability catalogue.
 *
 * A single instance-wide JSON document answering, manifest key by key, *what
 * this deployment can actually do* — not what some app already holds, but what
 * is *requestable*. It is the half of the developer documentation that varies
 * per deployment; the other half is deployment-agnostic and lives in
 * `packages/deploy-skill/SKILL.md` (published as docs, rendered generically).
 *
 * The catalogue sits behind the ADR-0024 bearer chain (decision 5): the
 * connection catalogue lists named integrations this deployment has
 * provisioned, which leaks vendor relationships and internal service names — a
 * real, if small, disclosure, and one nobody with a portal token should be
 * surprised by. No secret *value* is ever in the response, so this is nowhere
 * near `app_secrets` territory and needs no new role or grant.
 *
 * Decision 3 is the reason the endpoint is instance-wide rather than per-app:
 * its most useful payload is not the capability list but which requests
 * **auto-approve**. An agent that reads the thresholds first can design an app
 * that ships immediately instead of one that stalls on a human. That is a menu
 * of what is *requestable*, not a report of what some app already holds — so it
 * does not vary per app.
 *
 * Optional fields mean "not enabled on this deployment" (the same convention as
 * `DeploymentConfigResponseSchema`): `devApiBase` is absent when the dev
 * gateway is not deployed, and `visibility.modes` omits a mode the deployment
 * does not permit rather than listing it as available.
 */
export const CapabilityCatalogueSchema = z.object({
  /**
   * Visibility modes an app may declare here. `internal` is always present
   * (SSO, any directory principal — the baseline). `group` is present only when
   * an IdP with group claims is configured: on a dev-token-only portal it is
   * absent, matching `/api/v1/auth/config`'s 404. `password` / `public` are
   * present only when the operator policy permits them
   * (`PORTAL_ALLOW_*_APPS`). A mode absent from this list is not requestable.
   */
  visibility: z.object({
    modes: z.array(VisibilityModeSchema).min(1),
  }),

  /**
   * LLM: the **servable** model ids, not merely the curated catalog. A model is
   * servable when its upstream family is wired on this edge **and** the matching
   * `platform` secret is seeded; a curated-but-unseeded model (e.g. a `gpt-*`
   * model whose `openai` platform key was never added) is omitted, so an agent
   * that reads this list never designs an app that 502s at call time. Every id
   * in this list is also curated, so requesting one is baseline (auto-approve).
   *
   * `baselineDollarsPerDay` is the spend cap at/under which an LLM grant
   * auto-approves; above it queues. From `@azx-pbc/shared/approval.ts`, so the
   * catalogue and the classifier cannot drift.
   */
  llm: z.object({
    models: z.array(z.string().min(1)),
    baselineDollarsPerDay: z.number().positive(),
  }),

  /**
   * App-data: whether the three scopes are provisioned here, and the daily
   * budgets at/under which a data grant auto-approves. `provisioned` is `true`
   * today (the storage tables exist unconditionally); the field is the seam for
   * a future deployment-level toggle, present before it is needed. The
   * baselines come from `@azx-pbc/shared/approval.ts`.
   */
  data: z.object({
    provisioned: z.boolean(),
    baselineWritesPerDay: z.number().positive(),
    baselineBytesPerDay: z.number().positive(),
  }),

  /**
   * The fetch-proxy (`/_api/fetch`) and direct-CSP surfaces.
   *
   * `externalOriginsPermitted` is `true` when an app may request a direct-CSP
   * origin grant at all (the surface exists; any entry still queues for
   * approval). `connections` names the stored `global`-scope secrets an app may
   * reference from `capabilities.fetch.origins[].connection` — names only, never
   * values, and without the origin each one fronts: a global secret has no
   * stored origin (the origin is declared per-app in each manifest), so listing
   * one here would be a guess. An agent learns "this connection exists and is
   * referenceable" and supplies the origin itself. `baselineRequestsPerDay` is
   * the proxied-request budget at/under which a fetch grant auto-approves.
   */
  fetch: z.object({
    externalOriginsPermitted: z.boolean(),
    connections: z.array(z.object({ name: z.string().min(1) })),
    baselineRequestsPerDay: z.number().positive(),
  }),

  /**
   * MCP is carried in the manifest but **not enforced** — no transport exists
   * today. Surfaced as `false` so an agent does not assume a working `mcp`
   * grant; declaring any server queues for approval regardless.
   */
  mcp: z.object({
    enforced: z.boolean(),
  }),

  /**
   * Offline (ADR-0035): whether the platform service-worker grant is available,
   * and the rule a `scope` must satisfy (not the domain root, not a `/_…`
   * reserved path). Any grant or rescope queues for approval.
   */
  offline: z.object({
    available: z.boolean(),
    /** Human-facing summary of the scope rule; not machine-parsed. */
    scopeRule: z.string().min(1),
  }),

  /** Deploy bundle size caps in megabytes, as enforced on upload. */
  deploy: z.object({
    maxFileMb: z.number().positive(),
    maxBundleMb: z.number().positive(),
  }),

  /**
   * The opt-in dev-gateway base, absent when it is not deployed here (same
   * convention as `DeploymentConfigResponseSchema.devApiBase`).
   */
  devApiBase: z.url().optional(),

  /**
   * The approval half of the catalogue (decision 3). The four baselines mirror
   * `@azx-pbc/shared/approval.ts` exactly, and `elevationTriggers` enumerates
   * the requests that **queue for a human** rather than auto-applying — the
   * thing an agent reads to design an app that ships immediately. A trigger
   * absent from this list never queues.
   */
  approval: z.object({
    baselines: z.object({
      dollarsPerDay: z.number().positive(),
      writesPerDay: z.number().positive(),
      bytesPerDay: z.number().positive(),
      fetchRequestsPerDay: z.number().positive(),
    }),
    elevationTriggers: z.array(
      z.enum([
        /** Any `externalOrigins` entry — widens CSP for a direct browser call. */
        "externalOrigins",
        /** Any `fetch.origins` entry — a proxied outbound origin. */
        "fetchOrigins",
        /** Any `mcp` server — no transport is enforced today. */
        "mcp",
        /** `visibility: public` — crosses the tenant boundary. */
        "publicVisibility",
        /** Any budget above its baseline (LLM spend, data writes/bytes, fetch requests). */
        "budgetAboveBaseline",
        /** An LLM model not in this deployment's servable (curated) set. */
        "uncuratedLlmModel",
      ]),
    ),
  }),
});
export type CapabilityCatalogue = z.infer<typeof CapabilityCatalogueSchema>;

// ── The instance-wide values the catalogue derives from ──────────────────────
// Co-located with the schema so the route, the classifier, and any future
// consumer read one source. These re-export the approval constants so a caller
// does not need to know where the baseline lives — `catalogue` is the
// catalogue's own address, and the baselines are part of it.

/** The four approval baselines as a single object, sourced from `approval.ts`. */
export const APPROVAL_BASELINES = {
  dollarsPerDay: BASELINE_DOLLARS_PER_DAY,
  writesPerDay: BASELINE_WRITES_PER_DAY,
  bytesPerDay: BASELINE_BYTES_PER_DAY,
  fetchRequestsPerDay: BASELINE_FETCH_REQUESTS_PER_DAY,
} as const;

/**
 * The complete, ordered list of elevation triggers the classifier can queue —
 * the same set enumerated in {@link CapabilityCatalogueSchema}'s
 * `approval.elevationTriggers`, as a plain array for callers that build it
 * without restating the enum.
 */
export const ELEVATION_TRIGGERS = [
  "externalOrigins",
  "fetchOrigins",
  "mcp",
  "publicVisibility",
  "budgetAboveBaseline",
  "uncuratedLlmModel",
] as const;

/**
 * The visibility modes available on a deployment, derived from its IdP and
 * operator policy. `internal` is always present; `group` only when an IdP is
 * configured (the portal's `authPublicConfig` is non-null); `password` /
 * `public` only when the operator permits them.
 */
export function visibilityModesFor(opts: {
  idpConfigured: boolean;
  allowPublicApps: boolean;
  allowPasswordApps: boolean;
}): VisibilityMode[] {
  const modes: VisibilityMode[] = ["internal"];
  if (opts.idpConfigured) modes.push("group");
  if (opts.allowPasswordApps) modes.push("password");
  if (opts.allowPublicApps) modes.push("public");
  return modes;
}
