import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import { Pool, type Dispatcher } from "undici";
import type { Env, LlmChatRequest, LlmUsage } from "@azx-pbc/shared";

/**
 * The `LlmProvider` seam (architecture §6.1, project plan §4 M4). The gateway
 * handler is vendor-agnostic — it speaks the neutral `LlmChatRequest`/event
 * shape and lets the provider translate. Anthropic is the only member in M4;
 * Azure OpenAI etc. become new implementations behind this interface.
 *
 * Every provider streams: it yields `delta` events as text arrives and a final
 * `done` event carrying the stop reason and token usage (the basis for
 * metering). The handler relays those as SSE for streaming clients or
 * accumulates them into a single JSON body otherwise — one code path either way.
 */
export type LlmStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; stopReason: string; usage: LlmUsage };

/**
 * Per-call context the handler hands every provider. `signal` aborts the
 * upstream when the client goes away; `appId`/`userOid`/`requestId` are the
 * attribution a routing provider (`EgressLlmProvider`) needs to mint an attested
 * instruction. The direct {@link AnthropicProvider} ignores the attribution.
 */
export interface LlmStreamOpts {
  signal: AbortSignal;
  appId: string;
  userOid: string;
  requestId: string;
  /**
   * Partition tier (dev-mode design §6). The routing (egress) provider stamps it
   * into the attested instruction so egress env-scopes secret resolution; the
   * direct provider ignores it. Defaults to `prod` on every production path.
   */
  env: Env;
}

export interface LlmProvider {
  stream(req: LlmChatRequest, opts: LlmStreamOpts): AsyncIterable<LlmStreamEvent>;
  close(): Promise<void>;
}

/** The Anthropic Messages request body (always streamed). Shared by both providers. */
export function anthropicRequestBody(req: LlmChatRequest): string {
  return JSON.stringify({
    model: req.model,
    max_tokens: req.maxTokens,
    messages: req.messages,
    ...(req.system ? { system: req.system } : {}),
    stream: true,
  });
}

/**
 * Map an Anthropic SSE response body to the neutral `delta`/`done` event stream.
 * Shared by the direct provider and the egress-routed one — the parsing is the
 * same whether the bytes came straight from the vendor or relayed through egress.
 */
export async function* mapAnthropicStream(body: Readable): AsyncIterable<LlmStreamEvent> {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let stopReason = "end_turn";

  for await (const { data } of parseSse(body)) {
    let event: AnthropicEvent;
    try {
      event = JSON.parse(data) as AnthropicEvent;
    } catch {
      continue; // ignore non-JSON keepalives/comments
    }
    switch (event.type) {
      case "message_start":
        // `input_tokens` is the uncached remainder; cache classes are separate
        // (0 today — we send no cache_control yet).
        inputTokens = event.message?.usage?.input_tokens ?? 0;
        outputTokens = event.message?.usage?.output_tokens ?? 0;
        cacheReadInputTokens = event.message?.usage?.cache_read_input_tokens ?? 0;
        cacheCreationInputTokens = event.message?.usage?.cache_creation_input_tokens ?? 0;
        break;
      case "content_block_delta":
        if (event.delta?.type === "text_delta" && event.delta.text) {
          yield { type: "delta", text: event.delta.text };
        }
        break;
      case "message_delta":
        if (event.usage?.output_tokens != null) outputTokens = event.usage.output_tokens;
        if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
        break;
      case "error":
        throw new LlmProviderError(`anthropic stream error: ${event.error?.message ?? "unknown"}`);
      case "message_stop":
        yield {
          type: "done",
          stopReason,
          usage: { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens },
        };
        return;
    }
  }
  // Stream ended without an explicit message_stop — emit what we have.
  yield {
    type: "done",
    stopReason,
    usage: { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens },
  };
}

/** A provider call that failed upstream — the handler maps it to an error response. */
export class LlmProviderError extends Error {
  /** HTTP status from the vendor, if the failure was an HTTP response. */
  readonly upstreamStatus?: number;
  constructor(message: string, upstreamStatus?: number) {
    super(message);
    this.name = "LlmProviderError";
    this.upstreamStatus = upstreamStatus;
  }
}

