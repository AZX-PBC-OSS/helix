import { z } from "zod";
import {
  ApprovalDecisionRequestSchema,
  ApprovalRequestSchema,
  ApprovalStatusSchema,
} from "../../approval.js";
import { jsonBody, jsonResponse } from "../define.js";
import { apiError, portalRoute } from "./common.js";

const tags = ["Approvals"] as const;

const idParams = z.object({
  id: z.string().meta({ description: "The approval request's id." }),
});

export const listApprovalRequests = portalRoute({
  id: "listApprovalRequests",
  method: "GET",
  path: "/api/v1/approvals",
  tags,
  summary: "List approval requests",
  description:
    "With `app`, lists that app's requests; the caller must own the app or be a platform admin. Without it, lists the global queue, which requires the platform-admin role. Requests in the global queue carry prior-decision context for their app.",
  query: z.object({
    app: z.string().optional().meta({ description: "Only this app's requests, by slug." }),
    // An empty `?status=` has always meant "no filter".
    status: z
      .preprocess((v) => (v === "" ? undefined : v), ApprovalStatusSchema.optional())
      .meta({ description: "Only requests in this lifecycle state." }),
  }),
  responses: {
    200: jsonResponse(z.array(ApprovalRequestSchema), "The requests, newest first."),
    403: apiError(
      "The caller does not own the app, or lists the global queue, and is not a platform admin (`forbidden`).",
    ),
    404: apiError("No app has the `app` slug (`not_found`)."),
  },
});

const decisionErrors = {
  403: apiError(
    "The caller is not a platform admin, filed the request themselves, or the request predates requester ids and cannot be decided (`forbidden`).",
  ),
  404: apiError("No approval request has this id (`not_found`)."),
  409: apiError("The request was already decided differently (`conflict`)."),
};

export const approveApprovalRequest = portalRoute({
  id: "approveApprovalRequest",
  method: "POST",
  path: "/api/v1/approvals/:id/approve",
  admin: true,
  tags,
  summary: "Approve a request",
  description:
    "Applies the request's changes to the app and closes it, in one transaction. When a value the request touches changed since it was filed, the request moves to `needs_changes` instead. Repeating an approve that already landed is a no-op.",
  params: idParams,
  responses: {
    200: jsonResponse(ApprovalRequestSchema, "The decided request."),
    ...decisionErrors,
    403: apiError(
      "The caller is not a platform admin, filed the request themselves, the request predates requester ids, or it would make the app public on a deployment that disallows public apps (`forbidden`).",
    ),
    409: apiError(
      "The request was already decided differently, a bound provider changed since filing, or the app's policy changed concurrently (`conflict`).",
    ),
  },
});

const decisionBody = {
  ...jsonBody(ApprovalDecisionRequestSchema.nullish()),
  required: false,
};

export const denyApprovalRequest = portalRoute({
  id: "denyApprovalRequest",
  method: "POST",
  path: "/api/v1/approvals/:id/deny",
  admin: true,
  tags,
  summary: "Deny a request",
  description: "A note is required. Repeating a deny that already landed is a no-op.",
  params: idParams,
  body: decisionBody,
  responses: {
    200: jsonResponse(ApprovalRequestSchema, "The denied request."),
    400: apiError("The request failed validation, or carries no note (`validation_failed`)."),
    ...decisionErrors,
  },
});

export const requestApprovalChanges = portalRoute({
  id: "requestApprovalChanges",
  method: "POST",
  path: "/api/v1/approvals/:id/needs_changes",
  admin: true,
  tags,
  summary: "Send a request back for changes",
  description: "A note is required. Repeating this decision after it landed is a no-op.",
  params: idParams,
  body: decisionBody,
  responses: {
    200: jsonResponse(ApprovalRequestSchema, "The request, now `needs_changes`."),
    400: apiError("The request failed validation, or carries no note (`validation_failed`)."),
    ...decisionErrors,
  },
});

export const withdrawApprovalRequest = portalRoute({
  id: "withdrawApprovalRequest",
  method: "POST",
  path: "/api/v1/approvals/:id/withdraw",
  tags,
  summary: "Withdraw your own request",
  description: "Only the requester may withdraw. Repeating a withdraw that landed is a no-op.",
  params: idParams,
  responses: {
    200: jsonResponse(ApprovalRequestSchema, "The withdrawn request."),
    403: apiError(
      "The caller is not the requester, or the request predates requester ids and cannot be withdrawn (`forbidden`).",
    ),
    404: apiError("No approval request has this id (`not_found`)."),
    409: apiError("The request was already decided (`conflict`)."),
  },
});

export const approvalsContracts = [
  listApprovalRequests,
  approveApprovalRequest,
  denyApprovalRequest,
  requestApprovalChanges,
  withdrawApprovalRequest,
] as const;
