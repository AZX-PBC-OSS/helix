import { z } from "zod";

/**
 * App-data design §3.2/§5 — the owner-facing shape of a collected item. The app
 * frontend never sees these (collections are write-only from the browser); only
 * the portal's owner drain/export reads them, including the coarse abuse-triage
 * `meta`. `item` is opaque app-supplied JSON.
 */
export const CollectionItemSchema = z.object({
  id: z.uuid(),
  collection: z.string(),
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
