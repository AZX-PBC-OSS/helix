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
 * including the owner's, so the label stays out until the check exists. See
 * TODO.md.
 *
 * The Postgres enum *does* still carry `private` — as a legacy label being
 * retired over the expand/contract releases, never as an offered mode (see
 * {@link visibilityModeFromDb}). When the real `private` is built it claims a
 * name that by then is free again.
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

/**
 * Pre-rename DB labels still readable during the expand/contract window.
 * **Temporary — deleted in release 3** (see TODO.md), along with
 * {@link visibilityModeFromDb} and its call sites.
 *
 * Note what is deliberately *not* here: `private` is not a member of
 * `VISIBILITY_MODES` or the `Visibility` union. Making it one would mean the
 * request schema accepts a mode we intend to refuse, and dead branches in the
 * badge, the create form, the access tab and the CLI. The legacy label is a
 * read-side fact about rows written before the rename, not a mode the platform
 * offers — so it lives in one lookup rather than in the type.
 */
const LEGACY_VISIBILITY_MODES: Record<string, VisibilityMode> = { private: "internal" };

/**
 * Normalise a visibility label read **from the database**. Maps the pre-rename
 * spelling onto its current name so a row written before the rename keeps
 * exactly the gate it had.
 *
 * Anything unrecognised is returned **unchanged**, not thrown on. That is the
 * load-bearing part: the edge's `visibilityAllows` denies any mode it does not
 * understand, so an unknown label stays a contained per-app denial. A throwing
 * normaliser would escalate that into a registry-projection load failure, taking
 * out every app instead of the one row — the opposite of fail-closed.
 *
 * Write paths never need this: they take the `Visibility` union, which has no
 * legacy member, so everything written is already current.
 */
export function visibilityModeFromDb(raw: string): VisibilityMode {
  return LEGACY_VISIBILITY_MODES[raw] ?? (raw as VisibilityMode);
}

/** The legacy labels themselves — for the Prisma-enum drift guard. */
export const LEGACY_VISIBILITY_MODE_NAMES = Object.keys(LEGACY_VISIBILITY_MODES);
