import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { OpenAiChatCompletionChunk } from "@azx-pbc/shared";
import { buildApp } from "../app.js";
import { SESSION_COOKIE } from "../auth/cookies.js";
import { hashSessionToken, newSessionToken } from "../auth/sessions.js";
import { testAuthConfig, testEdgeConfig } from "../test/config.js";
import {
  FakeBlobReader,
  FakeLlmProvider,
  FakeOidcClient,
  FakeRegistry,
  FakeSessionStore,
  FakeUsageStore,
  registryEntry,
} from "../test/fakes.js";
import { RoutingLlmProvider } from "./routingLlmProvider.js";
import type { LlmProvider } from "./provider.js";

/**
 * The OpenAI-compatible surface (`/_api/openai/v1/*`). It rides the exact same
 * policy/metering spine as `/_api/llm/chat` (that regression lives in
 * `llm.test.ts`); these tests pin the OpenAI **envelope** — request translation,
 * `chat.completion(.chunk)` framing, OpenAI-shaped errors, `/v1/models`, and the
 * routing 503 — over the shared fakes.
 */

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PREFIX = "apps/a/1/";
const HOST = "demo.local.helix.azxlabs.io";
const ORIGIN = "https://demo.local.helix.azxlabs.io:8080";
const MODEL = "claude-opus-4-8";

interface Edge {
  app: FastifyInstance;
  sessions: FakeSessionStore;
  provider: FakeLlmProvider;
  usage: FakeUsageStore;
}

function buildEdge(
  opts: { models?: string[]; provider?: LlmProvider; noGrant?: boolean } = {},
): Edge {
  const sessions = new FakeSessionStore();
  const provider = new FakeLlmProvider();
  const usage = new FakeUsageStore();
  const app = buildApp({
    config: testEdgeConfig({ auth: testAuthConfig(), allowUnauthenticated: false }),
    registry: new FakeRegistry([
      registryEntry({
        appId: APP_ID,
        slug: "demo",
        blobPrefix: PREFIX,
        llm: opts.noGrant ? null : { models: opts.models ?? [MODEL], dollarsPerDay: 1 },
      }),
    ]),
    blob: new FakeBlobReader(),
    sessions,
    oidc: new FakeOidcClient(),
    llmProvider: opts.provider ?? provider,
    usage,
  });
  return { app, sessions, provider, usage };
}

async function seedSession(sessions: FakeSessionStore): Promise<string> {
  const id = randomUUID();
  await sessions.createPending({
    id,
    appId: APP_ID,
    user: { oid: "oid-alice", displayName: "Alice Anders", groups: [] },
    refreshDueAt: new Date(Date.now() + 60_000),
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  const token = newSessionToken();
  await sessions.redeem(id, APP_ID, hashSessionToken(token));
  return token;
}

function completions(
  edge: Edge,
  token: string | null,
  body: unknown,
  opts: { origin?: string | null } = {},
): Promise<LightMyRequestResponse> {
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  return edge.app.inject({
    method: "POST",
    url: "/_api/openai/v1/chat/completions",
    headers: {
      host: HOST,
      "sec-fetch-mode": "cors",
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
      ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}),
    },
    payload: body as object,
  });
}

/** Extract the JSON `data:` frames from an SSE body (skipping the `[DONE]` sentinel). */
function sseChunks(body: string): OpenAiChatCompletionChunk[] {
  return body
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice("data: ".length))
    .filter((d) => d !== "[DONE]")
    .map((d) => JSON.parse(d) as OpenAiChatCompletionChunk);
}

const ASK = { model: MODEL, messages: [{ role: "user", content: "hi" }] };

