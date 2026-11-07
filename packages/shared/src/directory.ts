import { z } from "zod";

/**
 * Directory endpoint contracts (ADR-0040 decisions 6–8).
 * Missing configuration or consent returns 200 with available: false so the UI
 * can show a banner and manual group-id entry. Transient failures use the error
 * envelope and remain distinguishable from expected unavailability.
 *
 * Resolve names on demand and cache them client-side. Authorization uses stored
 * group ids; do not persist a second name cache beside them. Audit entries may
 * record names as observed at write time.
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

/**
 * Mirrors `MIN_SEARCH_LENGTH` and `MAX_SEARCH_RESULTS` in `@azx-pbc/directory`,
 * which this package cannot import. `directory.test.ts` in the portal holds the
 * two in step.
 */
export const DIRECTORY_MIN_SEARCH_LENGTH = 3;
export const DIRECTORY_MAX_SEARCH_RESULTS = 25;

/** `GET /api/v1/directory/groups` query. */
export const DirectorySearchQuerySchema = z.object({
  /**
   * The provider enforces the minimum length too. This check gives the HTTP
   * caller a 400 in the shared error envelope.
   */
  q: z
    .string()
    .trim()
    .min(DIRECTORY_MIN_SEARCH_LENGTH)
    .meta({ description: "The search term, at least three characters after trimming." }),
  top: z.coerce
    .number()
    .int()
    .positive()
    .max(DIRECTORY_MAX_SEARCH_RESULTS)
    .default(10)
    .meta({ description: "The most groups to return, 1 to 25." }),
});
export type DirectorySearchQuery = z.infer<typeof DirectorySearchQuerySchema>;
