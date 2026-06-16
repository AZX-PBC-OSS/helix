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
 *   visibility: private
 *   capabilities:
 *     llm: { models: [gpt-5, claude-fable-5], tokens_per_day: 2_000_000 }
 *     data: { user: true, collections: [contacts] }
 *     mcp: [azure-billing]
 *     external_origins: []
 */
export const LlmCapabilitySchema = z.object({
  models: z.array(z.string()).default([]),
  tokensPerDay: z.int().positive().optional(),
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

export const CapabilitiesSchema = z.object({
  llm: LlmCapabilitySchema.optional(),
  data: DataCapabilitySchema.optional(),
  /** Platform-registered MCP servers this app may reach (§6.1, exposed as REST). */
  mcp: z.array(z.string()).default([]),
  /** Extra CSP `connect-src` origins the app requested (§4.4). */
  externalOrigins: z.array(z.url()).default([]),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export const AppManifestSchema = z.object({
  /** App slug; matches `App.slug`. */
  app: z.string().min(1),
  visibility: VisibilitySchema,
  capabilities: CapabilitiesSchema.default({ mcp: [], externalOrigins: [] }),
});
export type AppManifest = z.infer<typeof AppManifestSchema>;
