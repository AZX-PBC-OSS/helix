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
 *     data: { app_scope: true, user_scope: true }
 *     mcp: [azure-billing]
 *     external_origins: []
 */
export const LlmCapabilitySchema = z.object({
  models: z.array(z.string()).default([]),
  tokensPerDay: z.int().positive().optional(),
});
export type LlmCapability = z.infer<typeof LlmCapabilitySchema>;

export const DataCapabilitySchema = z.object({
  appScope: z.boolean().default(false),
  userScope: z.boolean().default(false),
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
