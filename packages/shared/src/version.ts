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

export const VersionSchema = z.object({
  id: z.uuid(),
  appId: z.uuid(),
  /** Monotonic per app, 1-based. */
  number: z.int().positive(),
  /** Blob key prefix for this version's assets, e.g. `apps/<appId>/7/`. */
  blobPrefix: z.string().min(1),
  status: VersionStatusSchema,
  createdAt: z.iso.datetime(),
});
export type Version = z.infer<typeof VersionSchema>;
