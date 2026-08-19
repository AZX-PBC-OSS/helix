import { z } from "zod";
import { VisibilitySchema } from "./visibility.js";

/**
 * A registered app in the control-plane registry (architecture §7).
 *
 * `slug` is the subdomain label — `<slug>.azx.helix.azxlabs.io` — and is the isolation
 * boundary (§4.1), so it is constrained to a DNS label. Every record is keyed
 * by app id from day one (decision §9.8) to keep multi-org additive later.
 */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const AppSchema = z.object({
  id: z.uuid(),
  slug: z
    .string()
    .min(1)
    .max(63)
    .regex(SLUG_PATTERN, "must be a lowercase DNS label (a-z, 0-9, hyphen)"),
  displayName: z.string().min(1).max(200),
  visibility: VisibilitySchema,
  /** The version currently served; null before the first deploy. */
  currentVersionId: z.uuid().nullable(),
  /** When set, the app is archived: the edge serves 410 + Clear-Site-Data (§7). */
  archivedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /**
   * Where this app is served, computed control-plane-side from the deployment's
   * apps base (`APP_PUBLIC_BASE`) — so clients render a URL instead of
   * templating `<slug>.<domain>` themselves and drifting per deployment. Optional
   * on the wire: the CLI parses this schema, so requiring it would break a newer
   * CLI against an older portal. Clients that lack it fall back to composing the
   * slug onto `appPublicBase` from `GET /api/v1/config`.
   */
  url: z.url().optional(),
  /**
   * Who owns this app — the portal actor that created it (`actor.sub`). The
   * **identity** half: this is what `scope=mine` and `ownsApp` compare against,
   * and it is never what a screen renders.
   *
   * Optional for the same reason as `url`: the CLI parses this schema, and rows
   * predating the approvals work carry no owner at all.
   */
  ownerId: z.string().optional(),
  /**
   * The owner's claims as captured at create time. The **display** half: render
   * these, never compare them. `ownerId` only looks like an email by accident of
   * the portal verifier collapsing the subject to
   * `email ?? preferred_username ?? sub`, and it is slated to be re-based onto an
   * opaque directory id — so display travels separately. Absent for rows created
   * before the columns existed; fall back to `ownerId`.
   */
  ownerName: z.string().optional(),
  ownerEmail: z.string().optional(),
});
export type App = z.infer<typeof AppSchema>;

/**
 * An app as the **list** endpoint returns it: the record plus the deploy
 * aggregates the apps table renders.
 *
 * These live here rather than on {@link AppSchema} because they are derived, not
 * registry state — and because computing them per row is exactly the 1+N the
 * list surface used to do (one `GET /versions` per card). The list endpoint
 * rolls them up in one query instead.
 *
 * `latestPreviewNumber` is what lets a caller tell "no deploys yet" from "a
 * preview is waiting to be promoted" (§5.1) without fetching any version rows.
 */
export const AppListItemSchema = AppSchema.extend({
  /** Total versions ever deployed into this app. */
  versionCount: z.int().nonnegative(),
  /** When the most recent version was created; null before the first deploy. */
  lastDeployAt: z.iso.datetime().nullable(),
  /** `number` of the version currently served; null before the first promote. */
  liveVersionNumber: z.int().positive().nullable(),
  /** Highest `preview`-status version; null when none exists. */
  latestPreviewNumber: z.int().positive().nullable(),
});
export type AppListItem = z.infer<typeof AppListItemSchema>;

/** Which apps `GET /api/v1/apps` returns. A filter, never a permission gate. */
export const APP_LIST_SCOPES = ["mine", "all"] as const;
export const AppListScopeSchema = z.enum(APP_LIST_SCOPES);
export type AppListScope = z.infer<typeof AppListScopeSchema>;
