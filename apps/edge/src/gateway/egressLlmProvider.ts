import { Readable } from "node:stream";
import type { LlmChatRequest } from "@azx-pbc/shared";
import {
  type LlmProvider,
  type LlmStreamEvent,
  type LlmStreamOpts,
  LlmProviderError,
  anthropicRequestBody,
  mapAnthropicStream,
} from "./provider.js";
import type { EgressProvider } from "./egressProvider.js";
import { mintInstruction } from "./instruction.js";

/**
 * The LLM provider that routes through `azx-egress` (secrets design §1, §4). It
 * keeps the edge out of the credential path entirely: the vendor key is a
 * `platform`-scoped secret egress resolves and injects, so the edge never holds
 * it and rotation in the portal needs no edge restart.
 *
 * The division of labour mirrors the fetch-proxy. All LLM *policy* — session
 * gate, model allowlist, USD budget, metering — stays in the handler
 * (`llm.ts`); this provider only builds the Anthropic request, mints an attested
 * `llm` instruction, and hands the call to egress, then parses the SSE that
 * streams back exactly as the direct provider does (shared `mapAnthropicStream`).
 */
export interface EgressLlmProviderConfig {
  /** Vendor origin (no path), e.g. `https://api.anthropic.com`. */
  endpoint: string;
  /** `anthropic-version` header value. */
  anthropicVersion: string;
  /** Name of the `platform`-scoped secret holding the vendor key. */
  connection: string;
}

export class EgressLlmProvider implements LlmProvider {
  readonly #config: EgressLlmProviderConfig;
  readonly #egress: EgressProvider;
  readonly #instructionKey: Buffer;

  constructor(config: EgressLlmProviderConfig, egress: EgressProvider, instructionKey: Buffer) {
    this.#config = config;
    this.#egress = egress;
    this.#instructionKey = instructionKey;
  }

  async *stream(req: LlmChatRequest, opts: LlmStreamOpts): AsyncIterable<LlmStreamEvent> {
    const origin = new URL(this.#config.endpoint).origin;
    const instruction = await mintInstruction(
      {
        appId: opts.appId,
        userOid: opts.userOid,
        capability: "llm",
        origin,
        connection: this.#config.connection,
        requestId: opts.requestId,
        env: opts.env,
        method: "POST",
        path: "/v1/messages",
      },
      this.#instructionKey,
    );

    const res = await this.#egress.proxy({
      instruction,
      target: `${origin}/v1/messages`,
      method: "POST",
      headers: {
        "anthropic-version": this.#config.anthropicVersion,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      // Send the JSON body whole (string → undici sets content-length). NOT
      // Readable.from(string): that is an object-mode char stream → empty body.
      body: anthropicRequestBody(req),
      signal: opts.signal,
    });

    if (res.status !== 200) {
      // A 403 here is egress refusing the connection — typically the platform
      // secret is unset/misnamed. Surface the upstream status to the handler.
      const text = await readText(res.body);
      throw new LlmProviderError(`egress llm call failed (${res.status}): ${text}`, res.status);
    }

    yield* mapAnthropicStream(res.body);
  }

  // The egress provider is shared with the fetch path and owned by the server
  // (closed via `egress.close()` on shutdown) — nothing for this provider to own.
  async close(): Promise<void> {}
}

async function readText(body: Readable, max = 200): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    chunks.push(buf);
    total += buf.length;
    if (total >= max) break;
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
