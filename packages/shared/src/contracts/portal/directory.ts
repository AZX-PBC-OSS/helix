// Contracts for apps/portal/src/routes/directory.ts (ADR-0054).
import { z } from "zod";
import { DirectoryGroupsResponseSchema, DirectorySearchQuerySchema } from "../../directory.js";
import { jsonResponse } from "../define.js";
import { apiError, portalRoute } from "./common.js";

const tags = ["Directory"] as const;

const groups = (description: string) =>
  jsonResponse(
    DirectoryGroupsResponseSchema,
    `${description} \`available: false\` means the directory is not configured or not consented, ` +
      "and the caller should offer manual group-id entry.",
  );

const rateLimited = apiError("The caller's directory lookup budget is spent (`rate_limited`).");
const unavailable = apiError(
  "The directory did not answer; retry shortly (`capability_unavailable`).",
);

export const searchDirectoryGroups = portalRoute({
  id: "searchDirectoryGroups",
  method: "GET",
  path: "/api/v1/directory/groups",
  tags,
  summary: "Search the tenant's groups",
  description:
    "Searches group names across the tenant. The deployment's directory-search policy decides " +
    "who may search: everyone, platform admins only, or nobody. Each search is audited and " +
    "counts against a per-caller rate limit.",
  query: DirectorySearchQuerySchema,
  responses: {
    200: groups("The matching groups."),
    403: apiError(
      "This deployment restricts group search and the caller does not qualify (`forbidden`).",
    ),
    429: rateLimited,
    503: unavailable,
  },
});

export const resolveAppVisibilityGroups = portalRoute({
  id: "resolveAppVisibilityGroups",
  method: "GET",
  path: "/api/v1/apps/:slug/visibility/groups",
  tags,
  summary: "Name an app's visibility groups",
  description:
    "Resolves the group ids stored on the app to display names. Ids that do not resolve are " +
    "left out. When the deployment restricts directory search, the caller must own the app " +
    "or be a platform admin; otherwise any authenticated caller may read it.",
  params: z.object({ slug: z.string().meta({ description: "The app's slug." }) }),
  responses: {
    200: groups("The app's groups that resolved."),
    403: apiError(
      "Directory search is restricted, and the caller does not own the app and is not a " +
        "platform admin (`forbidden`).",
    ),
    404: apiError("No app has this slug (`not_found`)."),
    429: rateLimited,
    503: unavailable,
  },
});

export const listMyDirectoryGroups = portalRoute({
  id: "listMyDirectoryGroups",
  method: "GET",
  path: "/api/v1/directory/my-groups",
  tags,
  summary: "Name the caller's own groups",
  description:
    "Resolves the group claim on the caller's verified token. Not subject to the " +
    "directory-search policy.",
  responses: {
    200: groups("The caller's groups that resolved."),
    429: rateLimited,
    503: unavailable,
  },
});

export const directoryContracts = [
  searchDirectoryGroups,
  resolveAppVisibilityGroups,
  listMyDirectoryGroups,
] as const;
