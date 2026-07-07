import { randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  LlmChatRequestSchema,
  costUsd,
  priceForModel,
  type ApiErrorCode,
  type LlmChatRequest,
  type LlmUsage,
} from "@helix/shared";
import type { RegistryReader } from "../registry/projection.js";
import { resolveServingEntry } from "../auth/routes/appHost.js";
import { abortOnClientDisconnect } from "../gateway/clientAbort.js";
import { LlmProviderError, type LlmProvider } from "../gateway/provider.js";
import type { GatewayOutcome, UsageStore } from "../gateway/usage.js";

/**
 * ⚠️ THROWAWAY PROTOTYPE — delete this whole directory when the real dev tier
 * lands. This is the Track C "thin dev-gateway spike" (see builder/README.md and
 * docs/design/dev-mode.md). It exists only to let a WebContainer/Lovable preview
 * — a *cross-origin* page — reach the LLM capability so an app under development
 * can be exercised against real inference before it's deployed.
 *
 * What the REAL dev tier (dev-mode.md §4–§6) does that this does NOT:
 *   - per-app minted/rotated/revoked dev tokens (§4) → here: one shared env token
 *   - the `env` data partition + `helix_dev` role + env-literal RLS (§5) → here:
 *     NONE. That is why this surface is **LLM-only**: the LLM path is stateless,
 *     so routing it through the real provider touches only metering, never data.
 *     `data`/`fetch` are deliberately absent — they can't be added without the
 *     env partition, or dev writes would land in the PROD partition.
 *   - per-env budgets (§5.1) → here: budget gate skipped; calls DO meter against
 *     the app's real ledger (the one contamination we accept, and it's only cost).
 *
 * Everything below is intentionally self-contained (its own SSE framing, its own
 * bearer check) so it deletes cleanly and never entangles the trusted prod
 * handlers. Fidelity we DO keep: the app's manifest model allowlist is enforced,
 * and the wire shape is the neutral `/_api/llm/chat` contract, so app code is
 * byte-identical to what runs in prod.
 */

export interface DevGatewayRuntime {
  registry: RegistryReader;
  provider: LlmProvider | null;
  usage: UsageStore | null;
  /** Shared bearer dev-token; when null the surface is off (routes 404). */
  token: string | null;
  /** Exact origins CORS reflects. */
  origins: string[];
}

/** The header the dev SDK transport adds to name the app (real tier: bound in the token). */
const DEV_APP_HEADER = "x-helix-dev-app";

function corsHeaders(origin: string | undefined, allowed: string[]): Record<string, string> | null {
  if (!origin || !allowed.includes(origin)) return null;
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": `authorization, content-type, ${DEV_APP_HEADER}`,
    "access-control-max-age": "600",
  };
}

function bearerAllowed(header: string | undefined, key: string): boolean {
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) return false;
  const given = Buffer.from(match[1]);
  const expected = Buffer.from(key);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function sendError(
  reply: FastifyReply,
  status: number,
  code: ApiErrorCode,
  message: string,
  cors: Record<string, string> | null,
): void {
  reply.status(status).header("cache-control", "no-store").type("application/json; charset=utf-8");
  if (cors) for (const [k, v] of Object.entries(cors)) reply.header(k, v);
  reply.send({ error: { code, message } });
}

function writeSseEvent(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function startSse(reply: FastifyReply, cors: Record<string, string>): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...cors,
  });
}

/** CORS preflight (OPTIONS) for the dev surface — 204 with headers if the origin is allowed. */
export function makeDevPreflightHandler(rt: DevGatewayRuntime) {
  return async function handleDevPreflight(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (!rt.token) {
      reply.status(404).send();
      return;
    }
    const cors = corsHeaders(req.headers.origin, rt.origins);
    if (!cors) {
      reply.status(403).send();
      return;
    }
    for (const [k, v] of Object.entries(cors)) reply.header(k, v);
    reply.status(204).send();
  };
}

/**
 * `POST /_api/llm/chat` on the dev host — the neutral LLM contract, CORS-reflected
 * for the registered preview origins and authed by the shared bearer dev-token.
 * Streams through the same {@link LlmProvider} seam prod uses; enforces the app's
 * manifest model allowlist; meters the call (against the prod ledger — see header).
 */
