import { z } from "zod";

/**
 * How an app gates access at the edge (architecture §4.2).
 *
 * Modeled as a discriminated union rather than a flat enum because `group`
 * carries a payload (which Entra group may open the app). The manifest's
 * `group:<id>` shorthand (§6.3) maps onto `{ mode: "group", groupId }`.
 *
 * `internal` is the baseline and the default: SSO, and *any* authenticated
 * directory principal passes. It was called `private` until the rename, a name
 * that overpromised — the gate never checked *which* user signed in, only that
 * one had. Note that under Entra a B2B guest is a directory principal too, so
 * `internal` admits guests; `group` is the mode that narrows to a population.
 *
 * A future owner-plus-platform-admins mode reclaims the name `private`. It is
 * deliberately **absent rather than reserved**: it needs a principal identifier
 * the data and control planes do not yet share (the edge session's `oid` is the
 * edge client's `sub`, while `App.ownerId` is the portal actor's — different
 * identifier spaces under Entra's pairwise `sub`). A mode listed here that no
 * plane can evaluate would fall through the edge's gate and deny every request
 * including the owner's, so the label stays out until the check exists. Adding
 * it back is one `ALTER TYPE ... ADD VALUE`. See TODO.md.
 */
export const VisibilitySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("internal") }),
  z.object({ mode: z.literal("group"), groupId: z.string().min(1) }),
  z.object({ mode: z.literal("password") }),
  z.object({ mode: z.literal("public") }),
]);
export type Visibility = z.infer<typeof VisibilitySchema>;

/** The bare mode names, useful for enums/columns that don't need the payload. */
export const VISIBILITY_MODES = ["internal", "group", "password", "public"] as const;
export const VisibilityModeSchema = z.enum(VISIBILITY_MODES);
export type VisibilityMode = z.infer<typeof VisibilityModeSchema>;
