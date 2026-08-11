import { z } from "zod";
import { EnvSchema } from "./env.js";

/**
 * App-data design §3.2/§5 — the owner-facing shape of a collected item. The app
 * frontend never sees these (collections are write-only from the browser); only
 * the portal's owner drain/export reads them, including the coarse abuse-triage
 * `meta`. `item` is opaque app-supplied JSON.
 */
export const CollectionItemSchema = z.object({
  id: z.uuid(),
  collection: z.string(),
  /**
   * Which tier collected the row (dev-mode §5). The runtime roles are RLS-pinned
   * to one tier each, but the portal reads across both, so the discriminator has
   * to travel — otherwise a developer's dev-mode test submissions are
   * indistinguishable from real prod leads in the drain.
   */
  env: EnvSchema,
  /** The submitting user, if authenticated; null for anonymous/public visitors. */
  userOid: z.string().nullable(),
  item: z.unknown(),
  /** Hashed IP / truncated UA for abuse triage; null if not captured. */
  meta: z.unknown().nullable(),
  createdAt: z.iso.datetime(),
});
export type CollectionItem = z.infer<typeof CollectionItemSchema>;

/** Paginated owner drain — newest-first, cursor on the trailing row's createdAt. */
export const CollectionItemsPageSchema = z.object({
  rows: z.array(CollectionItemSchema),
  /** Pass as `?before=` to fetch the next (older) page; absent when exhausted. */
  nextBefore: z.iso.datetime().optional(),
});
export type CollectionItemsPage = z.infer<typeof CollectionItemsPageSchema>;

/**
 * What an app has actually collected, per (collection, env) — the index behind the
 * owner's collection picker.
 *
 * This exists because the manifest is *not* a sufficient source of truth. Grants
 * are owner-editable, and nothing ever deletes rows, so removing a name from
 * `data.collections` leaves visitor PII in the table that a manifest-driven UI can
 * no longer show, export, or erase. An aggregate over the rows themselves is the
 * only way to surface those orphans. Callers union this with the manifest so a
 * declared-but-empty collection still appears.
 */
export const CollectionSummarySchema = z.object({
  name: z.string(),
  env: EnvSchema,
  count: z.int().nonnegative(),
  /** Newest row's timestamp; null only if the group is somehow empty. */
  lastAt: z.iso.datetime().nullable(),
});
export type CollectionSummary = z.infer<typeof CollectionSummarySchema>;
