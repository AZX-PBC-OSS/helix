import { z } from "zod";

/**
 * Most groups one app may be scoped to (ADR-0040 §5).
 *
 * **Enforced here and nowhere else.** Because the storage is a Postgres array,
 * moving this number needs no migration — so it is a policy guess that costs
 * nothing to revise. Retrofitting N onto a scalar column would instead have been
 * an expand/contract migration on a security-critical column with a live edge
 * projection, which is the dance this repo already did for the `private` →
 * `internal` rename, over three releases.
 */
export const MAX_VISIBILITY_GROUPS = 10;

/**
 * The groups that may open a `group` app. Semantics are **any-of (OR)** —
 * "engineering or product". All-of is a real but far rarer need and can arrive
 * later as a distinct mode without breaking any-of.
 *
 * An **empty array is deliberately valid**, and means what the old nullable
 * scalar meant: nobody can open the app. It has to be representable because the
 * edge's gate is what denies (`visibilityAllows` fails closed on an empty set,
 * pinned by a test), and a read path that threw on a zero-group row would turn a
 * harmless misconfiguration into a 500 on the whole apps list. The UI and the CLI
 * refuse to *write* one; this schema describes what can be stored.
 *
 * Membership in the claim is **transitive**: scoping to a parent group admits
 * members of its nested children. That is a property of Entra rather than of
 * this schema, but it is what the operator-facing copy has to say.
 */
export const VisibilityGroupIdsSchema = z.array(z.string().min(1)).max(MAX_VISIBILITY_GROUPS);

/**
 * How an app gates access at the edge (architecture §4.2).
 *
 * Modeled as a discriminated union rather than a flat enum because `group`
 * carries a payload (which Entra groups may open the app). The manifest's
 * `group:<id>[,<id>…]` shorthand (§6.3) maps onto `{ mode: "group", groupIds }`.
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
 * The name is now free in every direction: the expand/contract releases removed
 * the last legacy row and then the Postgres label itself, so nothing reads,
 * writes or stores `private` any more. A test pins that this schema still
 * refuses it, so the reservation is enforced rather than merely intended.
 */
export const VisibilitySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("internal") }),
  z.object({ mode: z.literal("group"), groupIds: VisibilityGroupIdsSchema }),
  z.object({ mode: z.literal("password") }),
  z.object({ mode: z.literal("public") }),
]);
export type Visibility = z.infer<typeof VisibilitySchema>;

/** The bare mode names, useful for enums/columns that don't need the payload. */
export const VISIBILITY_MODES = ["internal", "group", "password", "public"] as const;
export const VisibilityModeSchema = z.enum(VISIBILITY_MODES);
export type VisibilityMode = z.infer<typeof VisibilityModeSchema>;

/**
 * The group ids a visibility carries, or `[]` for every other mode. Saves each
 * call site repeating the `mode === "group"` narrowing before it can compare,
 * diff, or persist a set — and keeps "a non-group mode has no groups" one fact
 * rather than one per caller.
 */
export function visibilityGroupIds(visibility: Visibility): string[] {
  return visibility.mode === "group" ? visibility.groupIds : [];
}
