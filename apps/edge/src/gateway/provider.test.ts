import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { MockAgent } from "undici";
import {
  AnthropicProvider,
  LlmProviderError,
  mapAnthropicStream,
  type LlmStreamEvent,
} from "./provider.js";

/**
 * The Anthropic provider's request translation + SSE parsing, exercised against
 * undici's MockAgent (no network). The real-vendor streaming check at the
 * bottom runs only when ANTHROPIC_API_KEY is set (project plan §4: "verify
 * streaming against a real vendor").
 */

const ENDPOINT = "https://api.anthropic.com";

/** A minimal but realistic Anthropic Messages SSE transcript. */
const SSE = [
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 11, output_tokens: 0 } } })}`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } })}`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: " world" } })}`,
  `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } })}`,
  `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
  "",
].join("\n\n");

async function collect(events: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

describe("AnthropicProvider (mocked upstream)", () => {
  it("translates the request and parses the SSE into neutral events", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(ENDPOINT);

    let seenBody: Record<string, unknown> = {};
    let seenApiKey: string | undefined;
    let seenVersion: string | undefined;
    pool.intercept({ path: "/v1/messages", method: "POST" }).reply(
      200,
      (opts) => {
        seenBody = JSON.parse(String(opts.body)) as Record<string, unknown>;
        const h = opts.headers as Record<string, string>;
        seenApiKey = h["x-api-key"];
        seenVersion = h["anthropic-version"];
        return SSE;
      },
      { headers: { "content-type": "text/event-stream" } },
    );

    const provider = new AnthropicProvider({
      endpoint: ENDPOINT,
      anthropicVersion: "2023-06-01",
      apiKey: "sk-ant-test",
      dispatcher: pool,
    });

    const events = await collect(
      provider.stream(
        {
          model: "claude-opus-4-8",
          system: "be terse",
          messages: [{ role: "user", content: "hi" }],
          maxTokens: 256,
          stream: true,
        },
        {
          signal: new AbortController().signal,
          appId: "app-1",
          userOid: "u-1",
          requestId: "r-1",
          env: "prod",
        },
      ),
    );

    // Request translation: neutral → Anthropic Messages.
    expect(seenBody).toMatchObject({
      model: "claude-opus-4-8",
      max_tokens: 256,
      system: "be terse",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(seenApiKey).toBe("sk-ant-test");
    expect(seenVersion).toBe("2023-06-01");

    // SSE → neutral events: deltas in order, then a done with summed usage.
    expect(events).toEqual([
      { type: "delta", text: "Hello" },
      { type: "delta", text: " world" },
      {
        type: "done",
        stopReason: "end_turn",
        usage: {
          inputTokens: 11,
          outputTokens: 4,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    ]);
  });

  it("throws LlmProviderError on a non-200 upstream", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(ENDPOINT);
    pool
      .intercept({ path: "/v1/messages", method: "POST" })
      .reply(401, JSON.stringify({ type: "error", error: { message: "bad key" } }));

    const provider = new AnthropicProvider({
      endpoint: ENDPOINT,
      anthropicVersion: "2023-06-01",
      apiKey: "sk-ant-test",
      dispatcher: pool,
    });

    await expect(
      collect(
        provider.stream(
          {
            model: "claude-opus-4-8",
            messages: [{ role: "user", content: "hi" }],
            maxTokens: 16,
            stream: true,
          },
          {
            signal: new AbortController().signal,
            appId: "app-1",
            userOid: "u-1",
            requestId: "r-1",
            env: "prod",
          },
        ),
      ),
    ).rejects.toBeInstanceOf(LlmProviderError);
  });
});

describe("SSE parser hardening (issue #12)", () => {
  // café + an emoji: exercises multibyte UTF-8 (2- and 4-byte codepoints).
  const TEXT = "café😀";

  /** A complete Anthropic transcript whose line terminator is `nl`. */
  function buildSse(nl: string): string {
    const records = [
      [
        "event: message_start",
        `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 0 } } })}`,
      ],
      [
        "event: content_block_delta",
        `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: TEXT } })}`,
      ],
      [
        "event: message_delta",
        `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })}`,
      ],
      ["event: message_stop", `data: ${JSON.stringify({ type: "message_stop" })}`],
    ];
    return records.map((r) => r.join(nl)).join(nl + nl) + nl + nl;
  }

  const collectText = (events: LlmStreamEvent[]) =>
    events
      .filter((e): e is { type: "delta"; text: string } => e.type === "delta")
      .map((e) => e.text)
      .join("");

  it("frames a CRLF-delimited stream (LF-only splitting would yield nothing)", async () => {
    const body = Readable.from([Buffer.from(buildSse("\r\n"), "utf8")]);
    const events = await collect(mapAnthropicStream(body));

    expect(collectText(events)).toBe(TEXT); // no trailing \r leaked into the payload
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "end_turn" });
  });

  it("reassembles a multibyte codepoint split across a chunk boundary", async () => {
    const full = Buffer.from(buildSse("\n"), "utf8");
    // Split inside the emoji's 4-byte sequence — a per-chunk toString('utf8')
    // would decode replacement chars on both sides.
    const emojiAt = full.indexOf(Buffer.from("😀", "utf8"));
    expect(emojiAt).toBeGreaterThan(0);
    const body = Readable.from([full.subarray(0, emojiAt + 2), full.subarray(emojiAt + 2)]);

    const events = await collect(mapAnthropicStream(body));
    expect(collectText(events)).toBe(TEXT);
  });

  it("destroys a separator-less stream once it exceeds the buffer cap", async () => {
    async function* neverSeparates() {
      // >1 MiB of data with no blank-line record separator.
      for (let i = 0; i < 20; i++) yield Buffer.from("x".repeat(64 * 1024), "utf8");
    }
    const body = Readable.from(neverSeparates());

    await expect(collect(mapAnthropicStream(body))).rejects.toBeInstanceOf(LlmProviderError);
  });
});

describe("AnthropicProvider (real vendor)", () => {
  const key = process.env.ANTHROPIC_API_KEY;
  it.skipIf(!key)("streams a real completion end to end", async () => {
    const provider = new AnthropicProvider({
      endpoint: ENDPOINT,
      anthropicVersion: "2023-06-01",
      apiKey: key as string,
    });
    try {
      const events = await collect(
        provider.stream(
          {
            model: "claude-opus-4-8",
            messages: [{ role: "user", content: "Reply with exactly: pong" }],
            maxTokens: 16,
            stream: true,
          },
          {
            signal: new AbortController().signal,
            appId: "app-1",
            userOid: "u-1",
            requestId: "r-1",
            env: "prod",
          },
        ),
      );
      const text = events
        .filter((e): e is { type: "delta"; text: string } => e.type === "delta")
        .map((e) => e.text)
        .join("");
      const done = events.find((e) => e.type === "done");
      expect(text.toLowerCase()).toContain("pong");
      expect(done).toMatchObject({ usage: { outputTokens: expect.any(Number) } });
    } finally {
      await provider.close();
    }
  });
});
