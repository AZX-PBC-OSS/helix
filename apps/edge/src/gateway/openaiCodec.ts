import type { FastifyReply } from "fastify";
import {
  LlmChatRequestSchema,
  OpenAiChatCompletionRequestSchema,
  OpenAiChatCompletionResponseSchema,
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

function openAiError(code: ApiErrorCode, message: string): OpenAiErrorBody {
  const meta = openAiErrorMeta(code);
  return { error: { message, type: meta.type, param: null, code: meta.code } };
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
    id: `chatcmpl-${ctx.requestId}`,
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
function parseOpenAi(body: unknown): LlmParseResult {
  const parsed = OpenAiChatCompletionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, status: 400, code: "validation_failed", message: "invalid request" };
  }
  const req = parsed.data;

  if ((req.tools && req.tools.length > 0) || req.tool_choice !== undefined) {
    return {
      ok: false,
      status: 400,
      code: "validation_failed",
      message: "tool use is not supported",
    };
  }

  const systemParts: string[] = [];
  const messages: LlmMessage[] = [];
  for (const m of req.messages) {
    if (m.role === "tool" || m.tool_calls) {
      return {
        ok: false,
        status: 400,
        code: "validation_failed",
        message: "tool messages are not supported",
      };
    }
    if (typeof m.content !== "string") {
      return {
        ok: false,
        status: 400,
        code: "validation_failed",
        message: "only string message content is supported",
      };
    }
    if (m.role === "system" || m.role === "developer") {
      systemParts.push(m.content);
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }

  // Validate against the neutral contract (catches e.g. a system-only request →
  // no user/assistant turns) and normalize defaults.
  const chat = LlmChatRequestSchema.safeParse({
    model: req.model,
    messages,
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    maxTokens: req.max_completion_tokens ?? req.max_tokens,
    // OpenAI is non-streaming unless the client sets stream:true (the neutral
    // default is the opposite — do not inherit it).
    stream: req.stream ?? false,
  });
  if (!chat.success) {
    return { ok: false, status: 400, code: "validation_failed", message: "invalid request" };
  }
  return { ok: true, chat: chat.data, includeUsage: req.stream_options?.include_usage ?? false };
}

export const openAiCodec: LlmWireCodec = {
  parse: parseOpenAi,

  error(reply, status, code, message) {
    reply
      .status(status)
      .header("cache-control", "no-store")
      .type("application/json; charset=utf-8")
      .send(openAiError(code, message));
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
        id: `chatcmpl-${ctx.requestId}`,
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
