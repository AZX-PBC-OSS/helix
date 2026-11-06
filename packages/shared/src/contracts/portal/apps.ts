import { z } from "zod";
import {
  CreateAppRequestSchema,
  OriginGrantRequestSchema,
  PasswordCredentialResponseSchema,
  SetManifestRequestSchema,
  SetPasswordRequestSchema,
  SetVisibilityRequestSchema,
  UpdateAppRequestSchema,
} from "../../api.js";
import { AppListItemSchema, AppListScopeSchema, AppSchema } from "../../app.js";
import { ManifestUpdateResultSchema, VisibilityUpdateResultSchema } from "../../approval.js";
import { AppManifestSchema } from "../../manifest.js";
import { SlugCheckResponseSchema } from "../../platformSettings.js";
import { emptyResponse, jsonBody, jsonResponse } from "../define.js";
import { apiError, portalRoute } from "./common.js";

const tags = ["Apps"] as const;

const slugParams = z.object({
  slug: z.string().meta({ description: "The app's slug." }),
});

export const checkAppSlug = portalRoute({
  id: "checkAppSlug",
  method: "GET",
  path: "/api/v1/slug-check",
  tags,
  summary: "Check whether a slug can be used for a new app",
  description:
    "Reports everything app creation would refuse about a slug: a malformed slug, a reserved or blocked term, or a slug already taken. A missing or malformed slug answers 200 with reason `invalid`, not 400.",
  query: z.object({
    // Any non-string (a repeated parameter) is reported as `invalid`, not 400.
    slug: z.string().optional().catch(undefined).meta({ description: "The slug to check." }),
  }),
  responses: {
    200: jsonResponse(SlugCheckResponseSchema, "Whether the slug is available, and why not."),
  },
});

export const createApp = portalRoute({
  id: "createApp",
  method: "POST",
  path: "/api/v1/apps",
  tags,
  summary: "Create an app",
  description: "The caller becomes the app's owner.",
  body: jsonBody(CreateAppRequestSchema),
  responses: {
    201: jsonResponse(AppSchema, "The new app."),
    400: apiError(
      "The request failed validation, the slug is reserved or contains a blocked term, or a requested job type is not available (`validation_failed`).",
    ),
    403: apiError(
      "This deployment does not allow public or password apps, and one was requested (`forbidden`).",
    ),
    409: apiError("The slug is already taken (`slug_taken`)."),
  },
});

export const listApps = portalRoute({
  id: "listApps",
  method: "GET",
  path: "/api/v1/apps",
  tags,
  summary: "List apps",
  description:
    "`scope` is a filter, not a permission gate: every signed-in caller may list all apps.",
  query: z.object({
    scope: AppListScopeSchema.catch("mine").meta({
      description:
        "`mine` lists the caller's own apps; `all` lists every app. A missing or unknown value means `mine`.",
    }),
  }),
  responses: {
    200: jsonResponse(z.array(AppListItemSchema), "The apps, oldest first."),
  },
});

export const getApp = portalRoute({
  id: "getApp",
  method: "GET",
  path: "/api/v1/apps/:slug",
  tags,
  summary: "Get an app",
  params: slugParams,
  responses: {
    200: jsonResponse(AppSchema, "The app."),
    404: apiError("No app has this slug (`not_found`)."),
  },
});

export const updateApp = portalRoute({
  id: "updateApp",
  method: "PATCH",
  path: "/api/v1/apps/:slug",
  owner: true,
  tags,
  summary: "Edit an app's registry record",
  description: "Only the keys present are applied: an absent key is unchanged, `null` clears it.",
  params: slugParams,
  body: jsonBody(UpdateAppRequestSchema),
  responses: {
    200: jsonResponse(AppSchema, "The app."),
  },
});

export const archiveApp = portalRoute({
  id: "archiveApp",
  method: "POST",
  path: "/api/v1/apps/:slug/archive",
  owner: true,
  tags,
  summary: "Archive an app",
  description:
    "The edge then answers the app's host with 410. Idempotent. Cancellation of the app's running jobs is delivered asynchronously.",
  params: slugParams,
  responses: {
    200: jsonResponse(AppSchema, "The archived app."),
  },
});

export const unarchiveApp = portalRoute({
  id: "unarchiveApp",
  method: "POST",
  path: "/api/v1/apps/:slug/unarchive",
  owner: true,
  tags,
  summary: "Unarchive an app",
  description: "Idempotent.",
  params: slugParams,
  responses: {
    200: jsonResponse(AppSchema, "The app."),
  },
});

export const getAppManifest = portalRoute({
  id: "getAppManifest",
  method: "GET",
  path: "/api/v1/apps/:slug/manifest",
  tags,
  summary: "Get an app's manifest",
  description:
    "The app's visibility and capability grants. Each provider-bound origin reports whether its approval is still effective.",
  params: slugParams,
  responses: {
    200: jsonResponse(AppManifestSchema, "The manifest."),
    404: apiError("No app has this slug (`not_found`)."),
  },
});

