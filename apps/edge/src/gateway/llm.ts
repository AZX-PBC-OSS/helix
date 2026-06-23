import type { FastifyReply, FastifyRequest } from "fastify";
import {
  LlmChatRequestSchema,
  LlmChatResponseSchema,
  costUsd,
  priceForModel,
  type ApiErrorCode,
  type LlmChatRequest,
  type LlmUsage,
} from "@helix/shared";
import type { EdgeConfig } from "../config.js";
import type { RegistryReader } from "../registry/projection.js";
import { ANON_USER_OID, type CallerResolver } from "../auth/gate.js";
import { resolveServingEntry } from "../auth/routes/appHost.js";
import { isSameOrigin } from "../auth/validate.js";
import { anonRateLimited, type IpRateLimiter } from "./ipRateLimiter.js";
import { LlmProviderError, type LlmProvider } from "./provider.js";
import type { GatewayOutcome, UsageStore } from "./usage.js";

/**
 * `POST /_api/llm/chat` — the gateway's LLM capability (architecture §6.1,
 * project plan §4 M4). The choke point that makes per-app blast-radius real:
 * it authenticates the user (session gate), proves the request came from the
 * app's own origin (CSRF — §4.2), enforces the per-app model allowlist and
 * daily spend budget from the manifest (§6.3), proxies to the vendor through
 * the `LlmProvider` seam (the app never sees the key), and meters every call.
 *
 * Quota is **block-new, finish-in-flight**: the budget is checked once at
 * admission; an admitted request always runs to completion, even if it pushes
 * the app over budget — the next request is the one that gets blocked.
 *
 * The budget is denominated in **USD**, not tokens, so the cap means the same
 * thing across models (a token cap is a 10× range of dollars between haiku and
 * fable-5). Two windows are checked off the frozen `costMicroUsd` ledger column:
 * a calendar-day cap (the cost control — bounds the daily bill) and a rolling
 * 1-hour burst cap at a fraction of it (an availability control — a single
 * actor can't drain the whole day in one spike and lock the app out for 24h).
 */

/**
 * Rolling-hour burst cap = `dollarsPerDay × BURST_BUDGET_FRACTION`. With the
 * divisor at 6, draining the daily budget takes at least 6 hours. This is an
 * availability knob (it does not change the worst-case daily spend); retune
 * freely. The 1-hour window length itself lives in the SQL (usage.ts).
 */
const BURST_WINDOW_DIVISOR = 6;
const BURST_BUDGET_FRACTION = 1 / BURST_WINDOW_DIVISOR;

export interface LlmGatewayRuntime {
  config: EdgeConfig;
  registry: RegistryReader;
  resolveCaller: CallerResolver;
  /** Per-IP limiter for the anonymous tier (public apps); null disables it. */
  anonLimiter: IpRateLimiter | null;
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
    // navigation-vs-fetch split and refresh-due 401 for /_api/*). On `public`
    // apps the caller is anonymous and the gate is skipped (app-data §6).
    const caller = await rt.resolveCaller(req, reply, entry);
    if (!caller) return;
    const userOid = caller.authenticated ? caller.oid : ANON_USER_OID;

    // Per-IP cap for the anonymous tier (public apps): an anonymous caller has
    // no per-user budget, so cap by IP (app-data design §7). Not metered — a
    // ledger row per throttled call is itself a write-amplification vector.
    if (anonRateLimited(rt.anonLimiter, req, entry, caller)) {
      sendApiError(reply, 429, "rate_limited", "per-IP request budget exhausted");
      return;
    }

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
    // Fail-safe: a model with no price can't be cost-gated, so refuse it rather
    // than serve it for free. The curated catalog == the priced catalog
    // (@helix/shared), so this only bites a model that slipped past curation.
    if (priceForModel(chat.model) === undefined) {
      sendApiError(
        reply,
        403,
        "model_not_allowed",
        `model "${chat.model}" has no price configured`,
      );
      return;
    }

