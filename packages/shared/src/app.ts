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
});
export type App = z.infer<typeof AppSchema>;
