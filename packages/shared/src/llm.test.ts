import { describe, expect, it } from "vitest";
import { LlmChatRequestSchema, LlmChatResponseSchema, LlmStreamDoneSchema } from "./llm.js";

describe("LlmChatRequestSchema", () => {
  it("leaves maxTokens unset (each surface defaults it) and defaults stream", () => {
    const parsed = LlmChatRequestSchema.parse({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "hi" }],
    });
    // maxTokens is optional: Anthropic defaults it in its body builder, the
    // OpenAI surface omits the upstream cap (model max).
    expect(parsed.maxTokens).toBeUndefined();
    expect(parsed.stream).toBe(true);
    expect(parsed.system).toBeUndefined();
  });

  it("carries a system prompt and explicit knobs through", () => {
    const parsed = LlmChatRequestSchema.parse({
      model: "claude-opus-4-8",
      system: "You are terse.",
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
      maxTokens: 256,
      stream: false,
    });
    expect(parsed.system).toBe("You are terse.");
    expect(parsed.stream).toBe(false);
    expect(parsed.messages).toHaveLength(3);
  });

  it("rejects an empty message list and unknown roles", () => {
    expect(LlmChatRequestSchema.safeParse({ model: "m", messages: [] }).success).toBe(false);
    expect(
      LlmChatRequestSchema.safeParse({
        model: "m",
        messages: [{ role: "system", content: "x" }],
      }).success,
    ).toBe(false);
  });

  it("caps maxTokens at the model ceiling", () => {
    expect(
      LlmChatRequestSchema.safeParse({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        maxTokens: 200_000,
      }).success,
    ).toBe(false);
  });
});

describe("LlmChatResponseSchema / stream done", () => {
  it("round-trips a completion with usage", () => {
    const body = {
      model: "claude-opus-4-8",
      content: "hello",
      stopReason: "end_turn",
      usage: {
        inputTokens: 12,
        outputTokens: 3,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    };
    expect(LlmChatResponseSchema.parse(body)).toEqual(body);
    expect(
      LlmStreamDoneSchema.parse({
        stopReason: "end_turn",
        usage: { inputTokens: 12, outputTokens: 3 },
      }).usage.outputTokens,
    ).toBe(3);
  });
});
