import { describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { CURATED_LLM_MODELS } from "@helix/shared";
import { buildApp } from "../app.js";
import { testEdgeConfig } from "../test/config.js";
import { FakeBlobReader, FakeLlmProvider, FakeRegistry, registryEntry } from "../test/fakes.js";

/**
 * The builder endpoint (the "Lovable at home" prototype, Track A): an
 * OpenAI-compatible `/v1/chat/completions` + `/v1/models` on the platform host,
 * routed through the shared LlmProvider seam with a bearer key. Fakes for the
 * provider — no network. Proves auth, request/response translation, the model
 * catalog, fail-closed 503/404, and that it never answers on app hosts.
 */

const KEY = "test-builder-key";
const PLATFORM = "api.localtest.me";
const MODEL = "claude-opus-4-8";

interface BuilderEdge {
  app: FastifyInstance;
  provider: FakeLlmProvider;
}

function buildBuilderEdge(
  opts: { apiKey?: string | null; withProvider?: boolean } = {},
): BuilderEdge {
  const provider = new FakeLlmProvider();
  const app = buildApp({
    config: testEdgeConfig({
      builder: { apiKey: opts.apiKey === undefined ? KEY : opts.apiKey },
    }),
    // An app registered so the host-isolation test hits a real app host.
    registry: new FakeRegistry([registryEntry({ slug: "demo", blobPrefix: "apps/a/1/" })]),
    blob: new FakeBlobReader(),
    llmProvider: opts.withProvider === false ? null : provider,
  });
  return { app, provider };
}

function post(
  edge: BuilderEdge,
  body: unknown,
  opts: { auth?: string | null; host?: string } = {},
): Promise<LightMyRequestResponse> {
  const auth = opts.auth === undefined ? `Bearer ${KEY}` : opts.auth;
  return edge.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: {
      host: opts.host ?? PLATFORM,
      "content-type": "application/json",
      ...(auth ? { authorization: auth } : {}),
    },
    payload: body as object,
  });
}

const ASK = { model: MODEL, messages: [{ role: "user", content: "hi" }] };

describe("auth", () => {
  it("401s without a bearer token", async () => {
    const edge = buildBuilderEdge();
    const res = await post(edge, ASK, { auth: null });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_api_key");
    expect(edge.provider.calls).toHaveLength(0);
  });

  it("401s on a wrong bearer token", async () => {
    const edge = buildBuilderEdge();
    const res = await post(edge, ASK, { auth: "Bearer nope" });
    expect(res.statusCode).toBe(401);
    expect(edge.provider.calls).toHaveLength(0);
  });

  it("404s when no builder key is configured (capability off)", async () => {
    const edge = buildBuilderEdge({ apiKey: null });
    const res = await post(edge, ASK, { auth: null });
    expect(res.statusCode).toBe(404);
  });
});

describe("chat completions", () => {
  it("streams OpenAI chunks: role, content, finish, then [DONE]", async () => {
    const edge = buildBuilderEdge();
    const res = await post(edge, { ...ASK, stream: true });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain('"delta":{"role":"assistant"}');
    expect(res.body).toContain('"content":"Hello"');
    expect(res.body).toContain('"content":" world"');
    expect(res.body).toContain('"finish_reason":"stop"');
    expect(res.body).toContain("chat.completion.chunk");
    expect(res.body.trimEnd().endsWith("data: [DONE]")).toBe(true);

    expect(edge.provider.calls).toHaveLength(1);
    expect(edge.provider.calls[0]?.model).toBe(MODEL);
  });

  it("returns a chat.completion body with usage when stream is omitted", async () => {
    const edge = buildBuilderEdge();
    const res = await post(edge, ASK);

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const json = res.json();
    expect(json.object).toBe("chat.completion");
    expect(json.model).toBe(MODEL);
    expect(json.choices[0].message).toEqual({ role: "assistant", content: "Hello world" });
    expect(json.choices[0].finish_reason).toBe("stop");
    // FakeLlmProvider reports input 5 / output 2.
    expect(json.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  });

  it("hoists system/developer turns into the neutral system channel", async () => {
    const edge = buildBuilderEdge();
    await post(edge, {
      model: MODEL,
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ],
    });
    const call = edge.provider.calls[0];
    expect(call?.system).toBe("be terse");
    expect(call?.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("accepts array (multimodal) content by reading its text parts", async () => {
    const edge = buildBuilderEdge();
    await post(edge, {
      model: MODEL,
      messages: [{ role: "user", content: [{ type: "text", text: "hello there" }] }],
    });
    expect(edge.provider.calls[0]?.messages).toEqual([{ role: "user", content: "hello there" }]);
  });

  it("400s a model outside the curated catalog", async () => {
    const edge = buildBuilderEdge();
    const res = await post(edge, { ...ASK, model: "gpt-4o" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("model_not_found");
    expect(edge.provider.calls).toHaveLength(0);
  });

  it("503s when no provider is configured", async () => {
    const edge = buildBuilderEdge({ withProvider: false });
    const res = await post(edge, ASK);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.type).toBe("server_error");
  });
});

describe("models", () => {
  it("lists the curated catalog", async () => {
    const edge = buildBuilderEdge();
    const res = await edge.app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { host: PLATFORM, authorization: `Bearer ${KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.object).toBe("list");
    expect(json.data.map((m: { id: string }) => m.id)).toEqual([...CURATED_LLM_MODELS]);
    expect(json.data[0]).toMatchObject({ object: "model", owned_by: "helix" });
  });

  it("401s /v1/models without a bearer token", async () => {
    const edge = buildBuilderEdge();
    const res = await edge.app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { host: PLATFORM },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("host isolation", () => {
  it("never answers /v1/chat/completions on an app host", async () => {
    const edge = buildBuilderEdge();
    const res = await post(edge, ASK, { host: "demo.localtest.me" });
    expect(res.statusCode).toBe(404);
    expect(edge.provider.calls).toHaveLength(0);
  });
});
