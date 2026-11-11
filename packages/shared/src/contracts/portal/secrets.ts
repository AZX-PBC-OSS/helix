import { z } from "zod";
import { EnvSchema } from "../../env.js";
import {
  AdminSecretCreateRequestSchema,
  SecretCreateRequestSchema,
  SecretGrantRequestSchema,
  SecretGrantResponseSchema,
  SecretMetadataSchema,
  SecretRotateRequestSchema,
} from "../../secrets.js";
import { emptyResponse, jsonBody, jsonResponse } from "../define.js";
import { apiError, portalRoute } from "./common.js";

const tags = ["Secrets"] as const;

const slugParam = z.string().meta({ description: "The app's slug." });
const nameParam = z.string().meta({ description: "The secret's name." });
const idParam = z.string().meta({ description: "The secret's id." });

/** A name is unique only within a tier, so the tier picks the secret. */
const envQuery = z.object({
  env: EnvSchema.default("prod").meta({
    description: "The secret's partition tier. Defaults to `prod`.",
  }),
});

const unavailable = apiError("The secret store is not configured (`capability_unavailable`).");

export const listAppSecrets = portalRoute({
  id: "listAppSecrets",
  method: "GET",
  path: "/api/v1/apps/:slug/secrets",
  owner: true,
  tags,
  summary: "List an app's secrets",
  description:
    "Metadata only, for both the `prod` and `dev` tiers. A secret's value is never returned.",
  params: z.object({ slug: slugParam }),
  responses: {
    200: jsonResponse(z.array(SecretMetadataSchema), "The app's secrets."),
  },
});

export const createAppSecret = portalRoute({
  id: "createAppSecret",
  method: "POST",
  path: "/api/v1/apps/:slug/secrets",
  owner: true,
  tags,
  summary: "Create an app secret",
  description:
    "The value is sealed by the secret store and never returned. It must fit the injection recipe.",
  params: z.object({ slug: slugParam }),
  body: jsonBody(SecretCreateRequestSchema),
  responses: {
    201: jsonResponse(SecretMetadataSchema, "The new secret's metadata."),
    400: apiError(
      "The request failed validation, or the value does not fit the injection recipe (`validation_failed`).",
    ),
    409: apiError("A secret with this name already exists in this tier (`conflict`)."),
    503: unavailable,
  },
});

export const rotateAppSecret = portalRoute({
  id: "rotateAppSecret",
  method: "POST",
  path: "/api/v1/apps/:slug/secrets/:name/rotate",
  owner: true,
  tags,
  summary: "Rotate an app secret",
  description: "Replaces the value. The injection recipe is immutable.",
  params: z.object({ slug: slugParam, name: nameParam }),
  query: envQuery,
  body: jsonBody(SecretRotateRequestSchema),
  responses: {
    200: jsonResponse(SecretMetadataSchema, "The rotated secret's metadata."),
    400: apiError(
      "The request failed validation, or the value does not fit the injection recipe (`validation_failed`).",
    ),
    404: apiError("No app has this slug, or the app has no such secret (`not_found`)."),
    409: apiError(
      "The stored injection recipe is unreadable, or the secret was rotated concurrently (`conflict`).",
    ),
    503: unavailable,
  },
});

export const deleteAppSecret = portalRoute({
  id: "deleteAppSecret",
  method: "DELETE",
  path: "/api/v1/apps/:slug/secrets/:name",
  owner: true,
  tags,
  summary: "Delete an app secret",
  params: z.object({ slug: slugParam, name: nameParam }),
  query: envQuery,
  responses: {
    204: emptyResponse("The secret was deleted."),
    404: apiError("No app has this slug, or the app has no such secret (`not_found`)."),
  },
});

export const listAdminSecrets = portalRoute({
  id: "listAdminSecrets",
  method: "GET",
  path: "/api/v1/secrets",
  admin: true,
  tags,
  summary: "List global and platform secrets",
  description:
    "Metadata only, for both environment tiers. `boundApps` lists the apps each global secret is granted to.",
  responses: {
    200: jsonResponse(z.array(SecretMetadataSchema), "The global and platform secrets."),
  },
});

export const createAdminSecret = portalRoute({
  id: "createAdminSecret",
  method: "POST",
  path: "/api/v1/secrets",
  admin: true,
  tags,
  summary: "Create a global or platform secret",
  description:
    "Global secrets use the selected environment tier; platform secrets use `prod`. The value is sealed by the secret store and never returned. It must fit the injection recipe.",
  body: jsonBody(AdminSecretCreateRequestSchema),
  responses: {
    201: jsonResponse(SecretMetadataSchema, "The new secret's metadata."),
    400: apiError(
      "The request failed validation, or the value does not fit the injection recipe (`validation_failed`).",
    ),
    409: apiError("A secret with this name already exists in this scope (`conflict`)."),
    503: unavailable,
  },
});

export const rotateAdminSecret = portalRoute({
  id: "rotateAdminSecret",
  method: "POST",
  path: "/api/v1/secrets/:id/rotate",
  admin: true,
  tags,
  summary: "Rotate a global or platform secret",
  description: "Replaces the value. The injection recipe is immutable.",
  params: z.object({ id: idParam }),
  body: jsonBody(SecretRotateRequestSchema),
  responses: {
    200: jsonResponse(SecretMetadataSchema, "The rotated secret's metadata."),
    400: apiError(
      "The request failed validation, or the value does not fit the injection recipe (`validation_failed`).",
    ),
    404: apiError("No global or platform secret has this id (`not_found`)."),
    409: apiError(
      "The stored injection recipe is unreadable, or the secret was rotated concurrently (`conflict`).",
    ),
    503: unavailable,
  },
});

export const deleteAdminSecret = portalRoute({
  id: "deleteAdminSecret",
  method: "DELETE",
  path: "/api/v1/secrets/:id",
  admin: true,
  tags,
  summary: "Delete a global or platform secret",
  description: "Also removes every grant of the secret.",
  params: z.object({ id: idParam }),
  responses: {
    204: emptyResponse("The secret was deleted."),
    404: apiError("No global or platform secret has this id (`not_found`)."),
  },
});

export const grantSecret = portalRoute({
  id: "grantSecret",
  method: "POST",
  path: "/api/v1/secrets/:id/grants",
  admin: true,
  tags,
  summary: "Grant a global secret to an app",
  params: z.object({ id: idParam }),
  body: jsonBody(SecretGrantRequestSchema),
  responses: {
    201: jsonResponse(SecretGrantResponseSchema, "The new grant."),
    404: apiError("No global secret has this id, or no app has this slug (`not_found`)."),
    409: apiError("The app already holds this secret (`conflict`)."),
  },
});

export const revokeSecretGrant = portalRoute({
  id: "revokeSecretGrant",
  method: "DELETE",
  path: "/api/v1/secrets/:id/grants/:appSlug",
  admin: true,
  tags,
  summary: "Revoke a global secret from an app",
  description: "Idempotent: revoking a grant that does not exist also succeeds.",
  params: z.object({
    id: idParam,
    appSlug: z.string().meta({ description: "The slug of the app that holds the grant." }),
  }),
  responses: {
    204: emptyResponse("The grant was revoked."),
    404: apiError("No app has this slug (`not_found`)."),
  },
});

export const secretsContracts = [
  listAppSecrets,
  createAppSecret,
  rotateAppSecret,
  deleteAppSecret,
  listAdminSecrets,
  createAdminSecret,
  rotateAdminSecret,
  deleteAdminSecret,
  grantSecret,
  revokeSecretGrant,
] as const;
