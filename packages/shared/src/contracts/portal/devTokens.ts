import { z } from "zod";
import {
  DevTokenMetadataSchema,
  DevTokenMintRequestSchema,
  DevTokenMintResponseSchema,
  DevTokenRotateRequestSchema,
} from "../../devTokens.js";
import { emptyResponse, jsonBody, jsonResponse } from "../define.js";
import { apiError, portalRoute } from "./common.js";

const tags = ["Dev tokens"] as const;

const slugParam = z.string().meta({ description: "The app's slug." });
const idParam = z.string().meta({ description: "The dev token's id." });

export const listDevTokens = portalRoute({
  id: "listDevTokens",
  method: "GET",
  path: "/api/v1/apps/:slug/dev-tokens",
  tags,
  summary: "List an app's dev tokens",
  description: "Metadata only. A token's plaintext is returned once, when it is minted or rotated.",
  params: z.object({ slug: slugParam }),
  responses: {
    200: jsonResponse(z.array(DevTokenMetadataSchema), "The app's dev tokens, newest first."),
    404: apiError("No app has this slug (`not_found`)."),
  },
});

export const mintDevToken = portalRoute({
  id: "mintDevToken",
  method: "POST",
  path: "/api/v1/apps/:slug/dev-tokens",
  owner: true,
  tags,
  summary: "Mint a dev token",
  description:
    "The response carries the token's plaintext, which is not shown again. Only its hash is stored.",
  params: z.object({ slug: slugParam }),
  body: jsonBody(DevTokenMintRequestSchema),
  responses: {
    201: jsonResponse(DevTokenMintResponseSchema, "The new token and its metadata."),
  },
});

export const rotateDevToken = portalRoute({
  id: "rotateDevToken",
  method: "POST",
  path: "/api/v1/apps/:slug/dev-tokens/:id/rotate",
  owner: true,
  tags,
  summary: "Rotate a dev token",
  description:
    "Issues a new plaintext for the token and renews its lifetime, keeping its origins. The body is optional.",
  params: z.object({ slug: slugParam, id: idParam }),
  body: { ...jsonBody(DevTokenRotateRequestSchema.nullish()), required: false },
  responses: {
    200: jsonResponse(DevTokenMintResponseSchema, "The new token and its metadata."),
    404: apiError("No app has this slug, or the app has no such dev token (`not_found`)."),
    409: apiError("The token is revoked; mint a new one (`conflict`)."),
  },
});

export const revokeDevToken = portalRoute({
  id: "revokeDevToken",
  method: "DELETE",
  path: "/api/v1/apps/:slug/dev-tokens/:id",
  owner: true,
  tags,
  summary: "Revoke a dev token",
  description: "Takes effect immediately and cannot be undone.",
  params: z.object({ slug: slugParam, id: idParam }),
  responses: {
    204: emptyResponse("The token was revoked."),
    404: apiError("No app has this slug, or the app has no such dev token (`not_found`)."),
  },
});

export const devTokensContracts = [
  listDevTokens,
  mintDevToken,
  rotateDevToken,
  revokeDevToken,
] as const;
