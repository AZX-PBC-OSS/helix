import { z } from "zod";
import {
  BlockedSlugTermSchema,
  BlockedSlugTermsResponseSchema,
  CreateBlockedSlugTermRequestSchema,
  PlatformConfigResponseSchema,
  PlatformSettingsResponseSchema,
  UpdatePlatformSettingsRequestSchema,
} from "../../platformSettings.js";
import { emptyResponse, jsonBody, jsonResponse } from "../define.js";
import { apiError, portalRoute } from "./common.js";

const tags = ["Platform settings"] as const;

export const getPlatformSettings = portalRoute({
  id: "getPlatformSettings",
  method: "GET",
  path: "/api/v1/admin/settings",
  admin: true,
  tags,
  summary: "Read the operator settings",
  responses: {
    200: jsonResponse(PlatformSettingsResponseSchema, "The operator settings."),
  },
});

export const updatePlatformSettings = portalRoute({
  id: "updatePlatformSettings",
  method: "PUT",
  path: "/api/v1/admin/settings",
  admin: true,
  tags,
  summary: "Replace the operator settings",
  body: jsonBody(UpdatePlatformSettingsRequestSchema),
  responses: {
    200: jsonResponse(PlatformSettingsResponseSchema, "The updated operator settings."),
  },
});

export const listBlockedSlugTerms = portalRoute({
  id: "listBlockedSlugTerms",
  method: "GET",
  path: "/api/v1/admin/slug-terms",
  admin: true,
  tags,
  summary: "List blocked app-name terms",
  description: "Also lists live apps whose slug already contains a blocked term.",
  responses: {
    200: jsonResponse(BlockedSlugTermsResponseSchema, "The blocked terms and matching apps."),
  },
});

export const createBlockedSlugTerm = portalRoute({
  id: "createBlockedSlugTerm",
  method: "POST",
  path: "/api/v1/admin/slug-terms",
  admin: true,
  tags,
  summary: "Block an app-name term",
  body: jsonBody(CreateBlockedSlugTermRequestSchema),
  responses: {
    201: jsonResponse(BlockedSlugTermSchema, "The new blocked term."),
    409: apiError("The term is already blocked (`conflict`)."),
  },
});

export const deleteBlockedSlugTerm = portalRoute({
  id: "deleteBlockedSlugTerm",
  method: "DELETE",
  path: "/api/v1/admin/slug-terms/:id",
  admin: true,
  tags,
  summary: "Unblock an app-name term",
  params: z.object({ id: z.string().meta({ description: "The blocked term's id." }) }),
  responses: {
    204: emptyResponse("The term was removed."),
    404: apiError("No blocked term has this id (`not_found`)."),
  },
});

export const getPlatformConfig = portalRoute({
  id: "getPlatformConfig",
  method: "GET",
  path: "/api/v1/admin/config",
  admin: true,
  tags,
  summary: "Read this portal's configuration",
  description: "A read-only view of the deployment's configuration entries.",
  responses: {
    200: jsonResponse(PlatformConfigResponseSchema, "The configuration entries."),
  },
});

export const platformSettingsContracts = [
  getPlatformSettings,
  updatePlatformSettings,
  listBlockedSlugTerms,
  createBlockedSlugTerm,
  deleteBlockedSlugTerm,
  getPlatformConfig,
] as const;
