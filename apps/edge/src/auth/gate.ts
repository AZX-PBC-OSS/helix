import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthConfig, EdgeConfig } from "../config.js";
import { publicOrigin } from "../config.js";
import type { RegistryEntry } from "../registry/projection.js";
import { SESSION_COOKIE, parseCookieHeader } from "./cookies.js";
import { hashSessionToken, type Session, type SessionStore } from "./sessions.js";
import { validateReturnPath, visibilityAllows } from "./validate.js";

/**
 * The per-request session gate on app hosts (architecture §4.2): every asset
 * and `/_api/*` call happens behind it. One indexed SELECT per request — no
 * cache, so revocation is real (Appendix A.4).
 */

export interface SessionGateDeps {
  config: EdgeConfig;
  auth: AuthConfig;
  sessions: SessionStore;
}

/** Returns the session, or null after having already sent 302/401/403. */
export type SessionGate = (
  req: FastifyRequest,
  reply: FastifyReply,
  entry: RegistryEntry,
) => Promise<Session | null>;

/**
 * Top-level navigations get redirected into the login flow; subresource and
 * fetch requests get a 401 (redirecting a fetch breaks CORS, and the app
 * reloads into the navigation path anyway). `Sec-Fetch-Mode` is authoritative
 * where present (all evergreen browsers); the Accept sniff covers the rest.
 * Misclassification fails safe — a 401'd navigation is an error page, never
 * a leaked asset.
 */
export function isNavigation(req: FastifyRequest): boolean {
  const mode = req.headers["sec-fetch-mode"];
  if (typeof mode === "string" && mode !== "") {
    return mode === "navigate";
  }
  const accept = req.headers.accept;
  return typeof accept === "string" && accept.includes("text/html");
}

function redirectToStart(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: SessionGateDeps,
  entry: RegistryEntry,
  opts: { silent: boolean },
): void {
  // rd is server-derived (the URL actually requested) but validated anyway;
  // anything weird collapses to the app root.
  const rd = validateReturnPath(req.raw.url ?? "/") ?? "/";
  const start = new URL(`${publicOrigin(deps.config, "auth")}/start`);
  start.searchParams.set("app", entry.slug);
  start.searchParams.set("rd", rd);
  if (opts.silent) start.searchParams.set("silent", "1");
  reply.header("cache-control", "no-store").redirect(start.toString(), 302);
}

function sendUnauthenticated(reply: FastifyReply): void {
  reply
    .status(401)
    .header("cache-control", "no-store")
    .type("application/json; charset=utf-8")
    .send({ error: { code: "unauthorized", message: "Authentication required" } });
}

function sendRefreshRequired(reply: FastifyReply): void {
  reply
    .status(401)
    .header("cache-control", "no-store")
    .type("application/json; charset=utf-8")
    .send({ error: { code: "refresh_required", message: "Session refresh required" } });
}

/** Is this request inside the `/_api/*` platform namespace? */
function isApiPath(rawUrl: string): boolean {
  const pathname = rawUrl.split("?", 1)[0] ?? "";
  return pathname === "/_api" || pathname.startsWith("/_api/");
}

export function makeSessionGate(deps: SessionGateDeps): SessionGate {
  return async function requireSession(req, reply, entry): Promise<Session | null> {
    const token = parseCookieHeader(req.headers.cookie).get(SESSION_COOKIE);
    const session = token ? await deps.sessions.lookup(hashSessionToken(token), entry.appId) : null;

    if (!session) {
      // No session (or hard-expired — lookup filters those): interactive
      // login for navigations, 401 for everything else.
      if (isNavigation(req)) {
        redirectToStart(req, reply, deps, entry, { silent: false });
      } else {
        sendUnauthenticated(reply);
      }
      return null;
    }

    // Visibility is re-checked per request against the live registry entry —
    // tightening an app from private to group bites immediately, bounded by
    // the snapshot's staleness (≤ refresh interval). The silent refresh
    // re-snapshots groups at the IdP; a user who truly lacks the group ends
    // on the callback's 403, so this cannot loop.
    if (!visibilityAllows(entry, session.user.groups)) {
      if (isNavigation(req)) {
        redirectToStart(req, reply, deps, entry, { silent: true });
      } else {
        sendUnauthenticated(reply);
      }
      return null;
    }

    // Refresh due: navigations take the silent-refresh detour (Appendix
    // A.5). For `/_api/*` the due time is an authorization boundary — the
    // group snapshot is stale, so fetches get a 401 the app can react to
    // (reload into the navigation path) rather than 8 more hours of service
    // on old groups. Passive assets stay lenient until hard expiry.
    if (session.refreshDueAt.getTime() <= Date.now()) {
      if (isNavigation(req)) {
        redirectToStart(req, reply, deps, entry, { silent: true });
        return null;
      }
      if (isApiPath(req.raw.url ?? "/")) {
        sendRefreshRequired(reply);
        return null;
      }
    }

    return session;
  };
}
