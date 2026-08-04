import { describe, expect, it } from "vitest";
import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  costUsd,
  MODEL_PRICING,
  priceForModel,
  supportsStructuredOutputs,
} from "./pricing.js";

describe("pricing", () => {
  it("prices uncached input + output at the model's base rates", () => {
    // opus-4-8: $5/MTok in, $25/MTok out.
    const cost = costUsd({
      model: "claude-opus-4-8",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(5 + 25, 9);
  });

  it("prices cache reads at 0.1x and cache writes at 1.25x the base input rate", () => {
    const read = costUsd({
      model: "claude-opus-4-8",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 1_000_000,
    });
    expect(read).toBeCloseTo(5 * CACHE_READ_MULTIPLIER, 9); // $0.50

    const write = costUsd({
      model: "claude-opus-4-8",
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 1_000_000,
    });
    expect(write).toBeCloseTo(5 * CACHE_WRITE_MULTIPLIER, 9); // $6.25
  });

  it("treats absent cache counts as zero (no double-counting)", () => {
    const a = costUsd({ model: "claude-haiku-4-5", inputTokens: 500, outputTokens: 500 });
    const b = costUsd({
      model: "claude-haiku-4-5",
      inputTokens: 500,
      outputTokens: 500,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    expect(a).toBe(b);
  });

  it("contributes 0 for an unpriced model and reports it via priceForModel", () => {
    expect(
      costUsd({ model: "some-future-model", inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toBe(0);
    expect(priceForModel("some-future-model")).toBeUndefined();
    expect(priceForModel("claude-opus-4-8")).toEqual({
      inputPerMTok: 5,
      outputPerMTok: 25,
      provider: "anthropic",
      structuredOutputs: true,
    });
  });
});

describe("supportsStructuredOutputs (ADR-0034)", () => {
  // Pinned explicitly, negatives included: structured output is a per-model fact,
  // and a catalog edit must not silently flip a model on or off.
  const UNSUPPORTED = ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"];

  it("is false for models that cannot enforce a schema", () => {
    for (const model of UNSUPPORTED) {
      expect(priceForModel(model)).toBeDefined(); // still curated & callable
      expect(supportsStructuredOutputs(model)).toBe(false);
    }
  });

  it("is true for every other curated model", () => {
    const rest = Object.keys(MODEL_PRICING).filter((m) => !UNSUPPORTED.includes(m));
    expect(rest.length).toBeGreaterThan(0);
    for (const model of rest) expect(supportsStructuredOutputs(model)).toBe(true);
  });

  it("fails closed for an uncurated model", () => {
    expect(supportsStructuredOutputs("some-future-model")).toBe(false);
  });

  it("curates the current flagship models, which were missing entirely", () => {
    // Without these two, the newest schema-capable Anthropic models weren't
    // priced — so not curated, and not callable at all.
    for (const model of ["claude-opus-5", "claude-sonnet-5"]) {
      expect(priceForModel(model)).toBeDefined();
      expect(supportsStructuredOutputs(model)).toBe(true);
      // Not o-series: `reasoning` means "takes max_completion_tokens" here.
      expect(priceForModel(model)?.reasoning).toBeUndefined();
    }
    // List rates, not Sonnet 5's promotional $2/$10 — this table gates spend.
    expect(priceForModel("claude-sonnet-5")).toMatchObject({ inputPerMTok: 3, outputPerMTok: 15 });
  });
});
