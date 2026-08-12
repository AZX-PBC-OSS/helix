import { describe, expect, it } from "vitest";
import { randomBytes, scryptSync } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { SCRYPT_KEYLEN, SCRYPT_PARAMS, type VisibilityMode } from "@azx-pbc/shared";
import { buildApp } from "../app.js";
import { testAuthConfig, testEdgeConfig } from "../test/config.js";
import {
  FakeBlobReader,
  FakeOidcClient,
  FakeRegistry,
  FakeSessionStore,
  registryEntry,
} from "../test/fakes.js";
import { LoginThrottle } from "./loginThrottle.js";
import { InMemoryCounterStore } from "../gateway/counterStore.js";

/**
 * Adversarial twin for the shared-password challenge (`password` visibility,
 * docs/features/authentication.md). The flow is same-origin on the app host:
 * a correct password mints a `__Host-session` directly. These exercise the
 * threat surface — wrong password, login-CSRF, brute force, fetch vs nav, and
 * the per-session pseudonym — alongside the happy path.
 */

const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PREFIX = "apps/c/1/";
const PASSWORD = "correct-horse-battery-staple";
const ORIGIN = "https://pw.local.helix.azxlabs.io:8080";

/** scrypt at the shared cost — matches apps/portal/src/access/password.ts and the edge verifier. */
function hashFor(password: string): { passwordHash: string; passwordSalt: string } {
  const salt = randomBytes(16);
  return {
    passwordHash: scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS).toString("hex"),
    passwordSalt: salt.toString("hex"),
  };
}

function buildEdge(
  opts: { visibilityMode?: VisibilityMode; withPassword?: boolean; throttle?: LoginThrottle } = {},
): FastifyInstance {
  const blob = new FakeBlobReader();
  blob.set(`${PREFIX}index.html`, {
    body: "<!doctype html><body>secret app</body>",
    contentType: "text/html; charset=utf-8",
    etag: '"html-1"',
  });
  return buildApp({
    config: testEdgeConfig({ auth: testAuthConfig(), allowUnauthenticated: false }),
    registry: new FakeRegistry([
      registryEntry({
        appId: APP_ID,
        slug: "pw",
        blobPrefix: PREFIX,
        visibilityMode: opts.visibilityMode ?? "password",
        ...(opts.withPassword === false ? {} : hashFor(PASSWORD)),
      }),
    ]),
    blob,
    sessions: new FakeSessionStore(),
    oidc: new FakeOidcClient(),
    loginThrottle: opts.throttle ?? new LoginThrottle(new InMemoryCounterStore()),
  });
}

const navHeaders = {
  host: "pw.local.helix.azxlabs.io",
  "sec-fetch-mode": "navigate",
  accept: "text/html",
};

function submit(
  app: FastifyInstance,
  payload: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url: "/_auth/login",
    headers: {
      host: "pw.local.helix.azxlabs.io",
      origin: ORIGIN,
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    payload: new URLSearchParams(payload).toString(),
  });
}

/** Pull the `__Host-session` cookie value out of a Set-Cookie header. */
function sessionCookie(res: { headers: Record<string, unknown> }): string | null {
  const raw = res.headers["set-cookie"];
  const header = Array.isArray(raw) ? raw.join("\n") : (raw as string | undefined);
  const m = header?.match(/__Host-session=([^;]+)/);
  return m ? m[1]! : null;
}

