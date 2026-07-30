import { z } from "zod";

/**
 * The fetch-proxy wire contract (design doc `docs/design/fetch-proxy.md`).
 *
 * Apps call `fetch('/_api/fetch/https://api.example.com/...')` — same-origin, so
 * it satisfies `connect-src 'self'` with no CSP widening; method, safelisted
 * headers, and body pass through, and the response streams back unchanged
 * (§3.1). The edge enforces policy and forwards to `azx-egress` over an internal
 * HTTP seam carrying the attested instruction; egress performs the call. The
 * shapes here are the small pieces both services (and tests) share — there is no
 * JSON envelope, because the proxy is transparent and streaming.
 */

/** Same-origin path prefix the edge serves the proxy on. */
export const FETCH_PROXY_PREFIX = "/_api/fetch/";

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * Extract the target URL from a `/_api/fetch/<url>` request URL — raw first,
 * then percent-decoded, so both shapes the shim and hand-written callers
 * produce resolve to the same target. `indexOf` rather than `startsWith`: the
 * dev gateway serves the same handler under `/:slug/_api/fetch/*`.
 *
 * Shared because two callers must agree on what "the target" is: the gateway
 * authorizes it against the manifest (`apps/edge/src/gateway/fetch.ts`) and the
 * log serializer redacts it (`@azx-pbc/shared/logging`). If those two ever
 * parsed differently, the log would describe a call the edge didn't make.
 */
export function parseFetchTarget(rawUrl: string): URL | null {
  const i = rawUrl.indexOf(FETCH_PROXY_PREFIX);
  if (i === -1) return null;
  const tail = rawUrl.slice(i + FETCH_PROXY_PREFIX.length);
  if (!tail) return null;
  for (const candidate of [tail, safeDecode(tail)]) {
    if (candidate === null) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" || url.protocol === "http:") return url;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// ── Internal edge → egress transport (control via headers; bodies stream) ─────

/** Carries the signed attested instruction JWT (edge → egress). */
export const INSTRUCTION_HEADER = "x-helix-instruction";
/** The full target URL the edge authorized (egress checks origin == instruction.origin). */
export const TARGET_HEADER = "x-helix-target";
/** The upstream HTTP method to use (egress preserves the app's method). */
export const METHOD_HEADER = "x-helix-method";
/** Egress → edge: the outcome label for the edge to meter into `gateway_calls`. */
export const OUTCOME_HEADER = "x-helix-egress-outcome";

/**
 * Request headers the proxy forwards upstream. Everything else is dropped —
 * notably `cookie` and `authorization` (the app must not smuggle the session
 * cookie outbound nor override the injected credential) and hop-by-hop headers
 * (§6). Lowercase for case-insensitive comparison.
 *
 * `anthropic-version` is here for the `llm` capability: the edge sets it as a
 * constant on the vendor call it routes through egress. It is a benign API
 * version string — allowing an app to send it on a `fetch` call is meaningless.
 */
export const REQUEST_HEADER_SAFELIST: readonly string[] = [
  "accept",
  "accept-language",
  "anthropic-version",
  "content-type",
  "if-modified-since",
  "if-none-match",
  "user-agent",
];

/**
 * Response headers stripped before the upstream response is returned to the app
 * (§6) — credentials and transport framing never reach the browser. `authorization`
 * is a static backstop against an upstream reflecting the injected bearer credential
 * (issue #7); egress additionally strips whatever header it injected *dynamically*
 * (arbitrary `header`-recipe names a fixed list can't enumerate — see
 * `apps/egress/src/proxy.ts`). `www-authenticate` is intentionally NOT here: it is a
 * server-issued challenge, not a reflection of the injected secret.
 *
 * `location` is stripped so the browser can never follow an upstream redirect back
 * out of the proxy (egress does not chase redirects — `maxRedirections: 0` — and a
 * forwarded `Location` would let the browser chase it un-proxied). This makes the
 * non-follow policy end-to-end explicit (ADR-0005, issue #10). `content-location`
 * is *not* stripped — it doesn't drive navigation — but egress redacts an injected
 * query secret reflected in it (issue #7).
 */
export const RESPONSE_HEADER_BLOCKLIST: readonly string[] = [
  "set-cookie",
  "set-cookie2",
  "authorization",
  "location",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "trailer",
  "upgrade",
];

// ── App-facing error shape ────────────────────────────────────────────────────

/**
 * Error codes the proxy returns as JSON (the app's `fetch` resolves with the
 * status + this body) when the call is refused before/instead of an upstream
 * response. `blocked` is an SSRF refusal; `bad_target` a malformed/undecodable
 * target; `too_large` a request body over the size cap (413, refused before the
 * upstream call); `replay` a re-presented attested instruction whose one-time
 * `jti` was already burned (409, refused at egress before any upstream call —
 * ADR-0013 Step 1, issue #3); `upstream_error` an egress/transport failure. (A
 * *response* over the cap cannot use this code — status + headers are already
 * flushed by the time the byte counter trips, so the body is truncated instead;
 * see issue #8 and `@azx-pbc/shared` `capBody`.)
 */
export const FETCH_ERROR_CODES = [
  "forbidden",
  "rate_limited",
  "bad_target",
  "blocked",
  "too_large",
  "replay",
  "upstream_error",
] as const;
export const FetchErrorCodeSchema = z.enum(FETCH_ERROR_CODES);
export type FetchErrorCode = z.infer<typeof FetchErrorCodeSchema>;

export const FetchProxyErrorSchema = z.object({
  code: FetchErrorCodeSchema,
  message: z.string(),
});
export type FetchProxyError = z.infer<typeof FetchProxyErrorSchema>;
