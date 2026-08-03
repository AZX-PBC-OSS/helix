/**
 * Model pricing — kept as code, applied at read time (architecture §6.1/§8).
 *
 * The `gateway_calls` ledger records token counts, not cost; cost is a pricing
 * decision that shifts independently of the data. We keep the rate table here in
 * `@azx-pbc/shared` and recompute dollars when the portal reads the ledger, so a
 * price change is a map edit + redeploy — and historical figures move to the
 * current rate (an "estimated spend at today's rates" model, not frozen billing).
 *
 * **Cache-aware:** Anthropic bills the three input-token classes at different
 * rates — uncached input at 1x, a cache *write* at 1.25x (5-minute TTL), a cache
 * *read* at ~0.1x. Collapsing them into one number makes spend wrong for
 * cache-heavy apps, so `costUsd` prices each class separately. (Cache counts are
 * 0 until prompt caching is enabled — see apps/edge/src/gateway/provider.ts.)
 */

/**
 * Which upstream serves a model. This is the single source of truth for
 * **routing** as well as pricing: the edge's `RoutingLlmProvider` picks the
 * vendor from this field (`providerForModel`), so the two can never disagree.
 */
export type ModelProvider = "anthropic" | "openai";

/** Per-model base rates in USD per million tokens. */
export interface ModelPrice {
  /** USD per 1M uncached input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
  /** Upstream that serves this model (routing + pricing share this fact). */
  provider: ModelProvider;
  /**
   * OpenAI "reasoning" models (o-series): they take `max_completion_tokens`
   * (not `max_tokens`) and reject a non-default `temperature`. The OpenAI request
   * builder branches on this. Absent ⇒ a normal chat model.
   */
  reasoning?: boolean;
  /**
   * Floor for a reasoning model's `max_completion_tokens`. That budget covers
   * reasoning **and** visible output combined, so a small value can be spent
   * entirely on thinking and return empty (billed) content. The OpenAI builder
   * applies `max(requested ?? floor, floor)` so visible output always has room.
   * Only meaningful with `reasoning: true`.
   */
  minCompletionTokens?: number;
  /**
   * Server-enforced JSON-schema output (ADR-0034). Absent ⇒ the gateway refuses a
   * `responseFormat` request for this model with a 400 rather than letting the
   * upstream reject it. Not uniform across either vendor's line-up, so it is a
   * per-model fact rather than a per-provider one.
   */
  structuredOutputs?: boolean;
}

/**
 * Current catalog rates (USD / 1M tokens). Update here on a pricing change and
 * redeploy. Keys are the exact model ids apps request.
 *
 * This table is also the **authoritative curated-model catalog**: `approval.ts`
 * derives `CURATED_LLM_MODELS` from these keys, so "priced" and "curated" are
 * one set and can't drift. Adding a model to the platform = adding it here with
 * a price; an unpriced model is, by construction, neither curated nor callable
 * (the edge refuses it — see `apps/edge/src/gateway/llm.ts`).
 *
 * The `provider` field also drives model→upstream routing. There is no id-space
 * overlap between the `claude-*` and `gpt-*`/`o*` families, so a flat table is
 * unambiguous.
 *
 * NOTE (OpenAI rates): the numbers below are seeded from OpenAI's published
 * per-1M-token list prices and **must be re-verified against OpenAI's current
 * pricing before relying on them for billing** — OpenAI reprices periodically
 * (o-series especially). The `costUsd` cache multipliers below are Anthropic
 * cache semantics; the OpenAI path reports 0 cache tokens today, so they don't
 * apply to `gpt-*`/`o*`.
 */
