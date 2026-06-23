import { describe, expect, it } from "vitest";
import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  costUsd,
  priceForModel,
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
    expect(priceForModel("claude-opus-4-8")).toEqual({ inputPerMTok: 5, outputPerMTok: 25 });
  });
});
