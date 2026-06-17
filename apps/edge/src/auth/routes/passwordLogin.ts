import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthConfig, EdgeConfig } from "../../config.js";
import { publicOrigin } from "../../config.js";
import type { RegistryEntry, RegistryReader } from "../../registry/projection.js";
import { sendNotFound } from "../../errors.js";
import { resolveServingEntry } from "./appHost.js";
import { SESSION_COOKIE, parseCookieHeader, serializeSessionCookie } from "../cookies.js";
import { hashSessionToken, newSessionId, newSessionToken, type SessionStore } from "../sessions.js";
import { isSameOriginFormPost, validateReturnPath } from "../validate.js";
import { newPasswordPrincipal, verifyPassword } from "../password.js";
import type { LoginThrottle } from "../loginThrottle.js";

/**
 * The shared-password challenge (`password` visibility, docs/features/
 * authentication.md). Unlike SSO, this is entirely same-origin on the app host
 * — no auth-host round-trip, no handoff — so a correct password sets the
 * `__Host-session` cookie directly. The OIDC dedicated-review surface
 * (authHost.ts/handoff.ts/flow.ts) is deliberately untouched.
 *
 * Each visitor gets a fresh pseudonymous principal (`pw_<random>`): isolated
 * `user`-scope storage, no real identity. There is no silent refresh — the
 * session simply hard-expires and re-prompts.
 */

export interface PasswordLoginRuntime {
  config: EdgeConfig;
  auth: AuthConfig;
  registry: RegistryReader;
  sessions: SessionStore;
  throttle: LoginThrottle;
}

/** Resolve the app and require `password` visibility; otherwise 404 (no signal). */
function resolvePasswordApp(
  rt: PasswordLoginRuntime,
  slug: string,
  reply: FastifyReply,
): RegistryEntry | null {
  const entry = resolveServingEntry(rt.registry, slug, reply);
  if (!entry) return null; // resolveServingEntry already sent 404/410/503
  if (entry.visibilityMode !== "password") {
    sendNotFound(reply);
    return null;
  }
  return entry;
}

/** The login page's own strict CSP — platform HTML, so nothing app-supplied runs. */
const LOGIN_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Escape the five HTML-significant characters for safe attribute/text interpolation. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The OIDC start URL for this app — a password app also admits any SSO user. */
function ssoStartUrl(rt: PasswordLoginRuntime, slug: string, rd: string): string {
  const url = new URL(`${publicOrigin(rt.config, "auth")}/start`);
  url.searchParams.set("app", slug);
  url.searchParams.set("rd", rd);
  return url.toString();
}

function renderLoginPage(opts: {
  rd: string;
  error: string | null;
  ssoUrl: string;
  slug: string;
}): string {
  const errorBlock = opts.error ? `<p class="err" role="alert">${escapeHtml(opts.error)}</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Password required</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 15px/1.5 system-ui, sans-serif; background: #0f1115; color: #e8eaed; }
  .card { width: min(92vw, 360px); padding: 32px 28px; border-radius: 14px;
          background: #1a1d24; box-shadow: 0 12px 40px rgba(0,0,0,.4); }
  h1 { margin: 0 0 6px; font-size: 18px; }
  p.sub { margin: 0 0 20px; color: #9aa0aa; font-size: 13.5px; }
  label { display: block; margin: 0 0 6px; font-size: 13px; color: #c4c8d0; }
  input { width: 100%; box-sizing: border-box; padding: 11px 12px; border-radius: 9px;
          border: 1px solid #333845; background: #11141a; color: #e8eaed; font-size: 15px; }
  button { width: 100%; margin-top: 16px; padding: 11px; border: 0; border-radius: 9px;
           background: #4c7dff; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }
  p.err { margin: 0 0 16px; padding: 10px 12px; border-radius: 9px;
          background: rgba(255,90,90,.12); color: #ff8d8d; font-size: 13px; }
  .alt { margin: 18px 0 0; padding-top: 16px; border-top: 1px solid #2a2e37;
         text-align: center; font-size: 13px; }
  .alt a { color: #8aa6ff; text-decoration: none; }
  .alt a:hover { text-decoration: underline; }
  p.foot { margin: 16px 0 0; font-size: 11.5px; color: #6b7280; text-align: center; }
  .vh { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
        overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
</style>
</head>
<body>
  <main class="card">
    <h1>This app is password protected</h1>
    <p class="sub">Enter the shared password you were given to continue.</p>
    ${errorBlock}
    <form method="POST" action="/_auth/login">
      <input type="hidden" name="rd" value="${escapeHtml(opts.rd)}">
      <!-- A stable per-app "username" so browsers/password managers can save and
           offer the shared password (and to satisfy the password-form a11y
           guidance). It carries no auth weight — the POST handler ignores it. -->
      <label for="u" class="vh">App</label>
      <input id="u" name="username" type="text" value="${escapeHtml(opts.slug)}"
             autocomplete="username" readonly tabindex="-1" aria-hidden="true" class="vh">
      <label for="pw">Password</label>
      <input id="pw" name="password" type="password" autocomplete="current-password"
             autofocus required>
      <button type="submit">Continue</button>
    </form>
    <p class="alt"><a href="${escapeHtml(opts.ssoUrl)}">Sign in with your account instead</a></p>
    <p class="foot">Protected by AZX</p>
  </main>
</body>
</html>
`;
}

