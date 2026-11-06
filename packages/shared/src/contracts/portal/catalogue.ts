import { CapabilityCatalogueSchema } from "../../catalogue.js";
import { jsonResponse, media } from "../define.js";
import { portalRoute } from "./common.js";

const tags = ["Catalogue"] as const;

export const getCapabilityCatalogue = portalRoute({
  id: "getCapabilityCatalogue",
  method: "GET",
  path: "/api/v1/capabilities",
  tags,
  summary: "Read the capability catalogue",
  description:
    "What an app on this deployment can request, and which requests approve automatically. Instance-wide, not per app. Backs `helix capabilities`.",
  responses: {
    200: jsonResponse(CapabilityCatalogueSchema, "The capability catalogue."),
  },
});

export const getDeploySkill = portalRoute({
  id: "getDeploySkill",
  method: "GET",
  path: "/api/v1/skill",
  tags,
  summary: "Download the agent skill",
  description:
    "The deploy skill rendered for this deployment's addresses. The portal origin is taken from the request.",
  responses: {
    200: {
      description: "The rendered skill.",
      content: media("text/markdown", "The `SKILL.md` document."),
    },
  },
});

export const catalogueContracts = [getCapabilityCatalogue, getDeploySkill] as const;
