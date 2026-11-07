// Contracts for the edge's /_api/llm routes (ADR-0054).
import { LlmChatRequestSchema, LlmChatResponseSchema } from "../../llm.js";
import { json, jsonBody, media, type ResponseSpec } from "../define.js";
import { appApiError, appRoute, jsonBodyRefusals, RetryAfterHeader } from "./common.js";

const tags = ["LLM"] as const;

/**
 * The SSE wire, in prose: OpenAPI 3.1 cannot give each event its own schema
 * (ADR-0054 decision 7).
 */
const LLM_EVENT_STREAM =
  "Sent when `stream` is true (the default). Named events, each `data:` line one JSON object:\n\n" +
  "- `event: delta` — `{ text }` (`LlmStreamDelta`), zero or more.\n" +
  "- `event: done` — `{ stopReason, usage }` (`LlmStreamDone`), terminal on success.\n" +
  "- `event: error` — `{ code, message }` (`LlmStreamError`), terminal on a failure after the " +
  "stream started.\n\n" +
  "A failure before the first delta is answered with an error status instead of a stream.";

const throttled: ResponseSpec = {
  ...appApiError(
    "The app's daily spend budget is exhausted (`quota_exceeded`), its rolling-hour burst " +
      "budget is exhausted (`rate_limited`), the anonymous per-IP budget is exhausted on a " +
      "public app (`rate_limited`), or the upstream model throttled the call (`rate_limited`, " +
      "with `Retry-After`).",
  ),
  headers: RetryAfterHeader.partial(),
};

export const llmChat = appRoute({
  id: "llmChat",
  method: "POST",
  path: "/_api/llm/chat",
  tags,
  summary: "Run a chat completion",
  description:
    "The platform's provider-neutral LLM call. `model` must be on the app's manifest " +
    "allowlist; the edge routes it to the vendor that serves it and meters the call against " +
    "the app's budget. The request must carry the app's own `Origin` (CSRF check).",
  body: jsonBody(LlmChatRequestSchema),
  responses: {
    200: {
      description: "The completion: a JSON body when `stream` is false, otherwise an event stream.",
      content: {
        ...json(LlmChatResponseSchema, "The whole completion (`stream: false`)."),
        ...media("text/event-stream", LLM_EVENT_STREAM),
      },
    },
    400: appApiError(
      "The body is not a valid chat request, the model does not support `responseFormat`, or " +
        "the upstream rejected the request as invalid (`validation_failed`).",
    ),
    403: appApiError(
      "The `Origin` is not the app's own, or the app has no LLM grant (`forbidden`); or the " +
        "model is not on the app's allowlist or has no price (`model_not_allowed`).",
    ),
    429: throttled,
    502: appApiError("The upstream call failed (`internal`)."),
    503: appApiError(
      "The LLM capability is not configured on this deployment, or no upstream serves this " +
        "model (`capability_unavailable`).",
    ),
    ...jsonBodyRefusals,
  },
});

export const llmContracts = [llmChat] as const;
