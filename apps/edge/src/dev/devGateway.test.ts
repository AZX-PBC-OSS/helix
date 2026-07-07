import { describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../app.js";
import { testEdgeConfig } from "../test/config.js";
import {
  FakeBlobReader,
  FakeLlmProvider,
  FakeRegistry,
  FakeUsageStore,
  registryEntry,
} from "../test/fakes.js";

/**
 * The THROWAWAY dev-gateway (apps/edge/src/dev/, dev-mode.md §5): a CORS + bearer
 * LLM surface on the dev host for cross-origin previews. Adversarial coverage of
 * the surface's trust boundary — unregistered origins, missing/bad tokens, host
 * isolation — plus the happy path. No sessions/auth stack needed (bearer, not
 * cookie).
 */

const TOKEN = "dev-token-xyz";
const PREVIEW = "https://preview.webcontainer-api.io";
const DEV_HOST = "dev-api.localtest.me";
const MODEL = "claude-opus-4-8";

interface DevEdge {
  app: FastifyInstance;
  provider: FakeLlmProvider;
  usage: FakeUsageStore;
}

function buildDevEdge(opts: { token?: string | null; withProvider?: boolean } = {}): DevEdge {
  const provider = new FakeLlmProvider();
  const usage = new FakeUsageStore();
  const app = buildApp({
    config: testEdgeConfig({
      devGateway: { token: opts.token === undefined ? TOKEN : opts.token, origins: [PREVIEW] },
    }),
    registry: new FakeRegistry([
      registryEntry({ slug: "demo", blobPrefix: "apps/a/1/", llm: { models: [MODEL] } }),
    ]),
    blob: new FakeBlobReader(),
    llmProvider: opts.withProvider === false ? null : provider,
    usage: opts.withProvider === false ? null : usage,
  });
  return { app, provider, usage };
}

function chat(
  edge: DevEdge,
  opts: {
    origin?: string | null;
    token?: string | null;
    app?: string | null;
    model?: string;
    host?: string;
  } = {},
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = {
    host: opts.host ?? DEV_HOST,
    "content-type": "application/json",
  };
  if (opts.origin !== null) headers.origin = opts.origin ?? PREVIEW;
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
  if (opts.app !== null) headers["x-helix-dev-app"] = opts.app ?? "demo";
  return edge.app.inject({
    method: "POST",
    url: "/_api/llm/chat",
    headers,
    payload: { model: opts.model ?? MODEL, messages: [{ role: "user", content: "hi" }] },
  });
}

describe("CORS + preflight", () => {
  it("answers a preflight from a registered origin with reflected CORS", async () => {
    const edge = buildDevEdge();
    const res = await edge.app.inject({
      method: "OPTIONS",
      url: "/_api/llm/chat",
      headers: { host: DEV_HOST, origin: PREVIEW },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(PREVIEW);
    expect(res.headers["access-control-allow-headers"]).toContain("x-helix-dev-app");
    expect(res.headers.vary).toContain("Origin");
  });

  it("refuses a preflight from an unregistered origin (no ACAO)", async () => {
    const edge = buildDevEdge();
    const res = await edge.app.inject({
      method: "OPTIONS",
      url: "/_api/llm/chat",
      headers: { host: DEV_HOST, origin: "https://evil.example" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("auth + origin", () => {
  it("rejects an unregistered origin before checking the token", async () => {
    const edge = buildDevEdge();
    const res = await chat(edge, { origin: "https://evil.example" });
    expect(res.statusCode).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(edge.provider.calls).toHaveLength(0);
  });

  it("401s a missing token", async () => {
    const edge = buildDevEdge();
    const res = await chat(edge, { token: null });
    expect(res.statusCode).toBe(401);
    expect(edge.provider.calls).toHaveLength(0);
  });

  it("401s a wrong token", async () => {
    const edge = buildDevEdge();
    const res = await chat(edge, { token: "nope" });
    expect(res.statusCode).toBe(401);
  });

  it("404s when the dev gateway is not configured", async () => {
    const edge = buildDevEdge({ token: null });
    const res = await chat(edge, { token: null });
    expect(res.statusCode).toBe(404);
  });
});

describe("request handling", () => {
  it("streams neutral SSE for a registered origin + valid token, with CORS + metering", async () => {
    const edge = buildDevEdge();
    const res = await chat(edge);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["access-control-allow-origin"]).toBe(PREVIEW);
    expect(res.body).toContain("event: delta");
    expect(res.body).toContain('"text":"Hello"');
    expect(res.body).toContain("event: done");
    expect(edge.provider.calls[0]?.model).toBe(MODEL);
    // Metered against the app's ledger (the throwaway surface has no env split).
    expect(edge.usage.records).toHaveLength(1);
    expect(edge.usage.records[0]).toMatchObject({
      capability: "llm",
      model: MODEL,
      userOid: "dev",
    });
  });

  it("400s a missing app header", async () => {
    const edge = buildDevEdge();
    const res = await chat(edge, { app: null });
    expect(res.statusCode).toBe(400);
    expect(edge.provider.calls).toHaveLength(0);
  });

  it("403s a model outside the app's manifest allowlist", async () => {
    const edge = buildDevEdge();
    const res = await chat(edge, { model: "claude-haiku-4-5" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("model_not_allowed");
    expect(edge.provider.calls).toHaveLength(0);
  });

  it("503s when no provider is configured", async () => {
    const edge = buildDevEdge({ withProvider: false });
    const res = await chat(edge);
    expect(res.statusCode).toBe(503);
  });
});

describe("host isolation", () => {
  it("does not expose the dev surface on the platform host", async () => {
    const edge = buildDevEdge();
    const res = await chat(edge, { host: "api.localtest.me" });
    expect(res.statusCode).toBe(404);
    expect(edge.provider.calls).toHaveLength(0);
  });
});
