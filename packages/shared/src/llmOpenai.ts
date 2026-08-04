import { z } from "zod";

/**
 * OpenAI **chat/completions** wire contract for the `/_api/openai/v1/*` gateway
 * surface (see `apps/edge/src/gateway/openaiCodec.ts`). This is an *envelope*
 * only: the edge translates it to/from the platform-neutral `LlmChatRequest` /
 * `LlmStreamEvent` shape (`./llm.js`) and runs the exact same authz/budget/
 * metering spine as the native `/_api/llm/chat` endpoint. Nothing here binds a
 * vendor — a `claude-*` model and a `gpt-*` model both ride this surface.
 *
 * Pure zod so the browser SPA can import it. Scope is **text chat only**: tool
 * calls and multimodal content parts are represented so the codec can reject
 * them with a clear 400, not so they are supported.
 */

/**
 * OpenAI message roles. `developer` is OpenAI's newer alias for `system`; both
 * are hoisted into the neutral top-level `system` channel. `tool` is parsed only
 * so the codec can reject it (no tool-calling in v1).
 */
export const OpenAiRoleSchema = z.enum(["system", "developer", "user", "assistant", "tool"]);
export type OpenAiRole = z.infer<typeof OpenAiRoleSchema>;

/**
 * A message. `content` is a string for the shapes we support; an array (OpenAI's
 * multimodal content parts) is accepted by the schema so the codec can reject it
 * loudly rather than silently dropping the non-text parts.
 */
export const OpenAiMessageSchema = z.object({
  role: OpenAiRoleSchema,
  content: z.union([z.string(), z.array(z.unknown())]).nullish(),
  /** Present only on assistant tool-call turns — parsed to reject, never honored. */
  tool_calls: z.array(z.unknown()).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
});
export type OpenAiMessage = z.infer<typeof OpenAiMessageSchema>;

/** `stream_options.include_usage` controls whether a trailing usage chunk is emitted. */
export const OpenAiStreamOptionsSchema = z.object({
  include_usage: z.boolean().optional(),
});

/**
 * `response_format`, as a real union so the codec can branch instead of guessing
 * (ADR-0034). `json_schema` maps to the neutral `responseFormat`; `text` is
 * OpenAI's explicit default and is served as a no-op (same as `tool_choice:"none"`);
 * `json_object` is rejected with a 400 — it has no Anthropic equivalent, and
 * serving it would make behaviour depend on which vendor backs the model.
 *
 * `schema` is left loose here: the neutral `LlmResponseFormatSchema` owns the
 * root-type and size/depth guards, so validation lives in exactly one place.
 * `strict` is accepted and **ignored** — the platform always enforces (Anthropic has
 * no best-effort mode), and stock clients routinely omit it, so rejecting it would
 * break them while enforcing is strictly stronger than what a `false` asks for.
 */
export const OpenAiResponseFormatSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("json_schema"),
    json_schema: z.object({
      name: z.string().optional(),
      schema: z.record(z.string(), z.unknown()),
      strict: z.boolean().nullish(),
      /**
       * Declared so the codec can reject it rather than zod silently stripping it.
       * It is honorable on the OpenAI path but has no Anthropic equivalent, so
       * forwarding it would make behaviour depend on the backing vendor — the same
       * provider leak that got `json_object` rejected (ADR-0034).
       */
      description: z.string().optional(),
    }),
  }),
  z.object({ type: z.literal("json_object") }),
  z.object({ type: z.literal("text") }),
]);
export type OpenAiResponseFormat = z.infer<typeof OpenAiResponseFormatSchema>;

/**
 * `POST /_api/openai/v1/chat/completions` request. Unknown fields are stripped
 * by zod (OpenAI clients send many we ignore); `tools`/`tool_choice` are declared
 * so the codec can 400 on them. Either `max_tokens` or `max_completion_tokens`
 * (o-series) maps to the neutral `maxTokens`.
 */
