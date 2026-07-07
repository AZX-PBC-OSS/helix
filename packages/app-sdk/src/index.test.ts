import { afterEach, describe, expect, it, vi } from "vitest";
import { createHelixClient } from "./index.js";

/**
 * The SDK's job is the swappable transport (dev-mode.md §8): pick same-origin +
 * cookie in prod vs. dev-host + bearer + app-header in a cross-origin preview,
 * and parse the neutral gateway SSE. Driven with a stubbed `fetch`.
 */

interface Captured {
  url: string;
  init: RequestInit;
}

function sse(...records: string[]): string {
  return records.map((r) => `${r}\n\n`).join("");
}

function stubFetch(bodyText: string, status = 200): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(status === 200 ? bodyText : null, { status });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const DONE =
  'event: done\ndata: {"stopReason":"end_turn","usage":{"inputTokens":5,"outputTokens":2}}';

describe("transport selection", () => {
  it("uses same-origin and no auth header when deployed (no token)", async () => {
    const calls = stubFetch(sse('event: delta\ndata: {"text":"hi"}', DONE));
    const helix = createHelixClient({}); // deployed: empty config
    await helix.llm.chat({ model: "m", messages: [{ role: "user", content: "hi" }] });

    expect(calls[0]?.url).toBe("/_api/llm/chat");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(headers["x-helix-dev-app"]).toBeUndefined();
  });

  it("uses the dev host + bearer + app header when a token is configured", async () => {
    const calls = stubFetch(sse(DONE));
    const helix = createHelixClient({
      base: "https://dev-api.localtest.me:8080",
      token: "dev-tok",
      app: "myapp",
    });
    await helix.llm.chat({ model: "m", messages: [{ role: "user", content: "hi" }] });

    expect(calls[0]?.url).toBe("https://dev-api.localtest.me:8080/_api/llm/chat");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer dev-tok");
    expect(headers["x-helix-dev-app"]).toBe("myapp");
  });

  it("reads config from globalThis.__HELIX__ when none is passed", async () => {
    const calls = stubFetch(sse(DONE));
    vi.stubGlobal("__HELIX__", { base: "https://dev-api.localtest.me:8080", token: "t", app: "a" });
    const helix = createHelixClient();
    await helix.llm.chat({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(calls[0]?.url).toBe("https://dev-api.localtest.me:8080/_api/llm/chat");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer t");
  });

  it("always requests streaming", async () => {
    const calls = stubFetch(sse(DONE));
    await createHelixClient({}).llm.chat({
      model: "m",
      messages: [{ role: "user", content: "x" }],
    });
    expect(JSON.parse(calls[0]?.init.body as string).stream).toBe(true);
  });
});

describe("SSE parsing", () => {
  it("concatenates deltas, fires onDelta, and returns usage", async () => {
    stubFetch(
      sse('event: delta\ndata: {"text":"Hello"}', 'event: delta\ndata: {"text":" world"}', DONE),
    );
    const deltas: string[] = [];
    const result = await createHelixClient({}).llm.chat(
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      { onDelta: (t) => deltas.push(t) },
    );
    expect(result.text).toBe("Hello world");
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
    expect(deltas).toEqual(["Hello", " world"]);
  });

  it("throws on an error event", async () => {
    stubFetch(sse('event: error\ndata: {"code":"internal","message":"boom"}'));
    await expect(
      createHelixClient({}).llm.chat({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow("boom");
  });

  it("throws on a non-2xx response", async () => {
    stubFetch("", 503);
    await expect(
      createHelixClient({}).llm.chat({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow("HTTP 503");
  });
});
