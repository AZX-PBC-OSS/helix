import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import { Pool, type Dispatcher } from "undici";
import { priceForModel, type Env, type LlmChatRequest, type LlmUsage } from "@azx-pbc/shared";

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
  /**
   * Whether this provider can serve `model`. Optional — a single-vendor provider
   * serves whatever the handler already allowed and omits it. A routing provider
   * implements it so the handler can 503 a curated model whose upstream isn't
   * wired on this edge, *before* opening a stream. Absent ⇒ assume yes.
   */
  supports?(model: string): boolean;
  close(): Promise<void>;
}

/**
 * Default output cap when the client omits `maxTokens`. Anthropic Messages
 * *requires* `max_tokens`, so the neutral shape's optional field is defaulted
 * here — this keeps the native `/_api/llm/chat` behaviour unchanged for Claude.
 */
const DEFAULT_MAX_TOKENS = 1024;

/** The Anthropic Messages request body (always streamed). Shared by both providers. */
export function anthropicRequestBody(req: LlmChatRequest): string {
  return JSON.stringify({
    model: req.model,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: req.messages,
    ...(req.system ? { system: req.system } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.topP !== undefined ? { top_p: req.topP } : {}),
    ...(req.stop && req.stop.length > 0 ? { stop_sequences: req.stop } : {}),
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

/** Floor for a reasoning model's `max_completion_tokens` when the catalog gives none. */
const DEFAULT_REASONING_FLOOR = 25_000;

/**
 * The OpenAI **chat/completions** request body (always streamed). The neutral
 * top-level `system` is hoisted back into a leading `system` message.
 *
 * `max_tokens` is **omitted when the client didn't set one**, so the model's own
 * maximum applies — matching every other OpenAI-compatible endpoint (a forced
 * default would silently chop output). o-series reasoning models instead take
 * `max_completion_tokens` (which budgets reasoning + output together), floored so
 * reasoning can't starve visible output. `stream_options.include_usage` is always
 * requested so metering has token counts regardless of what the app asked for.
 */
export function openAiRequestBody(req: LlmChatRequest): string {
  const messages: Array<{ role: string; content: string }> = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  for (const m of req.messages) messages.push({ role: m.role, content: m.content });

  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  const price = priceForModel(req.model);
  if (price?.reasoning) {
    const floor = price.minCompletionTokens ?? DEFAULT_REASONING_FLOOR;
    body.max_completion_tokens = Math.max(req.maxTokens ?? floor, floor);
  } else if (req.maxTokens !== undefined) {
    body.max_tokens = req.maxTokens;
  }
  // OpenAI's temperature range (0–2) is wider than Anthropic's (0–1); forwarded
  // as-is, the vendor validates and a bad value surfaces as an upstream error.
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.topP !== undefined) body.top_p = req.topP;
  if (req.stop && req.stop.length > 0) body.stop = req.stop;
  return JSON.stringify(body);
}

/** Map an OpenAI upstream `finish_reason` to the platform-neutral stop reason. */
function neutralStopReason(finish: string | null): string {
  switch (finish) {
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      // "stop" and anything unrecognized. Tool-call finishes aren't mapped: the
      // codec rejects tool use, so they can't occur, and the downstream
      // (`finishReason`/`outcomeFor`) has no `tool_use` case to carry it to.
      return "end_turn";
  }
}

/**
 * Map an OpenAI chat/completions SSE body to the neutral `delta`/`done` stream.
 * Shared by any OpenAI-compatible upstream (`api.openai.com` today, a Warden URL
 * later). OpenAI's `completion_tokens` already folds reasoning tokens in, so it
 * is used verbatim as the neutral `outputTokens`; OpenAI cache tokens aren't
 * mapped (0 — the Anthropic-shaped cache classes don't apply here).
 */
export async function* mapOpenAiStream(body: Readable): AsyncIterable<LlmStreamEvent> {
  let inputTokens = 0;
  let outputTokens = 0;
  let finish: string | null = null;
  let sawUsage = false;
  let refused = false;

  for await (const { data } of parseSse(body)) {
    if (data === "[DONE]") break; // OpenAI's terminal sentinel
    let event: OpenAiChunk;
    try {
      event = JSON.parse(data) as OpenAiChunk;
    } catch {
      continue; // ignore non-JSON keepalives/comments
    }
    if (event.error) {
      throw new LlmProviderError(`openai stream error: ${event.error.message ?? "unknown"}`);
    }
    for (const choice of event.choices ?? []) {
      if (choice.delta?.content) yield { type: "delta", text: choice.delta.content };
      // A structured-output refusal (`delta.refusal`) is a refusal, not content —
      // meter it as such rather than an empty `ok`.
      if (choice.delta?.refusal) refused = true;
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    if (event.usage) {
      sawUsage = true;
      inputTokens = event.usage.prompt_tokens ?? 0;
      outputTokens = event.usage.completion_tokens ?? 0;
    }
  }

  // No usage block means the stream was truncated (or a non-conforming upstream):
  // we can't bill it, so surface an error rather than record a silent $0 `ok`.
  // Unlike Anthropic — which sends prompt tokens up front — OpenAI reports usage
  // only at the end, so an all-zero `done` here would under-bill every time. We
  // always request `stream_options.include_usage`, so real OpenAI always sends it;
  // a future OpenAI-compatible upstream that doesn't (e.g. some Warden config)
  // would need this revisited.
  if (!sawUsage) {
    throw new LlmProviderError("openai stream ended without a usage block");
  }

  yield {
    type: "done",
    stopReason: refused ? "refusal" : neutralStopReason(finish),
    usage: { inputTokens, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  };
}

/** The OpenAI chat/completions chunk fields we read (others ignored). */
interface OpenAiChunk {
  choices?: Array<{
    delta?: { content?: string; refusal?: string };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string };
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
export async function* parseSse(body: Readable): AsyncGenerator<{ event: string; data: string }> {
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

/**
 * A vendor descriptor for the egress-routed provider ({@link EgressLlmProvider}).
 * It captures everything vendor-specific — the upstream path, the static headers,
 * the neutral→wire body builder, and the wire→neutral stream mapper — so one
 * provider class serves both Anthropic and any OpenAI-compatible upstream. The
 * attested-instruction mint (jti/aud, ADR-0013) is identical across vendors;
 * only `origin`/`path`/`connection` vary.
 */
export interface EgressLlmVendor {
  /** Vendor origin (no path), e.g. `https://api.anthropic.com`. */
  endpoint: string;
  /** Upstream path, e.g. `/v1/messages` or `/v1/chat/completions`. */
  path: string;
  /** Name of the `platform`-scoped secret egress resolves + injects. */
  connection: string;
  /** Static headers sent upstream (content-type/accept are added by the provider). */
  headers: Record<string, string>;
  /** Neutral request → upstream request body. */
  buildBody(req: LlmChatRequest): string;
  /** Upstream SSE → neutral event stream. */
  mapStream(body: Readable): AsyncIterable<LlmStreamEvent>;
}

/** Anthropic Messages vendor descriptor. */
export function anthropicVendor(cfg: {
  endpoint: string;
  anthropicVersion: string;
  connection: string;
}): EgressLlmVendor {
  return {
    endpoint: cfg.endpoint,
    path: "/v1/messages",
    connection: cfg.connection,
    headers: { "anthropic-version": cfg.anthropicVersion },
    buildBody: anthropicRequestBody,
    mapStream: mapAnthropicStream,
  };
}

/** OpenAI-compatible chat/completions vendor descriptor (OpenAI direct, or Warden). */
export function openAiVendor(cfg: { endpoint: string; connection: string }): EgressLlmVendor {
  return {
    endpoint: cfg.endpoint,
    path: "/v1/chat/completions",
    connection: cfg.connection,
    headers: {},
    buildBody: openAiRequestBody,
    mapStream: mapOpenAiStream,
  };
}
