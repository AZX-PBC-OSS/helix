// Contracts for apps/portal/src/routes/data.ts (ADR-0054).
import { z } from "zod";
import {
  CollectionExportSchema,
  CollectionItemsPageSchema,
  CollectionSummarySchema,
} from "../../data.js";
import { ENVS } from "../../env.js";
import { emptyResponse, json, jsonResponse, media } from "../define.js";
import { apiError, portalRoute } from "./common.js";

const tags = ["App data"] as const;

const slug = z.string().meta({ description: "The app's slug." });
const name = z.string().meta({ description: "The collection name." });

/**
 * `?env=` narrows to one tier. Absent or empty means both tiers: callers that
 * build the query string unconditionally send `?env=`.
 */
const env = z
  .enum(["", ...ENVS])
  .optional()
  .transform((v) => (v === "" ? undefined : v))
  .meta({ description: "Only rows from this tier. Absent or empty returns both tiers." });

/** A page size: a non-numeric or non-positive value falls back, a large one is capped. */
function pageLimit(fallback: number, max: number) {
  return (
    z
      .string()
      .optional()
      // A repeated key arrives as an array, which falls back like any other bad value.
      .catch(undefined)
      .transform((raw) => {
        const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
        if (!Number.isFinite(n) || n < 1) return fallback;
        return Math.min(Math.trunc(n), max);
      })
      .meta({
        description: `Rows per page, 1 to ${max}. Defaults to ${fallback}; a larger value is capped.`,
      })
  );
}

export const listAppCollections = portalRoute({
  id: "listAppCollections",
  method: "GET",
  path: "/api/v1/apps/:slug/collections",
  owner: true,
  tags,
  summary: "List an app's collected data",
  description:
    "Row counts per collection and tier, from the rows themselves. A collection removed " +
    "from the manifest still appears while it holds rows.",
  params: z.object({ slug }),
  responses: {
    200: jsonResponse(
      z.array(CollectionSummarySchema),
      "One entry per collection and tier, sorted by name then tier.",
    ),
  },
});

export const listAppCollectionItems = portalRoute({
  id: "listAppCollectionItems",
  method: "GET",
  path: "/api/v1/apps/:slug/collections/:name",
  owner: true,
  tags,
  summary: "Page through a collection",
  description: "Newest first. Pass `nextBefore` from a page as `before` to fetch the next one.",
  params: z.object({ slug, name }),
  query: z.object({
    limit: pageLimit(50, 200),
    before: z
      .string()
      .optional()
      .meta({ description: "Only rows created before this ISO-8601 timestamp." }),
    env,
  }),
  responses: {
    200: jsonResponse(CollectionItemsPageSchema, "One page of rows."),
    400: apiError("`before` is not a timestamp, or `env` is not a tier (`validation_failed`)."),
  },
});

const exportHeaders = z.object({
  "x-helix-export-truncated": z.string().optional().meta({
    description:
      "Present when the collection exceeds the export cap. Holds the cap; the oldest rows were left out.",
  }),
  "x-helix-export-columns-truncated": z
    .string()
    .optional()
    .meta({
      description:
        "CSV only. Present when the items have more keys than the derived-column cap. Holds the " +
        "cap; the raw `item` column still carries every key.",
    }),
  "content-disposition": z
    .string()
    .optional()
    .meta({ description: "CSV only. An attachment filename built from the slug and collection." }),
});

export const exportAppCollection = portalRoute({
  id: "exportAppCollection",
  method: "GET",
  path: "/api/v1/apps/:slug/collections/:name/export",
  owner: true,
  tags,
  summary: "Export a collection",
  description:
    "The newest 10,000 rows, oldest first, as JSON or CSV. Each export is audited as " +
    "`collection.exported`.",
  params: z.object({ slug, name }),
  query: z.object({
    format: z
      .string()
      .optional()
      .catch(undefined)
      .transform((v) => (v === "csv" ? "csv" : "json"))
      .meta({ description: "`csv` for CSV. Any other value, or none, returns JSON." }),
    env,
  }),
  responses: {
    200: {
      description: "The exported rows.",
      content: {
        ...json(CollectionExportSchema, "The default format."),
        ...media("text/csv", "With `format=csv`: one row per item, with derived columns."),
      },
      headers: exportHeaders,
    },
    400: apiError("`env` is not a tier (`validation_failed`)."),
  },
});

export const deleteAppCollectionItem = portalRoute({
  id: "deleteAppCollectionItem",
  method: "DELETE",
  path: "/api/v1/apps/:slug/collections/:name/items/:id",
  owner: true,
  tags,
  summary: "Erase one collected item",
  description: "The deletion and its `collection.item_deleted` audit row commit together.",
  params: z.object({
    slug,
    name,
    id: z.string().meta({ description: "The item's id." }),
  }),
  responses: {
    204: emptyResponse("The item was erased."),
    404: apiError(
      "No app has this slug, or the collection has no item with this id (`not_found`).",
    ),
  },
});

export const dataContracts = [
  listAppCollections,
  listAppCollectionItems,
  exportAppCollection,
  deleteAppCollectionItem,
] as const;