    // Quota (block-new): if the app is already at/over its daily *or* rolling-
    // hour USD budget, refuse before sending anything upstream. An in-flight
    // request is never cut. Both windows read the frozen costMicroUsd column.
    const usage = rt.usage;
    const cap = entry.llm.dollarsPerDay;
    if (cap !== undefined) {
      const capMicro = cap * 1_000_000;
      const { todayMicro, hourMicro } = await usage.llmSpendMicroUsd(entry.appId);
      const overDay = todayMicro >= capMicro;
      const overBurst = hourMicro >= capMicro * BURST_BUDGET_FRACTION;
      if (overDay || overBurst) {
        await usage
          .record({
            appId: entry.appId,
            userOid,
            capability: "llm",
            model: chat.model,
            inputTokens: 0,
            outputTokens: 0,
            costMicroUsd: 0,
            outcome: "quota_blocked",
          })
          .catch(() => {});
        // Day cap is the harder stop ("done for the day"); prefer its message.
        if (overDay) {
          sendApiError(reply, 429, "quota_exceeded", "daily spend budget exhausted");
        } else {
          sendApiError(reply, 429, "rate_limited", "burst spend budget exhausted — retry shortly");
        }
        return;
      }
    }

    // Admitted. Abort the upstream if the client goes away.
    const abort = new AbortController();
    req.raw.on("close", () => abort.abort());

    const startedAt = performance.now();
    let recorded = false;
    let finalStopReason = "end_turn";
    const finalUsage: LlmUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    const recordOnce = async (
      outcome: GatewayOutcome,
      extra: { errorDetail?: string } = {},
    ): Promise<void> => {
      if (recorded) return;
      recorded = true;
      // Freeze the as-charged cost at write time (micro-USD) from the final
      // token counts + the requested model's current rate. This is what both
      // the spend gate and the portal dollar figures read back.
      const costMicroUsd = Math.round(costUsd({ model: chat.model, ...finalUsage }) * 1_000_000);
      await usage
        .record({
          appId: entry.appId,
          userOid,
          capability: "llm",
          model: chat.model,
          inputTokens: finalUsage.inputTokens,
          outputTokens: finalUsage.outputTokens,
          cacheReadInputTokens: finalUsage.cacheReadInputTokens,
          cacheCreationInputTokens: finalUsage.cacheCreationInputTokens,
          costMicroUsd,
          outcome,
          durationMs: Math.round(performance.now() - startedAt),
          // LLM streams over a 200; the stop reason is the useful signal here.
          stopReason: finalStopReason,
          errorDetail: extra.errorDetail ?? null,
        })
        .catch((err: unknown) => req.log.warn({ err }, "gateway usage record failed"));
    };

    const events = rt.provider.stream(chat, { signal: abort.signal });

    if (chat.stream) {
      let started = false;
      try {
        for await (const ev of events) {
          if (ev.type === "delta") {
            if (!started) {
              startSse(reply);
              started = true;
            }
            writeSseEvent(reply, "delta", { text: ev.text });
          } else {
            Object.assign(finalUsage, ev.usage);
            finalStopReason = ev.stopReason;
          }
        }
        if (!started) startSse(reply);
        writeSseEvent(reply, "done", { stopReason: finalStopReason, usage: finalUsage });
        reply.raw.end();
        await recordOnce(outcomeFor(finalStopReason));
      } catch (err) {
        await recordOnce("error", { errorDetail: errorDetailOf(err) });
        const { code, message } = describeError(err);
        if (!started) startSse(reply);
        writeSseEvent(reply, "error", { code, message });
        reply.raw.end();
      }
      return;
    }

    // Non-streaming: accumulate into a single JSON body.
    let content = "";
    try {
      for await (const ev of events) {
        if (ev.type === "delta") content += ev.text;
        else {
          Object.assign(finalUsage, ev.usage);
          finalStopReason = ev.stopReason;
        }
      }
      await recordOnce(outcomeFor(finalStopReason));
      await reply.header("cache-control", "no-store").send(
        LlmChatResponseSchema.parse({
          model: chat.model,
          content,
          stopReason: finalStopReason,
          usage: finalUsage,
        }),
      );
    } catch (err) {
      await recordOnce("error", { errorDetail: errorDetailOf(err) });
      const { code, message } = describeError(err);
      // 502 for upstream failures; the code stays within the shared set.
      sendApiError(reply, 502, code, message);
    }
  };
}

/** A clean completion whose stop reason is a refusal meters as `refusal`, not `ok`. */
function outcomeFor(stopReason: string): GatewayOutcome {
  return stopReason === "refusal" ? "refusal" : "ok";
}

/** Truncated upstream error string for the audit ledger (internal-only, not app-facing). */
function errorDetailOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}

/** Map a provider/abort failure to a stable code + safe message. */
function describeError(err: unknown): { code: ApiErrorCode; message: string } {
  if (err instanceof LlmProviderError) {
    return { code: "internal", message: "upstream LLM request failed" };
  }
  return { code: "internal", message: "LLM request failed" };
}
