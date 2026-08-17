import { z } from "zod";

/**
 * An immutable deploy of an app (architecture §4.3, §5). "Deploy" = flip the
 * app's pointer to a version; "rollback" = flip it back. Assets live in Blob at
 * `apps/<appId>/<version>/…`.
 *
 * `status` carries the preview-then-promote guardrail (§5.1): agent deploys land
 * as `preview` and a human promotes one to `live`; archived versions 410.
 */
export const VERSION_STATUSES = ["preview", "live", "archived"] as const;
export const VersionStatusSchema = z.enum(VERSION_STATUSES);
export type VersionStatus = z.infer<typeof VersionStatusSchema>;

/**
 * What the portal SPA did to an uploaded bundle before sending it (ADR-0038).
 *
 * **Client-asserted provenance, never authority.** Only the browser saw the
 * original upload, so the server cannot verify this; it is stored, size-capped
 * and schema-checked, purely to explain why a version's file list looks the way
 * it does. It is never consulted for policy, serving, or authorization, and an
 * absent or invalid report simply doesn't appear.
 */
export const DEPLOY_OUTCOMES = [
  "canonical",
  "rerooted",
  "nested",
  "ambiguous",
  "unsalvageable",
] as const;

export const DeployReportSchema = z.object({
  /** The planner revision that produced this, for reading old rows later. */
  plannerVersion: z.int().nonnegative(),
  outcome: z.enum(DEPLOY_OUTCOMES),
  /** The chosen bundle root (`""` = archive root). */
  root: z.string().max(1024),
  /** How many files were uploaded after re-rooting. */
  fileCount: z.int().nonnegative(),
  /** Count of dropped files, keyed by reason (junk/outside-root/…). */
  drops: z.record(z.string().max(64), z.int().nonnegative()).default({}),
  /** Problem kinds surfaced (missing-reference, secret-dropped, …). */
  problems: z.array(z.string().max(64)).max(50).default([]),
  /** Candidate roots the planner considered. */
  candidates: z.array(z.string().max(1024)).max(20).default([]),
});
export type DeployReport = z.infer<typeof DeployReportSchema>;

export const VersionSchema = z.object({
  id: z.uuid(),
  appId: z.uuid(),
  /** Monotonic per app, 1-based. */
  number: z.int().positive(),
  /** Blob key prefix for this version's assets, e.g. `apps/<appId>/7/`. */
  blobPrefix: z.string().min(1),
  status: VersionStatusSchema,
  createdAt: z.iso.datetime(),
  /** Client-asserted salvage provenance (ADR-0038); absent on CLI uploads. */
  deployReport: DeployReportSchema.optional(),
});
export type Version = z.infer<typeof VersionSchema>;
