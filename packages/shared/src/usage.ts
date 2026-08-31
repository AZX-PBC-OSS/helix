import { z } from "zod";

/**
 * Read-side metering contracts over the `gateway_calls` ledger (architecture
 * §6.1/§8, project plan §4 M4). The **edge writes** the ledger; the portal only
 * **reads** it for display, so these are response shapes for the portal's
 * usage/audit/platform endpoints — never a write boundary.
 *
 * Dollars alongside tokens: `gateway_calls` records token counts; the portal
 * recomputes `costUsd` at read time from the code-resident rate table
 * (./pricing.ts). Tokens stay — the daily budget is still token-denominated —
 * and cost sits beside them. Cache-aware: cache read/write tokens are carried
 * and priced separately (read ~0.1x, write 1.25x).
 */

/**
 * Gateway call outcomes — the values written to `gateway_calls.outcome`, and
 * the single source of truth for them. The edge **imports** `GatewayOutcome`
 * from here rather than declaring its own union: the two drifted once already
 * (`conflict` was added edge-side in 737da10 and never landed here, which made
 * every app-data 412 a 500 on the portal's audit route, since `toGatewayCall`
 * parses each row through `GatewayCallSchema`). Importing turns that class of
 * drift into a compile error.
 *
 * `forbidden` is the fetch-proxy's allowlist denial — the app asked for an
 * origin its manifest never granted. Like `quota_blocked` it is the platform's
 * own pre-egress refusal: no instruction is minted and nothing is dialled.
 */
export const GATEWAY_OUTCOMES = [
  "ok",
  "error",
  "refusal",
  "quota_blocked",
  "conflict",
  "forbidden",
] as const;
export const GatewayOutcomeSchema = z.enum(GATEWAY_OUTCOMES);
export type GatewayOutcome = z.infer<typeof GatewayOutcomeSchema>;

/**
 * Selectable trend windows. Per-app charts allow short, fine-grained ranges
 * (`24h` is hourly-bucketed); the platform rollup spans longer ranges. Both
 * resolve to a rolling `now − range` window with dense, zero-filled buckets.
 */
export const USAGE_RANGES = ["24h", "7d", "30d"] as const;
export const UsageRangeSchema = z.enum(USAGE_RANGES);
export type UsageRange = z.infer<typeof UsageRangeSchema>;

export const PLATFORM_RANGES = ["7d", "30d", "90d"] as const;
export const PlatformRangeSchema = z.enum(PLATFORM_RANGES);
export type PlatformRange = z.infer<typeof PlatformRangeSchema>;

/**
 * One dense time bucket on a trend series — the shared shape both the per-app
 * and platform endpoints emit, so one chart component renders either. `bucket`
 * is the bucket-start ISO timestamp; the grain (hour vs day) is implied by the
 * range. Carries all three metrics so the UI can toggle without a refetch.
 */
export const UsageSeriesPointSchema = z.object({
  bucket: z.iso.datetime(),
  costUsd: z.number().nonnegative(),
  tokens: z.int().nonnegative(),
  requests: z.int().nonnegative(),
});
export type UsageSeriesPoint = z.infer<typeof UsageSeriesPointSchema>;

/**
 * Per-app usage summary over a selectable rolling range — backs the app-detail
 * Usage tab. Aggregated from `gateway_calls`. Totals/series reflect the chosen
 * `range`; the separate `today` block stays calendar-day scoped so the daily-cap
 * gauge lines up with the edge's `date_trunc('day', now())` budget window.
 */
