import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { LightMyRequestResponse } from "fastify";
import { buildApp } from "../app.js";
import { deriveAuthKeys } from "./secrets.js";
import { mintHandoffToken } from "./handoff.js";
import { hashSessionToken } from "./sessions.js";
import { FLOW_COOKIE, SESSION_COOKIE } from "./cookies.js";
import { mintFlowToken } from "./flow.js";
import { testAuthConfig, testEdgeConfig, TEST_AUTH_SECRET } from "../test/config.js";
import {
  FakeBlobReader,
  FakeOidcClient,
  FakeRegistry,
  FakeSessionStore,
  registryEntry,
} from "../test/fakes.js";

/**
 * The adversarial suite for the handoff path (project plan §4 M3, §6:
 * adversarial tests land WITH the auth code). Each block names the attack it
 * kills. Unit-level — fakes for IdP and store; the concurrency race and the
 * real-IdP flow live in the integration suites.
 */

const APP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const APP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AUTH_HOST = { host: "auth.localtest.me" };
const KEYS = deriveAuthKeys(TEST_AUTH_SECRET);

interface AuthEdge {
  app: FastifyInstance;
  sessions: FakeSessionStore;
  oidc: FakeOidcClient;
  registry: FakeRegistry;
}

function buildAuthEdge(): AuthEdge {
  const registry = new FakeRegistry([
    registryEntry({ appId: APP_A, slug: "appa", blobPrefix: "apps/a/1/" }),
    registryEntry({ appId: APP_B, slug: "appb", blobPrefix: "apps/b/1/" }),
    registryEntry({
      appId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      slug: "team",
      blobPrefix: "apps/c/1/",
      visibilityMode: "group",
      visibilityGroupId: "eng-team",
    }),
    registryEntry({
      appId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      slug: "gated",
      visibilityMode: "password",
    }),
  ]);
  const sessions = new FakeSessionStore();
  const oidc = new FakeOidcClient();
  const app = buildApp({
    config: testEdgeConfig({ auth: testAuthConfig() }),
    registry,
    blob: new FakeBlobReader(),
    sessions,
    oidc,
  });
  return { app, sessions, oidc, registry };
}

function cookieValue(res: LightMyRequestResponse, name: string): string | undefined {
  const headers = res.headers["set-cookie"];
  const list = Array.isArray(headers) ? headers : headers ? [headers] : [];
  for (const line of list) {
    if (line.startsWith(`${name}=`)) {
      const value = line.slice(name.length + 1).split(";", 1)[0];
      if (value) return value;
    }
  }
  return undefined;
}

/** Steps 1–7 of Appendix A against the fakes; returns the handoff redirect. */
async function login(
  edge: AuthEdge,
  opts: { slug?: string; rd?: string; silent?: boolean } = {},
): Promise<{ completeUrl: URL; flowCookie: string; state: string }> {
  const slug = opts.slug ?? "appa";
  const start = await edge.app.inject({
    url: `/start?app=${slug}&rd=${encodeURIComponent(opts.rd ?? "/page")}${opts.silent ? "&silent=1" : ""}`,
    headers: AUTH_HOST,
  });
  expect(start.statusCode).toBe(302);
  const flowCookie = cookieValue(start, FLOW_COOKIE);
  expect(flowCookie).toBeTruthy();
  const state = new URL(start.headers.location as string).searchParams.get("state");
  expect(state).toBeTruthy();

  const callback = await edge.app.inject({
    url: `/callback?code=good&state=${state}`,
    headers: { ...AUTH_HOST, cookie: `${FLOW_COOKIE}=${flowCookie}` },
  });
  expect(callback.statusCode).toBe(302);
  return {
    completeUrl: new URL(callback.headers.location as string),
    flowCookie: flowCookie as string,
    state: state as string,
  };
}

