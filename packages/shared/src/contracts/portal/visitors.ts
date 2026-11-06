import { z } from "zod";
import { VisitorRangeSchema, VisitorSummarySchema } from "../../visitors.js";
import { jsonResponse } from "../define.js";
import { portalRoute } from "./common.js";

export const getAppVisitors = portalRoute({
  id: "getAppVisitors",
  method: "GET",
  path: "/api/v1/apps/:slug/visitors",
  owner: true,
  tags: ["Usage"],
  summary: "Summarize who opens an app",
  description:
    "Visits and unique visitors for the range and the range before it, a daily series, " +
    "and visitor locations.",
  params: z.object({ slug: z.string().meta({ description: "The app's slug." }) }),
  query: z.object({
    range: VisitorRangeSchema.catch("30d").meta({
      description: "The window in calendar days. An unknown value reads as `30d`.",
    }),
  }),
  responses: {
    200: jsonResponse(VisitorSummarySchema, "The visitor summary."),
  },
});

export const visitorsContracts = [getAppVisitors] as const;
