import { describe, expect, it } from "vitest";
import {
  OpenAiChatRequestSchema,
  finishReasonFromStopReason,
  openAiContentToText,
  openAiMessagesToNeutral,
} from "./openai.js";

describe("openAiContentToText", () => {
  it("passes a string through", () => {
    expect(openAiContentToText("hello")).toBe("hello");
  });

  it("concatenates text parts and ignores non-text", () => {
    expect(
      openAiContentToText([
        { type: "text", text: "a" },
        { type: "image_url" },
        { type: "text", text: "b" },
      ]),
    ).toBe("ab");
  });
});

describe("openAiMessagesToNeutral", () => {
  it("hoists system + developer turns into a single system string", () => {
    const { system, messages } = openAiMessagesToNeutral([
      { role: "system", content: "one" },
      { role: "developer", content: "two" },
      { role: "user", content: "hi" },
    ]);
    expect(system).toBe("one\n\ntwo");
    expect(messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("drops tool turns and empty content", () => {
    const { messages } = openAiMessagesToNeutral([
      { role: "user", content: "hi" },
      { role: "tool", content: "result" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "there" },
    ]);
    expect(messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "there" },
    ]);
  });

  it("omits system entirely when there is none", () => {
    const out = openAiMessagesToNeutral([{ role: "user", content: "hi" }]);
    expect(out.system).toBeUndefined();
  });
});

describe("finishReasonFromStopReason", () => {
  it("maps Anthropic vocabulary to OpenAI finish_reason", () => {
    expect(finishReasonFromStopReason("max_tokens")).toBe("length");
    expect(finishReasonFromStopReason("tool_use")).toBe("tool_calls");
    expect(finishReasonFromStopReason("end_turn")).toBe("stop");
    expect(finishReasonFromStopReason("refusal")).toBe("stop");
  });
});

describe("OpenAiChatRequestSchema", () => {
  it("defaults stream to false and strips unknown fields", () => {
    const parsed = OpenAiChatRequestSchema.parse({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
    });
    expect(parsed.stream).toBe(false);
    expect(parsed).not.toHaveProperty("temperature");
  });

  it("rejects an empty message list", () => {
    expect(OpenAiChatRequestSchema.safeParse({ model: "m", messages: [] }).success).toBe(false);
  });
});
