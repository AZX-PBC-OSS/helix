// Contracts for the edge's /_api/openai routes (ADR-0054).
import { z } from "zod";
import { ApiErrorSchema } from "../../api.js";
import {
  OpenAiChatCompletionRequestSchema,
  OpenAiChatCompletionResponseSchema,
  OpenAiErrorBodySchema,
  OpenAiModelListSchema,
} from "../../llmOpenai.js";
import { json, jsonBody, jsonResponse, media, type ResponseSpec } from "../define.js";
import { appRoute, jsonBodyRefusals, RetryAfterHeader } from "./common.js";

const tags = ["OpenAI-compatible"] as const;

const externalDocs = {
  url: "https://platform.openai.com/docs/api-reference/chat",
  description: "OpenAI's API reference, which this surface follows for the fields it accepts.",
};

function openAiError(description: string): ResponseSpec {
  return jsonResponse(OpenAiErrorBodySchema, description);
}

const COMPAT =
  "An OpenAI-compatible subset over the same policy, budget and metering as `/_api/llm/chat`. " +
  "Point an OpenAI client's `baseURL` at `<app origin>/_api/openai/v1`; the session cookie " +
  "authenticates, and the SDK's `apiKey` is ignored. Errors raised by this surface use " +
  "OpenAI's error envelope; the session gate's 401 and the edge's 500 keep the platform's " +
  "`ApiError` envelope.";

const CHUNK_STREAM =
  "Sent when `stream` is true. Each event is a `data:` line holding one " +
  "`chat.completion.chunk` (`OpenAiChatCompletionChunk`): the first carries " +
  "`delta.role`, then one per text delta, then one with `finish_reason`. When " +
  "`stream_options.include_usage` is true a final chunk with empty `choices` carries " +
  "`usage`. The stream ends with `data: [DONE]`. A failure after the stream started is sent " +
  "as one `data:` line holding the OpenAI error envelope, with no `[DONE]`.";

export const createOpenAiChatCompletion = appRoute({
  id: "createOpenAiChatCompletion",
  method: "POST",
  path: "/_api/openai/v1/chat/completions",
  tags,
  summary: "Create a chat completion (OpenAI-compatible)",
  description:
    `${COMPAT}\n\nText chat only: tools, multimodal content, \`json_object\`, and the ` +
    "sampling parameters the platform cannot honor (`n`, `seed`, `logit_bias`, the " +
    "penalties, `logprobs`) are refused with a 400 rather than dropped. The request must " +
    "carry the app's own `Origin` (CSRF check).",
  externalDocs,
  body: jsonBody(OpenAiChatCompletionRequestSchema),
  responses: {
    200: {
      description: "The completion: a JSON body unless `stream` is true.",
      content: {
        ...json(OpenAiChatCompletionResponseSchema, "A `chat.completion` object."),
        ...media("text/event-stream", CHUNK_STREAM),
      },
    },
    // Fastify refuses a malformed JSON body before the OpenAI codec runs, so
    // that 400 carries the platform envelope, not OpenAI's.
    400: jsonResponse(
      z.union([OpenAiErrorBodySchema, ApiErrorSchema]),
      "The request is invalid or uses an unsupported feature (an OpenAI error, " +
        "`invalid_request_error`, with `param` naming the field), or the upstream rejected " +
        "it. A body that is not valid JSON is refused before the OpenAI-compatible layer " +
        "runs, with the platform's `ApiError` envelope instead.",
    ),
    403: openAiError(
      "The `Origin` is not the app's own, or the app has no LLM grant " +
        "(`invalid_request_error`); or the model is not allowed (`model_not_found`).",
    ),
    429: {
      ...openAiError(
        "A spend budget is exhausted (`insufficient_quota`), or a per-IP, burst or upstream " +
          "limit applies (`rate_limit_exceeded`, with `Retry-After` when the upstream sent one).",
      ),
      headers: RetryAfterHeader.partial(),
    },
    502: openAiError("The upstream call failed (`api_error`)."),
    503: openAiError(
      "The LLM capability is not configured, or no upstream serves this model (`api_error`).",
    ),
    ...jsonBodyRefusals,
  },
});

export const listOpenAiModels = appRoute({
  id: "listOpenAiModels",
  method: "GET",
  path: "/_api/openai/v1/models",
  tags,
  summary: "List the app's models (OpenAI-compatible)",
  description: `${COMPAT}\n\nLists the models on the app's own allowlist, not the platform catalogue.`,
  externalDocs: {
    url: "https://platform.openai.com/docs/api-reference/models/list",
    description: "OpenAI's list-models reference.",
  },
  responses: {
    200: jsonResponse(OpenAiModelListSchema, "The app's allowlisted models."),
    403: openAiError("The app has no LLM grant (`invalid_request_error`)."),
    429: openAiError("The anonymous per-IP budget is exhausted (`rate_limit_exceeded`)."),
  },
});

export const openaiContracts = [createOpenAiChatCompletion, listOpenAiModels] as const;
