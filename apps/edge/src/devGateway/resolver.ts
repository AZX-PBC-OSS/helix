import type { FastifyReply } from "fastify";
import type { ApiErrorCode } from "@azx-pbc/shared";
import { hashDevToken } from "@azx-pbc/shared/devToken";
import type { Caller, CallerResolver } from "../auth/gate.js";
import type { DevTokenStore } from "./devTokenStore.js";

/**
 * The dev-gateway's identity seam (dev-mode design §5.4, Appendix A.3) — a
 * `CallerResolver` that authenticates a **dev token** instead of a session and
 * yields an `env: 'dev'` caller. Every failure is fail-closed and, crucially,
 * emits **no** `Access-Control-Allow-Origin` (an unregistered origin gets no CORS
 * reflection). The order matters: token validity → app binding → lifetime →
 * origin allowlist. `env='dev'` is baked in — no request input can change it.
 */

function sendApiError(
  reply: FastifyReply,
  status: number,
  code: ApiErrorCode,
  message: string,
): void {
  reply
    .status(status)
    .header("cache-control", "no-store")
    .type("application/json; charset=utf-8")
    .send({ error: { code, message } });
}

export function makeDevTokenResolver(store: DevTokenStore): CallerResolver {
  return async function resolveDevCaller(req, reply, entry): Promise<Caller | null> {
    const header = req.headers.authorization;
    const token =
      typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice("Bearer ".length)
        : null;
    if (!token) {
      sendApiError(reply, 401, "unauthorized", "missing dev token");
      return null;
    }

    const row = await store.resolve(hashDevToken(token));
    if (!row) {
      sendApiError(reply, 401, "unauthorized", "invalid dev token");
      return null;
    }
    // The token is bound to one app; the request's path slug resolved this entry,
    // so a token for app A presented on /appB/_api/* is refused (not a mutation).
    if (row.appId !== entry.appId) {
      sendApiError(reply, 403, "forbidden", "dev token is not valid for this app");
      return null;
    }
    if (row.revokedAt !== null || row.expiresAt.getTime() <= Date.now()) {
      sendApiError(reply, 401, "unauthorized", "dev token revoked or expired");
      return null;
    }

    // Origin allowlist — the CORS equivalent of production's exact-origin CSRF
    // check. A missing or unregistered Origin fails closed with no ACAO reflected.
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : null;
    if (!origin || !row.origins.includes(origin)) {
      sendApiError(reply, 403, "forbidden", "origin is not registered for this dev token");
      return null;
    }
    req.devCorsOrigin = origin;

    return {
      authenticated: true,
      oid: row.developerOid,
      displayName: row.developerOid,
      groups: [],
      env: "dev",
    };
  };
}
