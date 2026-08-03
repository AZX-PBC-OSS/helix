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

describe("responseFormat (structured output, ADR-0034)", () => {
  const SCHEMA = { type: "object", properties: { a: { type: "string" } } };
  const req = (responseFormat: unknown) => ({
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "hi" }],
    responseFormat,
  });

  it("is absent by default, so an existing request parses unchanged", () => {
    const parsed = LlmChatRequestSchema.parse({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(parsed.responseFormat).toBeUndefined();
  });

  it("accepts a json_schema", () => {
    const parsed = LlmChatRequestSchema.parse(req({ type: "json_schema", schema: SCHEMA }));
    expect(parsed.responseFormat).toEqual({ type: "json_schema", schema: SCHEMA });
  });

  it("carries an explicit name through", () => {
    const parsed = LlmChatRequestSchema.parse(
      req({ type: "json_schema", name: "my_shape-1", schema: SCHEMA }),
    );
    expect(parsed.responseFormat?.name).toBe("my_shape-1");
  });

  it("has no strict knob — enforcement is unconditional (ADR-0034)", () => {
    // Anthropic has no best-effort mode, so a strict:false could only be honored
    // on one vendor. zod strips the unknown key rather than carrying a lie.
    const parsed = LlmChatRequestSchema.parse(
      req({ type: "json_schema", schema: SCHEMA, strict: false }),
    );
    expect(parsed.responseFormat).not.toHaveProperty("strict");
  });

  it("rejects a name with characters the vendors disallow", () => {
    expect(
      LlmChatRequestSchema.safeParse(
        req({ type: "json_schema", name: "bad name!", schema: SCHEMA }),
      ).success,
    ).toBe(false);
  });

  it("rejects a mode other than json_schema", () => {
    expect(LlmChatRequestSchema.safeParse(req({ type: "json_object" })).success).toBe(false);
  });

  it("rejects a schema whose root is not an object", () => {
    for (const root of [{ type: "string" }, { type: "array", items: {} }, {}]) {
      expect(
        LlmChatRequestSchema.safeParse(req({ type: "json_schema", schema: root })).success,
      ).toBe(false);
    }
  });

  it("rejects a schema over the size cap", () => {
    // One fat property: well past 32k serialized, but shallow.
    const fat = { type: "object", properties: { a: { description: "x".repeat(40_000) } } };
    expect(LlmChatRequestSchema.safeParse(req({ type: "json_schema", schema: fat })).success).toBe(
      false,
    );
  });

  it("allows a realistically nested schema but rejects a pathological one", () => {
    // Each wrap adds two levels (the `properties` map, then its value), so a few
    // wraps is an ordinary nested object and 40 is a depth-bomb.
    const nest = (wraps: number): Record<string, unknown> => {
      let node: Record<string, unknown> = { type: "object" };
      for (let i = 0; i < wraps; i++) node = { type: "object", properties: { a: node } };
      return node;
    };
    expect(
      LlmChatRequestSchema.safeParse(req({ type: "json_schema", schema: nest(3) })).success,
    ).toBe(true);
    expect(
      LlmChatRequestSchema.safeParse(req({ type: "json_schema", schema: nest(40) })).success,
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
