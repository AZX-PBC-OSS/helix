import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { LightMyRequestResponse } from "fastify";
import { startDevIdp, TestHttpSession, type RunningDevIdp } from "@helix/dev-idp";
import { buildApp } from "../app.js";
import { OpenIdConnectClient } from "./oidc.js";
import { PgSessionStore, hashSessionToken } from "./sessions.js";
import { FLOW_COOKIE, SESSION_COOKIE } from "./cookies.js";
import { testAuthConfig, testEdgeConfig } from "../test/config.js";
import { FakeBlobReader, FakeRegistry, registryEntry } from "../test/fakes.js";
import { TEST_DATABASE_URL, deleteApp, seedApp, type SeededApp } from "../test/seed.js";

/**
 * Appendix A end to end against the REAL pieces: oidc-provider (in-process,
 * ephemeral port) for discovery/PKCE/nonce/code exchange, and Postgres for
 * the pending-row → atomic-redeem lifecycle. The test plays the browser:
 * app.inject() for edge hops, fetch with a cookie jar for IdP hops.
 */

const REDIRECT_URI = "https://auth.localtest.me:8080/callback";
const AUTH_HOST = { host: "auth.localtest.me" };

let idp: RunningDevIdp;
let pool: Pool;
let sessions: PgSessionStore;
let oidc: OpenIdConnectClient;
let app: FastifyInstance;
let privateApp: SeededApp;
let groupApp: SeededApp;

function cookieValue(res: LightMyRequestResponse, name: string): string | undefined {
  const headers = res.headers["set-cookie"];
  const list = Array.isArray(headers) ? headers : headers ? [headers] : [];
  const line = list.find((l) => l.startsWith(`${name}=`));
  return line?.slice(name.length + 1).split(";", 1)[0] || undefined;
}

