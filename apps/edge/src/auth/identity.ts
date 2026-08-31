/**
 * Capturing the display half of a user's identity.
 *
 * The edge stores two different things about a signed-in person, and the whole
 * point is that they never merge. `oid` is the **identity half** — Entra's
 * pairwise `sub`, compared and joined on, never rendered, because it resolves to
 * nobody. The claims picked here are the **display half** — rendered, never
 * compared. That is the split `App.ownerId` vs `App.ownerName`/`ownerEmail`
 * already draws on the control plane (`apps/portal/prisma/schema.prisma`); this
 * module is the same move for app users.
 *
 * The claims are *captured*, not resolved: the only id→name map in the system is
 * the `sessions` row itself, and `session_sweep()` deletes it at expiry, while
 * the rows it labels are append-only. A captured label is also the correct audit
 * semantic — who the caller was when the call happened.
 *
 * Lives in its own module so `oidc.ts` can pick claims without importing
 * `gate.ts` (and through it `sessions.ts` and `pg`), and so the two length caps
 * have exactly one home shared by the capture path and the ledger writer.
 */

/**
 * Max stored length of a captured name. 256 is Entra's own limit on the
 * `displayName` directory attribute, so no real value is ever ellipsized — this
 * is a bound, not a policy.
 */
export const USER_NAME_MAX = 256;

/**
 * Max stored length of a captured address. 320 is RFC 5321's maximum forward
 * path (64-char local part + `@` + 255-char domain).
 */
export const USER_EMAIL_MAX = 320;

/** Shared tail for the length caps. */
export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * A name claim as a bounded non-empty string, or null.
 *
 * Null rather than a fallback to the subject: a stored "name" that is the opaque
 * `sub` renders as an attribution while attributing nothing, and it also stops
 * the render-time `name ?? email ?? id` ladder one rung early, hiding an address
 * that *would* have identified the person. The fallback belongs at the render
 * boundary, which already has one.
 *
 * Capping here rather than only at the ledger closes a pre-existing hole:
 * `sessions.displayName` is plain TEXT and has never been bounded, so whatever
 * length the IdP sent went straight into the row.
 */
export function captureName(claim: unknown): string | null {
  return typeof claim === "string" && claim.length > 0 ? truncate(claim, USER_NAME_MAX) : null;
}

/**
 * An address claim as a bounded string, or null — accepting only something that
 * is actually addressable.
 *
 * The `@` test is the entire validation, and it is here because the caller feeds
 * this `preferred_username` as well as `email`. Under Entra `preferred_username`
 * is the UPN, which for an ordinary user *is* their address but is not
 * contractually one; a column named `userEmail` holding a non-address is worse
 * than a null, because the whole value of this column is that a reader can act
 * on it. Never used as a delivery target — this is a display value.
 */
export function captureEmail(claim: unknown): string | null {
  if (typeof claim !== "string" || !claim.includes("@")) return null;
  return truncate(claim, USER_EMAIL_MAX);
}