export const OpenAiChatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(OpenAiMessageSchema).min(1),
  max_tokens: z.int().positive().max(128_000).optional(),
  max_completion_tokens: z.int().positive().max(128_000).optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  stream: z.boolean().optional(),
  stream_options: OpenAiStreamOptionsSchema.optional(),
  /** Declared so the codec can reject tool use in v1 (not supported). */
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
  /**
   * Structured output (ADR-0034). Parsed, not rejected — see the union above.
   * `.nullish()` because clients and proxies that serialize every field send
   * `"response_format": null` to mean "no structured output", which is a request
   * this surface can serve; refusing it at the envelope would be gratuitous.
   */
  response_format: OpenAiResponseFormatSchema.nullish(),
  // Behaviour-changing params the platform does not honor in v1. Declared (not
  // stripped) so the codec can reject them with a 400 rather than silently drop
  // them — the same "reject, never silently drop" contract as `tools`.
  n: z.unknown().optional(),
  seed: z.unknown().optional(),
  logit_bias: z.unknown().optional(),
  presence_penalty: z.unknown().optional(),
  frequency_penalty: z.unknown().optional(),
  logprobs: z.unknown().optional(),
  top_logprobs: z.unknown().optional(),
});

/** The behaviour-changing OpenAI params the codec rejects with a 400 (see above). */
export const OPENAI_UNSUPPORTED_PARAMS = [
  "n",
  "seed",
  "logit_bias",
  "presence_penalty",
  "frequency_penalty",
  "logprobs",
  "top_logprobs",
] as const;
export type OpenAiChatCompletionRequest = z.infer<typeof OpenAiChatCompletionRequestSchema>;

/** OpenAI usage block. `prompt_tokens` folds all input classes; reasoning tokens count as completion. */
export const OpenAiUsageSchema = z.object({
  prompt_tokens: z.int().nonnegative(),
  completion_tokens: z.int().nonnegative(),
  total_tokens: z.int().nonnegative(),
});
export type OpenAiUsage = z.infer<typeof OpenAiUsageSchema>;

/** OpenAI `finish_reason` values we emit (mapped from the neutral stop reason). */
export type OpenAiFinishReason = "stop" | "length" | "content_filter";

/** Non-streaming `chat.completion` response body. Built + validated like the native path. */
export const OpenAiChatCompletionResponseSchema = z.object({
  id: z.string(),
  object: z.literal("chat.completion"),
  created: z.int(),
  model: z.string(),
  choices: z.array(
    z.object({
      index: z.int(),
      message: z.object({
        role: z.literal("assistant"),
        content: z.string(),
      }),
      finish_reason: z.string(),
    }),
  ),
  usage: OpenAiUsageSchema,
});
export type OpenAiChatCompletionResponse = z.infer<typeof OpenAiChatCompletionResponseSchema>;

/**
 * A single streaming `chat.completion.chunk`. Constructed frame-by-frame by the
 * codec (never parsed per-frame at runtime — tests validate it). `usage` appears
 * only on the trailing chunk when the client set `stream_options.include_usage`.
 */
export const OpenAiChatCompletionChunkSchema = z.object({
  id: z.string(),
  object: z.literal("chat.completion.chunk"),
  created: z.int(),
  model: z.string(),
  choices: z.array(
    z.object({
      index: z.int(),
      delta: z.object({
        role: z.literal("assistant").optional(),
        content: z.string().optional(),
      }),
      finish_reason: z.string().nullable(),
    }),
  ),
  usage: OpenAiUsageSchema.nullish(),
});
export type OpenAiChatCompletionChunk = z.infer<typeof OpenAiChatCompletionChunkSchema>;

/** OpenAI error envelope. `type`/`code` are set from the platform's ApiErrorCode. */
export interface OpenAiErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

/** OpenAI `GET /v1/models` list item. `created` is required by the OpenAI Model object. */
export const OpenAiModelSchema = z.object({
  id: z.string(),
  object: z.literal("model"),
  created: z.int(),
  owned_by: z.string(),
});
export type OpenAiModel = z.infer<typeof OpenAiModelSchema>;

/** OpenAI `GET /v1/models` list response. */
export const OpenAiModelListSchema = z.object({
  object: z.literal("list"),
  data: z.array(OpenAiModelSchema),
});
export type OpenAiModelList = z.infer<typeof OpenAiModelListSchema>;