/** Drive the IdP (real HTTP) from the authorize URL to the edge callback URL. */
async function browseIdpLogin(
  authorizeUrl: string,
  userEmail: string,
  browser: TestHttpSession = new TestHttpSession(),
): Promise<URL> {
  const session = browser;
  let current = authorizeUrl;
  for (let hop = 0; hop < 12; hop++) {
    const res = await session.request(current);
    if (res.status >= 300 && res.status < 400) {
      const next = new URL(res.headers.get("location") ?? "/", current);
      await res.body?.cancel();
      if (next.toString().startsWith(REDIRECT_URI)) return next; // back to the edge
      current = next.toString();
      continue;
    }
    // The interaction picker — complete via the deterministic ?user= hook.
    await res.body?.cancel();
    if (!/\/interaction\//.test(current)) throw new Error(`stalled at ${current} (${res.status})`);
    const withUser = new URL(current);
    withUser.searchParams.set("user", userEmail);
    current = withUser.toString();
  }
  throw new Error("IdP login did not return to the edge");
}

/** Full login; returns the redeemed session cookie value and the complete URL. */
async function loginAs(
  userEmail: string,
  slug: string,
  rd = "/page",
  browser: TestHttpSession = new TestHttpSession(),
): Promise<{
  callbackRes: LightMyRequestResponse;
  completeUrl?: URL;
  redeemRes?: LightMyRequestResponse;
  sessionCookie?: string;
}> {
  const start = await app.inject({
    url: `/start?app=${slug}&rd=${encodeURIComponent(rd)}`,
    headers: AUTH_HOST,
  });
  expect(start.statusCode).toBe(302);
  const flowCookie = cookieValue(start, FLOW_COOKIE);

  const callbackUrl = await browseIdpLogin(start.headers.location as string, userEmail, browser);
  const callbackRes = await app.inject({
    url: callbackUrl.pathname + callbackUrl.search,
    headers: { ...AUTH_HOST, cookie: `${FLOW_COOKIE}=${flowCookie}` },
  });
  if (callbackRes.statusCode !== 302) return { callbackRes };

  const completeUrl = new URL(callbackRes.headers.location as string);
  const redeemRes = await app.inject({
    url: completeUrl.pathname + completeUrl.search,
    headers: { host: completeUrl.host },
  });
  return {
    callbackRes,
    completeUrl,
    redeemRes,
    sessionCookie: cookieValue(redeemRes, SESSION_COOKIE),
  };
}

beforeAll(async () => {
  idp = await startDevIdp({ edgeRedirectUris: [REDIRECT_URI] });
  pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
  privateApp = await seedApp(pool, { live: true });
  groupApp = await seedApp(pool, {
    live: true,
    visibilityMode: "group",
    visibilityGroupId: "eng-team",
  });

  const auth = testAuthConfig({
    issuerUrl: idp.issuer,
    clientId: "helix-edge",
    credential: { kind: "secret", clientSecret: "edge-dev-secret" },
    allowInsecureIdp: true,
  });
  sessions = new PgSessionStore(TEST_DATABASE_URL, { max: 4 });
  oidc = new OpenIdConnectClient(auth, REDIRECT_URI, { info: () => {}, warn: () => {} });
  await oidc.start();
  expect(oidc.isReady()).toBe(true);

  const registry = new FakeRegistry([
    registryEntry({
      appId: privateApp.appId,
      slug: privateApp.slug,
      blobPrefix: privateApp.blobPrefix,
    }),
    registryEntry({
      appId: groupApp.appId,
      slug: groupApp.slug,
      blobPrefix: groupApp.blobPrefix,
      visibilityMode: "group",
      visibilityGroupId: "eng-team",
    }),
  ]);
  const blob = new FakeBlobReader();
  blob.set(`${privateApp.blobPrefix}index.html`, {
    body: "<body>private app</body>",
    contentType: "text/html",
  });
  app = buildApp({
    // The gate is live: assets and /_api/me require the session minted above.
    config: testEdgeConfig({ auth, allowUnauthenticated: false }),
    registry,
    blob,
    sessions,
    oidc,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  oidc.stop();
  await sessions.close();
  await deleteApp(pool, privateApp.appId);
  await deleteApp(pool, groupApp.appId);
  await pool.end();
  await idp.close();
});

describe("the full Appendix A flow against real oidc-provider + Postgres", () => {
  it("logs alice into a private app and lands on rd", async () => {
    const { redeemRes, sessionCookie, completeUrl } = await loginAs(
      "alice@azx.dev",
      privateApp.slug,
      "/deep/link?q=1",
    );
    expect(redeemRes?.statusCode).toBe(302);
    expect(redeemRes?.headers.location).toBe("/deep/link?q=1");
    expect(completeUrl?.host).toBe(`${privateApp.slug}.localtest.me:8080`);
    expect(sessionCookie).toBeTruthy();

    // The session row is real: alice's identity + group snapshot, app-scoped.
    const session = await sessions.lookup(
      hashSessionToken(sessionCookie as string),
      privateApp.appId,
    );
    expect(session?.user.displayName).toBe("Alice Anders");
    expect(session?.user.groups).toEqual(["eng-team", "platform-admins"]);
    expect(
      await sessions.lookup(hashSessionToken(sessionCookie as string), groupApp.appId),
    ).toBeNull();
  });

  it("admits bob (in eng-team) to the group app, and refuses mallory", async () => {
    const bob = await loginAs("bob@azx.dev", groupApp.slug);
    expect(bob.redeemRes?.statusCode).toBe(302);
    expect(bob.sessionCookie).toBeTruthy();

    const mallory = await loginAs("mallory@azx.dev", groupApp.slug);
    expect(mallory.callbackRes.statusCode).toBe(403);
    expect(mallory.completeUrl).toBeUndefined();
  });

  it("rejects a handoff replay (the atomic burn, on real Postgres)", async () => {
    const { completeUrl, redeemRes } = await loginAs("alice@azx.dev", privateApp.slug);
    expect(redeemRes?.statusCode).toBe(302);
    const replay = await app.inject({
      url: (completeUrl as URL).pathname + (completeUrl as URL).search,
      headers: { host: (completeUrl as URL).host },
    });
    expect(replay.statusCode).toBe(403);
    expect(replay.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects an authorization-code replay at the real token endpoint", async () => {
    const start = await app.inject({
      url: `/start?app=${privateApp.slug}&rd=/`,
      headers: AUTH_HOST,
    });
    const flowCookie = cookieValue(start, FLOW_COOKIE);
    const callbackUrl = await browseIdpLogin(start.headers.location as string, "alice@azx.dev");

    const first = await app.inject({
      url: callbackUrl.pathname + callbackUrl.search,
      headers: { ...AUTH_HOST, cookie: `${FLOW_COOKIE}=${flowCookie}` },
    });
    expect(first.statusCode).toBe(302);

    // Same code, fresh flow? No — same flow cookie too: the IdP must refuse
    // the second exchange (single-use codes), so no second handoff exists.
    const second = await app.inject({
      url: callbackUrl.pathname + callbackUrl.search,
      headers: { ...AUTH_HOST, cookie: `${FLOW_COOKIE}=${flowCookie}` },
    });
    expect(second.statusCode).toBe(400);
  });

  it("serves gated assets and /_api/me with the minted session", async () => {
    const host = { host: `${privateApp.slug}.localtest.me` };
    // Before login: navigation → login redirect; fetch → 401.
    const anon = await app.inject({ url: "/", headers: { ...host, "sec-fetch-mode": "navigate" } });
    expect(anon.statusCode).toBe(302);
    expect(anon.headers.location).toContain("https://auth.localtest.me:8080/start");

    const { sessionCookie } = await loginAs("alice@azx.dev", privateApp.slug);
    const cookie = `${SESSION_COOKIE}=${sessionCookie}`;

    const page = await app.inject({ url: "/", headers: { ...host, cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("private app");

    const me = await app.inject({ url: "/_api/me", headers: { ...host, cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({
      user: { id: "5f0d5d2a-9d3f-4b1e-8c5a-111111111111", displayName: "Alice Anders" },
    });
  });

  it("silently refreshes a due session via prompt=none on the live IdP", async () => {
    // One browser for both round-trips — the IdP session cookie is what makes
    // prompt=none succeed without an interaction.
    const browser = new TestHttpSession();
    const { sessionCookie } = await loginAs("alice@azx.dev", privateApp.slug, "/page", browser);
    const host = { host: `${privateApp.slug}.localtest.me` };

    // Make the session refresh-due, then navigate: the gate detours to
    // /start?silent=1.
    await pool.query(
      `UPDATE sessions SET "refreshDueAt" = now() - interval '1 minute' WHERE "tokenHash" = $1`,
      [hashSessionToken(sessionCookie as string)],
    );
    const nav = await app.inject({
      url: "/page",
      headers: {
        ...host,
        "sec-fetch-mode": "navigate",
        cookie: `${SESSION_COOKIE}=${sessionCookie}`,
      },
    });
    expect(nav.statusCode).toBe(302);
    const startUrl = new URL(nav.headers.location as string);
    expect(startUrl.searchParams.get("silent")).toBe("1");

    // Follow the detour: /start mints a prompt=none authorize URL…
    const start = await app.inject({
      url: startUrl.pathname + startUrl.search,
      headers: AUTH_HOST,
    });
    expect(start.statusCode).toBe(302);
    const authorizeUrl = new URL(start.headers.location as string);
    expect(authorizeUrl.searchParams.get("prompt")).toBe("none");
    const flowCookie = cookieValue(start, FLOW_COOKIE);

    // …which the IdP satisfies with NO interaction (same browser jar).
    const res = await browser.request(authorizeUrl.toString());
    expect([302, 303]).toContain(res.status);
    let next = new URL(res.headers.get("location") ?? "/", authorizeUrl);
    await res.body?.cancel();
    while (!next.toString().startsWith(REDIRECT_URI)) {
      const hop = await browser.request(next.toString());
      expect(hop.status, `unexpected interaction at ${next}`).toBeGreaterThanOrEqual(300);
      expect(hop.status).toBeLessThan(400);
      next = new URL(hop.headers.get("location") ?? "/", next);
      await hop.body?.cancel();
    }

    // The callback completes into a fresh session with a fresh snapshot.
    const callbackRes = await app.inject({
      url: next.pathname + next.search,
      headers: { ...AUTH_HOST, cookie: `${FLOW_COOKIE}=${flowCookie}` },
    });
    expect(callbackRes.statusCode).toBe(302);
    const completeUrl = new URL(callbackRes.headers.location as string);
    const redeemRes = await app.inject({
      url: completeUrl.pathname + completeUrl.search,
      headers: { host: completeUrl.host },
    });
    expect(redeemRes.statusCode).toBe(302);
    expect(redeemRes.headers.location).toBe("/page");
    const fresh = cookieValue(redeemRes, SESSION_COOKIE);
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(sessionCookie);

    const session = await sessions.lookup(hashSessionToken(fresh as string), privateApp.appId);
    expect(session?.user.groups).toEqual(["eng-team", "platform-admins"]);
    expect(session?.refreshDueAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects a callback whose state was swapped (real state validation)", async () => {
    const start = await app.inject({
      url: `/start?app=${privateApp.slug}&rd=/`,
      headers: AUTH_HOST,
    });
    const flowCookie = cookieValue(start, FLOW_COOKIE);
    const callbackUrl = await browseIdpLogin(start.headers.location as string, "alice@azx.dev");
    callbackUrl.searchParams.set("state", "swapped-by-attacker");

    const res = await app.inject({
      url: callbackUrl.pathname + callbackUrl.search,
      headers: { ...AUTH_HOST, cookie: `${FLOW_COOKIE}=${flowCookie}` },
    });
    expect(res.statusCode).toBe(400);
  });
});
