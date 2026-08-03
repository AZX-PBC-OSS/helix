import type { FastifyReply, FastifyRequest } from "fastify";
import { OpenAiModelListSchema } from "@azx-pbc/shared";
import { resolveServingEntry } from "../auth/routes/appHost.js";
import type { LlmGatewayRuntime } from "./llm.js";

/**
 * `GET /_api/openai/v1/models` — the app's own allowlisted models in OpenAI list
 * shape, so stock OpenAI clients/tools that enumerate models work. Session-gated
 * (a read, so no Origin/CSRF check — same posture as `/_api/me`); reflects the
 * per-app manifest allowlist, never the platform catalog.
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

    const models = entry.llm?.models ?? [];
    reply.header("cache-control", "no-store").send(
      OpenAiModelListSchema.parse({
        object: "list",
        data: models.map((id) => ({ id, object: "model", owned_by: "helix" })),
      }),
    );
  };
}
