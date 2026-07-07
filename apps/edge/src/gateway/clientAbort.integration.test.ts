import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { request } from "undici";
import type { LlmChatRequest } from "@helix/shared";
import { buildApp } from "../app.js";
import { testAuthConfig, testEdgeConfig } from "../test/config.js";
import {
  FakeBlobReader,
  FakeOidcClient,
  FakeRegistry,
  FakeSessionStore,
  FakeUsageStore,
  registryEntry,
} from "../test/fakes.js";
import { deriveInstructionKey } from "./instruction.js";
import type { LlmProvider, LlmStreamEvent, LlmStreamOpts } from "./provider.js";
import type { EgressProvider, EgressRequest, EgressResponse } from "./egressProvider.js";

/**
 * Real-socket coverage for the client-disconnect guard (see clientAbort.ts).
 * Binds a real port and drives it with undici; public apps keep the setup
 * session-free. `light-my-request` can't be used — its mock socket never emits
 * `close` like a real connection, which is exactly why the original defect
 * slipped past the inject suites.
 *
 * The disconnect tests below are the load-bearing regression: they FAIL against
 * the old `req.raw.on("close")` wiring (which, over a loopback keep-alive
 * connection, never aborts the upstream at all) and PASS against the
 * response-guarded fix. The "does NOT abort" tests are correctness guards —
 * they pin that a normal request runs to completion without a spurious abort.
 */

const MODEL = "claude-opus-4-8";
const HOST = "demo.localtest.me";
const ORIGIN = "https://demo.localtest.me:8080";
const USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};
const JSON_HEADERS = {
  host: HOST,
  origin: ORIGIN,
  "content-type": "application/json",
  "sec-fetch-mode": "cors",
};

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function listen(instance: FastifyInstance): Promise<number> {
  app = instance;
  await instance.listen({ port: 0, host: "127.0.0.1" });
  return (instance.server.address() as AddressInfo).port;
}

function llmEdge(provider: LlmProvider): FastifyInstance {
  return buildApp({
    config: testEdgeConfig({ auth: testAuthConfig() }),
    registry: new FakeRegistry([
      registryEntry({
        slug: "demo",
        visibilityMode: "public",
        blobPrefix: "apps/a/1/",
        llm: { models: [MODEL] },
      }),
    ]),
    blob: new FakeBlobReader(),
    sessions: new FakeSessionStore(),
    oidc: new FakeOidcClient(),
    llmProvider: provider,
    usage: new FakeUsageStore(),
  });
}

/**
 * Simulates upstream latency BEFORE the first byte — the window in which the
 * original defect aborted the call (req.raw's `close` fired after the request
 * body was read, before the handler ever wrote/hijacked the response). Then
 * streams "Hello world" + done. A handler that aborts a live request truncates
 * to zero deltas.
 */
class GapProvider implements LlmProvider {
  sawAbort = false;
  deltas = 0;
  constructor(private readonly gapMs: number) {}
  async *stream(_req: LlmChatRequest, opts: LlmStreamOpts): AsyncIterable<LlmStreamEvent> {
    await new Promise((r) => setTimeout(r, this.gapMs));
    if (opts.signal.aborted) {
      this.sawAbort = true;
      return;
    }
    yield { type: "delta", text: "Hello" };
    this.deltas++;
    yield { type: "delta", text: " world" };
    this.deltas++;
    yield { type: "done", stopReason: "end_turn", usage: USAGE };
  }
  async close(): Promise<void> {}
}

/** Yields "Hello", then blocks until the signal aborts (or a safety timeout). */
class BlockUntilAbortProvider implements LlmProvider {
  sawAbort = false;
  async *stream(_req: LlmChatRequest, opts: LlmStreamOpts): AsyncIterable<LlmStreamEvent> {
    yield { type: "delta", text: "Hello" };
    await new Promise<void>((resolve) => {
      if (opts.signal.aborted) return resolve();
      opts.signal.addEventListener("abort", () => resolve(), { once: true });
      setTimeout(resolve, 3000);
    });
    this.sawAbort = opts.signal.aborted;
  }
  async close(): Promise<void> {}
}

