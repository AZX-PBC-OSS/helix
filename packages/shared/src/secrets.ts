import { z } from "zod";

import { EnvSchema } from "./env.js";

/**
 * Connection secrets (design doc `docs/design/secrets-and-connections.md`).
 *
 * A **secret** is opaque credential material (an API key, PAT, bearer token)
 * the platform holds so an app never does. The app references it by name from a
 * proxy connection (manifest `capabilities.fetch.origins[].connection`); the
 * `azx-egress` service resolves it to plaintext and injects it server-side on
 * the outbound hop (§4). Secrets are **write-only / rotate-only** — the value is
 * never returned to anyone after it is set (§3), so the shapes here carry
 * metadata only; the value travels in the create/rotate request bodies and
 * nowhere else.
 */

/**
 * How a resolved secret is applied to the outbound request (§2). The recipe is a
 * property of the *credential* (how a given key is presented is intrinsic to it),
 * not of the app using it. v1 ships static-credential recipes; dynamic ones
 * (OAuth client-credentials, SigV4) are deferred (design §10 q2).
 */
export const InjectionRecipeSchema = z.discriminatedUnion("kind", [
  /** `Authorization: Bearer <secret>` — the common case. */
  z.object({ kind: z.literal("header-bearer") }),
  /** Arbitrary header; `{}` in `template` is replaced with the secret. */
  z.object({
    kind: z.literal("header"),
    name: z.string().min(1),
    template: z.string().default("{}"),
  }),
  /** Query parameter `?<param>=<secret>`. */
  z.object({ kind: z.literal("query"), param: z.string().min(1) }),
]);
export type InjectionRecipe = z.infer<typeof InjectionRecipeSchema>;

/** Injection recipe kinds, for UI selects / tests without restating strings. */
export const INJECTION_KINDS = ["header-bearer", "header", "query"] as const;

/**
 * Secret scope (§2). `app` secrets are usable only by their owning app; `global`
 * secrets are usable by many apps, but only via an explicit per-app grant
 * (`app_secret_grants`) — "global" never means "ambiently available". `platform`
 * secrets are platform vendor credentials (the LLM key) with `appId = null`: not
 * grantable to apps and not bindable from a manifest, resolvable by egress only
 * for the edge's `llm` capability — never via an app's fetch binding (§4).
 */
export const SECRET_SCOPES = ["app", "global", "platform"] as const;
export const SecretScopeSchema = z.enum(SECRET_SCOPES);
export type SecretScope = z.infer<typeof SecretScopeSchema>;

/**
 * What the portal returns about a secret — never the value. `boundApps` lists
 * the app slugs that reference this secret (own app for `app` scope; granted
 * apps for `global`). `lastUsedAt` drives the stale-secret report (§6).
 */
export const SecretMetadataSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  scope: SecretScopeSchema,
  /** Partition tier (dev-mode §6): a dev fetch injects only `dev` connection secrets. */
  env: EnvSchema,
  injection: InjectionRecipeSchema,
  createdBy: z.string(),
  createdAt: z.string(),
  rotatedAt: z.string().nullable().optional(),
  lastUsedAt: z.string().nullable().optional(),
  boundApps: z.array(z.string()).default([]),
});
export type SecretMetadata = z.infer<typeof SecretMetadataSchema>;

/**
 * Create-secret request body. The `value` is the only place plaintext crosses
 * the API boundary; it is encrypted (dev) or written to Key Vault (prod) and
 * never read back (§3).
 */
export const SecretCreateRequestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits, and hyphens"),
  value: z.string().min(1),
  /** Target tier (dev-mode §6). Defaults `prod`; `dev` configures a dev-tier credential. */
  env: EnvSchema.default("prod"),
  injection: InjectionRecipeSchema.default({ kind: "header-bearer" }),
});
export type SecretCreateRequest = z.infer<typeof SecretCreateRequestSchema>;

/** Rotate-secret request body — a new value for an existing name. */
export const SecretRotateRequestSchema = z.object({ value: z.string().min(1) });
export type SecretRotateRequest = z.infer<typeof SecretRotateRequestSchema>;

/** Grant a `global` secret to an app (admin-only, approval-gated — §7). */
export const SecretGrantRequestSchema = z.object({ appSlug: z.string().min(1) });
export type SecretGrantRequest = z.infer<typeof SecretGrantRequestSchema>;
