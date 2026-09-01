import { randomUUID } from "node:crypto";
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

/** pino's levels, plus `silent`. */
export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Today's behaviour — pino's own default. Setting nothing changes nothing. */
const DEFAULT_LOG_LEVEL: LogLevel = "info";

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Resolve the log level: `<PREFIX>_LOG_LEVEL`, else `LOG_LEVEL`, else `info`.
 *
 * The two-step fallback is the shape this repo already uses for ports
 * (`EDGE_PORT ?? PORT`) and DSNs (`EDGE_DATABASE_URL ?? DATABASE_URL`), so it
 * needs no new convention — and it buys the thing you actually want at 3am: one
 * line in `main.bicep` turns the whole platform to `debug`, and one prefixed
 * override turns up only the edge, which is the noisy one you would otherwise
 * never dare raise.
 *
 * **An unrecognised value falls back and says so; it never throws.** pino
 * validates the level in its constructor and throws synchronously, and
 * `Fastify({ logger })` runs at module scope in every `server.ts` — so a typo'd
 * `LOG_LEVEL=infoo` would mean the service does not boot. That is the wrong
 * failure mode for a verbosity knob, and the same call the telemetry config
 * already makes ("a typo in an env var must not be able to stop the edge").
 *
 * The precedent that looks like it cuts the other way — `EGRESS_ALLOW_PRIVATE`
 * and the bundle limits both boot-fail on a bad value — is distinguishable:
 * those are security seams where a wrong value silently weakens a control. The
 * worst case here is "logs are at info, which is what they were yesterday", and
 * the fallback announces itself.
 *
 * Exported so the fallback is assertable without constructing pino.
 */
export function resolveLogLevel(
  prefix: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): LogLevel {
  const raw = (prefix ? env[`${prefix}_LOG_LEVEL`] : undefined) ?? env.LOG_LEVEL;
  if (raw === undefined) return DEFAULT_LOG_LEVEL;

  const value = raw.trim().toLowerCase();
  if (value === "") return DEFAULT_LOG_LEVEL;
  if (isLogLevel(value)) return value;

  // Written straight to stderr, in the same shape `@azx-pbc/telemetry`'s config
  // resolution uses, and for the same reason: this runs while Fastify's logger
  // is being constructed, so there is no logger to report through. One precedent for
  // "config resolution has no logger", not two.
  process.stderr.write(
    `${JSON.stringify({
      level: "warn",
      event: "log.level_invalid",
      value: raw,
      fallback: DEFAULT_LOG_LEVEL,
    })}\n`,
  );
  return DEFAULT_LOG_LEVEL;
}

/** Per-service knobs for {@link loggerOption}. */
export interface LoggerOptions {
  /**
   * Service env prefix — makes `<PREFIX>_LOG_LEVEL` win over `LOG_LEVEL`.
   * Omitted (the dev gateway aside) only by callers that want the shared knob.
   */
  prefix?: "EDGE" | "PORTAL" | "EGRESS";
  /** Injected for tests; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Extra fields on every log line. Forwarded to pino verbatim and never called
   * here, so this module stays free of any OpenTelemetry import — the trace
   * correlation mixin lives in `@azx-pbc/telemetry/correlation` and is passed
   * in by each service's `app.ts`.
   */
  mixin?: () => Record<string, unknown>;
}

/**
 * Fastify's `logger` option, uniform across helix-edge, helix-portal, helix-egress
 * and the dev gateway: quiet in tests, otherwise the stock request serializer
 * with a redacted `url`. Mirrors Fastify 5's default field-for-field
 * (`lib/logger-pino.js:46-56`) so log consumers see the same shape; Fastify
 * merges this over its defaults, so the `res`/`err` serializers are untouched.
 *
 * Exported as a function rather than inlined at each `Fastify({…})` call so the
 * test-quiet branch is assertable — otherwise nothing catches a service that
 * silently reverts to `logger: true`.
 */
