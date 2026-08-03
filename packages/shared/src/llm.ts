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
 * Caps on an app-supplied response schema. The schema is untrusted input that
 * reaches the *trusted* edge path, and it is walked before any quota check runs
 * — an unbounded or deeply-nested one would be a cheap way to burn edge CPU. The
 * size cap is in **characters, not bytes**: this module is re-exported from the
 * browser-facing barrel, so `Buffer` is not available here (see `index.ts`).
 */
const MAX_SCHEMA_CHARS = 32_768;
const MAX_SCHEMA_DEPTH = 12;

/** Deepest nesting level in `value`, bailing out as soon as the cap is passed. */
function schemaDepth(value: unknown, depth = 1): number {
  if (value === null || typeof value !== "object") return depth;
  let deepest = depth;
  for (const child of Object.values(value)) {
    const d = schemaDepth(child, depth + 1);
    if (d > deepest) deepest = d;
    if (deepest > MAX_SCHEMA_DEPTH) return deepest; // no need to walk further
  }
  return deepest;
}

function withinSchemaBudget(schema: Record<string, unknown>): boolean {
  let serialized: string;
  try {
    serialized = JSON.stringify(schema);
  } catch {
    return false; // cyclic — could never be forwarded upstream anyway
  }
  return serialized.length <= MAX_SCHEMA_CHARS && schemaDepth(schema) <= MAX_SCHEMA_DEPTH;
}

/**
 * Structured output: constrain the completion to a JSON schema (ADR-0034).
 *
 * `json_schema` is the only mode. OpenAI's looser `{type:"json_object"}` has no
 * Anthropic equivalent, so serving it would make behaviour depend on which vendor
 * backs the model — the OpenAI codec rejects it with a 400 instead.
 *
 * Beyond the root-type and budget guards below the schema is **forwarded as-is**
 * and the vendor validates its own JSON Schema subset — the same division of
 * labour as `temperature`. The edge deliberately does not reimplement either
 * vendor's subset rules.
 */
export const LlmResponseFormatSchema = z.object({
  type: z.literal("json_schema"),
  /** Schema name. OpenAI requires one; defaulted at translation when omitted. */
  name: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, "must be 1-64 chars of [A-Za-z0-9_-]")
    .optional(),
  schema: z
    .record(z.string(), z.unknown())
    .refine((s) => s.type === "object", 'schema root must be `{"type":"object"}`')
    .refine(
      withinSchemaBudget,
      `schema must serialize to <= ${MAX_SCHEMA_CHARS} characters and nest <= ${MAX_SCHEMA_DEPTH} levels`,
    ),
  // NB there is deliberately no `strict` knob. Anthropic's `output_config.format`
  // always enforces and has no best-effort mode, so a `strict:false` could only be
  // honored on one vendor — the same request would then yield schema-violating JSON
  // on `gpt-*` but not `claude-*`, which is exactly the provider leak this seam
  // exists to prevent. The platform always enforces; see ADR-0034.
});
export type LlmResponseFormat = z.infer<typeof LlmResponseFormatSchema>;

/**
 * `POST /_api/llm/chat` request body. `model` is matched against the app's
 * per-app allowlist (manifest `capabilities.llm.models`) before anything is
 * sent upstream.
 *
 * `maxTokens` is **optional**: each vendor body builder decides what an unset
 * value means — Anthropic Messages requires the field so it defaults there
 * (`anthropicRequestBody`), while the OpenAI surface omits the upstream cap so
 * the model's own maximum applies (matching every other OpenAI-compatible
 * endpoint). `temperature`/`topP`/`stop` are optional sampling controls forwarded
 * to whichever vendor serves the model.
 */
export const LlmChatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(LlmMessageSchema).min(1),
  /** Optional system prompt; maps to the vendor's system channel. */
  system: z.string().optional(),
  maxTokens: z.int().positive().max(128_000).optional(),
  /** Sampling temperature; forwarded as-is (the vendor validates its own range). */
  temperature: z.number().optional(),
  /** Nucleus sampling; forwarded as-is. */
  topP: z.number().optional(),
  /** Stop sequences; normalized to a list at the boundary. */
  stop: z.array(z.string()).optional(),
  /**
   * Constrain the completion to a JSON schema (ADR-0034). Refused up front when
   * the requested model can't enforce it (`ModelPrice.structuredOutputs`). The
   * JSON still arrives as ordinary text, so `content` and the SSE `delta` frames
   * are unchanged — callers `JSON.parse` the result.
   */
  responseFormat: LlmResponseFormatSchema.optional(),
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
