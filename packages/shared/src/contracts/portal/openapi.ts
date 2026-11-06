import { z } from "zod";
import { jsonResponse } from "../define.js";
import { portalRoute } from "./common.js";

export const getPortalOpenApi = portalRoute({
  id: "getPortalOpenApi",
  method: "GET",
  path: "/api/v1/openapi.json",
  auth: "none",
  tags: ["Meta"],
  summary: "Read this OpenAPI document",
  description:
    "The portal API's OpenAPI 3.1 document for this portal's own release. Public: the " +
    "document describes routes, not data.",
  responses: {
    200: jsonResponse(
      z.record(z.string(), z.unknown()).meta({ description: "An OpenAPI 3.1 document." }),
      "The OpenAPI document.",
    ),
  },
});

export const openapiContracts = [getPortalOpenApi] as const;
