import type { FastifyReply, FastifyRequest } from "fastify";
import { AUTH_PAGE_CSP, renderAuthPage } from "./serving/authChrome.js";
import { sendApiError } from "./gateway/llmCodec.js";

/**
 * Terminal responses for the app-serving path. Plain bodies, no app headers,
 * `no-store` — error responses must never stick in a cache. The handful a human
 * actually lands on (archived app, sign-in dead ends) get the shared "Outrun"
 * chrome; machine-facing 404/405/503 stay plain text.
 */

export function sendNotFound(reply: FastifyReply): void {
  // Unknown slug, no live version, rejected path and missing asset all answer
  // identically — don't disclose which.
  reply
    .status(404)
    .header("cache-control", "no-store")
    .type("text/plain; charset=utf-8")
    .send("Not found\n");
}

export function sendGone(reply: FastifyReply): void {
  // Archived app (architecture §7): 410 + Clear-Site-Data evicts cached UI
  // and storage. Values must be double-quoted per spec; browsers honor the
  // header on secure origins only (plain-HTTP dev: harmless no-op).
  reply
    .status(410)
    .header("cache-control", "no-store")
    .header("clear-site-data", '"cache", "storage"')
    .header("content-security-policy", AUTH_PAGE_CSP)
    .type("text/html; charset=utf-8")
    .send(
      renderAuthPage({
        title: "App archived",
        heading: "This app has been archived",
        sub: "It’s no longer available. Contact the app owner if you think this is a mistake.",
        footHtml: '<p class="foot">410 · Archived · AZX</p>',
      }),
    );
}

export function sendMethodNotAllowed(reply: FastifyReply): void {
  reply
    .status(405)
    .header("allow", "GET, HEAD")
    .header("cache-control", "no-store")
    .type("text/plain; charset=utf-8")
    .send("Method not allowed\n");
}

export function sendForbidden(reply: FastifyReply): void {
  // Replayed/foreign/expired handoff and failed visibility checks all answer
  // identically — don't disclose which guard fired.
  reply
    .status(403)
    .header("cache-control", "no-store")
    .type("text/plain; charset=utf-8")
    .send("Forbidden\n");
}

/** Auth-flow dead ends a human may see (bad params, stale flow state). */
export function sendAuthFlowError(reply: FastifyReply, status: 400 | 403, message: string): void {
  reply
    .status(status)
    .header("cache-control", "no-store")
    .header("content-security-policy", AUTH_PAGE_CSP)
    .type("text/html; charset=utf-8")
    .send(
      renderAuthPage({
        title: "Sign-in problem",
        heading: "Sign-in problem",
        sub: message,
        bodyHtml: '<p class="note">Close this tab and open the app again to restart sign-in.</p>',
      }),
    );
}

export function sendUnavailable(reply: FastifyReply, message: string): void {
  reply
    .status(503)
    .header("retry-after", "5")
    .header("cache-control", "no-store")
    .type("text/plain; charset=utf-8")
    .send(`${message}\n`);
}

/**
 * The unhandled-throw terminal (see the error handler in `app.ts`).
 *
 * A fixed body, carrying nothing about which handler threw — no code, no
 * correlation id, no module name. That is the same rule the senders above
 * follow: `sendNotFound` and `sendForbidden` are deliberately indistinguishable
 * so a guard doesn't disclose which one fired, and an unhandled 500 is the path
 * that currently violates it hardest, because Fastify's stock handler puts
 * `err.message` in the body.
 *
 * Deliberately **not** the "Outrun" chrome that `sendGone` and
 * `sendAuthFlowError` get. Those are destinations a human lands on on purpose;
 * an unhandled 500 is not a designed destination, and rendering a template on
 * the path that just proved something is broken is a second failure waiting.
 */
export function sendInternalError(reply: FastifyReply, status = 500): void {
  reply
    .status(status)
    .header("cache-control", "no-store")
    .type("text/plain; charset=utf-8")
    .send("Internal server error\n");
}

/**
 * The edge's unhandled-throw handler, registered in `app.ts` before any route.
 *
 * The edge had none, so a throw reached Fastify's stock handler — which puts
 * `err.message` into a body that untrusted app code reads. That is the exact
 * exposure `apps/egress/src/app.ts` handles deliberately on the other plane,
 * and the edge has it by a shorter path: it *is* the thing the app talks to,
 * and it holds session material, the auth HKDF keys and the instruction key.
 *
 * A free function rather than an inline closure so it is testable without
 * `buildApp` — `loggerOption()` is `false` under NODE_ENV=test, and half of
 * what matters here is what reaches the log, so the suite has to build a bare
 * Fastify with a capture stream. Inlining it would mean the test asserting on a
 * copy of the handler rather than the handler.
 */
export function edgeErrorHandler(err: unknown, req: FastifyRequest, reply: FastifyReply): void {
  // `err` is `unknown` because the edge's app instance is a cast; read
  // `statusCode` defensively rather than asserting a shape a thrown non-Error
  // would not have.
  const thrownStatus = (err as { statusCode?: unknown } | null)?.statusCode;
  const status =
    typeof thrownStatus === "number" && thrownStatus >= 400 && thrownStatus < 500
      ? thrownStatus
      : 500;

  req.log.error(
    { err, event: "edge.unhandled_error", status, hostClass: req.hostClass?.kind },
    "unhandled error in edge",
  );

  // Already answering: cut the connection, never `send`.
  //
  // This is not tidiness. `reply.send()` after headers raises
  // `FST_ERR_REP_ALREADY_SENT`, which is one of the exactly two Fastify
  // messages that interpolate the RAW request URL into a log *message*
  // (`@azx-pbc/shared/logging`'s docblock names both). The `req` serializer
  // redacts the `url` FIELD and cannot reach a message string — so this guard
  // closes a redaction bypass on the credential-bearing routes, not merely a
  // double-send bug. The streaming paths (`/_api/llm`, `/_api/fetch`) are
  // exactly where a late throw is plausible.
  if (reply.sent || reply.raw.headersSent) {
    reply.raw.destroy();
    return;
  }

  // A 4xx from Fastify itself is real and must survive: the hand-rolled
  // content-type parsers produce 400s, and Fastify raises its own 413/415.
  // Blanket-500ing those would be a behaviour regression — a trap egress avoids
  // only because it calls `removeAllContentTypeParsers()`.
  if (req.url.startsWith("/_api/")) {
    // Keep the gateway's `ApiError` envelope; an app's client parses it.
    sendApiError(reply, status, "internal", "internal server error");
    return;
  }
  sendInternalError(reply, status);
}