describe("streaming", () => {
  it("frames chat.completion.chunk with a role chunk, content, finish, and [DONE]", async () => {
    const edge = buildEdge();
    const token = await seedSession(edge.sessions);
    const res = await completions(edge, token, { ...ASK, stream: true });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body.trimEnd().endsWith("data: [DONE]")).toBe(true);

    const chunks = sseChunks(res.body);
    for (const c of chunks) expect(c.object).toBe("chat.completion.chunk");
    // First chunk announces the assistant role.
    expect(chunks[0]?.choices[0]?.delta).toEqual({ role: "assistant" });
    // Content deltas carry the provider's scripted text.
    const text = chunks
      .flatMap((c) => c.choices)
      .map((ch) => ch?.delta?.content ?? "")
      .join("");
    expect(text).toBe("Hello world");
    // A finish chunk maps end_turn -> stop.
    expect(chunks.some((c) => c.choices[0]?.finish_reason === "stop")).toBe(true);
    // Stable id across all chunks.
    const ids = new Set(chunks.map((c) => c.id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^chatcmpl-/);

    // Metered exactly once.
    expect(edge.usage.records).toHaveLength(1);
    expect(edge.usage.records[0]).toMatchObject({ capability: "llm", model: MODEL, outcome: "ok" });
  });

  it("emits a trailing usage chunk only when stream_options.include_usage is set", async () => {
    const edge = buildEdge();
    const token = await seedSession(edge.sessions);

    const withUsage = await completions(edge, token, {
      ...ASK,
      stream: true,
      stream_options: { include_usage: true },
    });
    const usageChunk = sseChunks(withUsage.body).find((c) => c.usage != null);
    expect(usageChunk).toBeDefined();
    expect(usageChunk?.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });

    const without = await completions(edge, token, { ...ASK, stream: true });
    expect(sseChunks(without.body).some((c) => c.usage != null)).toBe(false);
  });

  it("surfaces a mid-stream error as an error frame with no [DONE]", async () => {
    const edge = buildEdge();
    edge.provider.error = new Error("boom");
    const token = await seedSession(edge.sessions);
    const res = await completions(edge, token, { ...ASK, stream: true });

    expect(res.body).toContain('"error"');
    expect(res.body).not.toContain("[DONE]");
    expect(edge.usage.records[0]).toMatchObject({ outcome: "error" });
  });
});

describe("non-streaming", () => {
  it("returns a chat.completion body with mapped usage", async () => {
    const edge = buildEdge();
    const token = await seedSession(edge.sessions);
    const res = await completions(edge, token, ASK); // stream defaults to false for OpenAI

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const body = res.json();
    expect(body.object).toBe("chat.completion");
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.choices[0].message).toEqual({ role: "assistant", content: "Hello world" });
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
    expect(edge.usage.records).toHaveLength(1);
  });

  it("hoists system/developer messages into the neutral system channel", async () => {
    const edge = buildEdge();
    const token = await seedSession(edge.sessions);
    await completions(edge, token, {
      model: MODEL,
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ],
    });
    expect(edge.provider.calls[0]?.system).toBe("be terse");
    expect(edge.provider.calls[0]?.messages).toEqual([{ role: "user", content: "hi" }]);
  });
});

