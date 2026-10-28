import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthConfig, EdgeConfig } from "../../config.js";
import { publicOrigin } from "../../config.js";
import type {
  OperatorSettingsReader,
  RegistryEntry,
  RegistryReader,
} from "../../registry/projection.js";
import { sendNotFound } from "../../errors.js";
import { resolveServingEntry } from "./appHost.js";
import { SESSION_COOKIE, parseCookieHeader, serializeSessionCookie } from "../cookies.js";
import { hashSessionToken, newSessionId, newSessionToken, type SessionStore } from "../sessions.js";
import { isSameOriginFormPost, validateReturnPath } from "../validate.js";
import { newPasswordPrincipal, verifyPassword } from "../password.js";
import type { LoginThrottle } from "../loginThrottle.js";
import {
  AUTH_PAGE_CSP,
  escapeHtml,
  renderAuthPage,
  renderSiteAbout,
  type SiteOperator,
} from "../../serving/authChrome.js";

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
  /** The operator identity shown on the page; absent renders the platform defaults. */
  operator?: OperatorSettingsReader | null;
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
  // Operator policy (EDGE_ALLOW_PASSWORD_APPS): when password apps are forbidden
  // the challenge is dead — 404, same no-signal shape as the mode check above.
  // The asset path 403s in parallel; the owner migrates the app down in the portal.
  if (!rt.config.allowPasswordApps) {
    sendNotFound(reply);
    return null;
  }
  return entry;
}

/** The form field that carries the access code. */
const ACCESS_CODE_FIELD = "access_code";

/** The login page's own strict CSP — the shared chrome plus a same-origin form. */
const LOGIN_CSP = `${AUTH_PAGE_CSP}; form-action 'self'`;

/** The OIDC start URL for this app — a password app also admits any SSO user. */
function ssoStartUrl(rt: PasswordLoginRuntime, slug: string, rd: string): string {
  const url = new URL(`${publicOrigin(rt.config, "auth")}/start`);
  url.searchParams.set("app", slug);
  url.searchParams.set("rd", rd);
  return url.toString();
}

/**
 * The page a web filter's crawler sees for every password app. It has no
 * username field, no Microsoft-style "organization account" wording and no
 * mention of email, and it says who hosts the site: a lone sign-in form on an
 * unexplained page is what gets a domain categorized as webmail. The app's own
 * name is not shown before sign-in (see `renderSiteAbout`).
 */
function renderLoginPage(opts: {
  rd: string;
  error: string | null;
  ssoUrl: string;
  operator: SiteOperator | null;
}): string {
  const errorBlock = opts.error ? `<p class="err" role="alert">${escapeHtml(opts.error)}</p>` : "";
  const name = opts.operator?.name ?? null;
  const ssoLabel = name ? `${name} staff? Sign in with SSO` : "Staff? Sign in with SSO";
  const body = `${errorBlock}
    <form method="POST" action="/_auth/login">
      <input type="hidden" name="rd" value="${escapeHtml(opts.rd)}">
      <label for="code">Access code</label>
      <input id="code" name="${ACCESS_CODE_FIELD}" type="password" autocomplete="off"
             autofocus required>
      <button type="submit">Continue<svg class="chevg" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button>
    </form>
    <p class="alt"><a href="${escapeHtml(opts.ssoUrl)}">${escapeHtml(ssoLabel)}</a></p>
    ${renderSiteAbout(opts.operator)}`;
  const heading = name ? `${name} access required` : "Access required";
  return renderAuthPage({
    title: heading,
    heading,
    sub: name
      ? `This page is a private site hosted by ${name}. Enter the access code you were given to continue.`
      : "This page is a private site. Enter the access code you were given to continue.",
    bodyHtml: body,
  });
}

function sendLoginPage(
  reply: FastifyReply,
  opts: {
    rd: string;
    error: string | null;
    ssoUrl: string;
    operator: SiteOperator | null;
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
      operator: rt.operator?.operatorSettings() ?? null,
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
    const field = body[ACCESS_CODE_FIELD];
    const submitted = typeof field === "string" ? field : "";
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
        operator: rt.operator?.operatorSettings() ?? null,
        error: "Couldn't verify that request. Please try again.",
        status: 403,
      });
      return;
    }

    // Reserve-first (atomic increment): count this attempt and refuse if it is
    // over budget BEFORE the scrypt verify. This closes the old
    // check-then-increment TOCTOU (issue #13) — concurrent guesses can't all
    // slip past a stale read — and caps scrypt runs at `maxFailures` per window.
    const throttleKey = `${req.ip}:${entry.appId}`;
    if ((await rt.throttle.reserve(throttleKey)).blocked) {
      sendLoginPage(reply, {
        rd,
        ssoUrl,
        operator: rt.operator?.operatorSettings() ?? null,
        error: "Too many attempts. Wait a few minutes and try again.",
        status: 429,
      });
      return;
    }

    const ok =
      submitted !== "" && (await verifyPassword(submitted, entry.passwordHash, entry.passwordSalt));
    if (!ok) {
      // The attempt is already counted by reserve(); nothing more to record.
      sendLoginPage(reply, {
        rd,
        ssoUrl,
        operator: rt.operator?.operatorSettings() ?? null,
        error: "That access code is not right — try again.",
        status: 401,
      });
      return;
    }

    await rt.throttle.clear(throttleKey);

    // Mint a fresh active session — pseudonymous principal, no groups, no
    // refresh window (refreshDueAt == expiresAt). The cookie value is fresh
    // random; the DB stores only its hash.
    const sessionToken = newSessionToken();
    const expiresAt = new Date(Date.now() + rt.auth.sessionTtlMs);
    await rt.sessions.createActive(
      {
        id: newSessionId(),
        appId: entry.appId,
        // No display half: a shared-password visitor is a fresh pseudonym per
        // login and is unattributable across sessions by construction. Storing
        // "Guest" as a captured name would render as an attribution on every
        // audit row while identifying nobody, so the columns stay null and the
        // portal falls back to showing the `pw_*` principal.
        user: {
          oid: newPasswordPrincipal(),
          displayName: "Guest",
          name: null,
          email: null,
          kind: "password",
          groups: [],
        },
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