describe("LLM gateway — client disconnect", () => {
  it("does NOT abort a live streaming request when the request body closes", async () => {
    const provider = new GapProvider(60);
    const port = await listen(llmEdge(provider));
    const res = await request(`http://127.0.0.1:${port}/_api/llm/chat`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    let text = "";
    for await (const chunk of res.body) text += chunk.toString();

    expect(res.statusCode).toBe(200);
    expect(text).toContain('"text":"Hello"');
    expect(text).toContain('"text":" world"');
    expect(text).toContain("event: done");
    expect(provider.sawAbort).toBe(false);
    expect(provider.deltas).toBe(2);
  });

  it("does NOT abort a live non-streaming request", async () => {
    const provider = new GapProvider(60);
    const port = await listen(llmEdge(provider));
    const res = await request(`http://127.0.0.1:${port}/_api/llm/chat`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    });
    const json = (await res.body.json()) as { content: string };
    expect(res.statusCode).toBe(200);
    expect(json.content).toBe("Hello world");
    expect(provider.sawAbort).toBe(false);
  });

  it("DOES abort the upstream when the client disconnects mid-stream", async () => {
    const provider = new BlockUntilAbortProvider();
    const port = await listen(llmEdge(provider));
    const clientAbort = new AbortController();
    const res = await request(`http://127.0.0.1:${port}/_api/llm/chat`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
      signal: clientAbort.signal,
    });
    res.body.on("error", () => {}); // swallow the abort-induced stream error
    for await (const chunk of res.body) {
      if (chunk.toString().includes("Hello")) break;
    }
    clientAbort.abort(); // hang up

    await vi.waitFor(() => expect(provider.sawAbort).toBe(true), { timeout: 2000 });
  });
});

const FETCH_ORIGIN = "https://api.example.com";
const fetchKey = deriveInstructionKey(randomBytes(32));

/** Streams one chunk then blocks; records whether its request signal aborted. */
class BlockingEgress implements EgressProvider {
  sawAbort = false;
  async proxy(req: EgressRequest): Promise<EgressResponse> {
    const body = new Readable({ read() {} });
    body.push(Buffer.from("chunk-1"));
    req.signal.addEventListener(
      "abort",
      () => {
        this.sawAbort = true;
        body.push(null);
      },
      { once: true },
    );
    setTimeout(() => body.push(null), 3000); // safety
    return { status: 200, headers: { "content-type": "text/plain" }, body, outcome: "ok" };
  }
  async close(): Promise<void> {}
}

describe("fetch gateway — client disconnect", () => {
  it("DOES abort the egress round-trip when the client disconnects mid-response", async () => {
    const egress = new BlockingEgress();
    app = buildApp({
      config: testEdgeConfig({ auth: testAuthConfig() }),
      registry: new FakeRegistry([
        registryEntry({
          slug: "demo",
          visibilityMode: "public",
          blobPrefix: "apps/a/1/",
          fetch: {
            connections: new Map([[FETCH_ORIGIN, null]]),
            requestsPerDay: null,
            shim: false,
          },
        }),
      ]),
      blob: new FakeBlobReader(),
      sessions: new FakeSessionStore(),
      oidc: new FakeOidcClient(),
      egress,
      instructionKey: fetchKey,
      usage: new FakeUsageStore(),
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;

    const clientAbort = new AbortController();
    const target = encodeURIComponent(`${FETCH_ORIGIN}/data`);
    const res = await request(`http://127.0.0.1:${port}/_api/fetch/${target}`, {
      method: "GET",
      headers: { host: HOST, origin: ORIGIN },
      signal: clientAbort.signal,
    });
    res.body.on("error", () => {});
    for await (const chunk of res.body) {
      if (chunk.toString().includes("chunk-1")) break;
    }
    clientAbort.abort();

    await vi.waitFor(() => expect(egress.sawAbort).toBe(true), { timeout: 2000 });
  });
});
