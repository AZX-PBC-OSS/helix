import type { FastifyReply, FastifyRequest } from "fastify";
import { MeResponseSchema } from "@azx-pbc/shared";
import type { AuthConfig, EdgeConfig } from "../../config.js";
import type { RegistryEntry, RegistryReader } from "../../registry/projection.js";
import { sendForbidden, sendGone, sendNotFound, sendUnavailable } from "../../errors.js";
import {
  SESSION_COOKIE,
  clearSessionCookie,
  parseCookieHeader,
  serializeSessionCookie,
} from "../cookies.js";
import type { AuthKeys } from "../secrets.js";
import type { SessionGate } from "../gate.js";
import { verifyHandoffToken } from "../handoff.js";
import { hashSessionToken, newSessionToken, type SessionStore } from "../sessions.js";
import { isSameOrigin, resolveAppForAuth, validateReturnPath } from "../validate.js";
import { spanUrlAttributes } from "@azx-pbc/shared/logging";
import { ROUTE_AUTH_COMPLETE, SPAN_AUTH_COMPLETE } from "@azx-pbc/shared/telemetry";
import { spanRoute } from "../../telemetry.js";

/**
 * App-host side of auth (architecture Appendix A.1 step 8 + A.6): handoff
 * redemption, `/_api/me`, and logout. The redemption handler is part of the
 * dedicated-review surface.
 */

export interface AppHostAuthRuntime {
  config: EdgeConfig;
  auth: AuthConfig;
  keys: AuthKeys;
  registry: RegistryReader;
  sessions: SessionStore;
}

export function makeAuthCompleteHandler(rt: AppHostAuthRuntime) {
  return spanRoute(
    SPAN_AUTH_COMPLETE,
    // The Appendix A handoff token is in this URL — the single most sensitive
    // query string the platform mints. The query is dropped wholesale.
    (req) => ({ "http.route": ROUTE_AUTH_COMPLETE, ...spanUrlAttributes(req.url) }),
    async function handleAuthComplete(
      req: FastifyRequest,
      reply: FastifyReply,
      slug: string,
    ): Promise<void> {
      const resolved = resolveAppForAuth(rt.registry, slug);
      if (resolved.kind === "registry-unavailable") {
        sendUnavailable(reply, "Registry unavailable; try again shortly.");
        return;
      }
      if (resolved.kind !== "ok") {
        sendNotFound(reply);
        return;
      }
      const entry = resolved.entry;

      const url = new URL(req.raw.url ?? "/", "http://app.invalid");
      const token = url.searchParams.get("token");
      if (!token) {
        sendNotFound(reply);
        return;
      }

      // Audience check #1: the JWS `aud` must be THIS host's appId.
      const claims = await verifyHandoffToken(token, entry.appId, rt.keys.handoffKey, {
        ttlSec: rt.auth.handoffTtlSec,
        clockToleranceSec: rt.auth.clockToleranceSec,
      });
      if (!claims) {
        sendForbidden(reply);
        return;
      }

      // A fresh random cookie value — never the URL-borne token, and never an
      // attacker-supplied pre-set cookie (fixation: incoming cookies are simply
      // not read here). Burn-then-cookie: audience check #2 lives in the
      // store's atomic UPDATE (appId predicate), which also kills replays.
      const sessionToken = newSessionToken();
      const redeemed = await rt.sessions.redeem(
        claims.sessionId,
        entry.appId,
        hashSessionToken(sessionToken),
      );
      if (!redeemed) {
        sendForbidden(reply);
        return;
      }

      // rd is signature-covered; re-validate anyway — defense in depth.
      const rd = validateReturnPath(claims.rd) ?? "/";
      reply
        .header("set-cookie", serializeSessionCookie(sessionToken, rt.auth.sessionTtlMs / 1000))
        .header("cache-control", "no-store")
        .header("referrer-policy", "no-referrer")
        .redirect(rd, 302);
    },
  );
}

/** Shared app-resolution ladder for the session-backed app-host routes. */
export function resolveServingEntry(
  registry: RegistryReader,
  slug: string,
  reply: FastifyReply,
): RegistryEntry | null {
  if (!registry.isLoaded()) {
    sendUnavailable(reply, "Registry unavailable; try again shortly.");
    return null;
  }
  const entry = registry.getApp(slug);
  if (!entry) {
    sendNotFound(reply);
    return null;
  }
  if (entry.archived) {
    sendGone(reply);
    return null;
  }
  return entry;
}

export interface AppApiRuntime {
  config: EdgeConfig;
  registry: RegistryReader;
  sessions: SessionStore;
  gate: SessionGate;
}

/**
 * `GET /_api/me` (Appendix A.6): how a static app learns who is signed in.
 * The response is the MeResponseSchema minimum — apps are untrusted code and
 * don't get the directory profile.
 */
export function makeMeHandler(rt: AppApiRuntime) {
  return async function handleMe(
    req: FastifyRequest,
    reply: FastifyReply,
    slug: string,
  ): Promise<void> {
    const entry = resolveServingEntry(rt.registry, slug, reply);
    if (!entry) return;
    const session = await rt.gate(req, reply, entry); // fetches get 401, not 302
    if (!session) return;
    await reply.header("cache-control", "no-store").send(
      MeResponseSchema.parse({
        user: { id: session.user.oid, displayName: session.user.displayName },
      }),
    );
  };
}

/**
 * `POST /_auth/logout`: Origin-checked (belt — SameSite=Lax already blocks
 * cross-site POST cookies — and braces), deletes the server-side row so
 * revocation is immediate, clears the cookie.
 */
export function makeLogoutHandler(rt: AppApiRuntime) {
  return async function handleLogout(
    req: FastifyRequest,
    reply: FastifyReply,
    slug: string,
  ): Promise<void> {
    const entry = resolveServingEntry(rt.registry, slug, reply);
    if (!entry) return;

    if (!isSameOrigin(req.headers.origin, rt.config, entry.slug)) {
      sendForbidden(reply);
      return;
    }

    const token = parseCookieHeader(req.headers.cookie).get(SESSION_COOKIE);
    if (token) {
      await rt.sessions.delete(hashSessionToken(token), entry.appId);
    }
    await reply
      .header("set-cookie", clearSessionCookie())
      .header("cache-control", "no-store")
      .status(204)
      .send();
  };
}