async function redeem(
  edge: AuthEdge,
  completeUrl: URL,
  opts: { host?: string; cookie?: string } = {},
): Promise<LightMyRequestResponse> {
  return edge.app.inject({
    url: completeUrl.pathname + completeUrl.search,
    headers: {
      host: opts.host ?? completeUrl.host,
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
  });
}

describe("the happy path (everything the attacks try to subvert)", () => {
  it("start → callback → complete mints a host-scoped session", async () => {
    const edge = buildAuthEdge();
    const { completeUrl } = await login(edge, { rd: "/deep/link?q=1" });

    expect(completeUrl.host).toBe("appa.localtest.me:8080");
    expect(completeUrl.protocol).toBe("https:");
    expect(completeUrl.pathname).toBe("/_auth/complete");

    const res = await redeem(edge, completeUrl);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/deep/link?q=1");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");

    const session = cookieValue(res, SESSION_COOKIE);
    expect(session).toBeTruthy();
    // The cookie is never the URL-borne token.
    expect(completeUrl.searchParams.get("token")).not.toBe(session);
    // And the store sees only its hash, bound to the right app.
    expect(await edge.sessions.lookup(hashSessionToken(session as string), APP_A)).not.toBeNull();

    const setCookie = String(res.headers["set-cookie"]);
    for (const attr of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax"]) {
      expect(setCookie).toContain(attr);
    }
    expect(setCookie).not.toContain("Domain");
  });

  it("silent=1 requests prompt=none from the IdP", async () => {
    const edge = buildAuthEdge();
    await login(edge, { silent: true });
    expect(edge.oidc.authorizeRequests.at(-1)?.prompt).toBe("none");
  });

  it("a silent refresh the IdP cannot satisfy restarts interactively", async () => {
    const edge = buildAuthEdge();
    const start = await edge.app.inject({
      url: "/start?app=appa&rd=/page&silent=1",
      headers: AUTH_HOST,
    });
    const flowCookie = cookieValue(start, FLOW_COOKIE);
    const state = new URL(start.headers.location as string).searchParams.get("state");

    const res = await edge.app.inject({
      url: `/callback?error=login_required&state=${state}`,
      headers: { ...AUTH_HOST, cookie: `${FLOW_COOKIE}=${flowCookie}` },
    });
    expect(res.statusCode).toBe(302);
    const restart = new URL(res.headers.location as string);
    expect(restart.host).toBe("auth.localtest.me:8080");
    expect(restart.pathname).toBe("/start");
    expect(restart.searchParams.get("app")).toBe("appa");
    expect(restart.searchParams.get("rd")).toBe("/page");
    expect(restart.searchParams.get("silent")).toBeNull();
  });
});

describe("attack: handoff replay", () => {
  it("redeems exactly once; the second attempt gets 403 and no cookie", async () => {
    const edge = buildAuthEdge();
    const { completeUrl } = await login(edge);

    const first = await redeem(edge, completeUrl);
    expect(first.statusCode).toBe(302);

    const second = await redeem(edge, completeUrl);
    expect(second.statusCode).toBe(403);
    expect(second.headers["set-cookie"]).toBeUndefined();
    expect(second.headers["cache-control"]).toBe("no-store");
  });
});

