import { z } from "zod";
import { AppSchema } from "./app.js";
import { VersionSchema } from "./version.js";
import { VisibilitySchema } from "./visibility.js";

/**
 * The portal's versioned REST contract (architecture §7, project plan §1).
 * These request/response shapes are the wire boundary shared between the portal
 * and the `azx` CLI (and a future SPA), so they live in @helix/shared and are
 * validated on both ends.
 */

/** `POST /api/v1/apps` body. Visibility defaults to private (architecture §4.2). */
export const CreateAppRequestSchema = z.object({
  slug: AppSchema.shape.slug,
  displayName: AppSchema.shape.displayName,
  visibility: VisibilitySchema.default({ mode: "private" }),
});
export type CreateAppRequest = z.infer<typeof CreateAppRequestSchema>;

/** A single deploy-time advisory from the CSP courtesy lint (architecture §4.4). */
export const CspWarningSchema = z.object({
  file: z.string(),
  origin: z.string(),
  hint: z.string(),
});
export type CspWarning = z.infer<typeof CspWarningSchema>;

/** `POST /api/v1/apps/:slug/versions` response — the new (preview) version + lint warnings. */
export const UploadVersionResponseSchema = z.object({
  version: VersionSchema,
  warnings: z.array(CspWarningSchema),
});
export type UploadVersionResponse = z.infer<typeof UploadVersionResponseSchema>;

/** `POST /api/v1/apps/:slug/rollback` body. Omit `toNumber` to step back to the previous live version. */
export const RollbackRequestSchema = z.object({
  toNumber: z.int().positive().optional(),
});
export type RollbackRequest = z.infer<typeof RollbackRequestSchema>;

/** Stable error codes, mapped to HTTP status by the portal's error handler. */
export const API_ERROR_CODES = [
  "validation_failed",
  "not_found",
  "slug_taken",
  "bundle_invalid",
  "unauthorized",
  /** Authenticated but not allowed — reserved for v1 RBAC. */
  "forbidden",
  "conflict",
  "internal",
] as const;
export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

/** Uniform error envelope returned by every non-2xx response. */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
