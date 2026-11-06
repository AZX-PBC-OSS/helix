import { z } from "zod";
import { ApiErrorSchema } from "../../api.js";
import {
  ConfirmationRequiredDetailsSchema,
  ProviderCreateRequestSchema,
  ProviderDeleteRequestSchema,
  ProviderDeleteResponseSchema,
  ProviderExportDocumentSchema,
  ProviderImpactSchema,
  ProviderImportPreviewRequestSchema,
  ProviderImportPreviewResponseSchema,
  ProviderImportRequestSchema,
  ProviderImportResponseSchema,
  ProviderListResponseSchema,
  ProviderMetadataSchema,
  ProviderUpdateRequestSchema,
} from "../../providers.js";
import { jsonBody, jsonResponse } from "../define.js";
import { apiError, portalRoute } from "./common.js";

const tags = ["Connection providers"] as const;

const params = z.object({ id: z.string().meta({ description: "The provider's id." }) });

const invalidBody = apiError(
  "The body failed validation (`validation_failed`). The zod issues are in `details`, so a form can show them on its fields.",
);
const notFound = apiError("No provider has this id (`not_found`).");
const noSecretStore = apiError(
  "No secret store is configured to seal credentials (`capability_unavailable`).",
);

/** The 409 of a sensitive edit or a deletion sent without the acknowledgement. */
const ConfirmationRequiredErrorSchema = z
  .object({
    error: z.object({
      code: z.literal("confirmation_required"),
      message: z.string(),
      details: ConfirmationRequiredDetailsSchema,
    }),
  })
  .meta({
    id: "ConfirmationRequiredError",
    description: "A change that invalidates connections was sent without `confirmInvalidation`.",
  });

const confirmationOrConflict = (conflict: string) =>
  jsonResponse(
    z.union([ConfirmationRequiredErrorSchema, ApiErrorSchema]),
    `The change invalidates the provider's connections and was not confirmed (\`confirmation_required\`, with the impact in \`details\`), or ${conflict} (\`conflict\`).`,
  );

export const listProviders = portalRoute({
  id: "listProviders",
  method: "GET",
  path: "/api/v1/providers",
  admin: true,
  tags,
  summary: "List connection providers",
  description: "Metadata only: no response carries a provider's client credentials.",
  responses: {
    200: jsonResponse(ProviderListResponseSchema, "The providers and the OAuth callback URL."),
  },
});

export const createProvider = portalRoute({
  id: "createProvider",
  method: "POST",
  path: "/api/v1/providers",
  admin: true,
  tags,
  summary: "Create a connection provider",
  description: "Seals the client credentials into the secret store.",
  body: jsonBody(ProviderCreateRequestSchema),
  responses: {
    201: jsonResponse(ProviderMetadataSchema, "The new provider."),
    409: apiError("A provider with this ref already exists in the environment (`conflict`)."),
    422: invalidBody,
    503: noSecretStore,
  },
});

export const getProvider = portalRoute({
  id: "getProvider",
  method: "GET",
  path: "/api/v1/providers/:id",
  admin: true,
  tags,
  summary: "Read a connection provider",
  params,
  responses: {
    200: jsonResponse(ProviderMetadataSchema, "The provider."),
    404: notFound,
  },
});

export const exportProvider = portalRoute({
  id: "exportProvider",
  method: "GET",
  path: "/api/v1/providers/:id/export",
  admin: true,
  tags,
  summary: "Export a connection provider",
  description:
    "The provider's editable configuration as an import document. Never includes credentials. A stored configuration that fails the document schema is a 500, never a partial document.",
  params,
  responses: {
    200: jsonResponse(ProviderExportDocumentSchema, "The export document."),
    404: notFound,
  },
});

export const updateProvider = portalRoute({
  id: "updateProvider",
  method: "PUT",
  path: "/api/v1/providers/:id",
  admin: true,
  tags,
  summary: "Edit a connection provider",
  description:
    "Compare-and-set on `revision`. Omitted credentials are kept. A change to a sensitive field invalidates the provider's connections and pending consent attempts, so it requires `confirmInvalidation`.",
  params,
  body: jsonBody(ProviderUpdateRequestSchema),
  responses: {
    200: jsonResponse(ProviderMetadataSchema, "The updated provider."),
    404: notFound,
    409: confirmationOrConflict("the provider changed since `revision` was read"),
    422: invalidBody,
    503: noSecretStore,
  },
});

export const previewProviderImport = portalRoute({
  id: "previewProviderImport",
  method: "POST",
  path: "/api/v1/providers/import/preview",
  admin: true,
  tags,
  summary: "Preview a provider import",
  description:
    "Validates an export document and, given a mode, proposes the create or the update without applying it.",
  body: jsonBody(ProviderImportPreviewRequestSchema),
  responses: {
    200: jsonResponse(ProviderImportPreviewResponseSchema, "The proposal."),
    400: apiError(
      "The request is not a valid preview, or its mode, `env` and `targetId` do not fit together (`validation_failed`).",
    ),
    404: apiError("No provider has the `targetId` (`not_found`)."),
  },
});

export const importProvider = portalRoute({
  id: "importProvider",
  method: "POST",
  path: "/api/v1/providers/import",
  admin: true,
  tags,
  summary: "Import a connection provider",
  description:
    "Creates a provider from an export document, with the credentials in the request, or updates the named target through the same rules as an edit.",
  body: jsonBody(ProviderImportRequestSchema),
  responses: {
    200: jsonResponse(ProviderImportResponseSchema, "The target provider was updated."),
    201: jsonResponse(ProviderImportResponseSchema, "A provider was created."),
    404: apiError("No provider has the `targetId` (`not_found`)."),
    409: confirmationOrConflict(
      "a provider with this ref already exists in the environment, or the target changed since `revision` was read",
    ),
    422: invalidBody,
    503: noSecretStore,
  },
});

export const getProviderImpact = portalRoute({
  id: "getProviderImpact",
  method: "GET",
  path: "/api/v1/providers/:id/impact",
  admin: true,
  tags,
  summary: "Read a provider's blast radius",
  description:
    "The bound apps, live connections, and pending consent attempts a sensitive edit or a deletion would invalidate.",
  params,
  responses: {
    200: jsonResponse(ProviderImpactSchema, "The impact."),
    404: notFound,
  },
});

export const deleteProvider = portalRoute({
  id: "deleteProvider",
  method: "DELETE",
  path: "/api/v1/providers/:id",
  admin: true,
  tags,
  summary: "Delete a connection provider",
  description:
    "Requires `confirmInvalidation`: deletion always invalidates the provider's connections and pending consent attempts. Repeating the deletion of an id removed here answers `already_removed`.",
  params,
  body: {
    ...jsonBody(ProviderDeleteRequestSchema),
    required: false,
    description: "The acknowledgement. An absent body is read as an empty one.",
  },
  responses: {
    200: jsonResponse(
      ProviderDeleteResponseSchema,
      "The provider was deleted or was already removed.",
    ),
    404: notFound,
    409: jsonResponse(
      ConfirmationRequiredErrorSchema,
      "The deletion was not confirmed (`confirmation_required`, with the impact in `details`).",
    ),
    422: invalidBody,
  },
});

export const providersContracts = [
  listProviders,
  createProvider,
  getProvider,
  exportProvider,
  updateProvider,
  previewProviderImport,
  importProvider,
  getProviderImpact,
  deleteProvider,
] as const;
