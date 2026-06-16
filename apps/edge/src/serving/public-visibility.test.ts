import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import type { VisibilityMode } from "@helix/shared";
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
 * Phase 1 (app-data design §6): `public` apps are served — and may call the
 * `/_api/*` gateway — with no session and no anonymous identity. Every other
 * visibility mode stays behind the session gate. These are the adversarial
 * twins for the "no anon identity" prerequisite: a public app must serve to
 * everyone, a private app must not, and a public gateway call must be
 * attributed to `anon`, never to a borrowed principal.
 */

const APP_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PREFIX = "apps/b/1/";
const MODEL = "claude-opus-4-8";

function buildEdge(opts: { visibilityMode: VisibilityMode; slug?: string; withLlm?: boolean }): {
  app: FastifyInstance;
  usage: FakeUsageStore;
} {
  const slug = opts.slug ?? "pub";
  const blob = new FakeBlobReader();
  blob.set(`${PREFIX}index.html`, {
    body: "<!doctype html><body>public</body>",
    contentType: "text/html; charset=utf-8",
    etag: '"html-1"',
  });
  const usage = new FakeUsageStore();
  const app = buildApp({
    config: testEdgeConfig({ auth: testAuthConfig(), allowUnauthenticated: false }),
    registry: new FakeRegistry([
      registryEntry({
        appId: APP_ID,
        slug,
        blobPrefix: PREFIX,
        visibilityMode: opts.visibilityMode,
        llm: opts.withLlm ? { models: [MODEL] } : null,
      }),
    ]),
    blob,
    sessions: new FakeSessionStore(),
    oidc: new FakeOidcClient(),
    llmProvider: opts.withLlm ? new FakeLlmProvider() : null,
    usage: opts.withLlm ? usage : null,
  });
  return { app, usage };
}

describe("public-app serving (no session)", () => {
  it("serves a public app to an anonymous navigation with no cookie", async () => {
    const { app } = buildEdge({ visibilityMode: "public" });
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: "pub.localtest.me", "sec-fetch-mode": "navigate", accept: "text/html" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("public");
  });

  it("still gates a private app: a no-cookie navigation redirects to /start", async () => {
    const { app } = buildEdge({ visibilityMode: "private", slug: "priv" });
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: "priv.localtest.me", "sec-fetch-mode": "navigate", accept: "text/html" },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("/start");
  });

  it("still fails closed on a password app: no-cookie navigation redirects to /start", async () => {
    const { app } = buildEdge({ visibilityMode: "password", slug: "pw" });
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: "pw.localtest.me", "sec-fetch-mode": "navigate", accept: "text/html" },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("/start");
  });
});

describe("public-app LLM gateway (anonymous caller)", () => {
  it("serves an anonymous, same-origin chat and meters it as anon", async () => {
    const { app, usage } = buildEdge({ visibilityMode: "public", withLlm: true });
    const res = await app.inject({
      method: "POST",
      url: "/_api/llm/chat",
      headers: {
        host: "pub.localtest.me",
        origin: "https://pub.localtest.me:8080",
        "sec-fetch-mode": "cors",
        "content-type": "application/json",
      },
      payload: { model: MODEL, messages: [{ role: "user", content: "hi" }], stream: false },
    });
    expect(res.statusCode).toBe(200);
    expect(usage.records).toHaveLength(1);
    expect(usage.records[0]?.userOid).toBe("anon");
    expect(usage.records[0]?.outcome).toBe("ok");
  });

  it("still enforces CSRF on a public app: a foreign Origin is rejected", async () => {
    const { app } = buildEdge({ visibilityMode: "public", withLlm: true });
    const res = await app.inject({
      method: "POST",
      url: "/_api/llm/chat",
      headers: {
        host: "pub.localtest.me",
        origin: "https://evil.example.com",
        "sec-fetch-mode": "cors",
        "content-type": "application/json",
      },
      payload: { model: MODEL, messages: [{ role: "user", content: "hi" }], stream: false },
    });
    expect(res.statusCode).toBe(403);
  });
});
