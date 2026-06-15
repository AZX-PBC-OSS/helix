import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
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

/**
 * The `/_api/llm/chat` gateway (architecture §6.1, project plan §4 M4): authn,
 * cross-app CSRF, the manifest model allowlist, block-new/finish-in-flight
 * quota, streaming relay, and per-call metering. Fakes for the provider and
 * ledger — no network, no DB.
 */

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PREFIX = "apps/a/1/";
const HOST = { host: "demo.localtest.me" };
const ORIGIN = "https://demo.localtest.me:8080";
const MODEL = "claude-opus-4-8";

interface LlmEdge {
  app: FastifyInstance;
  sessions: FakeSessionStore;
  provider: FakeLlmProvider;
  usage: FakeUsageStore;
}

function buildLlmEdge(
  opts: {
    llm?: { models: string[]; tokensPerDay?: number } | null;
    withProvider?: boolean;
  } = {},
): LlmEdge {
  const sessions = new FakeSessionStore();
  const provider = new FakeLlmProvider();
  const usage = new FakeUsageStore();
  const llm = opts.llm === undefined ? { models: [MODEL], tokensPerDay: 1000 } : opts.llm;
  const app = buildApp({
    config: testEdgeConfig({ auth: testAuthConfig(), allowUnauthenticated: false }),
    registry: new FakeRegistry([
      registryEntry({ appId: APP_ID, slug: "demo", blobPrefix: PREFIX, llm }),
    ]),
    blob: new FakeBlobReader(),
    sessions,
    oidc: new FakeOidcClient(),
    llmProvider: opts.withProvider === false ? null : provider,
    usage: opts.withProvider === false ? null : usage,
  });
  return { app, sessions, provider, usage };
}

async function seedSession(sessions: FakeSessionStore, appId = APP_ID): Promise<string> {
  const id = randomUUID();
  await sessions.createPending({
    id,
    appId,
    user: { oid: "oid-alice", displayName: "Alice Anders", groups: [] },
    refreshDueAt: new Date(Date.now() + 60_000),
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  const token = newSessionToken();
  await sessions.redeem(id, appId, hashSessionToken(token));
  return token;
}

function chat(
  edge: LlmEdge,
  token: string | null,
  body: unknown,
  opts: { origin?: string | null; host?: string } = {},
): Promise<LightMyRequestResponse> {
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  return edge.app.inject({
    method: "POST",
    url: "/_api/llm/chat",
    headers: {
      host: opts.host ?? HOST.host,
      "sec-fetch-mode": "cors",
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
      ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}),
    },
    payload: body as object,
  });
}

const ASK = { model: MODEL, messages: [{ role: "user", content: "hi" }] };

describe("happy paths", () => {
  it("streams deltas + done as SSE and meters the call once", async () => {
    const edge = buildLlmEdge();
    const token = await seedSession(edge.sessions);
    const res = await chat(edge, token, { ...ASK, stream: true });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("event: delta");
    expect(res.body).toContain('"text":"Hello"');
    expect(res.body).toContain("event: done");
    expect(res.body).toContain('"stopReason":"end_turn"');

    expect(edge.provider.calls).toHaveLength(1);
    expect(edge.provider.calls[0]?.model).toBe(MODEL);
    expect(edge.usage.records).toEqual([
      {
        appId: APP_ID,
        userOid: "oid-alice",
        capability: "llm",
        model: MODEL,
        inputTokens: 5,
        outputTokens: 2,
        outcome: "ok",
      },
    ]);
  });

  it("returns a single JSON body when stream:false", async () => {
    const edge = buildLlmEdge();
    const token = await seedSession(edge.sessions);
    const res = await chat(edge, token, { ...ASK, stream: false });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json()).toEqual({
      model: MODEL,
      content: "Hello world",
      stopReason: "end_turn",
      usage: { inputTokens: 5, outputTokens: 2 },
    });
    expect(edge.usage.records[0]?.outcome).toBe("ok");
  });
});

