import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import type { VisibilityMode } from "@azx-pbc/shared";
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
 * everyone, an internal app must not, and a public gateway call must be
 * attributed to `anon`, never to a borrowed principal.
 */

const APP_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PREFIX = "apps/b/1/";
const MODEL = "claude-opus-4-8";

function buildEdge(opts: {
  visibilityMode: VisibilityMode;
  slug?: string;
  withLlm?: boolean;
  /** Per-IP anon cap; omit to leave the limiter off (max 0). */
  anonRateLimit?: { max: number; windowMs: number };
  /** Operator policy overrides (default: both permitted, matching the fixture). */
  allowPublicApps?: boolean;
  allowPasswordApps?: boolean;
}): {
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
    config: testEdgeConfig({
      auth: testAuthConfig(),
      allowUnauthenticated: false,
      ...(opts.anonRateLimit ? { anonRateLimit: opts.anonRateLimit } : {}),
      ...(opts.allowPublicApps !== undefined ? { allowPublicApps: opts.allowPublicApps } : {}),
      ...(opts.allowPasswordApps !== undefined
        ? { allowPasswordApps: opts.allowPasswordApps }
        : {}),
    }),
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
      headers: {
        host: "pub.local.helix.azxlabs.io",
        "sec-fetch-mode": "navigate",
        accept: "text/html",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("public");
  });

  it("still gates an internal app: a no-cookie navigation redirects to /start", async () => {
    const { app } = buildEdge({ visibilityMode: "internal", slug: "priv" });
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: {
        host: "priv.local.helix.azxlabs.io",
        "sec-fetch-mode": "navigate",
        accept: "text/html",
      },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("/start");
  });

  it("gates a password app: no-cookie navigation redirects to the same-origin /_auth/login", async () => {
    const { app } = buildEdge({ visibilityMode: "password", slug: "pw" });
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: {
        host: "pw.local.helix.azxlabs.io",
        "sec-fetch-mode": "navigate",
        accept: "text/html",
      },
    });
    expect(res.statusCode).toBe(302);
    // Same-origin app-host challenge, not the OIDC auth host.
    expect(res.headers.location).toContain("pw.local.helix.azxlabs.io");
    expect(res.headers.location).toContain("/_auth/login");
    expect(res.headers.location).not.toContain("/start");
  });
});

describe("operator policy: disallowed open surfaces (EDGE_ALLOW_*_APPS)", () => {
  it("refuses to serve a public app's assets with 403 when public is disallowed", async () => {
    const { app } = buildEdge({ visibilityMode: "public", allowPublicApps: false });
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: {
        host: "pub.local.helix.azxlabs.io",
        "sec-fetch-mode": "navigate",
        accept: "text/html",
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses a public app's /_api/* with 403 (no anonymous caller) when public is disallowed", async () => {
    const { app, usage } = buildEdge({
      visibilityMode: "public",
      withLlm: true,
      allowPublicApps: false,
    });
    const res = await app.inject({
      method: "POST",
      url: "/_api/llm/chat",
      headers: {
        host: "pub.local.helix.azxlabs.io",
        origin: "https://pub.local.helix.azxlabs.io:8080",
        "sec-fetch-mode": "cors",
        "content-type": "application/json",
      },
      payload: { model: MODEL, messages: [{ role: "user", content: "hi" }], stream: false },
    });
    expect(res.statusCode).toBe(403);
    // Refused before any provider call — nothing metered.
    expect(usage.records).toHaveLength(0);
  });

  it("refuses to serve a password app's assets with 403 when password is disallowed", async () => {
    const { app } = buildEdge({
      visibilityMode: "password",
      slug: "pw",
      allowPasswordApps: false,
    });
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: {
        host: "pw.local.helix.azxlabs.io",
        "sec-fetch-mode": "navigate",
        accept: "text/html",
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("kills the /_auth/login challenge (404) for a disallowed password app", async () => {
    const { app } = buildEdge({
      visibilityMode: "password",
      slug: "pw",
      allowPasswordApps: false,
    });
    const res = await app.inject({
      method: "GET",
      url: "/_auth/login",
      headers: { host: "pw.local.helix.azxlabs.io", accept: "text/html" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("leaves the other open surface alone: disallowing password does not block a public app", async () => {
    const { app } = buildEdge({ visibilityMode: "public", allowPasswordApps: false });
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: {
        host: "pub.local.helix.azxlabs.io",
        "sec-fetch-mode": "navigate",
        accept: "text/html",
      },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("public-app LLM gateway (anonymous caller)", () => {
  it("serves an anonymous, same-origin chat and meters it as anon", async () => {
    const { app, usage } = buildEdge({ visibilityMode: "public", withLlm: true });
    const res = await app.inject({
      method: "POST",
      url: "/_api/llm/chat",
      headers: {
        host: "pub.local.helix.azxlabs.io",
        origin: "https://pub.local.helix.azxlabs.io:8080",
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
        host: "pub.local.helix.azxlabs.io",
        origin: "https://evil.example.com",
        "sec-fetch-mode": "cors",
        "content-type": "application/json",
      },
      payload: { model: MODEL, messages: [{ role: "user", content: "hi" }], stream: false },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("public-app anonymous-tier per-IP rate limit (app-data design §7)", () => {
  const chat = (app: FastifyInstance) =>
    app.inject({
      method: "POST",
      url: "/_api/llm/chat",
      headers: {
        host: "pub.local.helix.azxlabs.io",
        origin: "https://pub.local.helix.azxlabs.io:8080",
        "sec-fetch-mode": "cors",
        "content-type": "application/json",
      },
      payload: { model: MODEL, messages: [{ role: "user", content: "hi" }], stream: false },
    });

  it("blocks an anonymous caller past the per-IP budget with 429 rate_limited", async () => {
    const { app } = buildEdge({
      visibilityMode: "public",
      withLlm: true,
      anonRateLimit: { max: 2, windowMs: 60_000 },
    });
    expect((await chat(app)).statusCode).toBe(200);
    expect((await chat(app)).statusCode).toBe(200);
    const blocked = await chat(app);
    expect(blocked.statusCode).toBe(429);
    expect(JSON.parse(blocked.body).error.code).toBe("rate_limited");
  });

  it("does not meter rate-limited requests (no write-amplification under a flood)", async () => {
    const { app, usage } = buildEdge({
      visibilityMode: "public",
      withLlm: true,
      anonRateLimit: { max: 1, windowMs: 60_000 },
    });
    await chat(app); // allowed → metered
    await chat(app); // blocked → must NOT meter
    await chat(app); // blocked → must NOT meter
    expect(usage.records).toHaveLength(1);
    expect(usage.records[0]?.outcome).toBe("ok");
  });

  it("leaves the limiter off by default (no anonRateLimit override → unlimited)", async () => {
    const { app } = buildEdge({ visibilityMode: "public", withLlm: true });
    for (let i = 0; i < 5; i++) expect((await chat(app)).statusCode).toBe(200);
  });
});
