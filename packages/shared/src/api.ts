import { z } from "zod";
import { AppSchema } from "./app.js";
import { CapabilitiesSchema } from "./manifest.js";
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
  /** Optional per-app capability grant set at create time (architecture §6.3). */
  capabilities: CapabilitiesSchema.optional(),
});
export type CreateAppRequest = z.infer<typeof CreateAppRequestSchema>;

/** `PUT /api/v1/apps/:slug/manifest` body — replaces the app's capability grants. */
export const SetManifestRequestSchema = z.object({
  capabilities: CapabilitiesSchema,
});
export type SetManifestRequest = z.infer<typeof SetManifestRequestSchema>;

/** A manually-set shared password must clear this bar (a generated one far exceeds it). */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Body for `POST /api/v1/apps/:slug/access/password/rotate`. Omit `password` to
 * reroll a fresh xkcd-style passphrase; supply one to set it manually (the
 * shared-credential feature — see docs/features/authentication.md).
 */
export const SetPasswordRequestSchema = z.object({
  password: z.string().min(MIN_PASSWORD_LENGTH).optional(),
});
export type SetPasswordRequest = z.infer<typeof SetPasswordRequestSchema>;

/**
 * Response from the password-access endpoints — the cleartext credential the
 * owner shares out-of-band. Returned only over authenticated portal routes;
 * never present in the manifest or any open read.
 */
export const PasswordCredentialResponseSchema = z.object({
  /** The shared passphrase, in cleartext, for the owner to copy/share. */
  password: z.string().min(1),
  /** The app's public URL, prebuilt so the UI can offer a one-click copy. */
  url: z.url(),
  /** When the current password was set (ISO 8601). */
  setAt: z.string(),
});
export type PasswordCredentialResponse = z.infer<typeof PasswordCredentialResponseSchema>;

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
  /** Gateway: requested model is not in the app's manifest allowlist (§6.3). */
  "model_not_allowed",
  /** Gateway: the app's daily token budget is exhausted (§6.1). */
  "quota_exceeded",
  /** Gateway: a configured capability is not available on this edge. */
  "capability_unavailable",
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