export const UsageSummarySchema = z.object({
  appId: z.uuid(),
  /** The rolling range these figures cover. */
  range: UsageRangeSchema,
  requests: z.int().nonnegative(),
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  /** Cache-aware input token totals (0 until prompt caching is enabled). */
  cacheReadInputTokens: z.int().nonnegative(),
  cacheCreationInputTokens: z.int().nonnegative(),
  /** Estimated spend in USD over the window at current rates (./pricing.ts). */
  costUsd: z.number().nonnegative(),
  /** 95th-percentile upstream latency (ms) over the window; null when no timed calls. */
  latencyP95Ms: z.number().nonnegative().nullable(),
  /** Fraction of calls in the window whose outcome was not `ok` (0..1). */
  errorRate: z.number().min(0).max(1),
  /** Count of calls keyed by outcome — see {@link GATEWAY_OUTCOMES}. */
  byOutcome: z.record(z.string(), z.int().nonnegative()),
  byModel: z.array(
    z.object({
      model: z.string(),
      tokens: z.int().nonnegative(),
      requests: z.int().nonnegative(),
      /** Estimated spend in USD for this model over the window. */
      costUsd: z.number().nonnegative(),
    }),
  ),
  /** Dense, zero-filled buckets across the range, oldest-first, for the trend chart. */
  series: z.array(UsageSeriesPointSchema),
  /**
   * Today-since-midnight totals, independent of `range` — backs the daily-cap
   * gauge (the budget the edge enforces is per calendar day).
   */
  today: z.object({
    tokens: z.int().nonnegative(),
    costUsd: z.number().nonnegative(),
  }),
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;

/**
 * One `gateway_calls` row, enriched with the app slug (left-joined — the ledger
 * outlives individual app records, so `slug` may be null for a deleted app).
 * Backs the admin audit log.
 */
export const GatewayCallSchema = z.object({
  id: z.uuid(),
  appId: z.uuid(),
  /** App slug at read time; null when the app row no longer exists. */
  slug: z.string().nullable(),
  userOid: z.string(),
  /**
   * The caller's claims as captured when the call was made — the **display half**
   * (`App.ownerName`/`ownerEmail` applied to the ledger). Render these; never
   * compare them, and never join on them. Null for anonymous, shared-password and
   * dev-token callers, and for rows predating the columns, in which case the UI
   * falls back to `userOid` — which is Entra's pairwise `sub` and identifies
   * nobody, so it is a last resort rather than a label.
   */
  userName: z.string().nullable(),
  userEmail: z.string().nullable(),
  capability: z.string(),
  model: z.string(),
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cacheReadInputTokens: z.int().nonnegative(),
  cacheCreationInputTokens: z.int().nonnegative(),
  /** Estimated spend in USD for this single call at current rates. */
  costUsd: z.number().nonnegative(),
  /** Upstream round-trip latency in ms (0 when not measured). */
  durationMs: z.int().nonnegative(),
  /** Upstream/egress HTTP status — set for `fetch`; null for streamed `llm`. */
  statusCode: z.int().nullable(),
  /**
   * Request path of the proxied call — set for `fetch`; null otherwise. The
   * target's query string is excluded (see `redactFetchTarget` in `./logging.ts`)
   * because that is where credentials are conventionally placed — but a path can
   * carry one too, and nothing here detects that. See ADR-0021.
   */
  path: z.string().nullable(),
  /** HTTP method of the proxied call — set for `fetch`; null otherwise. */
  method: z.string().nullable(),
  /** LLM stop reason; null for non-LLM calls. */
  stopReason: z.string().nullable(),
  /** Short upstream error string; null on success. */
  errorDetail: z.string().nullable(),
  outcome: GatewayOutcomeSchema,
  createdAt: z.iso.datetime(),
});
export type GatewayCall = z.infer<typeof GatewayCallSchema>;

/** Paginated audit response — newest-first, cursor on the trailing row. */
export const GatewayAuditPageSchema = z.object({
  rows: z.array(GatewayCallSchema),
  /** Pass as `?before=` to fetch the next (older) page; absent when exhausted. */
  nextBefore: z.iso.datetime().optional(),
});
export type GatewayAuditPage = z.infer<typeof GatewayAuditPageSchema>;

/**
 * Platform-wide rollup over `gateway_calls` — backs the admin Platform page and
 * the workspace `/usage` page. The `totals` are month-to-date headline KPIs; the
 * `series` and the `byApp`/`capabilityMix` breakdowns reflect the selected
 * `range`, so the trend is explorable while the MTD numbers stay fixed.
 */
export const PlatformUsageSchema = z.object({
  /** The rolling range the series + breakdowns cover. */
  range: PlatformRangeSchema,
  /** Dense, zero-filled daily buckets across the range, oldest-first. */
  series: z.array(UsageSeriesPointSchema),
  /** Per-app rollup over the range, busiest-first. */
  byApp: z.array(
    z.object({
      slug: z.string().nullable(),
      tokens: z.int().nonnegative(),
      requests: z.int().nonnegative(),
      /** Estimated spend in USD for this app over the range. */
      costUsd: z.number().nonnegative(),
    }),
  ),
  /** Month-to-date headline KPIs (independent of `range`). */
  totals: z.object({
    tokensMTD: z.int().nonnegative(),
    requestsMTD: z.int().nonnegative(),
    /** Estimated month-to-date spend in USD across all apps. */
    costMTD: z.number().nonnegative(),
    /** Distinct `userOid`s seen month-to-date. */
    activeUsers: z.int().nonnegative(),
  }),
  /** Token + cost share by capability over the range (essentially all `llm` in M4). */
  capabilityMix: z.array(
    z.object({
      capability: z.string(),
      tokens: z.int().nonnegative(),
      /** Estimated spend in USD for this capability over the range. */
      costUsd: z.number().nonnegative(),
    }),
  ),
});
export type PlatformUsage = z.infer<typeof PlatformUsageSchema>;
