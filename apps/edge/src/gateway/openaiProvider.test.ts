import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { LlmChatRequest } from "@azx-pbc/shared";
import {
  LlmProviderError,
  mapOpenAiStream,
  openAiRequestBody,
  type LlmProvider,
  type LlmStreamEvent,
  type LlmStreamOpts,
} from "./provider.js";
import { RoutingLlmProvider } from "./routingLlmProvider.js";

const OPTS: LlmStreamOpts = {
  signal: new AbortController().signal,
  appId: "app-1",
  userOid: "user-1",
  requestId: "req-1",
  env: "prod",
};

function req(over: Partial<LlmChatRequest> = {}): LlmChatRequest {
  return {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 256,
    stream: true,
    ...over,
  };
}

async function collect(events: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

describe("openAiRequestBody", () => {
  it("hoists system into a leading system message and uses max_tokens for chat models", () => {
    const body = JSON.parse(openAiRequestBody(req({ system: "be terse" })));
    expect(body.messages[0]).toEqual({ role: "system", content: "be terse" });
    expect(body.messages[1]).toEqual({ role: "user", content: "hi" });
    expect(body.max_tokens).toBe(256);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("uses max_completion_tokens for o-series reasoning models", () => {
    const body = JSON.parse(openAiRequestBody(req({ model: "o4-mini" })));
    expect(body.max_completion_tokens).toBe(256);
    expect(body.max_tokens).toBeUndefined();
  });
});

describe("mapOpenAiStream", () => {
  const chunk = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;

  it("maps content deltas + usage to neutral events, ignoring [DONE]", async () => {
    const sse =
      chunk({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }) +
      chunk({ choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] }) +
      chunk({ choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }] }) +
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      // completion_tokens already folds in reasoning tokens — used verbatim.
      chunk({
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 7,
          completion_tokens_details: { reasoning_tokens: 3 },
        },
      }) +
      "data: [DONE]\n\n";

    const events = await collect(mapOpenAiStream(Readable.from([Buffer.from(sse)])));
    expect(events).toEqual([
      { type: "delta", text: "Hello" },
      { type: "delta", text: " world" },
      {
        type: "done",
        stopReason: "end_turn",
        usage: {
          inputTokens: 10,
          outputTokens: 7,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    ]);
  });

  it("maps finish_reason length -> max_tokens and content_filter -> refusal", async () => {
    for (const [finish, stopReason] of [
      ["length", "max_tokens"],
      ["content_filter", "refusal"],
    ] as const) {
      const sse =
        chunk({ choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }] }) +
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: finish }] }) +
        "data: [DONE]\n\n";
      const events = await collect(mapOpenAiStream(Readable.from([Buffer.from(sse)])));
      const done = events.at(-1);
      expect(done?.type === "done" && done.stopReason).toBe(stopReason);
    }
  });

  it("throws on an in-band error object", async () => {
    const sse = `data: ${JSON.stringify({ error: { message: "bad" } })}\n\n`;
    await expect(
      collect(mapOpenAiStream(Readable.from([Buffer.from(sse)]))),
    ).rejects.toBeInstanceOf(LlmProviderError);
  });
});

describe("RoutingLlmProvider", () => {
  class Recorder implements LlmProvider {
    calls: string[] = [];
    async *stream(r: LlmChatRequest): AsyncIterable<LlmStreamEvent> {
      this.calls.push(r.model);
      yield {
        type: "done",
        stopReason: "end_turn",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      };
    }
    async close(): Promise<void> {}
  }

  it("reports support only for families it has an upstream for", () => {
    const both = new RoutingLlmProvider({ anthropic: new Recorder(), openai: new Recorder() });
    expect(both.supports("claude-opus-4-8")).toBe(true);
    expect(both.supports("gpt-4o")).toBe(true);
    expect(both.supports("not-a-model")).toBe(false);

    const anthropicOnly = new RoutingLlmProvider({ anthropic: new Recorder(), openai: null });
    expect(anthropicOnly.supports("claude-opus-4-8")).toBe(true);
    expect(anthropicOnly.supports("gpt-4o")).toBe(false);
  });

  it("dispatches each model to its family upstream", async () => {
    const anthropic = new Recorder();
    const openai = new Recorder();
    const routing = new RoutingLlmProvider({ anthropic, openai });
    await collect(routing.stream(req({ model: "claude-opus-4-8" }), OPTS));
    await collect(routing.stream(req({ model: "gpt-4o" }), OPTS));
    expect(anthropic.calls).toEqual(["claude-opus-4-8"]);
    expect(openai.calls).toEqual(["gpt-4o"]);
  });

  it("throws a 503-shaped error when the family upstream is missing", async () => {
    const routing = new RoutingLlmProvider({ anthropic: new Recorder(), openai: null });
    await expect(collect(routing.stream(req({ model: "gpt-4o" }), OPTS))).rejects.toMatchObject({
      upstreamStatus: 503,
    });
  });
});
