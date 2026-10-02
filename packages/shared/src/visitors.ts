import { z } from "zod";

/**
 * Visitor analytics for a hosted app (ADR-0050) — backs the Visitors section of
 * the app-detail Usage tab. Aggregated from `app_visits`, which the edge writes
 * once per top-level document load.
 *
 * A **visit** is a run of loads by one visitor with no gap longer than
 * {@link VISIT_IDLE_MINUTES}. A **visitor** is a distinct keyed hash of the
 * client IP, so people behind one NAT count once and one person on two
 * networks counts twice.
 */
export const VISITOR_RANGES = ["7d", "30d", "90d"] as const;
export const VisitorRangeSchema = z.enum(VISITOR_RANGES);
export type VisitorRange = z.infer<typeof VisitorRangeSchema>;

/** Idle gap that ends a visit. */
export const VISIT_IDLE_MINUTES = 30;

/** How many location rows the summary names before rolling the rest up. */
export const VISITOR_LOCATION_LIMIT = 10;

const count = z.int().nonnegative();

export const VisitorTotalsSchema = z.object({
  visits: count,
  uniqueVisitors: count,
});
export type VisitorTotals = z.infer<typeof VisitorTotalsSchema>;

/**
 * Whether the portal can place visitors, and the licence notice it must show
 * when it does. `reason` explains an unavailable resolver to the owner.
 */
export const GeoStatusSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  attribution: z.object({ text: z.string(), url: z.url() }).nullable(),
});
export type GeoStatus = z.infer<typeof GeoStatusSchema>;

export const VisitorLocationSchema = z.object({
  /** ISO 3166-1 alpha-2. */
  country: z.string(),
  countryName: z.string().nullable(),
  /** First-level subdivision (state, province); null when the database has none. */
  region: z.string().nullable(),
  visitors: count,
  visits: count,
});
export type VisitorLocation = z.infer<typeof VisitorLocationSchema>;

export const VisitorSeriesPointSchema = z.object({
  /** Bucket-start ISO timestamp (one calendar day). */
  bucket: z.iso.datetime(),
  visits: count,
  /** Distinct visitors that day — a visitor active on two days counts on each. */
  uniqueVisitors: count,
});
export type VisitorSeriesPoint = z.infer<typeof VisitorSeriesPointSchema>;

export const VisitorSummarySchema = z.object({
  appId: z.uuid(),
  range: VisitorRangeSchema,
  /** The selected window. */
  current: VisitorTotalsSchema,
  /** The window of the same length immediately before it, for the deltas. */
  prior: VisitorTotalsSchema,
  /** Dense, zero-filled daily buckets, oldest first. */
  series: z.array(VisitorSeriesPointSchema),
  /** The top {@link VISITOR_LOCATION_LIMIT} locations by visitors. */
  locations: z.array(VisitorLocationSchema),
  /** Every resolved location past the top ones. */
  otherLocations: VisitorTotalsSchema,
  /** Private, proxied or unknown networks, and every row when geo is unavailable. */
  unresolved: VisitorTotalsSchema,
  geo: GeoStatusSchema,
});
export type VisitorSummary = z.infer<typeof VisitorSummarySchema>;
