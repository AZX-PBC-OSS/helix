import { randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  OpenAiChatRequestSchema,
  finishReasonFromStopReason,
  openAiError,
  openAiMessagesToNeutral,
  type LlmChatRequest,
  type LlmUsage,
  type OpenAiErrorBody,
} from "@helix/shared";
import { LlmProviderError, type LlmProvider } from "./provider.js";
import { abortOnClientDisconnect } from "./clientAbort.js";

/**
 * The **builder** LLM endpoint (Track A of the "Lovable at home" prototype):
 * an OpenAI-compatible `POST /v1/chat/completions` + `GET /v1/models` served on
 * the platform host, so a web app builder (bolt.diy) can point at the platform
 * as if it were OpenAI and never hold a vendor key. It routes through the same
 * {@link ./provider.js LlmProvider} seam the app-facing gateway uses, so the
 * upstream stays swappable and the client stays vendor-neutral.
 *
 * This is deliberately NOT the app-facing `/_api/llm/chat` gateway. That path
 * serves untrusted hosted apps and carries the heavy policy — session gate,
 * per-app manifest allowlist, Origin/CSRF, per-app USD budget. The builder is a
 * developer tool called server-to-server with a bearer key, so its policy is
 * just: a valid key, and a model from the curated catalog. Keeping it separate
 * leaves the trusted app path untouched.
 *
 * Prototype scope: bearer-key auth (one shared dev key), no per-developer
 * metering yet (the ledger is keyed by appId and there is no app here). Both are
 * fine for proving the concept; production would key off the developer's portal
 * identity and meter to a builder budget.
 */

export interface BuilderLlmRuntime {
  /** The vendor provider seam (shared with the app gateway); null → 503. */
  provider: LlmProvider | null;
  /** Shared bearer key; null → capability off (the routes 404). */
  apiKey: string | null;
  /** Curated model catalog advertised by /v1/models and enforced on chat. */
  models: readonly string[];
}

function sendOpenAiError(reply: FastifyReply, status: number, body: OpenAiErrorBody): void {
  reply
    .status(status)
    .header("cache-control", "no-store")
    .type("application/json; charset=utf-8")
    .send(body);
}

/** Constant-time bearer check against the configured key. */
function bearerAllowed(header: string | undefined, key: string): boolean {
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) return false;
  const given = Buffer.from(match[1]);
  const expected = Buffer.from(key);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Clamp to the neutral schema's ceiling; default matches OpenAI's small default. */
function resolveMaxTokens(req: { max_completion_tokens?: number; max_tokens?: number }): number {
  const requested = req.max_completion_tokens ?? req.max_tokens ?? 1024;
  return Math.min(requested, 128_000);
}