export function loggerOption(
  env: string | undefined = process.env.NODE_ENV,
  options: LoggerOptions = {},
) {
  if (env === "test") return false as const;
  return {
    level: resolveLogLevel(options.prefix, options.env),
    ...(options.mixin ? { mixin: options.mixin } : {}),
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

/**
 * The correlation id's header on the edge → egress hop.
 *
 * **Internal only.** It must never appear in `REQUEST_HEADER_SAFELIST`
 * (`./fetch.ts`) — that list is what egress forwards to a third-party upstream,
 * and our request id is nobody else's business. A test pins the exclusion,
 * because it is one word away from regressing.
 */
export const REQUEST_ID_HEADER = "x-helix-request-id";

/** A v4-shaped UUID, the only thing {@link parseRequestId} will accept. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Validate an inbound correlation id, or `null`.
 *
 * Deliberately shape-checked rather than merely length-capped. The value lands
 * on every log line for the request and is retained for 30 days, so an
 * unvalidated header is a place to put a newline (forging a second log entry),
 * 8 KB of padding, or ANSI escapes for whoever greps it later. A UUID or
 * nothing removes the whole class.
 *
 * Note what this is *not*: authentication. Egress's authority comes from the
 * signed attested instruction (ADR-0013), and a caller who cannot mint one can
 * do nothing with a forged request id but mislabel its own log lines.
 */
export function parseRequestId(raw: unknown): string | null {
  if (typeof raw !== "string") return null; // covers a repeated header (string[])
  const value = raw.trim().toLowerCase();
  return UUID_RE.test(value) ? value : null;
}

/** The subset of a request {@link requestIdOptions} reads. */
interface RequestIdSource {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Fastify's request-id options: a fresh UUID per request, and — on the one hop
 * where it is sound — continuity with the caller's id.
 *
 * **Why this exists at all.** Fastify's default generator is a per-process
 * counter (`req-1`, `req-2`, …). Two replicas both start at `req-1`, every
 * restart resets, and nothing connects the edge's line to egress's — which
 * matters more here than in most systems, because the two planes ship stdout to
 * *different* Log Analytics workspaces. Correlating a `/_api/fetch` call today
 * means matching on app id, origin and timestamp by eye.
 *
 * **`requestIdHeader` is always `false`, in both modes.** Fastify 5 already
 * defaults it that way, so this is a drift guard rather than a fix — but it is
 * a load-bearing one: the obvious next edit is `requestIdHeader: "x-request-id"`,
 * and on the edge that would take an id straight from untrusted app code. The
 * inbound path lives inside `genReqId` instead, so there is exactly one code
 * path and {@link parseRequestId} is on it.
 *
 * @param trustInbound Adopt a valid {@link REQUEST_ID_HEADER} from the caller.
 *   **Egress only.** Never on the edge, the portal or the dev gateway: every
 *   request they answer originates from app code, and honouring an app-supplied
 *   id would let it collide ids deliberately to poison a search, or forge
 *   correlation between unrelated requests. Same reasoning as ADR-0037
 *   decision 7 for `traceparent`, and for the same reason — unauthenticated
 *   metadata cannot carry authority.
 */
export function requestIdOptions({ trustInbound = false }: { trustInbound?: boolean } = {}): {
  requestIdHeader: false;
  genReqId: (req: RequestIdSource) => string;
} {
  return {
    requestIdHeader: false,
    genReqId: (req) =>
      (trustInbound ? parseRequestId(req.headers[REQUEST_ID_HEADER]) : null) ?? randomUUID(),
  };
}

/**
 * The `url.path` span attribute for a request, with the query gone (ADR-0037
 * decision 6).
 *
 * **Two layers, deliberately, and the second is the one that matters.**
 * {@link redactUrl} runs first — it is what handles `/_api/fetch/<target>`,
 * where the app-chosen target URL *is* the path and its own query rides along
 * unencoded. Then the query is dropped **wholesale**, not scanned. So even a
 * credential under a parameter name `SENSITIVE_PARAMS` has never heard of never
 * reaches a span attribute, which is a stronger guarantee than the log line
 * gets and is the right trade here: a log line's query string is occasionally
 * useful for debugging, whereas nothing about a span needs it.
 *
 * Never returns `url.full`, `http.url` or `http.target`. Those are precisely the
 * semantic-convention keys that carry a whole URL, and a span attribute lands in
 * the same 30-day-retained backend a log line does. An ESLint rule bans them and
 * `FORBIDDEN_URL_ATTRS` (`@azx-pbc/shared/telemetry`) is the shared list.
 */
export function spanUrlAttributes(rawUrl: string): { "url.path": string } {
  const redacted = redactUrl(rawUrl);
  const q = redacted.indexOf("?");
  return { "url.path": q === -1 ? redacted : redacted.slice(0, q) };
}
