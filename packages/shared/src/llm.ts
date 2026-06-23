import { z } from "zod";

/**
 * The neutral LLM gateway contract (architecture §6.1, project plan §4 M4).
 *
 * Apps call the platform's LLM capability at the same-origin path
 * `POST /_api/llm/chat`. The wire shape here is **provider-neutral on purpose**:
 * the edge translates it to whatever vendor backs the app's grant (Anthropic in
 * M4; Azure OpenAI etc. later) behind the `LlmProvider` seam, so vibe-coded apps
 * never bind to a vendor SDK and never see a vendor key. Validated at the edge
 * boundary on the way in, and on clients/tests via the inferred types.
 */

/** A single conversational turn. `system` is carried top-level, not as a role. */
export const LlmMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1),
});
export type LlmMessage = z.infer<typeof LlmMessageSchema>;

/**
 * Token accounting returned with every completion — the basis for metering.
 * `inputTokens` is the *uncached* input remainder; cache read/write tokens are
 * reported separately (Anthropic prices them differently). Cache counts stay 0
 * until prompt caching is enabled, but the seam carries them so accounting is
 * correct the day it is.
 */
export const LlmUsageSchema = z.object({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cacheReadInputTokens: z.int().nonnegative().default(0),
  cacheCreationInputTokens: z.int().nonnegative().default(0),
});
export type LlmUsage = z.infer<typeof LlmUsageSchema>;

/**
 * `POST /_api/llm/chat` request body. `model` is matched against the app's
 * per-app allowlist (manifest `capabilities.llm.models`) before anything is
 * sent upstream. `maxTokens` is required by Anthropic Messages; we default it so
 * the simplest client call works.
 */
export const LlmChatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(LlmMessageSchema).min(1),
  /** Optional system prompt; maps to the vendor's system channel. */
  system: z.string().optional(),
  maxTokens: z.int().positive().max(128_000).default(1024),
  /** SSE streaming (default) vs a single JSON body. */
  stream: z.boolean().default(true),
});
export type LlmChatRequest = z.infer<typeof LlmChatRequestSchema>;

/** Non-streaming `POST /_api/llm/chat` response. */
export const LlmChatResponseSchema = z.object({
  model: z.string(),
  content: z.string(),
  stopReason: z.string(),
  usage: LlmUsageSchema,
});
export type LlmChatResponse = z.infer<typeof LlmChatResponseSchema>;

/**
 * Streaming wire shape (Server-Sent Events), emitted by the edge when
 * `stream: true`. Small and vendor-free — a plain `EventSource`/fetch reader
 * handles it:
 *
 *   event: delta   data: { "text": "..." }      (zero or more)
 *   event: done    data: { "stopReason", "usage" }   (terminal, success)
 *   event: error   data: { "code", "message" }       (terminal, failure)
 */
export const LlmStreamDeltaSchema = z.object({ text: z.string() });
export type LlmStreamDelta = z.infer<typeof LlmStreamDeltaSchema>;

export const LlmStreamDoneSchema = z.object({
  stopReason: z.string(),
  usage: LlmUsageSchema,
});
export type LlmStreamDone = z.infer<typeof LlmStreamDoneSchema>;

export const LlmStreamErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type LlmStreamError = z.infer<typeof LlmStreamErrorSchema>;

/** SSE event names the edge emits — shared so clients/tests don't hardcode strings. */
export const LLM_STREAM_EVENTS = ["delta", "done", "error"] as const;
