import type { FastifyReply, FastifyRequest } from "fastify";
import { OpenAiModelListSchema } from "@azx-pbc/shared";
import { resolveServingEntry } from "../auth/routes/appHost.js";
import { anonRateLimited } from "./ipRateLimiter.js";
import { openAiCodec } from "./openaiCodec.js";
import type { LlmGatewayRuntime } from "./llm.js";

/**
 * `GET /_api/openai/v1/models` — the app's own allowlisted models in OpenAI list
 * shape, so stock OpenAI clients/tools that enumerate models work. Session-gated
 * (a read, so no Origin/CSRF check — same posture as `/_api/me`); reflects the
 * per-app manifest allowlist, never the platform catalog. It holds the same
 * invariants as the chat route (`llm.ts`): the anon per-IP limiter on public
 * apps, and a 403 when the app has no LLM grant. Errors are OpenAI-shaped.
 */
export function makeOpenAiModelsHandler(rt: LlmGatewayRuntime) {
  return async function handleModels(
    req: FastifyRequest,
    reply: FastifyReply,
    slug: string,
  ): Promise<void> {
    const entry = resolveServingEntry(rt.registry, slug, reply);
    if (!entry) return;

    const caller = await rt.resolveCaller(req, reply, entry);
    if (!caller) return;

    // Anon per-IP cap (public apps route around the session, so this is otherwise
    // unauthenticated) — same guard the chat/data/fetch handlers apply.
    if (await anonRateLimited(rt.anonLimiter, req, entry, caller)) {
      openAiCodec.error(reply, 429, "rate_limited", "per-IP request budget exhausted");
      return;
    }

    // No grant → 403, matching the chat route. An empty list would misleadingly
    // read as "granted LLM, zero models allowlisted".
    if (!entry.llm) {
      openAiCodec.error(reply, 403, "forbidden", "this app has no LLM capability");
      return;
    }

    reply.header("cache-control", "no-store").send(
      OpenAiModelListSchema.parse({
        object: "list",
        // `created` is required by the OpenAI Model object; a stable 0 (these are
        // platform models, not per-app artifacts with a creation time).
        data: entry.llm.models.map((id) => ({
          id,
          object: "model",
          created: 0,
          owned_by: "helix",
        })),
      }),
    );
  };
}
