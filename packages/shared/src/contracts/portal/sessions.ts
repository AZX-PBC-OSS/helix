import { z } from "zod";
import {
  SessionListResponseSchema,
  SessionRevokeRequestSchema,
  SessionRevokeResultSchema,
} from "../../sessions.js";
import { jsonBody, jsonResponse } from "../define.js";
import { portalRoute } from "./common.js";
import { clampedLimitQuery } from "./usage.js";

const tags = ["Sessions"] as const;

export const listSessions = portalRoute({
  id: "listSessions",
  method: "GET",
  path: "/api/v1/sessions",
  admin: true,
  tags,
  summary: "List live app sessions",
  description:
    "Activated, unexpired sessions across every app, grouped by user. Group names are " +
    "resolved when the directory allows it; `groupsResolved` says whether they were.",
  query: z.object({ limit: clampedLimitQuery(200, 500) }),
  responses: {
    200: jsonResponse(SessionListResponseSchema, "The live sessions."),
  },
});

export const revokeSessions = portalRoute({
  id: "revokeSessions",
  method: "POST",
  path: "/api/v1/sessions/revoke",
  admin: true,
  tags,
  summary: "End every session of one user",
  description:
    "Deletes the user's sessions on every app, including a sign-in in progress. The user " +
    "can sign in again while their access remains. Revoking a user with no sessions " +
    "returns `removed: 0`.",
  body: jsonBody(SessionRevokeRequestSchema),
  responses: {
    200: jsonResponse(
      SessionRevokeResultSchema,
      "How many sessions were removed, and on which apps.",
    ),
  },
});

export const sessionsContracts = [listSessions, revokeSessions] as const;
