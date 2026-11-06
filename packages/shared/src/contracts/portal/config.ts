import { DeploymentConfigResponseSchema } from "../../deployment.js";
import { jsonResponse } from "../define.js";
import { portalRoute } from "./common.js";

export const getDeploymentConfig = portalRoute({
  id: "getDeploymentConfig",
  method: "GET",
  path: "/api/v1/config",
  auth: "none",
  tags: ["Configuration"],
  summary: "Read the deployment configuration",
  description:
    "The topology the portal SPA and the CLI bootstrap from: the apps base, the deploy limits, and which optional surfaces are enabled. Public, and answers whether or not an IdP is configured. An optional field is omitted when its surface is not enabled.",
  responses: {
    200: jsonResponse(DeploymentConfigResponseSchema, "The deployment configuration."),
  },
});

export const configContracts = [getDeploymentConfig] as const;
