import type { FastifyReply } from "fastify";
import {
  LlmChatRequestSchema,
  OpenAiChatCompletionRequestSchema,
  OpenAiChatCompletionResponseSchema,
  OPENAI_UNSUPPORTED_PARAMS,
  type ApiErrorCode,
  type LlmMessage,
  type LlmUsage,
  type OpenAiChatCompletionChunk,
  type OpenAiErrorBody,
  type OpenAiFinishReason,
  type OpenAiUsage,
} from "@azx-pbc/shared";
import {
  startEventStream,
  type LlmParseResult,
  type LlmWireCodec,
  type LlmWireContext,
} from "./llmCodec.js";

/**
 * The OpenAI **chat/completions** wire codec for `/_api/openai/v1/*`. It only
 * translates the envelope — every policy/metering step runs in `llm.ts` exactly
 * as for the native codec. Scope is text chat (see `packages/shared/src/
 * llmOpenai.ts`): tool calls and multimodal content are rejected with a clear
 * 400 rather than silently dropped.
 */

/** OpenAI error `type`/`code` for each platform ApiErrorCode. */
function openAiErrorMeta(code: ApiErrorCode): { type: string; code: string | null } {
  switch (code) {
    case "validation_failed":
      return { type: "invalid_request_error", code: null };
    case "model_not_allowed":
      return { type: "invalid_request_error", code: "model_not_found" };
    case "forbidden":
    case "unauthorized":
      return { type: "invalid_request_error", code: null };
    case "quota_exceeded":
      return { type: "insufficient_quota", code: "insufficient_quota" };
    case "rate_limited":
      return { type: "rate_limit_exceeded", code: "rate_limit_exceeded" };
    case "capability_unavailable":
    case "internal":
    default:
      return { type: "api_error", code: null };
  }
}

function openAiError(code: ApiErrorCode, message: string, param?: string): OpenAiErrorBody {
  const meta = openAiErrorMeta(code);
  return { error: { message, type: meta.type, param: param ?? null, code: meta.code } };
}

/** Neutral stop reason → OpenAI `finish_reason`. */
function finishReason(stopReason: string): OpenAiFinishReason {
  switch (stopReason) {
    case "max_tokens":
      return "length";
    case "refusal":
      return "content_filter";
    default:
      return "stop"; // end_turn / stop_sequence / anything else
  }
}

function usageBlock(u: LlmUsage): OpenAiUsage {
  const prompt = u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens;
  return {
    prompt_tokens: prompt,
    completion_tokens: u.outputTokens,
    total_tokens: prompt + u.outputTokens,
  };
}

