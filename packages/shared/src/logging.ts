import { FETCH_PROXY_PREFIX, parseFetchTarget } from "./fetch.js";

/**
 * Request-log redaction (issue #20, part 3) — shared by every Fastify service.
 *
 * Several platform URLs carry a live credential in the query string: the
 * Appendix A handoff (`<slug>/_auth/complete?token=…`), the edge's OIDC callback
 * (`auth.<base>/callback?code=…`), and the portal SPA's own callback
 * (`/auth/callback?code=…`). Fastify's default request serializer writes
 * `req.url` verbatim, and in Azure that stdout lands in Log Analytics for 30
 * days — so a bounded, single-use credential becomes a retained one. This
 * module replaces that serializer.
 *
 * **Scope of the guarantee: the `req.url` FIELD.** It is not a blanket promise
 * that no URL reaches a log line. Two known paths bypass it:
 *
 *  - Fastify interpolates the raw URL into a log *message* in two places
 *    (`lib/reply.js:145` → `FST_ERR_REP_ALREADY_SENT`, and `lib/reply.js:569`).
 *    Both need a double-send bug in one of our own handlers to fire. A pino
 *    `hooks.logMethod` scanning every message string would close them, at the
 *    cost of a per-log-call scan in the trusted path — not worth it for a
 *    failure mode that is already a bug.
 *  - Hand-rolled log calls. **Anything logging a URL by hand must pass it
 *    through {@link redactUrl} first** — `req.log.info({ url: req.url })` is
 *    not covered by anything here.
 */

/**
 * Query parameters whose values never reach a log line. Names are compared
 * after percent-decoding and lowercasing, so `%74oken` can't smuggle one past.
 *
 * Deliberately over-broad: everything here is worthless in a log, so a false
 * positive costs nothing while a miss is retained for 30 days. It is still only
 * defense in depth behind the fetch-proxy rule below — a finite name list
 * cannot make an arbitrary-upstream-URL surface safe.
 */
const SENSITIVE_PARAMS = new Set([
  // Platform-minted, in URLs we generate.
  "token", // Appendix A handoff token (`/_auth/complete`)
  "code", // OIDC authorization code (edge `auth.<base>/callback`, portal `/auth/callback`)
  "id_token",
  "access_token",
  "refresh_token",
  "session",
  "sid",
  // Third-party credential conventions, for anything app-supplied.
  "api_key",
  "apikey",
  "key",
  "sig", // Azure SAS
  "signature",
  "secret",
  "client_secret",
  "password",
  "passphrase",
  "assertion",
  "authorization",
  // Not a credential: free text an IdP (or an attacker driving one) chooses.
  // Kept out of retained logs; the enumerated `error` code stays, and that is
  // what triage actually keys on. See `summarizeExchangeError` in the edge.
  "error_description",
]);

const PLACEHOLDER = "REDACTED";

function isSensitive(rawName: string): boolean {
  // `+` is a space in form-encoding; decode failures fall back to the raw name
  // rather than throwing on a malformed request line.
  const plus = rawName.replace(/\+/g, " ");
  let name: string;
  try {
    name = decodeURIComponent(plus);
  } catch {
    name = plus;
  }
  return SENSITIVE_PARAMS.has(name.trim().toLowerCase());
}

/**
 * `/_api/fetch/<target>` is the one surface a name list can't cover: the target
 * is an arbitrary third-party URL the app chose, and the shim splices it in
 * unencoded (`PREFIX + u.href`), so *its* query string becomes ours. An
 * `?api_key=` or a SAS `?sig=` would be logged verbatim, and a percent-encoded
 * target hides the whole thing in the path where the parameter scan never runs.
 *
 * So: keep origin + path (enough to tell which upstream was called — and it is
 * already in the `gateway_calls` ledger as `model`), and drop the target's query
 * wholesale. `origin` also strips any `user:pass@` userinfo. An unparseable tail
 * is dropped entirely: it can only 400 `bad_target`, and this component fails
 * closed.
 */
function redactFetchTarget(rawUrl: string, path: string): string | null {
  // Match on the PATH, not the whole URL: a query value that merely contains
  // the literal prefix (`/x?token=…&y=/_api/fetch/…`) must not divert the
  // request out of the parameter scan and back into the log intact.
  const i = path.indexOf(FETCH_PROXY_PREFIX);
  if (i === -1) return null;
  const head = rawUrl.slice(0, i + FETCH_PROXY_PREFIX.length);
  const target = parseFetchTarget(rawUrl);
  if (!target) return `${head}${PLACEHOLDER}`;
  const query = target.search ? `?${PLACEHOLDER}` : "";
  return `${head}${target.origin}${target.pathname}${query}`;
}

/**
 * Replace the values of sensitive query parameters in a raw request URL (path +
 * query, as it arrives on the wire). Everything else — path, parameter order,
 * other values — is returned byte-identical, so logs stay useful for debugging.
 *
 * The scan covers the whole post-`?` remainder and treats `&`, `;` and `#` as
 * parameter separators. A fragment can't legally reach the server and no
 * platform-minted URL uses `;` as a separator, so either shape arriving means a
 * hand-crafted request line — nothing worth preserving, and no reason to leave
 * an unscanned window in a fail-closed component.
 */
export function redactUrl(rawUrl: string): string {
  const q = rawUrl.indexOf("?");
  const path = q === -1 ? rawUrl : rawUrl.slice(0, q);

  const fetchTarget = redactFetchTarget(rawUrl, path);
  if (fetchTarget !== null) return fetchTarget;

  if (q === -1) return rawUrl;

  const params = rawUrl
    .slice(q + 1)
    .split(/([&;#])/)
    .map((part) => {
      if (part === "&" || part === ";" || part === "#") return part;
      const eq = part.indexOf("=");
      // No `=` means no value to leak — leave the bare name alone.
      if (eq === -1) return part;
      const name = part.slice(0, eq);
      return isSensitive(name) ? `${name}=${PLACEHOLDER}` : part;
    });

  return `${path}?${params.join("")}`;
}

/** The subset of a Fastify request the serializer reads. */
interface LoggableRequest {
  method: string;
  url: string;
  host?: string;
  ip?: string;
  /** The index signature matters: an all-optional shape is a TS weak type. */
  headers: Record<string, string | string[] | undefined>;
  socket?: { remotePort?: number | undefined };
}

/**
 * Fastify's `logger` option, uniform across azx-edge, azx-portal, azx-egress
 * and the dev gateway: quiet in tests, otherwise the stock request serializer
 * with a redacted `url`. Mirrors Fastify 5's default field-for-field
 * (`lib/logger-pino.js:46-56`) so log consumers see the same shape; Fastify
 * merges this over its defaults, so the `res`/`err` serializers are untouched.
 *
 * Exported as a function rather than inlined at each `Fastify({…})` call so the
 * test-quiet branch is assertable — otherwise nothing catches a service that
 * silently reverts to `logger: true`.
 */
export function loggerOption(env: string | undefined = process.env.NODE_ENV) {
  if (env === "test") return false as const;
  return {
    serializers: {
      req(req: LoggableRequest) {
        const version = req.headers["accept-version"];
        return {
          method: req.method,
          url: redactUrl(req.url),
          version: typeof version === "string" ? version : undefined,
          host: req.host,
          remoteAddress: req.ip,
          // Fastify guards this (`req.socket ? … : undefined`) and so must we:
          // pino does not wrap serializers in try/catch, so a throw here
          // escapes as an unhandled rejection and the log line is lost.
          remotePort: req.socket?.remotePort,
        };
      },
    },
  };
}
