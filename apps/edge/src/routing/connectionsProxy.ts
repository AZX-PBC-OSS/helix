import type { FastifyReply, FastifyRequest } from "fastify";
import { capBody } from "@azx-pbc/shared/bodyCap";
import { INTERNAL_AUTH_HEADER } from "@azx-pbc/shared";
import { spanUrlAttributes } from "@azx-pbc/shared/logging";
import { ATTR_METHOD, ROUTE_CONNECTIONS, SPAN_CONNECTIONS_PROXY } from "@azx-pbc/shared/telemetry";
import { sendNotFound, sendUnavailable } from "../errors.js";
import { mintInternalToken } from "../internalJwt.js";
import { spanRoute } from "../telemetry.js";
import type { PortalProvider } from "./portalProvider.js";

/**
 * The auth host's `/connections/*` reverse proxy (I-02 ADR-0002 part 3;
 * clarifications.md Q4). The consent callback and the portal-rendered
 * completion pages are control-plane surfaces, but `auth.<base>` terminates at
 * the edge and — on ACA — one hostname binds one container app, so the portal
 * cannot answer there directly. This is the one narrow join: everything under
 * the prefix forwards to the portal over the internal `PortalProvider` seam,
 * carrying T-0006's per-call internal JWT, and nothing else on the auth host
 * changes.
 *
 * Deliberately NOT a general-purpose portal forwarder: request headers ride a
 * three-name safelist (so no inbound header — an internal-JWT forgery, a
 * `traceparent`, a cookie — survives the hop), the path prefix is re-checked
 * here even though the route table already implies it, and response headers
 * pass through minus the hop-by-hop set. The callback URL carries `code` and
 * `state`, so its responses follow the auth-callback precedent:
 * `cache-control: no-store` and `referrer-policy: no-referrer`.
 */

/** The one path prefix that proxies to the portal — never widened casually. */
export const CONNECTIONS_PREFIX = "/connections";

export interface ConnectionsProxyRuntime {
  /** null ⇒ EDGE_PORTAL_URL unset; the surface 503s fail-closed. */
  portal: PortalProvider | null;
  /** null ⇒ HELIX_INTERNAL_SECRET unset; the surface 503s fail-closed. */
  internalKey: Buffer | null;
}

/**
 * Request headers forwarded to the portal. Everything else is dropped —
 * notably `cookie` (the auth host's flow cookie is edge-only, and the consent
 * surface keys identity off `state` server-side), `authorization`, and every
 * internal/trace header. Lowercase for case-insensitive comparison.
 */
const FORWARDED_HEADERS = new Set(["accept", "accept-language", "content-type"]);

/**
 * Response headers never passed back to the browser: the hop-by-hop set, the
 * length (the body re-frames as it streams through), and — defensively — the
 * internal header itself, so the minted token could never be reflected off
 * this surface even by a portal bug.
 */
const RESPONSE_BLOCKED = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  INTERNAL_AUTH_HEADER,
]);

/**
 * Per-request body cap on the one direction an unauthenticated prober can
 * pump bytes into: the consent surface posts tiny forms, so 1 MiB is generous
 * and a config knob is not warranted. The portal is a trusted platform plane,
 * so its response streams back uncapped — the fetch proxy's response cap
 * exists for third-party upstreams, and nothing here is one.
 */
const MAX_BODY_BYTES = 1024 * 1024;

function sendBadGateway(reply: FastifyReply): void {
  reply
    .status(502)
    .header("cache-control", "no-store")
    .type("text/plain; charset=utf-8")
    .send("Connections are temporarily unavailable; try again shortly.\n");
}

function sendRequestTooLarge(reply: FastifyReply): void {
  reply
    .status(413)
    .header("cache-control", "no-store")
    .type("text/plain; charset=utf-8")
    .send("Request body exceeds the size cap\n");
}

export function makeConnectionsProxyHandler(rt: ConnectionsProxyRuntime) {
  async function handleConnections(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    // Fail closed, distinguishably: no proxying, no pass-through, no crash.
    if (!rt.portal || !rt.internalKey) {
      sendUnavailable(reply, "The connections surface is not configured on this edge.");
      return;
    }

    const url = req.raw.url ?? "/";
    // Belt and braces behind the route table: the minted internal JWT must
    // never authorize anything outside the consent prefix, so the exact
    // prefix — and the absence of dot segments a downstream router might
    // normalize — is re-asserted here, on the raw URL.
    const path = url.split("?", 1)[0] ?? "/";
    const underPrefix = path === CONNECTIONS_PREFIX || path.startsWith(`${CONNECTIONS_PREFIX}/`);
    if (!underPrefix || path.split("/").some((seg) => seg === "." || seg === "..")) {
      sendNotFound(reply);
      return;
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (FORWARDED_HEADERS.has(k) && typeof v === "string") headers[k] = v;
    }

    // Abort the portal call when the browser hangs up — watching the
    // *response*, with `writableEnded` separating completion from a hang-up;
    // the same wiring `gateway/fetch.ts` uses for the egress hop.
    const abort = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) abort.abort();
    });

    const bodyless = req.method === "GET" || req.method === "HEAD";
    // Cheap fast-path: refuse a truthful oversized content-length before
    // dialing the portal. The byte counter on the re-stream below is the real,
    // framing-independent enforcement (issue #8's split).
    if (!bodyless) {
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        sendRequestTooLarge(reply);
        return;
      }
    }
    let requestCapTripped = false;
    const requestBody = bodyless
      ? null
      : capBody(req.raw, MAX_BODY_BYTES, "request", () => {
          requestCapTripped = true;
        });

    try {
      // Per-call mint (T-0006, `aud: portal`): the token is the only thing
      // that authorizes the portal's internal routes, so it is minted fresh
      // for every forwarded call.
      const internalToken = await mintInternalToken(rt.internalKey);
      const res = await rt.portal.proxy({
        method: req.method,
        target: url,
        headers,
        body: requestBody,
        signal: abort.signal,
        correlationId: String(req.id),
        internalToken,
      });

      reply.status(res.status);
      for (const [k, v] of Object.entries(res.headers)) {
        if (!RESPONSE_BLOCKED.has(k) && v !== undefined) reply.header(k, v);
      }
      // The auth-callback precedent (design.md §Consent journey), set AFTER
      // the passthrough so the edge's posture holds even if the portal's
      // response ever omitted them — the callback URL carries `code`/`state`.
      reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
      return reply.send(res.body);
    } catch {
      if (requestCapTripped) {
        sendRequestTooLarge(reply);
        return;
      }
      req.log.warn("connections proxy request failed");
      sendBadGateway(reply);
    }
  }

  return spanRoute(
    SPAN_CONNECTIONS_PROXY,
    // Route-level span, `url.path` only (design.md §Operator-visible signals):
    // the callback URL carries `code` and `state`, and `spanUrlAttributes`
    // drops the query wholesale — nothing URL-shaped beyond the bare path
    // reaches the span.
    (req) => ({
      "http.route": ROUTE_CONNECTIONS,
      [ATTR_METHOD]: req.method,
      ...spanUrlAttributes(req.url),
    }),
    handleConnections,
  );
}