const capabilityWriteResponses = {
  200: jsonResponse(
    ManifestUpdateResultSchema,
    "The resulting manifest, the baseline changes applied now, and the id of the approval request opened for elevated changes (or null).",
  ),
  400: apiError(
    "The request failed validation, a requested job type is not available, or a provider binding is invalid (`validation_failed`).",
  ),
  409: apiError("The app's policy changed concurrently (`conflict`)."),
};

export const setAppManifest = portalRoute({
  id: "setAppManifest",
  method: "PUT",
  path: "/api/v1/apps/:slug/manifest",
  owner: true,
  tags,
  summary: "Replace an app's capability grants",
  description:
    "Baseline changes commit immediately. Elevated changes are bundled into one pending approval request.",
  params: slugParams,
  body: jsonBody(SetManifestRequestSchema),
  responses: capabilityWriteResponses,
});

export const grantAppOrigin = portalRoute({
  id: "grantAppOrigin",
  method: "POST",
  path: "/api/v1/apps/:slug/access/origin",
  owner: true,
  tags,
  summary: "Request one external origin for an app",
  description: "Adding an origin is always elevated, so this opens an approval request.",
  params: slugParams,
  body: jsonBody(OriginGrantRequestSchema),
  responses: capabilityWriteResponses,
});

export const setAppVisibility = portalRoute({
  id: "setAppVisibility",
  method: "POST",
  path: "/api/v1/apps/:slug/visibility",
  owner: true,
  tags,
  summary: "Change how an app gates access",
  description:
    "Reducing exposure commits immediately. Going public opens an approval request. Password visibility is enabled through the password-access route instead.",
  params: slugParams,
  body: jsonBody(SetVisibilityRequestSchema),
  responses: {
    200: jsonResponse(
      VisibilityUpdateResultSchema,
      "The app, the change applied now, and the id of the approval request opened (or null).",
    ),
    403: apiError(
      "The caller does not own the app and is not a platform admin, or public apps are disabled on this deployment (`forbidden`).",
    ),
    409: apiError(
      "Password visibility was requested, or the app's policy changed concurrently (`conflict`).",
    ),
  },
});

const passwordTags = ["Apps", "Password access"] as const;

export const enableAppPassword = portalRoute({
  id: "enableAppPassword",
  method: "POST",
  path: "/api/v1/apps/:slug/access/password",
  owner: true,
  tags: passwordTags,
  summary: "Enable shared-password access",
  description:
    "Switches the app to password visibility and mints a passphrase. Idempotent: when password access is already enabled, the existing credential is returned.",
  params: slugParams,
  responses: {
    200: jsonResponse(PasswordCredentialResponseSchema, "Password access was already enabled."),
    201: jsonResponse(PasswordCredentialResponseSchema, "Password access was enabled."),
    403: apiError(
      "The caller does not own the app and is not a platform admin, or password apps are disabled on this deployment (`forbidden`).",
    ),
    409: apiError("The app's access mode changed concurrently (`conflict`)."),
  },
});

export const rotateAppPassword = portalRoute({
  id: "rotateAppPassword",
  method: "POST",
  path: "/api/v1/apps/:slug/access/password/rotate",
  owner: true,
  tags: passwordTags,
  summary: "Rotate the shared password",
  description: "Omit the body or `password` to generate a passphrase; supply one to set it.",
  params: slugParams,
  body: { ...jsonBody(SetPasswordRequestSchema.nullish()), required: false },
  responses: {
    200: jsonResponse(PasswordCredentialResponseSchema, "The new credential."),
    403: apiError(
      "The caller does not own the app and is not a platform admin, or password apps are disabled on this deployment (`forbidden`).",
    ),
    409: apiError(
      "Password access is not enabled, or the app's access mode changed concurrently (`conflict`).",
    ),
  },
});

export const getAppPassword = portalRoute({
  id: "getAppPassword",
  method: "GET",
  path: "/api/v1/apps/:slug/access/password",
  owner: true,
  tags: passwordTags,
  summary: "Read the shared password",
  params: slugParams,
  responses: {
    200: jsonResponse(PasswordCredentialResponseSchema, "The current credential."),
    404: apiError("No app has this slug, or password access is not enabled (`not_found`)."),
  },
});

export const disableAppPassword = portalRoute({
  id: "disableAppPassword",
  method: "DELETE",
  path: "/api/v1/apps/:slug/access/password",
  owner: true,
  tags: passwordTags,
  summary: "Disable shared-password access",
  description:
    "Reverts the app to internal visibility and deletes the credential. Idempotent: an app without password access is left unchanged.",
  params: slugParams,
  responses: {
    204: emptyResponse("Password access is disabled."),
    409: apiError("The app's access mode changed concurrently (`conflict`)."),
  },
});

export const appsContracts = [
  checkAppSlug,
  createApp,
  listApps,
  getApp,
  updateApp,
  archiveApp,
  unarchiveApp,
  getAppManifest,
  setAppManifest,
  grantAppOrigin,
  setAppVisibility,
  enableAppPassword,
  rotateAppPassword,
  getAppPassword,
  disableAppPassword,
] as const;