function chatCompletionId(): string {
  return `chatcmpl-${randomUUID()}`;
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

/** SSE: one `data: <json>` record per chunk (OpenAI framing — no `event:` line). */
function writeChunk(reply: FastifyReply, chunk: unknown): void {
  reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function startSse(reply: FastifyReply): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
}

/** A streaming chunk envelope shared across role/content/final frames. */
function chunkEnvelope(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
): unknown {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export function makeBuilderChatHandler(rt: BuilderLlmRuntime) {
  return async function handleBuilderChat(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    // Capability off (no key configured) — the route should not have been built,
    // but fail closed regardless.
    if (!rt.apiKey) {
      sendOpenAiError(reply, 404, openAiError("not found", "invalid_request_error"));
      return;
    }
    if (!bearerAllowed(req.headers.authorization, rt.apiKey)) {
      sendOpenAiError(
        reply,
        401,
        openAiError("invalid or missing API key", "invalid_request_error", "invalid_api_key"),
      );
      return;
    }
    if (!rt.provider) {
      sendOpenAiError(reply, 503, openAiError("LLM capability is not configured", "server_error"));
      return;
    }

    const parsed = OpenAiChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendOpenAiError(reply, 400, openAiError("invalid chat request", "invalid_request_error"));
      return;
    }
    const body = parsed.data;

    if (!rt.models.includes(body.model)) {
      sendOpenAiError(
        reply,
        400,
        openAiError(
          `model \`${body.model}\` does not exist`,
          "invalid_request_error",
          "model_not_found",
        ),
      );
      return;
    }

    const { system, messages } = openAiMessagesToNeutral(body.messages);
    if (messages.length === 0) {
      sendOpenAiError(
        reply,
        400,
        openAiError("no user/assistant messages in request", "invalid_request_error"),
      );
      return;
    }

    const chat: LlmChatRequest = {
      model: body.model,
      messages,
      maxTokens: resolveMaxTokens(body),
      stream: body.stream,
      ...(system ? { system } : {}),
    };

    // Abort the upstream if the client goes away before we finish (guarded on
    // the response socket — see abortOnClientDisconnect).
    const abort = abortOnClientDisconnect(reply);

    const events = rt.provider.stream(chat, {
      signal: abort.signal,
      // No app/user attribution on the builder path (no app context yet); the
      // direct provider ignores these, the egress provider would need real ones.
      appId: "builder",
      userOid: "builder",
      requestId: randomUUID(),
    });

    const id = chatCompletionId();
    const created = nowUnix();

    if (body.stream) {
      let started = false;
      let stopReason = "end_turn";
      try {
        for await (const ev of events) {
          if (ev.type === "delta") {
            if (!started) {
              startSse(reply);
              // OpenAI's first chunk announces the assistant role.
              writeChunk(
                reply,
                chunkEnvelope(id, created, body.model, { role: "assistant" }, null),
              );
              started = true;
            }
            writeChunk(reply, chunkEnvelope(id, created, body.model, { content: ev.text }, null));
          } else {
            stopReason = ev.stopReason;
          }
        }
        if (!started) {
          startSse(reply);
          writeChunk(reply, chunkEnvelope(id, created, body.model, { role: "assistant" }, null));
        }
        writeChunk(
          reply,
          chunkEnvelope(id, created, body.model, {}, finishReasonFromStopReason(stopReason)),
        );
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
      } catch (err) {
        const { status, message, code } = upstreamError(err, req.log);
        if (!started) {
          // Nothing sent yet — a real HTTP status + message is far more useful to
          // the client than a 200 stream carrying an error object.
          sendOpenAiError(reply, status, openAiError(message, "invalid_request_error", code));
        } else {
          // Mid-stream: no standard SSE error frame in OpenAI's protocol; emit an
          // error object then close.
          writeChunk(reply, openAiError(message, "server_error", code));
          reply.raw.end();
        }
      }
      return;
    }

    // Non-streaming: accumulate into a single chat.completion body.
    let content = "";
    let stopReason = "end_turn";
    const usage: LlmUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    try {
      for await (const ev of events) {
        if (ev.type === "delta") content += ev.text;
        else {
          stopReason = ev.stopReason;
          Object.assign(usage, ev.usage);
        }
      }
    } catch (err) {
      const { status, message, code } = upstreamError(err, req.log);
      sendOpenAiError(reply, status, openAiError(message, "invalid_request_error", code));
      return;
    }

    const promptTokens =
      usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
    await reply.header("cache-control", "no-store").send({
      id,
      object: "chat.completion",
      created,
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: finishReasonFromStopReason(stopReason),
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: promptTokens + usage.outputTokens,
      },
    });
  };
}

/** `GET /v1/models` — advertise the curated catalog so a client's model list populates. */
export function makeBuilderModelsHandler(rt: BuilderLlmRuntime) {
  return async function handleBuilderModels(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (!rt.apiKey) {
      sendOpenAiError(reply, 404, openAiError("not found", "invalid_request_error"));
      return;
    }
    if (!bearerAllowed(req.headers.authorization, rt.apiKey)) {
      sendOpenAiError(
        reply,
        401,
        openAiError("invalid or missing API key", "invalid_request_error", "invalid_api_key"),
      );
      return;
    }
    const created = nowUnix();
    await reply.header("cache-control", "no-store").send({
      object: "list",
      data: rt.models.map((id) => ({ id, object: "model", created, owned_by: "helix" })),
    });
  };
}

/**
 * Log a provider failure and map it to a client status + message. The builder
 * endpoint is a developer tool (not the untrusted-app path), so — unlike the
 * app-facing gateway, which hides vendor detail — we surface the upstream status
 * and message: a bolt "prompt is too long" / "max_tokens" 400 is exactly what
 * the developer needs to see. The full error is also logged for the edge shell.
 */
function upstreamError(
  err: unknown,
  log: FastifyRequest["log"],
): { status: number; message: string; code: string } {
  if (err instanceof LlmProviderError) {
    log.warn(
      { err: err.message, upstreamStatus: err.upstreamStatus },
      "builder llm upstream failed",
    );
    // A 4xx from the vendor (bad request, rate limit) is the caller's to see and
    // act on; pass it through. 5xx/unknown collapse to 502 (a gateway failure).
    const passthrough =
      err.upstreamStatus !== undefined && err.upstreamStatus >= 400 && err.upstreamStatus < 500;
    return {
      status: passthrough ? err.upstreamStatus : 502,
      message: extractUpstreamMessage(err.message),
      code: err.upstreamStatus === 429 ? "rate_limit_exceeded" : "upstream_error",
    };
  }
  log.warn({ err: err instanceof Error ? err.message : String(err) }, "builder llm failed");
  return { status: 500, message: "LLM request failed", code: "internal_error" };
}

/** Pull the vendor's error text out of the wrapped provider message, if present. */
function extractUpstreamMessage(wrapped: string): string {
  const brace = wrapped.indexOf("{");
  if (brace !== -1) {
    try {
      const parsed = JSON.parse(wrapped.slice(brace)) as { error?: { message?: string } };
      if (parsed.error?.message) return parsed.error.message;
    } catch {
      /* fall through to the raw wrapped message */
    }
  }
  return wrapped;
}
