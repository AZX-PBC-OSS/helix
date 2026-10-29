import { z } from "zod";
import { SLUG_TERM_PATTERN } from "./app.js";

/**
 * Platform-wide settings an administrator edits in the portal (Platform
 * Settings screen). The operator fields are shown to anonymous visitors on the
 * edge's sign-in and about pages, so web filters and recipients can see who
 * runs the site. They are plain text: the edge escapes them and renders no
 * markup.
 */

export const OPERATOR_NAME_MAX = 80;
export const OPERATOR_DESCRIPTION_MAX = 600;
export const OPERATOR_CONTACT_URL_MAX = 300;
export const BLOCKED_TERM_NOTE_MAX = 200;

/**
 * `https:` or `mailto:` only, with no userinfo — the edge renders this as a
 * link to anonymous visitors, so a pasted `https://user:pass@…` must not reach it.
 */
export const OperatorContactUrlSchema = z
  .string()
  .max(OPERATOR_CONTACT_URL_MAX)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "mailto:") &&
        url.username === "" &&
        url.password === ""
      );
    } catch {
      return false;
    }
  }, "must be an https: or mailto: URL without a username or password");

/** The operator identity as stored and served. `null` means "not set". */
export const OperatorSettingsSchema = z.object({
  operatorName: z.string().min(1).max(OPERATOR_NAME_MAX).nullable(),
  operatorDescription: z.string().min(1).max(OPERATOR_DESCRIPTION_MAX).nullable(),
  operatorContactUrl: OperatorContactUrlSchema.nullable(),
});
export type OperatorSettings = z.infer<typeof OperatorSettingsSchema>;

/** `GET /api/v1/admin/settings` response. */
export const PlatformSettingsResponseSchema = OperatorSettingsSchema.extend({
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: z.string().nullable(),
});
export type PlatformSettingsResponse = z.infer<typeof PlatformSettingsResponseSchema>;

/**
 * `PUT /api/v1/admin/settings` body. Replaces all three fields; an empty or
 * whitespace-only string clears a field, the same as `null`.
 */
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullable()
    .transform((v) => (v === null || v.trim() === "" ? null : v.trim()));

export const UpdatePlatformSettingsRequestSchema = z.object({
  operatorName: optionalText(OPERATOR_NAME_MAX),
  operatorDescription: optionalText(OPERATOR_DESCRIPTION_MAX),
  operatorContactUrl: optionalText(OPERATOR_CONTACT_URL_MAX).pipe(
    OperatorContactUrlSchema.nullable(),
  ),
});
export type UpdatePlatformSettingsRequest = z.input<typeof UpdatePlatformSettingsRequestSchema>;

export const BlockedSlugTermSchema = z.object({
  id: z.uuid(),
  term: z.string(),
  note: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
});
export type BlockedSlugTerm = z.infer<typeof BlockedSlugTermSchema>;

/** An existing app whose slug contains a blocked term — terms apply only at creation. */
export const BlockedTermMatchSchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  term: z.string(),
});
export type BlockedTermMatch = z.infer<typeof BlockedTermMatchSchema>;

/** `GET /api/v1/admin/slug-terms` response. */
export const BlockedSlugTermsResponseSchema = z.object({
  terms: z.array(BlockedSlugTermSchema),
  matchingApps: z.array(BlockedTermMatchSchema),
});
export type BlockedSlugTermsResponse = z.infer<typeof BlockedSlugTermsResponseSchema>;

/** `POST /api/v1/admin/slug-terms` body. The term is lowercased and trimmed before validation. */
export const CreateBlockedSlugTermRequestSchema = z.object({
  term: z
    .string()
    .transform((v) => v.trim().toLowerCase())
    .pipe(
      z
        .string()
        .min(1)
        .max(63)
        .regex(SLUG_TERM_PATTERN, "use lowercase letters and digits, joined by single hyphens"),
    ),
  note: z
    .string()
    .max(BLOCKED_TERM_NOTE_MAX)
    .nullable()
    .optional()
    .transform((v) => (v == null || v.trim() === "" ? null : v.trim())),
});
export type CreateBlockedSlugTermRequest = z.input<typeof CreateBlockedSlugTermRequestSchema>;

/** `GET /api/v1/slug-check?slug=` response — live feedback for the create form and CLI. */
export const SlugCheckResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(["invalid", "reserved", "blocked", "taken"]),
    message: z.string(),
  }),
]);
export type SlugCheckResponse = z.infer<typeof SlugCheckResponseSchema>;

/**
 * One row of `GET /api/v1/admin/config`: a portal environment variable from a
 * fixed allowlist. A secret is reported as set or not set and never carries a
 * value.
 */
export const PlatformConfigEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  secret: z.boolean(),
  set: z.boolean(),
  value: z.string().nullable(),
});
export type PlatformConfigEntry = z.infer<typeof PlatformConfigEntrySchema>;

export const PlatformConfigResponseSchema = z.object({
  entries: z.array(PlatformConfigEntrySchema),
});
export type PlatformConfigResponse = z.infer<typeof PlatformConfigResponseSchema>;
