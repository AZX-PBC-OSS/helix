import { z } from "zod";
import { RollbackRequestSchema, UploadVersionResponseSchema } from "../../api.js";
import { AppSchema } from "../../app.js";
import { VersionSchema } from "../../version.js";
import { jsonBody, jsonResponse, media, type BodySpec } from "../define.js";
import { apiError, portalRoute } from "./common.js";

const tags = ["Versions"] as const;

const slugParam = z.string().meta({ description: "The app's slug." });

/**
 * The multipart upload both deploy routes read. The handler reads the parts
 * itself; `report` must precede `bundle`, because only fields sent before the
 * file are visible when the file is read.
 */
export function bundleUploadBody(withReport: boolean): BodySpec {
  const bundle = z.string().meta({
    format: "binary",
    description: "The app bundle, a zip archive. It must be the only file part.",
  });
  return {
    required: true,
    content: media(
      "multipart/form-data",
      undefined,
      withReport
        ? z.object({
            report: z
              .string()
              .optional()
              .meta({
                description:
                  "Optional client-asserted deploy report (JSON, at most 8 KB), sent before " +
                  "`bundle`. An oversized or invalid report is ignored, never a deploy failure.",
              }),
            bundle,
          })
        : z.object({ bundle }),
    ),
  };
}

/** The error responses an upload adds to the defaults, shared with the CI route. */
export const bundleUploadErrors = {
  400: apiError(
    "The request has no `bundle` file, or the bundle failed validation (`bundle_invalid`).",
  ),
  409: apiError("The app is archived, or a version number could not be allocated (`conflict`)."),
  413: apiError("The bundle is larger than the upload limit (`bundle_invalid`)."),
};

export const uploadVersion = portalRoute({
  id: "uploadVersion",
  method: "POST",
  path: "/api/v1/apps/:slug/versions",
  owner: true,
  tags,
  summary: "Upload a bundle as a new preview version",
  description: "The new version is a preview; promote it to make it live.",
  params: z.object({ slug: slugParam }),
  body: bundleUploadBody(true),
  responses: {
    201: jsonResponse(UploadVersionResponseSchema, "The new version and any CSP warnings."),
    ...bundleUploadErrors,
  },
});

export const listVersions = portalRoute({
  id: "listVersions",
  method: "GET",
  path: "/api/v1/apps/:slug/versions",
  tags,
  summary: "List an app's versions",
  description: "Newest first.",
  params: z.object({ slug: slugParam }),
  responses: {
    200: jsonResponse(z.array(VersionSchema), "The app's versions."),
    404: apiError("No app has this slug (`not_found`)."),
  },
});

export const promoteVersion = portalRoute({
  id: "promoteVersion",
  method: "POST",
  path: "/api/v1/apps/:slug/versions/:number/promote",
  owner: true,
  tags,
  summary: "Make a preview version live",
  description: "Promoting the version that is already live returns the app unchanged.",
  params: z.object({
    slug: slugParam,
    number: z.string().meta({ description: "The version number, a positive integer." }),
  }),
  responses: {
    200: jsonResponse(AppSchema, "The app, with the version live."),
    400: apiError("The version number is not a positive integer (`validation_failed`)."),
    404: apiError("No app has this slug, or the app has no such version (`not_found`)."),
    409: apiError(
      "The app is archived, or the version is archived and needs a rollback (`conflict`).",
    ),
  },
});

export const rollbackVersion = portalRoute({
  id: "rollbackVersion",
  method: "POST",
  path: "/api/v1/apps/:slug/rollback",
  owner: true,
  tags,
  summary: "Roll back to an earlier version",
  description:
    "Without `toNumber`, rolls back to the most recently archived version, the one live " +
    "before the current one. Rolling back to the live version returns the app unchanged.",
  params: z.object({ slug: slugParam }),
  body: { ...jsonBody(RollbackRequestSchema), required: false },
  responses: {
    200: jsonResponse(AppSchema, "The app, with the target version live."),
    404: apiError("No app has this slug, or the app has no such version (`not_found`)."),
    409: apiError("The app is archived, or there is no earlier version (`conflict`)."),
  },
});

export const versionsContracts = [
  uploadVersion,
  listVersions,
  promoteVersion,
  rollbackVersion,
] as const;
