/**
 * Model pricing — kept as code, applied at read time (architecture §6.1/§8).
 *
 * The `gateway_calls` ledger records token counts, not cost; cost is a pricing
 * decision that shifts independently of the data. We keep the rate table here in
 * `@helix/shared` and recompute dollars when the portal reads the ledger, so a
 * price change is a map edit + redeploy — and historical figures move to the
 * current rate (an "estimated spend at today's rates" model, not frozen billing).
 *
 * **Cache-aware:** Anthropic bills the three input-token classes at different
 * rates — uncached input at 1x, a cache *write* at 1.25x (5-minute TTL), a cache
 * *read* at ~0.1x. Collapsing them into one number makes spend wrong for
 * cache-heavy apps, so `costUsd` prices each class separately. (Cache counts are
 * 0 until prompt caching is enabled — see apps/edge/src/gateway/provider.ts.)
 */

/** Per-model base rates in USD per million tokens. */
export interface ModelPrice {
  /** USD per 1M uncached input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
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
 */
export const MODEL_PRICING: Record<string, ModelPrice> = {
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

/**
 * Per-model token limits — the context window (max input) and the max output
 * (completion) tokens. Kept alongside {@link MODEL_PRICING} (same keys) so the
 * catalog carries capability, not just price. Consumed by the builder's
 * `/v1/models` so a client (bolt.diy) advertises the real window instead of its
 * hardcoded default, and by the builder's per-model `max_tokens` clamp so an
 * over-large request is capped here rather than 400ing at the vendor.
 */
export interface ModelLimits {
  /** Max input tokens (context window). */
  contextWindow: number;
  /** Max output tokens per response. */
  maxOutputTokens: number;
}

export const MODEL_LIMITS: Record<string, ModelLimits> = {
  "claude-fable-5": { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  "claude-opus-4-8": { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  "claude-opus-4-7": { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  "claude-opus-4-6": { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  "claude-sonnet-4-6": { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  "claude-haiku-4-5": { contextWindow: 200_000, maxOutputTokens: 64_000 },
};

/** The output ceiling for a model; a safe default for anything uncatalogued. */
export function maxOutputTokensFor(model: string): number {
  return MODEL_LIMITS[model]?.maxOutputTokens ?? 128_000;
}

/** Cache-read tokens bill at ~0.1x the base input rate. */
export const CACHE_READ_MULTIPLIER = 0.1;
/** Cache-write tokens bill at 1.25x the base input rate (5-minute TTL — our default). */
export const CACHE_WRITE_MULTIPLIER = 1.25;

/** Look up the rate for a model; undefined when unpriced (UI flags rather than showing $0). */
export function priceForModel(model: string): ModelPrice | undefined {
  return MODEL_PRICING[model];
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
