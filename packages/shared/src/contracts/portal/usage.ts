import { z } from "zod";
import {
  GatewayAuditPageSchema,
  GatewayOutcomeSchema,
  PlatformRangeSchema,
  PlatformUsageSchema,
  UsageRangeSchema,
  UsageSummarySchema,
} from "../../usage.js";
import { jsonResponse } from "../define.js";
import { apiError, portalRoute } from "./common.js";

const tags = ["Usage"] as const;

const slugParam = z.string().meta({ description: "The app's slug." });

/**
 * A `?limit=` value: a missing, unparseable or non-positive value reads as
 * `fallback`, and a larger one is capped at `max`. Leading digits count, so
 * `12abc` is 12.
 */
export function clampedLimitQuery(fallback: number, max: number) {
  return z
    .string()
    .optional()
    .transform((raw) => {
      const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 1) return fallback;
      return Math.min(Math.trunc(n), max);
    })
    .catch(fallback)
    .meta({
      description: `How many rows to return. Defaults to ${fallback}; at most ${max}.`,
    });
}

export const getAppUsage = portalRoute({
  id: "getAppUsage",
  method: "GET",
  path: "/api/v1/apps/:slug/usage",
  tags,
  summary: "Summarize an app's gateway usage",
  description:
    "Aggregate counts, tokens and cost over a rolling range. Discloses no caller identity.",
  params: z.object({ slug: slugParam }),
  query: z.object({
    range: UsageRangeSchema.catch("24h").default("24h").meta({
      description: "The rolling window. An unknown value reads as `24h`.",
    }),
  }),
  responses: {
    200: jsonResponse(UsageSummarySchema, "The usage summary."),
    404: apiError("No app has this slug (`not_found`)."),
  },
});

export const listAppGatewayCalls = portalRoute({
  id: "listAppGatewayCalls",
  method: "GET",
  path: "/api/v1/apps/:slug/audit",
  owner: true,
  tags,
  summary: "List an app's recent gateway calls",
  description:
    "The latest calls, newest first, with no cursor. `errorDetail` is null unless the " +
    "caller is a platform admin.",
  params: z.object({ slug: slugParam }),
  query: z.object({ limit: clampedLimitQuery(50, 200) }),
  responses: {
    200: jsonResponse(GatewayAuditPageSchema, "The latest calls; never has `nextBefore`."),
  },
});

export const listGatewayAudit = portalRoute({
  id: "listGatewayAudit",
  method: "GET",
  path: "/api/v1/gateway/audit",
  admin: true,
  tags,
  summary: "Page through the gateway audit log",
  description:
    "Calls across every app, newest first. Pass `nextBefore` as `before` for the next page.",
  query: z.object({
    app: z.string().optional().meta({ description: "Only calls to the app with this slug." }),
    outcome: GatewayOutcomeSchema.or(z.literal(""))
      .optional()
      .meta({ description: "Only calls with this outcome. Empty means no filter." }),
    limit: clampedLimitQuery(50, 200),
    before: z.string().optional().meta({
      description: "Only calls made before this ISO-8601 timestamp.",
    }),
  }),
  responses: {
    200: jsonResponse(GatewayAuditPageSchema, "One page of calls."),
    400: apiError(
      "`before` is not a timestamp, or `outcome` is not a known outcome (`validation_failed`).",
    ),
    404: apiError("No app has the `app` slug (`not_found`)."),
  },
});

export const getPlatformUsage = portalRoute({
  id: "getPlatformUsage",
  method: "GET",
  path: "/api/v1/gateway/usage",
  tags,
  summary: "Summarize gateway usage across the platform",
  description:
    "A trend and per-app and per-capability breakdowns over the range, plus month-to-date totals.",
  query: z.object({
    range: PlatformRangeSchema.catch("30d").default("30d").meta({
      description: "The rolling window. An unknown value reads as `30d`.",
    }),
  }),
  responses: {
    200: jsonResponse(PlatformUsageSchema, "The platform usage rollup."),
  },
});

export const usageContracts = [
  getAppUsage,
  listAppGatewayCalls,
  listGatewayAudit,
  getPlatformUsage,
] as const;
