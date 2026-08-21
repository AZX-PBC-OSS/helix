import { z } from "zod";

/**
 * Wire shapes for the portal's directory endpoints (ADR-0040 decisions 6–8) —
 * the group picker's search and its "groups you're a member of" default view.
 *
 * **Every response carries `available`, and the degraded case is a 200.** ADR-0040
 * decision 8 requires that a deployment without the `GroupMember.Read.All` grant
 * keeps a working Access tab, falling back to free-text group ids behind an
 * explicit banner. Modelling absent consent as an error status would put the
 * picker in a failure state and make that fallback the hard path; as a success
 * shape the client renders a banner off one boolean. Transient failures still use
 * the normal error envelope, so a real outage stays distinguishable from a tenant
 * that said no.
 *
 * Names are **not** persisted anywhere (decision 7): they are resolved on demand
 * through these endpoints and cached client-side. The authorization value is the
 * id array on the app row and nothing else — a second, staler copy of a name
 * sitting beside a live authorization value invites exactly one bug, disagreeing
 * about which is real, and the UI would show the wrong one. The single exception
 * is an audit entry, which records names as observed at write time because that
 * is a historical fact rather than a cache.
 */

export const DirectoryGroupSchema = z.object({
  /** Object id — a GUID under Entra, a readable fixture id in dev. */
  id: z.string().min(1),
  displayName: z.string().min(1),
  /**
   * Whether this is a security group — the only kind the `groups` claim carries,
   * so the only kind worth scoping an app to. Reported rather than filtered so
   * the picker can mark an ineligible group with a reason instead of hiding it;
   * "the group I searched for isn't listed" is a worse failure than a greyed-out
   * row.
   *
   * **Absent means "not read", not "false".** The batch id→name resolve does not
   * always return it, and defaulting an unread flag to `true` made the same group
   * show as eligible in one view and ineligible in another depending on which
   * query resolved last. A client should treat absent as eligible-but-unknown and
   * never let it overwrite a value it does know.
   */
  securityEnabled: z.boolean().optional(),
});
export type DirectoryGroup = z.infer<typeof DirectoryGroupSchema>;

/**
 * Why the directory can't answer. Every value is permanent-until-an-operator-
 * acts, which is what separates them from an error: retrying changes nothing.
 * They are kept distinct because the fixes are different people — `no-consent`
 * needs a directory administrator, `no-credential` needs whoever configured the
 * portal, `not-configured` needs a deployment change. Collapsing them would send
 * someone to ask an admin for a permission when the portal simply cannot
 * authenticate.
 */
export const DIRECTORY_UNAVAILABLE_REASONS = [
  "no-consent",
  "no-credential",
  "not-configured",
] as const;
export const DirectoryUnavailableReasonSchema = z.enum(DIRECTORY_UNAVAILABLE_REASONS);

export const DirectoryGroupsResponseSchema = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(true),
    groups: z.array(DirectoryGroupSchema),
  }),
  z.object({
    available: z.literal(false),
    reason: DirectoryUnavailableReasonSchema,
    /** Operator-facing sentence; the SPA shows it in the degradation banner. */
    detail: z.string().min(1),
    /** The Graph permission an administrator would have to grant. */
    missingPermission: z.string().min(1).optional(),
  }),
]);
export type DirectoryGroupsResponse = z.infer<typeof DirectoryGroupsResponseSchema>;
