import { z } from "zod";

/**
 * Read-side metering contracts over the `gateway_calls` ledger (architecture
 * §6.1/§8, project plan §4 M4). The **edge writes** the ledger; the portal only
 * **reads** it for display, so these are response shapes for the portal's
 * usage/audit/platform endpoints — never a write boundary.
 *
 * Tokens, not dollars: `gateway_calls` records input/output token counts, not
 * cost. Cost is a product/pricing decision that isn't modelled yet, so nothing
 * here carries a `cost` field.
 */

/**
 * Gateway call outcomes — mirrors the edge's `GatewayOutcome`
 * (`apps/edge/src/gateway/usage.ts`) and the values written to
 * `gateway_calls.outcome`.
 */
export const GATEWAY_OUTCOMES = ["ok", "error", "refusal", "quota_blocked"] as const;
export const GatewayOutcomeSchema = z.enum(GATEWAY_OUTCOMES);
export type GatewayOutcome = z.infer<typeof GatewayOutcomeSchema>;

/**
 * Per-app usage summary over a rolling day window — backs the app-detail Usage
 * tab. Aggregated from `gateway_calls`; the day window matches the edge's
 * `date_trunc('day', now())` boundary so "today" lines up with the live quota.
 */
export const UsageSummarySchema = z.object({
  appId: z.uuid(),
  /** Window size in days (1 = today, 7 = last week, …). */
  windowDays: z.int().positive(),
  requests: z.int().nonnegative(),
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  /** Fraction of calls in the window whose outcome was not `ok` (0..1). */
  errorRate: z.number().min(0).max(1),
  /** Count of calls keyed by outcome (`ok` / `error` / `refusal` / `quota_blocked`). */
  byOutcome: z.record(z.string(), z.int().nonnegative()),
  byModel: z.array(
    z.object({
      model: z.string(),
      tokens: z.int().nonnegative(),
      requests: z.int().nonnegative(),
    }),
  ),
  /** Hourly buckets across the window, oldest-first, for the spark charts. */
  series: z.array(
    z.object({
      bucket: z.iso.datetime(),
      tokens: z.int().nonnegative(),
      requests: z.int().nonnegative(),
    }),
  ),
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
  capability: z.string(),
  model: z.string(),
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
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
 * the workspace `/usage` page. Tokens, not cost.
 */
export const PlatformUsageSchema = z.object({
  /** Daily token totals, oldest-first (default 14 days). */
  tokens14d: z.array(z.int().nonnegative()),
  /** Daily request totals, oldest-first (default 14 days). */
  requests14d: z.array(z.int().nonnegative()),
  /** Per-app rollup over the same window, busiest-first. */
  byApp: z.array(
    z.object({
      slug: z.string().nullable(),
      tokens: z.int().nonnegative(),
      requests: z.int().nonnegative(),
    }),
  ),
  totals: z.object({
    tokensMTD: z.int().nonnegative(),
    requestsMTD: z.int().nonnegative(),
    /** Distinct `userOid`s seen month-to-date. */
    activeUsers: z.int().nonnegative(),
  }),
  /** Token share by capability — derived from real rows (essentially all `llm` in M4). */
  capabilityMix: z.array(
    z.object({
      capability: z.string(),
      tokens: z.int().nonnegative(),
    }),
  ),
});
export type PlatformUsage = z.infer<typeof PlatformUsageSchema>;
