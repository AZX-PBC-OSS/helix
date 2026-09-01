/**
 * The telemetry vocabulary — instrument names and attribute keys, as plain
 * strings (ADR-0037 decisions 6 and 8).
 *
 * **This module imports nothing, and must stay that way.** It is the one piece
 * of the observability work that both the edge and egress need to agree on: if
 * the two planes spell `helix.app_id` differently, the trace that crosses the
 * trust boundary is unjoinable and nothing says so — the spans simply never
 * line up. Making the agreement a compile-time one costs a constant.
 *
 * It lives here rather than in `@azx-pbc/telemetry` because that package owns
 * the OpenTelemetry **SDK** and only the `server.ts` files may import it. A
 * string constant has no such constraint, and `@azx-pbc/shared` is already a
 * dependency of every service. Conversely `@opentelemetry/api` must never be
 * added to this package: `packages/cli` (published to npm, ADR-0032) and
 * `apps/portal-web` (a browser bundle) both depend on it, and ADR-0037
 * decision 11 defers browser telemetry precisely to avoid that direction.
 */

/**
 * Instrument names, all `helix.`-prefixed per ADR-0037 decision 8.
 *
 * These are what an alert rule and a dashboard key on, so they are API in the
 * same way `REGISTRY_CHECK_NAME` is — don't rename one without knowing what
 * queries it.
 */
export const INSTR_REGISTRY_STALE_FOR_MS = "helix.registry.stale_for_ms";
export const INSTR_REGISTRY_LOAD_FAILURES = "helix.registry.load_failures";
export const INSTR_GATEWAY_CALLS = "helix.gateway.calls";
export const INSTR_GATEWAY_DURATION = "helix.gateway.duration";
export const INSTR_EGRESS_PROXY_DURATION = "helix.egress.proxy.duration";
export const INSTR_SESSION_GATE_DENIED = "helix.session.gate_denied";

/**
 * Attribute keys.
 *
 * `helix.`-prefixed rather than reusing OpenTelemetry semantic conventions,
 * because none of these are semconv attributes and squatting on a semconv name
 * with our own meaning is worse than inventing one. The two genuine semconv
 * keys we do use — `url.path` and `http.route` — are spelled out at their call
 * sites; see {@link FORBIDDEN_URL_ATTRS} for the ones that are banned.
 */
export const ATTR_APP_ID = "helix.app_id";
export const ATTR_ENV = "helix.env";
export const ATTR_CAPABILITY = "helix.capability";
export const ATTR_OUTCOME = "helix.outcome";
export const ATTR_REASON = "helix.reason";
export const ATTR_MODEL = "helix.model";
export const ATTR_METHOD = "helix.method";
export const ATTR_TARGET_ORIGIN = "helix.target.origin";
export const ATTR_TARGET_PATH = "helix.target.path";
export const ATTR_CONNECTION = "helix.connection";
export const ATTR_UPSTREAM_STATUS = "helix.upstream.status";
export const ATTR_CLIENT_DISCONNECTED = "helix.client_disconnected";
export const ATTR_STREAM = "helix.stream";
/**
 * The app's slug. Bounded by the tenant like {@link ATTR_APP_ID}, and the half
 * a human recognises — kept as a SPAN attribute only. `appId` remains the
 * metric dimension, because a slug can be reused after an app is deleted while
 * the uuid cannot, and a metric series that silently changes meaning is worse
 * than one that is hard to read.
 */
export const ATTR_APP_SLUG = "helix.app.slug";
/** Which app-data verb — `putUser`, `getShared`, … Bounded by the handler set. */
export const ATTR_DATA_VERB = "helix.data.verb";

/**
 * Span names. Like the instrument names these are queried by humans and by
 * dashboards, so they are constants rather than string literals at the call
 * site — a typo in one of ~14 hand-placed spans is otherwise invisible until
 * someone notices a trace view is missing a step.
 */
export const SPAN_LLM = "helix.gateway.llm";
export const SPAN_FETCH = "helix.gateway.fetch";
export const SPAN_DATA = "helix.gateway.data";
export const SPAN_EGRESS_PROXY = "helix.egress.proxy";
export const SPAN_REGISTRY_LOAD = "helix.registry.load";
export const SPAN_AUTH_START = "helix.auth.oidc.start";
export const SPAN_AUTH_CALLBACK = "helix.auth.oidc.callback";
export const SPAN_AUTH_COMPLETE = "helix.auth.handoff.complete";

/**
 * `http.route` values. The literal route pattern, never the request URL —
 * ADR-0037 decision 6 forbids `url.full`/`http.url`, and on these routes there
 * is nothing variable to record anyway.
 */
export const ROUTE_LLM = "/_api/llm/chat";
export const ROUTE_FETCH = "/_api/fetch/*";
export const ROUTE_DATA = "/_api/data/*";
export const ROUTE_AUTH_START = "/start";
export const ROUTE_AUTH_CALLBACK = "/callback";
export const ROUTE_AUTH_COMPLETE = "/_auth/complete";

/**
 * Attribute keys that must never appear on a span, anywhere (ADR-0037
 * decision 6).
 *
 * Several platform URLs carry a live credential in the query string: the
 * Appendix A handoff `token`, the OIDC `code`, and — uncoverable by any name
 * list — the fetch-proxy target's own query, which may hold an app's API key or
 * an Azure SAS `sig`. These are exactly the semantic-convention keys that
 * carry a full URL, and a span attribute lands in a 30-day-retained backend
 * the same way a log line does.
 *
 * Record `url.path` and `http.route` instead, and put anything URL-shaped
 * through `redactUrl` from `@azx-pbc/shared/logging` first. An ESLint rule
 * enforces this list; the constant is here so the rule and the docs cannot
 * drift from each other.
 */
export const FORBIDDEN_URL_ATTRS = ["url.full", "http.url", "http.target", "url.query"] as const;

/**
 * Why a session-gate denial happened — the `helix.session.gate_denied`
 * dimension.
 *
 * Bounded by construction: these are the early returns in
 * `apps/edge/src/auth/gate.ts`, and a test asserts the set is exhaustive. The
 * *response* stays indistinguishable across all of them (`apps/edge/src/errors.ts`
 * exists so a guard doesn't disclose which one fired) — this records the reason
 * internally without changing a byte of what the caller sees.
 */
export const SESSION_DENIAL_REASONS = [
  "mode_forbidden",
  "no_session",
  "visibility_denied",
  "refresh_required",
] as const;
export type SessionDenialReason = (typeof SESSION_DENIAL_REASONS)[number];

/**
 * Why a registry projection load failed — the `helix.registry.load_failures`
 * dimension. Mirrors the split `apps/edge/src/registry/listener.ts` already
 * makes between its two event names, so the counter and the log agree.
 */
export const REGISTRY_LOAD_OUTCOMES = ["failed", "never_loaded"] as const;
export type RegistryLoadOutcome = (typeof REGISTRY_LOAD_OUTCOMES)[number];

/**
 * Duration-histogram bucket boundaries, in milliseconds.
 *
 * OpenTelemetry's default explicit buckets top out at 10 000 ms. An LLM stream
 * routinely runs longer than that, so on the defaults every slow call lands in
 * the overflow bucket and p95/p99 answer nothing — a latency metric that looks
 * healthy because it cannot represent the tail is worse than none, the same
 * argument ADR-0037 decision 5 makes about a span ended at response headers.
 */
export const DURATION_BUCKETS_MS = [
  0, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 120_000,
] as const;
