import type { FastifyReply, FastifyRequest } from "fastify";
import {
  LlmChatRequestSchema,
  LlmChatResponseSchema,
  type ApiErrorCode,
  type LlmChatRequest,
  type LlmUsage,
} from "@helix/shared";
import type { EdgeConfig } from "../config.js";
import type { RegistryReader } from "../registry/projection.js";
import type { SessionGate } from "../auth/gate.js";
import { resolveServingEntry } from "../auth/routes/appHost.js";
import { isSameOrigin } from "../auth/validate.js";
import { LlmProviderError, type LlmProvider } from "./provider.js";
import type { GatewayOutcome, UsageStore } from "./usage.js";

/**
 * `POST /_api/llm/chat` — the gateway's LLM capability (architecture §6.1,
 * project plan §4 M4). The choke point that makes per-app blast-radius real:
 * it authenticates the user (session gate), proves the request came from the
 * app's own origin (CSRF — §4.2), enforces the per-app model allowlist and
 * daily token budget from the manifest (§6.3), proxies to the vendor through
 * the `LlmProvider` seam (the app never sees the key), and meters every call.
 *
 * Quota is **block-new, finish-in-flight**: the budget is checked once at
 * admission; an admitted request always runs to completion, even if it pushes
 * the app over budget — the next request is the one that gets blocked.
 */

export interface LlmGatewayRuntime {
  config: EdgeConfig;
  registry: RegistryReader;
  gate: SessionGate;
  /** Null when no vendor key is configured — the capability 503s. */
  provider: LlmProvider | null;
  usage: UsageStore | null;
}

function sendApiError(
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

/** SSE framing — one record per event (data is JSON). */
function writeSseEvent(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function startSse(reply: FastifyReply): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    // Defeat proxy buffering so deltas reach the browser as they arrive.
    "x-accel-buffering": "no",
  });
}

export function makeLlmHandler(rt: LlmGatewayRuntime) {
  return async function handleLlmChat(
    req: FastifyRequest,
    reply: FastifyReply,
    slug: string,
  ): Promise<void> {
    const entry = resolveServingEntry(rt.registry, slug, reply);
    if (!entry) return;

    // Authn: a fetch with no/expired session gets 401 (the gate handles the
    // navigation-vs-fetch split and refresh-due 401 for /_api/*).
    const session = await rt.gate(req, reply, entry);
    if (!session) return;

    // CSRF: a sibling subdomain must not POST to this app's gateway on the
    // user's session. SameSite doesn't cover cross-subdomain; Origin does.
    if (!isSameOrigin(req.headers.origin, rt.config, entry.slug)) {
      sendApiError(reply, 403, "forbidden", "Origin not allowed");
      return;
    }

    // Capability must be configured on this edge (a vendor key is present).
    if (!rt.provider || !rt.usage) {
      sendApiError(reply, 503, "capability_unavailable", "LLM capability is not configured");
      return;
    }

    const parsed = LlmChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendApiError(reply, 400, "validation_failed", "invalid chat request");
      return;
    }
    const chat: LlmChatRequest = parsed.data;

    // Authz: the app must hold an LLM grant and the model must be allowlisted
    // (manifest capabilities.llm — §6.3).
    if (!entry.llm) {
      sendApiError(reply, 403, "forbidden", "this app has no LLM capability");
      return;
    }
    if (!entry.llm.models.includes(chat.model)) {
      sendApiError(reply, 403, "model_not_allowed", `model "${chat.model}" is not allowed`);
      return;
    }

    // Quota (block-new): if the app is already at/over its daily budget, refuse
    // before sending anything upstream. An in-flight request is never cut.
    const usage = rt.usage;
    const budget = entry.llm.tokensPerDay;
    if (budget !== undefined) {
      const usedToday = await usage.tokensUsedToday(entry.appId);
      if (usedToday >= budget) {
        await usage
          .record({
            appId: entry.appId,
            userOid: session.user.oid,
            capability: "llm",
            model: chat.model,
            inputTokens: 0,
            outputTokens: 0,
            outcome: "quota_blocked",
          })
          .catch(() => {});
        sendApiError(reply, 429, "quota_exceeded", "daily token budget exhausted");
        return;
      }
    }

    // Admitted. Abort the upstream if the client goes away.
    const abort = new AbortController();
    req.raw.on("close", () => abort.abort());

    let recorded = false;
    const finalUsage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
    const recordOnce = async (outcome: GatewayOutcome): Promise<void> => {
      if (recorded) return;
      recorded = true;
      await usage
        .record({
          appId: entry.appId,
          userOid: session.user.oid,
          capability: "llm",
          model: chat.model,
          inputTokens: finalUsage.inputTokens,
          outputTokens: finalUsage.outputTokens,
          outcome,
        })
        .catch((err: unknown) => req.log.warn({ err }, "gateway usage record failed"));
    };

    const events = rt.provider.stream(chat, { signal: abort.signal });

    if (chat.stream) {
      let started = false;
      let stopReason = "end_turn";
      try {
        for await (const ev of events) {
          if (ev.type === "delta") {
            if (!started) {
              startSse(reply);
              started = true;
            }
            writeSseEvent(reply, "delta", { text: ev.text });
          } else {
            finalUsage.inputTokens = ev.usage.inputTokens;
            finalUsage.outputTokens = ev.usage.outputTokens;
            stopReason = ev.stopReason;
          }
        }
        if (!started) startSse(reply);
        writeSseEvent(reply, "done", { stopReason, usage: finalUsage });
        reply.raw.end();
        await recordOnce("ok");
      } catch (err) {
        await recordOnce("error");
        const { code, message } = describeError(err);
        if (!started) startSse(reply);
        writeSseEvent(reply, "error", { code, message });
        reply.raw.end();
      }
      return;
    }

    // Non-streaming: accumulate into a single JSON body.
    let content = "";
    let stopReason = "end_turn";
    try {
      for await (const ev of events) {
        if (ev.type === "delta") content += ev.text;
        else {
          finalUsage.inputTokens = ev.usage.inputTokens;
          finalUsage.outputTokens = ev.usage.outputTokens;
          stopReason = ev.stopReason;
        }
      }
      await recordOnce("ok");
      await reply.header("cache-control", "no-store").send(
        LlmChatResponseSchema.parse({
          model: chat.model,
          content,
          stopReason,
          usage: finalUsage,
        }),
      );
    } catch (err) {
      await recordOnce("error");
      const { code, message } = describeError(err);
      // 502 for upstream failures; the code stays within the shared set.
      sendApiError(reply, 502, code, message);
    }
  };
}

/** Map a provider/abort failure to a stable code + safe message. */
function describeError(err: unknown): { code: ApiErrorCode; message: string } {
  if (err instanceof LlmProviderError) {
    return { code: "internal", message: "upstream LLM request failed" };
  }
  return { code: "internal", message: "LLM request failed" };
}