function writeChunk(reply: FastifyReply, chunk: OpenAiChatCompletionChunk): void {
  reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function baseChunk(ctx: LlmWireContext): Omit<OpenAiChatCompletionChunk, "choices"> {
  return {
    id: `chatcmpl-${ctx.completionId}`,
    object: "chat.completion.chunk",
    created: ctx.created,
    model: ctx.model,
  };
}

/**
 * Parse an OpenAI request into the neutral shape. `system`/`developer` messages
 * are hoisted into the neutral top-level `system`; `user`/`assistant` become
 * neutral turns. Anything the platform doesn't support in v1 — tools, tool_choice,
 * `role:"tool"`, or non-string (multimodal) content — is a 400, never a silent drop.
 */
/** A 400 that names the offending field (OpenAI surfaces `param` to the developer). */
function badRequest(message: string, param?: string): LlmParseResult {
  return { ok: false, status: 400, code: "validation_failed", message, param };
}

function parseOpenAi(body: unknown): LlmParseResult {
  const parsed = OpenAiChatCompletionRequestSchema.safeParse(body);
  if (!parsed.success) {
    // Surface the first zod issue + its path so the client can locate the field.
    const issue = parsed.error.issues[0];
    return badRequest(issue?.message ?? "invalid request", issue?.path.join(".") || undefined);
  }
  const req = parsed.data;

  // Reject affirmative tool use, but allow opting *out* (`tool_choice:"none"`,
  // empty `tools:[]`) — those are requests this surface can serve exactly.
  if (
    (req.tools && req.tools.length > 0) ||
    (req.tool_choice !== undefined && req.tool_choice !== "none")
  ) {
    return badRequest("tool use is not supported", "tools");
  }

  // Behaviour-changing params are rejected loudly, never silently dropped. `n:1`
  // is exempt: it's the no-op default many wrappers (LangChain, LiteLLM) always
  // send and matches the single choice we return — rejecting it would break stock
  // clients for nothing. `n > 1` genuinely changes behaviour and is rejected.
  for (const p of OPENAI_UNSUPPORTED_PARAMS) {
    const value = (req as Record<string, unknown>)[p];
    if (value === undefined) continue;
    if (p === "n" && value === 1) continue;
    return badRequest(`the "${p}" parameter is not supported`, p);
  }

  const systemParts: string[] = [];
  const messages: LlmMessage[] = [];
  for (const m of req.messages) {
    if (m.role === "tool" || m.tool_calls) {
      return badRequest("tool messages are not supported", "messages");
    }
    if (typeof m.content !== "string") {
      return badRequest("only string message content is supported", "messages");
    }
    if (m.role === "system" || m.role === "developer") {
      systemParts.push(m.content);
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }

  // Validate against the neutral contract (catches e.g. a system-only request →
  // no user/assistant turns) and normalize. `maxTokens` stays optional — the
  // OpenAI body builder omits the upstream cap when it's unset (model max).
  const chat = LlmChatRequestSchema.safeParse({
    model: req.model,
    messages,
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    maxTokens: req.max_completion_tokens ?? req.max_tokens,
    temperature: req.temperature,
    topP: req.top_p,
    stop: req.stop === undefined ? undefined : typeof req.stop === "string" ? [req.stop] : req.stop,
    // OpenAI is non-streaming unless the client sets stream:true (the neutral
    // default is the opposite — do not inherit it).
    stream: req.stream ?? false,
  });
  if (!chat.success) {
    const issue = chat.error.issues[0];
    return badRequest(issue?.message ?? "invalid request", issue?.path.join(".") || undefined);
  }
  return { ok: true, chat: chat.data, includeUsage: req.stream_options?.include_usage ?? false };
}

export const openAiCodec: LlmWireCodec = {
  parse: parseOpenAi,

  error(reply, status, code, message, param) {
    reply
      .status(status)
      .header("cache-control", "no-store")
      .type("application/json; charset=utf-8")
      .send(openAiError(code, message, param));
  },

  startStream(reply, ctx) {
    startEventStream(reply, ctx.corsOrigin);
    // OpenAI clients expect the assistant role in the first chunk.
    writeChunk(reply, {
      ...baseChunk(ctx),
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
  },

  writeDelta(reply, ctx, text) {
    writeChunk(reply, {
      ...baseChunk(ctx),
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    });
  },

  writeDone(reply, ctx, done) {
    writeChunk(reply, {
      ...baseChunk(ctx),
      choices: [{ index: 0, delta: {}, finish_reason: finishReason(done.stopReason) }],
    });
    // A trailing usage chunk (choices: []) only when the client asked for it.
    if (ctx.includeUsage) {
      writeChunk(reply, { ...baseChunk(ctx), choices: [], usage: usageBlock(done.usage) });
    }
    reply.raw.write("data: [DONE]\n\n");
  },

  writeStreamError(reply, _ctx, err) {
    // No standard mid-stream error frame; emit an error object chunk and stop
    // (no `[DONE]`) so the client sees the failure rather than a clean end.
    reply.raw.write(`data: ${JSON.stringify(openAiError(err.code, err.message))}\n\n`);
  },

  endStream(reply) {
    reply.raw.end();
  },

  sendResponse(reply, ctx, res) {
    reply.header("cache-control", "no-store").send(
      OpenAiChatCompletionResponseSchema.parse({
        id: `chatcmpl-${ctx.completionId}`,
        object: "chat.completion",
        created: ctx.created,
        model: ctx.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: res.content },
            finish_reason: finishReason(res.stopReason),
          },
        ],
        usage: usageBlock(res.usage),
      }),
    );
  },
};