export function makeDevLlmHandler(rt: DevGatewayRuntime) {
  return async function handleDevLlm(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!rt.token) {
      sendError(reply, 404, "not_found", "dev gateway is not configured", null);
      return;
    }
    const cors = corsHeaders(req.headers.origin, rt.origins);
    if (!cors) {
      // No ACAO → the browser blocks the read anyway; be explicit for non-browser callers.
      sendError(reply, 403, "forbidden", "origin not allowed", null);
      return;
    }
    if (!bearerAllowed(req.headers.authorization, rt.token)) {
      sendError(reply, 401, "unauthorized", "invalid or missing dev token", cors);
      return;
    }

    const slug = req.headers[DEV_APP_HEADER];
    if (typeof slug !== "string" || slug === "") {
      sendError(reply, 400, "validation_failed", `missing ${DEV_APP_HEADER} header`, cors);
      return;
    }
    const entry = resolveServingEntry(rt.registry, slug, reply);
    if (!entry) return;

    if (!rt.provider || !rt.usage) {
      sendError(reply, 503, "capability_unavailable", "LLM capability is not configured", cors);
      return;
    }
    const parsed = LlmChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(reply, 400, "validation_failed", "invalid chat request", cors);
      return;
    }
    const chat: LlmChatRequest = parsed.data;

    // Fidelity: enforce the app's real manifest allowlist (the point of dev-mode).
    if (!entry.llm) {
      sendError(reply, 403, "forbidden", "this app has no LLM capability", cors);
      return;
    }
    if (!entry.llm.models.includes(chat.model) || priceForModel(chat.model) === undefined) {
      sendError(reply, 403, "model_not_allowed", `model "${chat.model}" is not allowed`, cors);
      return;
    }
    // NB: the per-app USD budget gate (llm.ts) is intentionally omitted in the
    // throwaway surface; the real dev tier enforces it per-env (dev-mode.md §5.1).

    const usage = rt.usage;
    const abort = abortOnClientDisconnect(reply);
    const startedAt = performance.now();
    const finalUsage: LlmUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    let stopReason = "end_turn";
    let recorded = false;
    const recordOnce = async (outcome: GatewayOutcome): Promise<void> => {
      if (recorded) return;
      recorded = true;
      await usage
        .record({
          appId: entry.appId,
          userOid: "dev",
          capability: "llm",
          model: chat.model,
          inputTokens: finalUsage.inputTokens,
          outputTokens: finalUsage.outputTokens,
          cacheReadInputTokens: finalUsage.cacheReadInputTokens,
          cacheCreationInputTokens: finalUsage.cacheCreationInputTokens,
          costMicroUsd: Math.round(costUsd({ model: chat.model, ...finalUsage }) * 1_000_000),
          outcome,
          durationMs: Math.round(performance.now() - startedAt),
          stopReason,
        })
        .catch((err: unknown) => req.log.warn({ err }, "dev gateway usage record failed"));
    };

    const events = rt.provider.stream(chat, {
      signal: abort.signal,
      appId: entry.appId,
      userOid: "dev",
      requestId: randomUUID(),
    });

    let started = false;
    try {
      for await (const ev of events) {
        if (ev.type === "delta") {
          if (!started) {
            startSse(reply, cors);
            started = true;
          }
          writeSseEvent(reply, "delta", { text: ev.text });
        } else {
          Object.assign(finalUsage, ev.usage);
          stopReason = ev.stopReason;
        }
      }
      if (!started) startSse(reply, cors);
      writeSseEvent(reply, "done", { stopReason, usage: finalUsage });
      reply.raw.end();
      await recordOnce(stopReason === "refusal" ? "refusal" : "ok");
    } catch (err) {
      await recordOnce("error");
      // Dev surface — surface the vendor detail (e.g. "prompt is too long") and
      // log it for the edge shell, like the builder endpoint.
      const detail =
        err instanceof LlmProviderError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      req.log.warn({ err: detail }, "dev gateway llm upstream failed");
      const message =
        err instanceof LlmProviderError
          ? extractUpstreamMessage(err.message)
          : "LLM request failed";
      if (!started) startSse(reply, cors);
      writeSseEvent(reply, "error", { code: "internal", message });
      reply.raw.end();
    }
  };
}

/** Pull the vendor error text out of the wrapped provider message, if present. */
function extractUpstreamMessage(wrapped: string): string {
  const brace = wrapped.indexOf("{");
  if (brace !== -1) {
    try {
      const parsed = JSON.parse(wrapped.slice(brace)) as { error?: { message?: string } };
      if (parsed.error?.message) return parsed.error.message;
    } catch {
      /* fall through */
    }
  }
  return wrapped;
}