export const MODEL_PRICING: Record<string, ModelPrice> = {
  // Anthropic. NB `structuredOutputs` is deliberately absent on 4-7/4-6/sonnet-4-6:
  // structured outputs are supported on Fable 5, Opus 4.8 and Haiku 4.5 but not on
  // those three, so the flag is opt-in per model rather than per provider.
  "claude-fable-5": {
    inputPerMTok: 10,
    outputPerMTok: 50,
    provider: "anthropic",
    structuredOutputs: true,
  },
  "claude-opus-4-8": {
    inputPerMTok: 5,
    outputPerMTok: 25,
    provider: "anthropic",
    structuredOutputs: true,
  },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25, provider: "anthropic" },
  "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25, provider: "anthropic" },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15, provider: "anthropic" },
  "claude-haiku-4-5": {
    inputPerMTok: 1,
    outputPerMTok: 5,
    provider: "anthropic",
    structuredOutputs: true,
  },
  // OpenAI — VERIFY against current published rates before production billing.
  // Every model here resolves to a snapshot new enough for `response_format`
  // json_schema, so `structuredOutputs` is set across the board.
  "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10, provider: "openai", structuredOutputs: true },
  "gpt-4o-mini": {
    inputPerMTok: 0.15,
    outputPerMTok: 0.6,
    provider: "openai",
    structuredOutputs: true,
  },
  "gpt-4.1": { inputPerMTok: 2, outputPerMTok: 8, provider: "openai", structuredOutputs: true },
  "gpt-4.1-mini": {
    inputPerMTok: 0.4,
    outputPerMTok: 1.6,
    provider: "openai",
    structuredOutputs: true,
  },
  "gpt-4.1-nano": {
    inputPerMTok: 0.1,
    outputPerMTok: 0.4,
    provider: "openai",
    structuredOutputs: true,
  },
  o3: {
    inputPerMTok: 2,
    outputPerMTok: 8,
    provider: "openai",
    reasoning: true,
    minCompletionTokens: 25_000,
    structuredOutputs: true,
  },
  "o4-mini": {
    inputPerMTok: 1.1,
    outputPerMTok: 4.4,
    provider: "openai",
    reasoning: true,
    minCompletionTokens: 25_000,
    structuredOutputs: true,
  },
};

/** Cache-read tokens bill at ~0.1x the base input rate. */
export const CACHE_READ_MULTIPLIER = 0.1;
/** Cache-write tokens bill at 1.25x the base input rate (5-minute TTL — our default). */
export const CACHE_WRITE_MULTIPLIER = 1.25;

/** Look up the rate for a model; undefined when unpriced (UI flags rather than showing $0). */
export function priceForModel(model: string): ModelPrice | undefined {
  return MODEL_PRICING[model];
}

/**
 * The upstream that serves a model, or undefined when the model is not in the
 * catalog. The edge routes on this (`RoutingLlmProvider`); an unknown model has
 * no provider and is refused before it can reach any upstream.
 */
export function providerForModel(model: string): ModelProvider | undefined {
  return MODEL_PRICING[model]?.provider;
}

/**
 * Whether `model` can enforce a JSON-schema response (ADR-0034). False for an
 * unknown model, so the gateway fails closed: an uncurated model is refused by
 * the price lookup first, and never reaches an upstream with a `responseFormat`.
 */
export function supportsStructuredOutputs(model: string): boolean {
  return MODEL_PRICING[model]?.structuredOutputs === true;
}

/**
 * Cost in USD for one call's (or one aggregated bucket's) token counts. The
 * three input classes are priced independently; `inputTokens` is the *uncached*
 * remainder (as Anthropic reports it), so there is no double-counting. Unknown
 * models contribute 0 — pair with {@link priceForModel} when you need to flag them.
 */
export function costUsd(input: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}): number {
  const price = MODEL_PRICING[input.model];
  if (!price) return 0;
  const perInputTok = price.inputPerMTok / 1_000_000;
  const perOutputTok = price.outputPerMTok / 1_000_000;
  return (
    input.inputTokens * perInputTok +
    input.outputTokens * perOutputTok +
    (input.cacheReadInputTokens ?? 0) * perInputTok * CACHE_READ_MULTIPLIER +
    (input.cacheCreationInputTokens ?? 0) * perInputTok * CACHE_WRITE_MULTIPLIER
  );
}
