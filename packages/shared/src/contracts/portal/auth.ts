import { AuthConfigResponseSchema, PortalMeResponseSchema } from "../../auth.js";
import { jsonResponse } from "../define.js";
import { apiError, portalRoute } from "./common.js";

const tags = ["Auth"] as const;

export const getAuthConfig = portalRoute({
  id: "getAuthConfig",
  method: "GET",
  path: "/api/v1/auth/config",
  auth: "none",
  tags,
  summary: "Discover the identity provider",
  description:
    "Public. The CLI bootstraps sign-in from here, so its only configuration is the portal URL.",
  responses: {
    200: jsonResponse(AuthConfigResponseSchema, "The OIDC settings a client signs in with."),
    404: apiError("The portal has no IdP configured and accepts dev tokens only (`not_found`)."),
  },
});

export const getCurrentActor = portalRoute({
  id: "getCurrentActor",
  method: "GET",
  path: "/api/v1/me",
  tags,
  summary: "Identify the caller",
  description: "The principal the bearer token resolves to, and what the caller may do.",
  responses: {
    200: jsonResponse(PortalMeResponseSchema, "The caller's identity and permissions."),
  },
});

export const authContracts = [getAuthConfig, getCurrentActor] as const;