describe("authorization", () => {
  it("401s an unauthenticated request and never calls the provider", async () => {
    const edge = buildLlmEdge();
    const res = await chat(edge, null, ASK);
    expect(res.statusCode).toBe(401);
    expect(edge.provider.calls).toHaveLength(0);
  });

  it("403s a disallowed model", async () => {
    const edge = buildLlmEdge();
    const token = await seedSession(edge.sessions);
    const res = await chat(edge, token, { model: "gpt-5", messages: ASK.messages });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("model_not_allowed");
    expect(edge.provider.calls).toHaveLength(0);
  });

  it("403s an app with no LLM grant", async () => {
    const edge = buildLlmEdge({ llm: null });
    const token = await seedSession(edge.sessions);
    const res = await chat(edge, token, ASK);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });

  it("403s a cross-origin (sibling subdomain) POST — CSRF", async () => {
    const edge = buildLlmEdge();
    const token = await seedSession(edge.sessions);
    const res = await chat(edge, token, ASK, { origin: "https://evil.localtest.me:8080" });
    expect(res.statusCode).toBe(403);
    expect(edge.provider.calls).toHaveLength(0);
  });

  it("403s an origin-less POST", async () => {
    const edge = buildLlmEdge();
    const token = await seedSession(edge.sessions);
    const res = await chat(edge, token, ASK, { origin: null });
    expect(res.statusCode).toBe(403);
  });

  it("503s when no vendor key is configured", async () => {
    const edge = buildLlmEdge({ withProvider: false });
    const token = await seedSession(edge.sessions);
    const res = await chat(edge, token, ASK);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("capability_unavailable");
  });

  it("404s off app hosts", async () => {
    const edge = buildLlmEdge();
    const token = await seedSession(edge.sessions);
    const res = await chat(edge, token, ASK, { host: "auth.localtest.me" });
    expect(res.statusCode).toBe(404);
  });
});

describe("quota: block-new, finish-in-flight", () => {
  it("429s a new request once the daily budget is reached, and audits the block", async () => {
    const edge = buildLlmEdge();
    edge.usage.usedToday = 1000; // == budget
    const token = await seedSession(edge.sessions);
    const res = await chat(edge, token, ASK);

    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("quota_exceeded");
    expect(edge.provider.calls).toHaveLength(0); // nothing sent upstream
    expect(edge.usage.records).toEqual([
      expect.objectContaining({ outcome: "quota_blocked", inputTokens: 0, outputTokens: 0 }),
    ]);
  });

  it("admits an under-budget request and runs it to completion even if it crosses", async () => {
    const edge = buildLlmEdge();
    edge.usage.usedToday = 999; // under the 1000 budget — admitted
    edge.provider.usage = { inputTokens: 60, outputTokens: 60 }; // pushes well over
    const token = await seedSession(edge.sessions);
    const res = await chat(edge, token, { ...ASK, stream: true });

    expect(res.statusCode).toBe(200);
    // The full stream was delivered — not cut when the budget was crossed.
    expect(res.body).toContain('"text":"Hello"');
    expect(res.body).toContain('"text":" world"');
    expect(res.body).toContain("event: done");
    expect(edge.usage.records[0]).toMatchObject({
      outcome: "ok",
      inputTokens: 60,
      outputTokens: 60,
    });
  });

  it("imposes no cap when the grant omits tokensPerDay", async () => {
    const edge = buildLlmEdge({ llm: { models: [MODEL] } });
    edge.usage.usedToday = 10_000_000;
    const token = await seedSession(edge.sessions);
    const res = await chat(edge, token, ASK);
    expect(res.statusCode).toBe(200);
  });
});

describe("upstream failure", () => {
  it("emits an SSE error event and records outcome=error", async () => {
    const edge = buildLlmEdge();
    edge.provider.error = new Error("boom");
    const token = await seedSession(edge.sessions);
    const res = await chat(edge, token, { ...ASK, stream: true });

    // SSE was opened (200) and the failure is in-band.
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("event: error");
    expect(edge.usage.records[0]?.outcome).toBe("error");
  });

  it("502s a non-streaming upstream failure", async () => {
    const edge = buildLlmEdge();
    edge.provider.error = new Error("boom");
    const token = await seedSession(edge.sessions);
    const res = await chat(edge, token, { ...ASK, stream: false });
    expect(res.statusCode).toBe(502);
    expect(edge.usage.records[0]?.outcome).toBe("error");
  });
});