describe("GET /_auth/login (the challenge page)", () => {
  it("serves the password form with a strict CSP and an SSO link", async () => {
    const res = await buildEdge().inject({
      method: "GET",
      url: "/_auth/login",
      headers: navHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="password"');
    expect(res.body).toContain("/_auth/login");
    // Hidden per-app username so password managers can save/offer the credential
    // (and to satisfy the password-form a11y guidance).
    expect(res.body).toContain('name="username"');
    expect(res.body).toContain('autocomplete="username"');
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    // A password app also admits SSO users — the page links to the auth host.
    expect(res.body).toContain("auth.local.helix.azxlabs.io");
    expect(res.body).toContain("/start?app=pw");
  });

  it("404s on a non-password app (no signal that login even exists)", async () => {
    const res = await buildEdge({ visibilityMode: "internal" }).inject({
      method: "GET",
      url: "/_auth/login",
      headers: navHeaders,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /_auth/login (verification)", () => {
  it("mints a session on the correct password and redirects to rd", async () => {
    const app = buildEdge();
    const res = await submit(app, { password: PASSWORD, rd: "/dashboard" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/dashboard");
    const cookie = sessionCookie(res);
    expect(cookie).toBeTruthy();

    // The minted session serves the app and reports a pseudonymous identity.
    const me = await app.inject({
      method: "GET",
      url: "/_api/me",
      headers: { host: "pw.local.helix.azxlabs.io", cookie: `__Host-session=${cookie}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.id).toMatch(/^pw_/);
    expect(me.json().user.displayName).toBe("Guest");
  });

  it("rejects a wrong password (401, no cookie, form re-rendered)", async () => {
    const app = buildEdge();
    const res = await submit(app, { password: "wrong-password-guess", rd: "/" });
    expect(res.statusCode).toBe(401);
    expect(sessionCookie(res)).toBeNull();
    expect(res.body).toContain("Incorrect password");
  });

  it("rejects a foreign Origin and a cross-site fetch-metadata (403 — login CSRF)", async () => {
    const app = buildEdge();
    // A cross-origin POST always carries Origin; a mismatch is refused — but
    // with the retry form, never a bare "Forbidden" page, and never a cookie.
    const foreign = await submit(app, { password: PASSWORD }, { origin: "https://evil.example" });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.body).toContain('name="password"');
    expect(sessionCookie(foreign)).toBeNull();

    // Sec-Fetch-Site is authoritative where present: a sibling-subdomain
    // (same-site) or external (cross-site) post is refused even if it spoofs no
    // Origin.
    for (const site of ["cross-site", "same-site"]) {
      const res = await app.inject({
        method: "POST",
        url: "/_auth/login",
        headers: {
          host: "pw.local.helix.azxlabs.io",
          "sec-fetch-site": site,
          "content-type": "application/x-www-form-urlencoded",
        },
        payload: new URLSearchParams({ password: PASSWORD }).toString(),
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it("accepts a same-origin form POST that omits Origin (Firefox/Safari behavior)", async () => {
    const app = buildEdge();
    // No Origin, no Sec-Fetch-Site — a cross-origin attacker could not strip
    // Origin, so an absent one is necessarily same-origin. The correct password
    // then mints a session.
    const res = await app.inject({
      method: "POST",
      url: "/_auth/login",
      headers: {
        host: "pw.local.helix.azxlabs.io",
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams({ password: PASSWORD, rd: "/" }).toString(),
    });
    expect(res.statusCode).toBe(302);
    expect(sessionCookie(res)).toBeTruthy();
  });

  it("accepts a same-origin Sec-Fetch-Site post", async () => {
    const app = buildEdge();
    const res = await app.inject({
      method: "POST",
      url: "/_auth/login",
      headers: {
        host: "pw.local.helix.azxlabs.io",
        "sec-fetch-site": "same-origin",
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams({ password: PASSWORD, rd: "/" }).toString(),
    });
    expect(res.statusCode).toBe(302);
  });

  it("404s a login POST on a non-password app", async () => {
    const res = await submit(buildEdge({ visibilityMode: "internal" }), { password: PASSWORD });
    expect(res.statusCode).toBe(404);
  });

  it("throttles brute force — blocks after the failure budget (429)", async () => {
    const throttle = new LoginThrottle(new InMemoryCounterStore(), {
      maxFailures: 3,
      windowMs: 60_000,
    });
    const app = buildEdge({ throttle });
    for (let i = 0; i < 3; i++) {
      expect((await submit(app, { password: "nope" })).statusCode).toBe(401);
    }
    const blocked = await submit(app, { password: "nope" });
    expect(blocked.statusCode).toBe(429);
    // Even the correct password is refused while blocked.
    expect((await submit(app, { password: PASSWORD })).statusCode).toBe(429);
  });
});

describe("the session gate for password apps", () => {
  it("redirects a no-cookie navigation to the same-origin login", async () => {
    const res = await buildEdge().inject({ method: "GET", url: "/secret", headers: navHeaders });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("/_auth/login");
    expect(res.headers.location).toContain("rd=%2Fsecret");
  });

  it("401s a fetch (non-navigation) rather than redirecting", async () => {
    const res = await buildEdge().inject({
      method: "GET",
      url: "/_api/me",
      headers: { host: "pw.local.helix.azxlabs.io" },
    });
    expect(res.statusCode).toBe(401);
  });
});