describe("attack: audience confusion", () => {
  it("a token captured by appB is worthless there (JWS aud check)", async () => {
    const edge = buildAuthEdge();
    const { completeUrl } = await login(edge); // audience: appa
    const res = await redeem(edge, completeUrl, { host: "appb.localtest.me:8080" });
    expect(res.statusCode).toBe(403);
    expect(res.headers["set-cookie"]).toBeUndefined();
    // And the pending session survives for the legitimate host.
    expect((await redeem(edge, completeUrl)).statusCode).toBe(302);
  });

  it("a JWS-valid token for appB cannot redeem appA's session row (row-level check)", async () => {
    const edge = buildAuthEdge();
    const { completeUrl } = await login(edge); // pending row is appa's
    const sessionId = [...edge.sessions.byId.keys()][0] as string;

    // Hypothetical bug: a token re-minted for appB referencing appa's row.
    const crossToken = await mintHandoffToken(
      { sessionId, appId: APP_B, rd: "/" },
      KEYS.handoffKey,
      30,
    );
    const res = await edge.app.inject({
      url: `/_auth/complete?token=${crossToken}`,
      headers: { host: "appb.localtest.me:8080" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(completeUrl.searchParams.get("token")).not.toBe(crossToken);
  });
});

describe("attack: open redirect via /start", () => {
  it.each([
    "https://evil.example/",
    "http://evil.example/",
    "//evil.example/",
    "/\\evil.example",
    "\\evil.example",
    "page",
    "../up",
    "/a\rb",
  ])("rejects rd=%j with 400 and never contacts the IdP", async (rd) => {
    const edge = buildAuthEdge();
    const res = await edge.app.inject({
      url: `/start?app=appa&rd=${encodeURIComponent(rd)}`,
      headers: AUTH_HOST,
    });
    expect(res.statusCode).toBe(400);
    expect(edge.oidc.authorizeRequests).toHaveLength(0);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("404s unknown/archived apps and 503s v1 visibility modes", async () => {
    const edge = buildAuthEdge();
    expect((await edge.app.inject({ url: "/start?app=nope", headers: AUTH_HOST })).statusCode).toBe(
      404,
    );
    expect((await edge.app.inject({ url: "/start", headers: AUTH_HOST })).statusCode).toBe(404);
    expect(
      (await edge.app.inject({ url: "/start?app=gated", headers: AUTH_HOST })).statusCode,
    ).toBe(503);
  });
});

describe("attack: state/nonce tampering at /callback", () => {
  it("rejects a state that does not match the flow cookie", async () => {
    const edge = buildAuthEdge();
    const start = await edge.app.inject({ url: "/start?app=appa&rd=/", headers: AUTH_HOST });
    const flowCookie = cookieValue(start, FLOW_COOKIE);

    const res = await edge.app.inject({
      url: `/callback?code=good&state=attacker-chosen`,
      headers: { ...AUTH_HOST, cookie: `${FLOW_COOKIE}=${flowCookie}` },
    });
    expect(res.statusCode).toBe(400);
    expect(edge.sessions.byId.size).toBe(0); // no pending row, no handoff
  });

  it("rejects a callback with no flow cookie (forged or expired round-trip)", async () => {
    const edge = buildAuthEdge();
    const res = await edge.app.inject({ url: "/callback?code=good&state=x", headers: AUTH_HOST });
    expect(res.statusCode).toBe(400);
    expect(edge.sessions.byId.size).toBe(0);
  });

  it("rejects a flow cookie signed with the wrong key", async () => {
    const edge = buildAuthEdge();
    const foreignKeys = deriveAuthKeys(Buffer.from("ffffffffffffffffffffffffffffffff"));
    const forged = await mintFlowToken(
      { state: "s", nonce: "n", codeVerifier: "v", app: "appa", rd: "/", silent: false },
      foreignKeys.flowKey,
    );
    const res = await edge.app.inject({
      url: "/callback?code=good&state=s",
      headers: { ...AUTH_HOST, cookie: `${FLOW_COOKIE}=${forged}` },
    });
    expect(res.statusCode).toBe(400);
    expect(edge.sessions.byId.size).toBe(0);
  });

  it("an exchange failure (bad nonce/code — IdP-verified) mints nothing", async () => {
    const edge = buildAuthEdge();
    edge.oidc.forcedOutcome = { kind: "invalid" };
    const start = await edge.app.inject({ url: "/start?app=appa&rd=/", headers: AUTH_HOST });
    const flowCookie = cookieValue(start, FLOW_COOKIE);
    const state = new URL(start.headers.location as string).searchParams.get("state");
    const res = await edge.app.inject({
      url: `/callback?code=good&state=${state}`,
      headers: { ...AUTH_HOST, cookie: `${FLOW_COOKIE}=${flowCookie}` },
    });
    expect(res.statusCode).toBe(400);
    expect(edge.sessions.byId.size).toBe(0);
  });
});

describe("attack: session fixation at /_auth/complete", () => {
  it("ignores attacker-preset session cookies; the minted value is fresh", async () => {
    const edge = buildAuthEdge();
    const { completeUrl } = await login(edge);
    const res = await redeem(edge, completeUrl, {
      cookie: `${SESSION_COOKIE}=attacker-fixed-value`,
    });
    expect(res.statusCode).toBe(302);
    const minted = cookieValue(res, SESSION_COOKIE);
    expect(minted).toBeTruthy();
    expect(minted).not.toBe("attacker-fixed-value");
    // The attacker's value never becomes a session.
    expect(await edge.sessions.lookup(hashSessionToken("attacker-fixed-value"), APP_A)).toBeNull();
  });
});

describe("attack: visibility bypass", () => {
  it("denies a group-mode app to a user outside the group, minting nothing", async () => {
    const edge = buildAuthEdge();
    edge.oidc.identity = { oid: "oid-mallory", displayName: "Mallory", groups: [] };
    const start = await edge.app.inject({ url: "/start?app=team&rd=/", headers: AUTH_HOST });
    const flowCookie = cookieValue(start, FLOW_COOKIE);
    const state = new URL(start.headers.location as string).searchParams.get("state");
    const res = await edge.app.inject({
      url: `/callback?code=good&state=${state}`,
      headers: { ...AUTH_HOST, cookie: `${FLOW_COOKIE}=${flowCookie}` },
    });
    expect(res.statusCode).toBe(403);
    expect(edge.sessions.byId.size).toBe(0);
  });
});

describe("the two-router discipline for auth routes", () => {
  it("auth routes never answer on app or platform hosts", async () => {
    const edge = buildAuthEdge();
    // /start on an app host is an asset path, not a login endpoint.
    const onApp = await edge.app.inject({ url: "/start", headers: { host: "appa.localtest.me" } });
    expect(onApp.statusCode).toBe(404); // empty fake blob — but no redirect
    expect(onApp.headers.location).toBeUndefined();

    const onPlatform = await edge.app.inject({
      url: "/start?app=appa",
      headers: { host: "localtest.me" },
    });
    expect(onPlatform.statusCode).toBe(404);
  });

  it("/_auth/complete never answers on the auth or platform hosts", async () => {
    const edge = buildAuthEdge();
    const { completeUrl } = await login(edge);
    const onAuth = await redeem(edge, completeUrl, { host: "auth.localtest.me:8080" });
    expect(onAuth.statusCode).toBe(404);
    const onPlatform = await redeem(edge, completeUrl, { host: "localtest.me:8080" });
    expect(onPlatform.statusCode).toBe(404);
  });

  it("/_auth/* and /_api/* on app hosts never reach the blob store", async () => {
    const edge = buildAuthEdge();
    const blob = new FakeBlobReader();
    const app = buildApp({
      config: testEdgeConfig(),
      registry: edge.registry,
      blob,
      sessions: edge.sessions,
      oidc: edge.oidc,
    });
    for (const url of ["/_auth/anything", "/_auth", "/_api/me", "/_api", "/_api/llm/v1"]) {
      const res = await app.inject({ url, headers: { host: "appa.localtest.me" } });
      expect(res.statusCode, url).toBe(404);
    }
    expect(blob.requests).toHaveLength(0);
    await app.close();
  });

  it("auth routes fail closed when the auth stack is not configured", async () => {
    const app = buildApp({
      config: testEdgeConfig(), // auth: null
      registry: new FakeRegistry([registryEntry({ slug: "appa", appId: APP_A })]),
      blob: new FakeBlobReader(),
    });
    expect((await app.inject({ url: "/start?app=appa", headers: AUTH_HOST })).statusCode).toBe(503);
    expect((await app.inject({ url: "/callback", headers: AUTH_HOST })).statusCode).toBe(503);
    const complete = await app.inject({
      url: "/_auth/complete?token=x",
      headers: { host: "appa.localtest.me" },
    });
    expect(complete.statusCode).toBe(404);
    await app.close();
  });
});
