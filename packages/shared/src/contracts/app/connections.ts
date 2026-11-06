// Contracts for the edge's /_api/connections routes (ADR-0054).
import { z } from "zod";
import {
  AttemptCancelRequestSchema,
  CancelResponseSchema,
  ConnectionStatusResponseSchema,
  ConsentAttemptTagSchema,
} from "../../consent.js";
import { ProviderRefSchema } from "../../providers.js";
import { jsonBody, jsonResponse } from "../define.js";
import { appApiError, appRoute, htmlPage, jsonBodyRefusals, plainText } from "./common.js";

const tags = ["Connections"] as const;

const refParams = z.object({
  ref: ProviderRefSchema.meta({
    description:
      "The provider reference the app's manifest binds. A malformed reference answers the " +
      "plain-text 404.",
  }),
});

const TERMINAL_PAGE =
  "A terminal page in the platform's chrome. It posts the outcome to the opener " +
  "(`window.opener.postMessage`, a `ConnectOutcomeMessage`) and offers Close.";

export const startConnection = appRoute({
  id: "startConnection",
  method: "GET",
  path: "/_api/connections/:ref/start",
  auth: "session",
  gate: false,
  tags,
  summary: "Open the consent flow for a provider",
  description:
    "The entry to the consent popup: a same-origin browser navigation, not a `fetch`. Open " +
    "it in a popup (the `window.helix.connect` helper does). With a usable session and a " +
    "provider the app binds, the popup is redirected to the provider's authorize URL; every " +
    "other outcome renders a terminal page that posts its outcome to the opener.\n\n" +
    "The navigation must be same-origin: `Sec-Fetch-Site`, when sent, must be `same-origin`, " +
    "and `Origin` or `Referer` must name the app's own origin. A shared-password session " +
    "cannot connect accounts and is treated as signed out.",
  params: refParams,
  query: z.object({
    attempt: ConsentAttemptTagSchema.optional().meta({
      description: "A correlation tag the outcome message echoes back. At most one.",
    }),
  }),
  responses: {
    200: htmlPage(
      `The caller is already connected, or the connection is not available to this app. ${TERMINAL_PAGE}`,
    ),
    302: {
      description: "The consent attempt started; the popup goes to the provider's authorize URL.",
      headers: z.object({
        location: z.string().meta({ description: "The provider's authorize URL (https)." }),
      }),
    },
    400: plainText("The `attempt` tag is malformed or repeated."),
    401: htmlPage(`No usable session: the sign-in-required page. ${TERMINAL_PAGE}`),
    403: plainText("The navigation is not same-origin.", "`Forbidden`"),
    503: htmlPage(
      `The consent attempt could not start (the platform's connection service failed or is not configured). ${TERMINAL_PAGE}`,
    ),
  },
});

export const cancelConnectionAttempt = appRoute({
  id: "cancelConnectionAttempt",
  method: "POST",
  path: "/_api/connections/attempt/cancel",
  auth: "session",
  gate: false,
  tags,
  summary: "Acknowledge a closed consent popup",
  description:
    "The connect helper calls this when the consent popup closed without posting an outcome, " +
    "so a late completion of that attempt cannot succeed. Only attempts this caller started " +
    "can be cancelled. The request must carry the app's own `Origin` (CSRF check).",
  body: jsonBody(AttemptCancelRequestSchema),
  responses: {
    200: jsonResponse(
      CancelResponseSchema,
      "`cancelled`, or `not_cancellable` for an unknown, finished, expired or foreign attempt " +
        "(indistinguishable on purpose).",
    ),
    400: appApiError("The body is malformed (`validation_failed`)."),
    401: appApiError("No usable session (`unauthorized`)."),
    403: plainText("The `Origin` is not the app's own.", "`Forbidden`"),
    503: appApiError(
      "The platform's connection service failed or is not configured (`capability_unavailable`).",
    ),
    ...jsonBodyRefusals,
  },
});

export const getConnectionStatus = appRoute({
  id: "getConnectionStatus",
  method: "GET",
  path: "/_api/connections/:ref/status",
  auth: "session",
  gate: false,
  tags,
  summary: "Read the caller's connection status for a provider",
  description:
    "Whether the signed-in user's next call to this provider will be sent with their " +
    "connection, from the platform's own records; no call is made to the provider. " +
    "`connected`: it will. `not_connected`: it would be refused with `connection_required`, " +
    "so offer Connect. `not_available`: the app does not bind this provider, or the provider " +
    "is not available. A shared-password session is treated as signed out.",
  params: refParams,
  responses: {
    200: jsonResponse(ConnectionStatusResponseSchema, "The connection status."),
    401: appApiError("No usable session (`unauthorized`)."),
    503: appApiError(
      "The platform's connection service failed or is not configured (`capability_unavailable`).",
    ),
  },
});

export const connectionsContracts = [
  startConnection,
  cancelConnectionAttempt,
  getConnectionStatus,
] as const;
