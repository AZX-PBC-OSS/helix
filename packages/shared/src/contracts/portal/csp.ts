import { CspViolationsPageSchema } from "../../api.js";
import { jsonResponse } from "../define.js";
import { portalRoute } from "./common.js";

export const listCspViolations = portalRoute({
  id: "listCspViolations",
  method: "GET",
  path: "/api/v1/csp/violations",
  admin: true,
  tags: ["CSP"],
  summary: "List CSP violations",
  description:
    "The edge's CSP reports, grouped by app, directive, and blocked URI, most recent first. At most 200 groups.",
  responses: {
    200: jsonResponse(CspViolationsPageSchema, "The grouped violations."),
  },
});

export const cspContracts = [listCspViolations] as const;
