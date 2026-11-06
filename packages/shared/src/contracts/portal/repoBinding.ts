import { z } from "zod";
import { RepoBindingSchema, SetRepoBindingRequestSchema } from "../../repoBinding.js";
import { emptyResponse, jsonBody, jsonResponse } from "../define.js";
import { apiError, portalRoute } from "./common.js";

const tags = ["Repo binding"] as const;

const params = z.object({ slug: z.string().meta({ description: "The app's slug." }) });

const disabled = "Repo deploys are disabled on this portal, or no app has this slug (`not_found`).";

export const getRepoBinding = portalRoute({
  id: "getRepoBinding",
  method: "GET",
  path: "/api/v1/apps/:slug/repo-binding",
  owner: true,
  tags,
  summary: "Read an app's repo binding",
  description: "The GitHub repository and branch that may upload preview versions from CI.",
  params,
  responses: {
    200: jsonResponse(RepoBindingSchema, "The app's repo binding."),
    404: apiError(
      "Repo deploys are disabled on this portal, no app has this slug, or the app has no binding (`not_found`). `details.reason` is `no_binding` in the last case.",
    ),
  },
});

export const setRepoBinding = portalRoute({
  id: "setRepoBinding",
  method: "PUT",
  path: "/api/v1/apps/:slug/repo-binding",
  owner: true,
  tags,
  summary: "Set an app's repo binding",
  description:
    "Creates or replaces the binding. Changing the repository clears the pinned repository and owner ids.",
  params,
  body: jsonBody(SetRepoBindingRequestSchema),
  responses: {
    200: jsonResponse(RepoBindingSchema, "The saved binding."),
    404: apiError(disabled),
    409: apiError("The app is archived (`conflict`)."),
  },
});

export const deleteRepoBinding = portalRoute({
  id: "deleteRepoBinding",
  method: "DELETE",
  path: "/api/v1/apps/:slug/repo-binding",
  owner: true,
  tags,
  summary: "Remove an app's repo binding",
  description: "Idempotent: removing a binding that does not exist also succeeds.",
  params,
  responses: {
    204: emptyResponse("The binding was removed."),
    404: apiError(disabled),
  },
});

export const repoBindingContracts = [getRepoBinding, setRepoBinding, deleteRepoBinding] as const;
