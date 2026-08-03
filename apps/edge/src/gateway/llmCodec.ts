import type { FastifyReply } from "fastify";
import {
  LlmChatRequestSchema,
  LlmChatResponseSchema,
  type ApiErrorCode,
  type LlmChatRequest,
  type LlmUsage,
} from "@azx-pbc/shared";

/**
 * The **wire codec** seam. The LLM gateway handler (`llm.ts`) owns the whole
 * security/metering spine — session gate, Origin/CSRF, model allowlist, USD
 * budget, the `LlmProvider` seam, and the usage ledger — and speaks only the
 * platform-neutral `LlmChatRequest` / `LlmStreamEvent` shape. A codec owns the
 * *envelope*: how the request body is parsed into the neutral shape, and how the
 * neutral event stream is framed back out. Swapping the codec swaps the wire
 * format without touching a single policy check.
 *
 * `nativeCodec` (this file) is the original `POST /_api/llm/chat` behaviour,
 * byte-identical; `openAiCodec` (`openaiCodec.ts`) is the OpenAI-compatible
 * `/_api/openai/v1/chat/completions` surface.
 */

/** Per-request context handed to every codec framing call. Native ignores most of it. */
export interface LlmWireContext {
  /**
   * App-visible completion id (the OpenAI codec builds `chatcmpl-<completionId>`).
   * Deliberately distinct from the internal egress `requestId`/`jti`, which must
   * not be published to app code.
   */
  completionId: string;
  /** The requested model id (echoed back in the response envelope). */
  model: string;
  /** `created` unix seconds, stamped once so all chunks of one response agree. */
  created: number;
  /** Dev-gateway CORS: reflected on the hijacked SSE socket. Absent on the edge. */
  corsOrigin?: string;
  /** OpenAI `stream_options.include_usage` — emit a trailing usage chunk. */
  includeUsage?: boolean;
}

/** Outcome of parsing the request envelope into the neutral shape. */
export type LlmParseResult =
  | { ok: true; chat: LlmChatRequest; includeUsage?: boolean }
  | { ok: false; status: number; code: ApiErrorCode; message: string; param?: string };

export interface LlmWireCodec {
  /** Envelope body → neutral request, or a typed 4xx. */
  parse(body: unknown): LlmParseResult;
  /**
   * A pre-stream (or non-stream) error response, in this wire's shape. `param`
   * names the offending field when known (OpenAI puts it in the envelope; the
   * native codec ignores it).
   */
  error(
    reply: FastifyReply,
    status: number,
    code: ApiErrorCode,
    message: string,
    param?: string,
  ): void;
  /** Begin the streaming response (hijacks the socket + writes the head). */
  startStream(reply: FastifyReply, ctx: LlmWireContext): void;
  /** One text delta frame. */
  writeDelta(reply: FastifyReply, ctx: LlmWireContext, text: string): void;
  /** The terminal frame(s): stop reason + usage (+ `[DONE]` for OpenAI). */
  writeDone(
    reply: FastifyReply,
    ctx: LlmWireContext,
    done: { stopReason: string; usage: LlmUsage },
  ): void;
  /** An error surfaced mid-stream (after the head is already sent). */
  writeStreamError(
    reply: FastifyReply,
    ctx: LlmWireContext,
    err: { code: ApiErrorCode; message: string },
  ): void;
  /** Close the hijacked socket. */
  endStream(reply: FastifyReply): void;
  /** The non-streaming JSON response body, in this wire's shape. */
  sendResponse(
    reply: FastifyReply,
    ctx: LlmWireContext,
    res: { content: string; stopReason: string; usage: LlmUsage },
  ): void;
}

/** Platform error envelope (`{error:{code,message}}`). Shared by the native codec. */
export function sendApiError(
  reply: FastifyReply,
  status: number,
  code: ApiErrorCode,
  message: string,
): void {
  reply
    .status(status)
    .header("cache-control", "no-store")
    .type("application/json; charset=utf-8")
    .send({ error: { code, message } });
}

/**
 * Hijack the socket and write the SSE response head. Shared by both codecs — the
 * framing (event names vs `data:` chunks) differs, but the transport headers are
 * identical. `corsOrigin` is reflected only on the dev-gateway (dev-mode §5.4);
 * on the edge it is unset, so production SSE is unchanged.
 */
export function startEventStream(reply: FastifyReply, corsOrigin?: string): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    // Defeat proxy buffering so deltas reach the browser as they arrive.
    "x-accel-buffering": "no",
    ...(corsOrigin ? { "access-control-allow-origin": corsOrigin, vary: "Origin" } : {}),
  });
}

/** Native SSE framing — one record per event, data is JSON. */
function writeSseEvent(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * The original `/_api/llm/chat` wire: the neutral request straight in, named-event
 * SSE (`event: delta|done|error`) and the neutral `LlmChatResponse` out. Kept
 * byte-identical so the existing gateway contract and its tests do not move.
 */
export const nativeCodec: LlmWireCodec = {
  parse(body) {
    const parsed = LlmChatRequestSchema.safeParse(body);
    if (!parsed.success) {
      return { ok: false, status: 400, code: "validation_failed", message: "invalid chat request" };
    }
    return { ok: true, chat: parsed.data };
  },
  error(reply, status, code, message) {
    sendApiError(reply, status, code, message);
  },
  startStream(reply, ctx) {
    startEventStream(reply, ctx.corsOrigin);
  },
  writeDelta(reply, _ctx, text) {
    writeSseEvent(reply, "delta", { text });
  },
  writeDone(reply, _ctx, done) {
    writeSseEvent(reply, "done", { stopReason: done.stopReason, usage: done.usage });
  },
  writeStreamError(reply, _ctx, err) {
    writeSseEvent(reply, "error", err);
  },
  endStream(reply) {
    reply.raw.end();
  },
  sendResponse(reply, ctx, res) {
    reply.header("cache-control", "no-store").send(
      LlmChatResponseSchema.parse({
        model: ctx.model,
        content: res.content,
        stopReason: res.stopReason,
        usage: res.usage,
      }),
    );
  },
};