export interface AnthropicProviderConfig {
  /** Origin only (no path), e.g. `https://api.anthropic.com`. */
  endpoint: string;
  /** `anthropic-version` header value, e.g. `2023-06-01`. */
  anthropicVersion: string;
  /**
   * Vendor key, injected at construction. This class is retained for its unit
   * tests only — it is NOT selected at runtime (the edge never holds the vendor
   * key; the LLM call routes through egress). See `server.ts` / ADR-0008.
   */
  apiKey: string;
  /** Inject a dispatcher (tests use undici's MockAgent); default is an owned Pool. */
  dispatcher?: Dispatcher;
}

/**
 * Anthropic Messages provider. Streams over **undici** with a hand-built
 * request — deliberately NOT the `@anthropic-ai/sdk`: the edge is the trusted
 * path and dependency-minimal (CLAUDE.md, project plan §6), the same reason the
 * blob reader hand-rolls undici instead of the Azure SDK. It always requests
 * `stream: true` upstream and parses the SSE; the handler decides how to relay.
 */
export class AnthropicProvider implements LlmProvider {
  readonly #dispatcher: Dispatcher;
  readonly #ownsDispatcher: boolean;
  readonly #config: AnthropicProviderConfig;

  constructor(config: AnthropicProviderConfig) {
    this.#config = config;
    this.#dispatcher = config.dispatcher ?? new Pool(new URL(config.endpoint).origin);
    this.#ownsDispatcher = config.dispatcher === undefined;
  }

  async *stream(req: LlmChatRequest, opts: LlmStreamOpts): AsyncIterable<LlmStreamEvent> {
    const res = await this.#dispatcher.request({
      origin: new URL(this.#config.endpoint).origin,
      method: "POST",
      path: "/v1/messages",
      signal: opts.signal,
      headers: {
        "x-api-key": this.#config.apiKey,
        "anthropic-version": this.#config.anthropicVersion,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: anthropicRequestBody(req),
    });

    if (res.statusCode !== 200) {
      const text = await res.body.text();
      throw new LlmProviderError(
        `anthropic responded ${res.statusCode}: ${truncate(text)}`,
        res.statusCode,
      );
    }

    yield* mapAnthropicStream(res.body);
  }

  async close(): Promise<void> {
    if (this.#ownsDispatcher) await this.#dispatcher.close();
  }
}

/** The Anthropic SSE event shapes we read (others are ignored). */
interface AnthropicEvent {
  type: string;
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  delta?: { type?: string; text?: string; stop_reason?: string };
  usage?: { output_tokens?: number };
  error?: { message?: string };
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Ceiling on a single unterminated SSE record. An upstream that never emits the
 * record separator would otherwise grow the buffer without bound (memory
 * pressure on the edge — issue #12). Anthropic events are tiny (a text delta or
 * a usage object), so 1 MiB is orders of magnitude of headroom; past it we treat
 * the stream as hostile and destroy it.
 */
const MAX_SSE_BUFFER_BYTES = 1024 * 1024;

/** Blank-line record separator in any of the SSE spec's line terminators. */
const SSE_RECORD_SEP = /\r\n\r\n|\r\r|\n\n/;
/** Line terminator: CRLF, bare CR, or LF (WHATWG event-stream §9.2.4). */
const SSE_LINE_SEP = /\r\n|\r|\n/;

/**
 * Minimal SSE parser over a Node Readable: yields `{ event, data }` per record
 * (records separated by a blank line, `data:` lines concatenated). Enough for
 * the Anthropic stream; not a general SSE implementation.
 *
 * Hardened per issue #12: framing handles CRLF / bare-CR (not just LF), chunks
 * are decoded through a {@link StringDecoder} so a multibyte codepoint split
 * across a chunk boundary is not corrupted, and the record buffer is byte-capped
 * so a separator-less upstream cannot grow it without bound.
 */
async function* parseSse(body: Readable): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new StringDecoder("utf8");
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.write(chunk as Buffer);
    let m: RegExpExecArray | null;
    while ((m = SSE_RECORD_SEP.exec(buf)) !== null) {
      const record = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      yield parseRecord(record);
    }
    if (Buffer.byteLength(buf, "utf8") > MAX_SSE_BUFFER_BYTES) {
      body.destroy();
      throw new LlmProviderError(
        `SSE record exceeded ${MAX_SSE_BUFFER_BYTES} bytes without a separator`,
      );
    }
  }
  buf += decoder.end();
  if (buf.trim() !== "") yield parseRecord(buf);
}

function parseRecord(record: string): { event: string; data: string } {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of record.split(SSE_LINE_SEP)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  return { event, data: dataLines.join("\n") };
}