describe("rejects unsupported features with an OpenAI error", () => {
  it("400s on tools", async () => {
    const edge = buildEdge();
    const token = await seedSession(edge.sessions);
    const res = await completions(edge, token, { ...ASK, tools: [{ type: "function" }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe("invalid_request_error");
    expect(edge.provider.calls).toHaveLength(0);
  });

  it("400s on multimodal (array) content", async () => {
    const edge = buildEdge();
    const token = await seedSession(edge.sessions);
    const res = await completions(edge, token, {
      model: MODEL,
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe("invalid_request_error");
  });

  it("400s on a tool-role message", async () => {
    const edge = buildEdge();
    const token = await seedSession(edge.sessions);
    const res = await completions(edge, token, {
      model: MODEL,
      messages: [{ role: "tool", content: "result", tool_call_id: "x" }],
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s a behaviour-changing param and names it in `param`", async () => {
    const edge = buildEdge();
    const token = await seedSession(edge.sessions);
    const res = await completions(edge, token, {
      ...ASK,
      response_format: { type: "json_object" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.param).toBe("response_format");
    expect(edge.provider.calls).toHaveLength(0);
  });

  it("accepts n:1 (no-op default) but 400s n>1", async () => {
    const edge = buildEdge();
    const token = await seedSession(edge.sessions);
    const ok = await completions(edge, token, { ...ASK, n: 1 });
    expect(ok.statusCode).toBe(200);
    const bad = await completions(edge, token, { ...ASK, n: 2 });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.param).toBe("n");
  });

  it("surfaces the zod field path in `param` on a schema failure", async () => {
    const edge = buildEdge();
    const token = await seedSession(edge.sessions);
    // content:"" is legal in OpenAI but fails the neutral min(1) → a 400 that
    // points at the field rather than an opaque "invalid request".
    const res = await completions(edge, token, {
      model: MODEL,
      messages: [{ role: "user", content: "" }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.param).toBeTruthy();
  });
});

describe("opting out of tools is allowed", () => {
  it('serves tool_choice:"none" with an empty tools list', async () => {
    const edge = buildEdge();
    const token = await seedSession(edge.sessions);
    const res = await completions(edge, token, { ...ASK, tool_choice: "none", tools: [] });
    expect(res.statusCode).toBe(200);
    expect(edge.provider.calls).toHaveLength(1);
  });
});

describe("sampling params reach the provider", () => {
  it("forwards temperature/top_p/stop into the neutral request", async () => {
    const edge = buildEdge();
    const token = await seedSession(edge.sessions);
    await completions(edge, token, {
      ...ASK,
      temperature: 0.2,
      top_p: 0.5,
      stop: "\n\n",
    });
    expect(edge.provider.calls[0]).toMatchObject({
      temperature: 0.2,
      topP: 0.5,
      stop: ["\n\n"], // a string `stop` is normalized to a list
    });
  });
});

describe("authz maps to OpenAI errors", () => {
  it("401 without a session", async () => {
    const edge = buildEdge();
    const res = await completions(edge, null, ASK);
    expect(res.statusCode).toBe(401);
  });

  it("403 on a cross-app origin", async () => {
    const edge = buildEdge();
    const token = await seedSession(edge.sessions);
    const res = await completions(edge, token, ASK, {
      origin: "https://evil.local.helix.azxlabs.io:8080",
    });
    expect(res.statusCode).toBe(403);
  });

  it("model_not_found when the model is not allowlisted", async () => {
    const edge = buildEdge(); // allowlist is [claude-opus-4-8]
    const token = await seedSession(edge.sessions);
    const res = await completions(edge, token, {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("model_not_found");
  });
});

describe("OpenAI models flow through and meter at OpenAI rates", () => {
  it("serves gpt-4o-mini and meters its cost", async () => {
    const edge = buildEdge({ models: ["gpt-4o-mini"] });
    const token = await seedSession(edge.sessions);
    const res = await completions(edge, token, {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.statusCode).toBe(200);
    expect(edge.provider.calls[0]?.model).toBe("gpt-4o-mini");
    // 5 in * $0.15/Mtok + 2 out * $0.60/Mtok = 1.95 micro-USD -> rounds to 2.
    expect(edge.usage.records[0]).toMatchObject({ model: "gpt-4o-mini", costMicroUsd: 2 });
  });
});

describe("routing", () => {
  it("503s a curated model whose upstream family is not configured", async () => {
    // A routing provider with only anthropic wired; the app allowlists gpt-4o-mini.
    const routing = new RoutingLlmProvider({ anthropic: new FakeLlmProvider(), openai: null });
    const edge = buildEdge({ models: ["gpt-4o-mini"], provider: routing });
    const token = await seedSession(edge.sessions);
    const res = await completions(edge, token, {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.type).toBe("api_error");
  });
});

describe("GET /_api/openai/v1/models", () => {
  function models(edge: Edge, token: string | null): Promise<LightMyRequestResponse> {
    return edge.app.inject({
      method: "GET",
      url: "/_api/openai/v1/models",
      headers: { host: HOST, ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}) },
    });
  }

  it("lists the app's allowlisted models in OpenAI list shape", async () => {
    const edge = buildEdge({ models: [MODEL, "gpt-4o-mini"] });
    const token = await seedSession(edge.sessions);
    const res = await models(edge, token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe("list");
    expect(body.data.map((m: { id: string }) => m.id)).toEqual([MODEL, "gpt-4o-mini"]);
    // `created` is required on the OpenAI Model object.
    expect(body.data[0]).toMatchObject({ object: "model", owned_by: "helix", created: 0 });
  });

  it("401s without a session", async () => {
    const edge = buildEdge();
    const res = await models(edge, null);
    expect(res.statusCode).toBe(401);
  });

  it("403s (not an empty list) when the app has no LLM grant", async () => {
    const edge = buildEdge({ noGrant: true });
    const token = await seedSession(edge.sessions);
    const res = await models(edge, token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.type).toBe("invalid_request_error");
  });
});