function sendLoginPage(
  reply: FastifyReply,
  opts: {
    rd: string;
    error: string | null;
    ssoUrl: string;
    slug: string;
    status: 200 | 401 | 403 | 429;
  },
): void {
  reply
    .status(opts.status)
    .header("cache-control", "no-store")
    .header("content-security-policy", LOGIN_CSP)
    .header("referrer-policy", "no-referrer")
    .header("x-frame-options", "DENY")
    .type("text/html; charset=utf-8")
    .send(renderLoginPage(opts));
}

export function makePasswordLoginPageHandler(rt: PasswordLoginRuntime) {
  return async function handleLoginPage(
    req: FastifyRequest,
    reply: FastifyReply,
    slug: string,
  ): Promise<void> {
    const entry = resolvePasswordApp(rt, slug, reply);
    if (!entry) return;

    const url = new URL(req.raw.url ?? "/", "http://app.invalid");
    const rd = validateReturnPath(url.searchParams.get("rd") ?? undefined) ?? "/";

    // Already signed in (e.g. opened the URL again): skip the prompt.
    const token = parseCookieHeader(req.headers.cookie).get(SESSION_COOKIE);
    if (token && (await rt.sessions.lookup(hashSessionToken(token), entry.appId))) {
      reply.header("cache-control", "no-store").redirect(rd, 302);
      return;
    }

    sendLoginPage(reply, {
      rd,
      error: null,
      ssoUrl: ssoStartUrl(rt, entry.slug, rd),
      slug: entry.slug,
      status: 200,
    });
  };
}

export function makePasswordLoginSubmitHandler(rt: PasswordLoginRuntime) {
  return async function handleLoginSubmit(
    req: FastifyRequest,
    reply: FastifyReply,
    slug: string,
  ): Promise<void> {
    const entry = resolvePasswordApp(rt, slug, reply);
    if (!entry) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const submitted = typeof body.password === "string" ? body.password : "";
    const rd = validateReturnPath(typeof body.rd === "string" ? body.rd : undefined) ?? "/";
    const ssoUrl = ssoStartUrl(rt, entry.slug, rd);

    // CSRF: a sibling subdomain must not be able to drive a login. This is a
    // top-level form POST (no JS), so a same-origin submit may omit Origin —
    // isSameOriginFormPost handles that via Sec-Fetch-Site / Origin-present.
    // On failure we still re-render the form (never a bare error page) so a
    // legitimate user can simply try again.
    if (
      !isSameOriginFormPost(
        req.headers.origin,
        req.headers["sec-fetch-site"],
        rt.config,
        entry.slug,
      )
    ) {
      sendLoginPage(reply, {
        rd,
        ssoUrl,
        slug: entry.slug,
        error: "Couldn't verify that request. Please try again.",
        status: 403,
      });
      return;
    }

    const throttleKey = `${req.ip}:${entry.appId}`;
    if (rt.throttle.isBlocked(throttleKey)) {
      sendLoginPage(reply, {
        rd,
        ssoUrl,
        slug: entry.slug,
        error: "Too many attempts. Wait a few minutes and try again.",
        status: 429,
      });
      return;
    }

    const ok =
      submitted !== "" && (await verifyPassword(submitted, entry.passwordHash, entry.passwordSalt));
    if (!ok) {
      rt.throttle.recordFailure(throttleKey);
      sendLoginPage(reply, {
        rd,
        ssoUrl,
        slug: entry.slug,
        error: "Incorrect password — try again.",
        status: 401,
      });
      return;
    }

    rt.throttle.clear(throttleKey);

    // Mint a fresh active session — pseudonymous principal, no groups, no
    // refresh window (refreshDueAt == expiresAt). The cookie value is fresh
    // random; the DB stores only its hash.
    const sessionToken = newSessionToken();
    const expiresAt = new Date(Date.now() + rt.auth.sessionTtlMs);
    await rt.sessions.createActive(
      {
        id: newSessionId(),
        appId: entry.appId,
        user: { oid: newPasswordPrincipal(), displayName: "Guest", groups: [] },
        refreshDueAt: expiresAt,
        expiresAt,
      },
      hashSessionToken(sessionToken),
    );

    reply
      .header("set-cookie", serializeSessionCookie(sessionToken, rt.auth.sessionTtlMs / 1000))
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .redirect(rd, 302);
  };
}
