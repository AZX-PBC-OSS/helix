import { z } from "zod";
import { UploadVersionResponseSchema } from "../../api.js";
import { apiError, portalRoute } from "./common.js";
import { jsonResponse } from "../define.js";
import { bundleUploadBody, bundleUploadErrors } from "./versions.js";

export const uploadCiVersion = portalRoute({
  id: "uploadCiVersion",
  method: "POST",
  path: "/api/v1/apps/:slug/ci/versions",
  auth: "oidc-ci",
  tags: ["Versions"],
  summary: "Upload a preview version from GitHub Actions",
  description:
    "Called by a GitHub Actions job on the app's bound repository and branch, with the " +
    "job's OIDC token as the bearer token (ADR-0051). Creates a preview version only.",
  params: z.object({ slug: z.string().meta({ description: "The app's slug." }) }),
  body: bundleUploadBody(false),
  responses: {
    201: jsonResponse(UploadVersionResponseSchema, "The new version and any CSP warnings."),
    ...bundleUploadErrors,
    401: apiError(
      "The bearer token is missing or is not a valid GitHub Actions token (`unauthorized`).",
    ),
    403: apiError(
      "The token's repository, branch, workflow or environment does not match the app's " +
        "repo binding, or no app with this slug accepts repo deploys (`forbidden`).",
    ),
    404: apiError("Repo-backed deploys are not enabled on this portal (`not_found`)."),
    409: apiError(
      "The app is archived, the token has already deployed a version, or a version number " +
        "could not be allocated (`conflict`).",
    ),
  },
});

export const ciVersionsContracts = [uploadCiVersion] as const;
