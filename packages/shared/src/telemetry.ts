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
export const INSTR_TRUST_PROXY_UNRESOLVED = "helix.edge.trust_proxy.unresolved";
export const INSTR_PROVIDERS_RECONCILES = "helix.providers.reconciles";
export const INSTR_PROVIDERS_LISTEN_STATUS = "helix.providers.listen_status";
export const INSTR_CONSENT_OPERATIONS = "helix.consent.operations";
export const INSTR_EGRESS_EXCHANGES = "helix.egress.exchanges";
export const INSTR_EGRESS_RENEWALS = "helix.egress.renewals";
export const INSTR_EGRESS_RETIREMENTS = "helix.egress.retirements";
export const INSTR_APP_VISITS = "helix.app.visits";
export const INSTR_JOBS_STORAGE_PROBES = "helix.jobs.storage.probes";
export const INSTR_JOBS_INSTRUCTIONS = "helix.jobs.instructions";
export const INSTR_JOBS_BURN_SWEEPS = "helix.jobs.burn.sweeps";
export const INSTR_JOBS_EXECUTIONS = "helix.jobs.executions";
export const INSTR_JOBS_RECOVERIES = "helix.jobs.recoveries";

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
/**
 * How egress sourced the injected credential — `secret` (a sealed `app_secrets`
 * row), `managed-identity` (a minted Entra token, ADR-0046), or `delegated`
 * (the caller's own OAuth connection). Bounded to those three
 * values; never the credential itself, its header name, or a token claim.
 */
export const ATTR_CREDENTIAL_SOURCE = "helix.credential_source";
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
 * How many keys a `shared` list call matched (ADR-0042 decision 7). Bounded by
 * the page cap, and deliberately the COUNT — the matched keys themselves are
 * app data and never ride a span.
 */
export const ATTR_DATA_MATCH_COUNT = "helix.data.match_count";
/**
 * Which signed internal jobs operation a signal is about — bounded by the six
 * names in `JobsOperations` (`@azx-pbc/shared/jobsSigning`), and always taken
 * from the ROUTE the receiver registered, never from the (unverified) token.
 */
export const ATTR_JOBS_OPERATION = "helix.jobs.operation";
/**
 * The jobs lifecycle generation a signal is about — a small non-negative
 * integer the portal app model owns (ADR-0007). Never a personal value; the
 * app's identity rides {@link ATTR_APP_ID}.
 */
export const ATTR_JOBS_GENERATION = "helix.jobs.generation";
/**
 * The qualified job type a jobs execution signal is about — a bounded
 * deployment-catalogue dimension (the installed types are the catalogue's),
 * never a caller-supplied name.
 */
export const ATTR_JOBS_TYPE = "helix.jobs.type";
/**
 * Which execution attempt of a job a signal is about — a small positive
 * integer (1-based). A span attribute; job attempt numbers are never metric
 * dimensions.
 */
export const ATTR_JOBS_ATTEMPT = "helix.jobs.attempt";
/**
 * The job's public reference id — a bounded opaque server-local string, as a
 * span attribute so an operator can join a trace to the snapshot the app
 * polls. Never a metric dimension.
 */
export const ATTR_JOBS_JOB_ID = "helix.jobs.job_id";
/**
 * Whether a lifecycle signal's generation closes the app (an archive —
 * `true`) or opens one (creation/unarchive — `false`). Bounded boolean.
 */
export const ATTR_JOBS_ARCHIVED = "helix.jobs.archived";
/**
 * How many per-target intents a lifecycle transition recorded — one per
 * configured serving/retiring server, so bounded by the deployment map.
 */
export const ATTR_JOBS_LIFECYCLE_TARGETS = "helix.jobs.lifecycle.targets";
/** How many apps the registry projection loaded. Bounded by the tenant. */
export const ATTR_REGISTRY_APPS = "helix.registry.apps";
/**
 * How many provider rows the egress cache holds after a reconcile. Bounded by
 * the tenant — the table is administrator-created.
 */
export const ATTR_PROVIDERS = "helix.providers.rows";
/** Files in a deployed bundle, and CSP lint warnings raised on it. */
export const ATTR_DEPLOY_FILE_COUNT = "helix.deploy.file_count";
export const ATTR_DEPLOY_WARNING_COUNT = "helix.deploy.warning_count";
/**
 * Which consent-flow operation a signal is about — `consult`, `cancel`,
 * `claim`, `sweep`, `redeem`, `callback`, or `status` (`redeem`
 * is the dev journey's nonce redemption; `callback` is the completion
 * state machine the vendor redirect lands in; `status` is the
 * read-only connection-status read, ADR-0031 as amended). Bounded to those
 * seven; the identity the operation is for is never a dimension.
 */
export const ATTR_CONSENT_OPERATION = "helix.consent.operation";
/** The provider `ref` a consent operation consults against — admin-chosen, ≤64 chars. */
export const ATTR_PROVIDER_REF = "helix.provider_ref";
/** How many expired consent-attempt rows a sweep cycle removed. */
export const ATTR_CONSENT_SWEEP_REMOVED = "helix.consent.sweep_removed";
/** How many pending consent attempts a disconnect killed. */
export const ATTR_ATTEMPTS_KILLED = "helix.attempts_killed";

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
export const SPAN_EGRESS_RESOLUTION = "helix.egress.resolution";
export const SPAN_EGRESS_EXCHANGE = "helix.egress.exchange";
export const SPAN_EGRESS_RENEWAL = "helix.egress.renewal";
export const SPAN_EGRESS_RETIRE = "helix.egress.retire";
export const SPAN_REGISTRY_LOAD = "helix.registry.load";
export const SPAN_PROVIDERS_RECONCILE = "helix.providers.reconcile";
export const SPAN_AUTH_START = "helix.auth.oidc.start";
export const SPAN_AUTH_CALLBACK = "helix.auth.oidc.callback";
export const SPAN_AUTH_COMPLETE = "helix.auth.handoff.complete";
export const SPAN_CONNECTIONS_PROXY = "helix.auth.connections.proxy";
export const SPAN_DEPLOY_BUNDLE = "helix.deploy.bundle";
export const SPAN_DEPLOY_VALIDATE = "helix.deploy.validate";
export const SPAN_DEPLOY_ALLOCATE = "helix.deploy.allocate";
export const SPAN_DEPLOY_UPLOAD = "helix.deploy.upload";
export const SPAN_DEPLOY_RECORD = "helix.deploy.record";
export const SPAN_CONSENT_CONSULT = "helix.consent.consult";
export const SPAN_CONSENT_CANCEL = "helix.consent.cancel";
export const SPAN_CONSENT_CLAIM = "helix.consent.claim";
export const SPAN_CONSENT_SWEEP = "helix.consent.sweep";
export const SPAN_CONSENT_CALLBACK = "helix.consent.callback";
export const SPAN_CONSENT_START = "helix.consent.start";
export const SPAN_CONSENT_START_DEV = "helix.consent.start.dev";
export const SPAN_CONSENT_REDEEM = "helix.consent.redeem";
/** The app-facing connection-status read (ADR-0031 as amended) — the portal's
 * read-only decision behind the edge's `.status.edge` / `.status.dev` routes. */
export const SPAN_CONSENT_STATUS = "helix.consent.status";
/** The prod edge route `GET /_api/connections/:ref/status`, which forwards to
 * the portal's own `.status` span over the internal seam. */
export const SPAN_CONSENT_STATUS_EDGE = "helix.consent.status.edge";
/** The dev gateway's `GET /:slug/_api/connections/:ref/status`. */
export const SPAN_CONSENT_STATUS_DEV = "helix.consent.status.dev";
/** The edge's app-facing cancel-acknowledgement route, which
 * forwards to the portal's own cancel span (above) over the internal seam. */
export const SPAN_CONSENT_CANCEL_EDGE = "helix.consent.cancel.edge";
/** The portal's My Connections list route — the caller's own
 * connections, metadata only. */
export const SPAN_CONNECTIONS_MINE = "helix.connections.mine";
/** The portal's disconnect route — the one-transaction
 * invalidation that stops the caller's own Helix access. */
export const SPAN_CONNECTIONS_DISCONNECT = "helix.connections.disconnect";
/** The jobs receiver's signed-operation routes (one span each, named for the
 * operation the ROUTE serves — never a name read from the token). */
export const SPAN_JOBS_SUBMIT = "helix.jobs.submit";
export const SPAN_JOBS_SNAPSHOT = "helix.jobs.snapshot";
export const SPAN_JOBS_RESULT = "helix.jobs.result";
export const SPAN_JOBS_CANCEL = "helix.jobs.cancel";
export const SPAN_JOBS_LIFECYCLE = "helix.jobs.lifecycle";
/** The jobs worker's execution of one attempt of one job — a root consumer
 * span (background work has no inbound request context to continue). */
export const SPAN_JOBS_EXECUTE = "helix.jobs.execute";
/** The jobs recovery sweeper's disposition of one interrupted job — a root
 * consumer span, one per job the pass dispositioned (never for the passing
 * through of consistent work). */
export const SPAN_JOBS_RECOVER = "helix.jobs.recover";
/** The portal's lifecycle outbox write — the transaction that commits app
 * state, the next generation and the per-target intents together (ADR-0007).
 * The receiver's `helix.jobs.lifecycle` route span is the delivery's other end. */
export const SPAN_JOBS_LIFECYCLE_OUTBOX = "helix.jobs.lifecycle.outbox";

/**
 * `http.route` values. The literal route pattern, never the request URL —
 * ADR-0037 decision 6 forbids `url.full`/`http.url`, and on these routes there
 * is nothing variable to record anyway.
 */
export const ROUTE_LLM = "/_api/llm/chat";
export const ROUTE_OPENAI = "/_api/openai/v1/chat/completions";
export const ROUTE_FETCH = "/_api/fetch/*";
export const ROUTE_DATA = "/_api/data/*";
export const ROUTE_AUTH_START = "/start";
export const ROUTE_AUTH_CALLBACK = "/callback";
export const ROUTE_AUTH_COMPLETE = "/_auth/complete";
export const ROUTE_CONNECTIONS = "/connections/*";
export const ROUTE_CONSENT_START = "/_api/connections/:ref/start";
export const ROUTE_CONSENT_START_DEV = "/:slug/_api/connections/:ref/start";
export const ROUTE_CONSENT_STATUS = "/_api/connections/:ref/status";
export const ROUTE_CONSENT_STATUS_DEV = "/:slug/_api/connections/:ref/status";
export const ROUTE_CONSENT_CANCEL = "/_api/connections/attempt/cancel";
export const ROUTE_CONNECTIONS_NONCE_ENTRY = "/connections/consent/start";
export const ROUTE_CONNECTIONS_CALLBACK = "/connections/callback";
export const ROUTE_CONNECTIONS_MINE = "/api/v1/connections/mine";
export const ROUTE_CONNECTIONS_MINE_ID = "/api/v1/connections/mine/:id";
export const ROUTE_EGRESS_EXCHANGE = "/exchange";

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
 * What happened to a visit the edge decided to record — the `helix.app.visits`
 * dimension (ADR-0050). The row is written fire-and-forget, so this counter is
 * the only place a lost visit is visible.
 *
 * - `recorded`: the row landed.
 * - `failed`: the write was attempted and errored (including a pool wait that
 *   timed out).
 * - `dropped`: too many writes were already in flight, so none was attempted.
 *   A sustained rate means the database is slow or someone is flooding loads.
 * - `deduplicated`: the same visitor was recorded on this replica within the
 *   last minute, so the row would add nothing to the 30-minute visit grouping.
 */
export const VISIT_RECORD_OUTCOMES = ["recorded", "failed", "dropped", "deduplicated"] as const;
export type VisitRecordOutcome = (typeof VISIT_RECORD_OUTCOMES)[number];

/**
 * Why a provider-cache reconcile was counted — the `helix.providers.reconciles`
 * dimension. An attempt counter, not a failures-only counter: the cache has no
 * `/health` grade to ladder into (egress reports liveness only), so the alert
 * is a *rate* — a run of `failed` with no `ok` is a stale-config cache.
 */
export const PROVIDERS_RECONCILE_OUTCOMES = ["ok", "failed"] as const;
export type ProvidersReconcileOutcome = (typeof PROVIDERS_RECONCILE_OUTCOMES)[number];

/**
 * How the jobs storage-readiness probe answered — the `helix.outcome`
 * dimension on `helix.jobs.storage.probes`. Deliberately coarse: the
 * *distinguishable* reasons (unreachable store, missing schema, queue-policy
 * drift, missing runtime privileges) ride the `jobs_database` health check's
 * body and the structured log events, which ADR-0009's body-aware alerts read;
 * this counter's job is the rate — retries absorbed while the store is down
 * must be visible, not silent. An attempt counter, like
 * {@link PROVIDERS_RECONCILE_OUTCOMES}, not a failures-only one.
 */
export const JOBS_STORAGE_PROBE_OUTCOMES = ["ok", "unavailable"] as const;
export type JobsStorageProbeOutcome = (typeof JOBS_STORAGE_PROBE_OUTCOMES)[number];

/**
 * How a signed internal instruction was received — the `helix.outcome` values
 * on the `helix.jobs.instructions` counter. An attempt counter over every
 * presentation, refused or not:
 *
 * - `accepted` — verified and its `jti` durably burned; the operation proceeds.
 * - `replayed` — verified but the `jti` was already spent: a transport replay,
 *   refused before any side effect (criterion 56's replay exposure).
 * - `rejected` — verification failed; the bounded reject reason rides the
 *   span's `helix.reason` (`JOBS_INSTRUCTION_REJECT_REASONS`, plus `missing`
 *   for a request with no instruction header at all), never a metric
 *   dimension.
 * - `unavailable` — the receiver could not reach its burn store, so the
 *   instruction was denied without a verdict (fail closed).
 */
export const JOBS_INSTRUCTION_OUTCOMES = [
  "accepted",
  "replayed",
  "rejected",
  "unavailable",
] as const;
export type JobsInstructionOutcome = (typeof JOBS_INSTRUCTION_OUTCOMES)[number];

/**
 * The burn-store sweep pass's outcome — the `helix.outcome` dimension on
 * `helix.jobs.burn.sweeps`. Passes that remove rows are routine silence; a run
 * of `failed` with no `ok` is a store that stopped answering its cleanup, and
 * the burn rows then grow with instruction volume until the store answers.
 */
export const JOBS_BURN_SWEEP_OUTCOMES = ["ok", "failed"] as const;
export type JobsBurnSweepOutcome = (typeof JOBS_BURN_SWEEP_OUTCOMES)[number];

/**
 * How the jobs receiver applied one lifecycle delivery — the final
 * `helix.outcome` on the `helix.jobs.lifecycle` route span (overwriting the
 * verification verdict once the operation runs). Bounded by construction:
 * each value is one exit of the apply.
 *
 * - `applied` — the delivery moved the app's durable generation forward.
 * - `stale` — the delivery was not newer than the generation already applied
 *   (a redelivery or an out-of-order older change): acknowledged with the
 *   highest applied generation and deliberately without state change. A run
 *   of `stale` is normal after redelivery, never a fault.
 * - `invalid_body` — the delivery's body failed the lifecycle schema after
 *   its instruction verified; answered 400 and never applied. (Deliberately
 *   not `rejected` — that word is the instruction counter's verification
 *   verdict, and one word must not mean two things on one span.)
 * - `unavailable` — the lifecycle store could not answer, so nothing was
 *   applied and nothing acknowledged (503, retryable by the sender).
 */
export const JOBS_LIFECYCLE_OUTCOMES = ["applied", "stale", "invalid_body", "unavailable"] as const;
export type JobsLifecycleOutcome = (typeof JOBS_LIFECYCLE_OUTCOMES)[number];

/**
 * How the jobs service decided one submission — the final `helix.outcome` on
 * the `helix.jobs.submit` route span (overwriting the verification verdict
 * once the operation runs). One word, one meaning on this span: the
 * instruction counter's `replayed` (a spent nonce) is deliberately not
 * reused for keyed recovery.
 *
 * - `accepted` — new work: the runner job and its wrapper record committed
 *   together; answered 202 with the new reference.
 * - `recovered` — a keyed resubmission whose exact original bytes matched a
 *   retained key: the original job's reference and current status returned,
 *   no new work created.
 * - `conflict` — a keyed resubmission whose bytes differ from the retained
 *   key's original (409 `idempotency_conflict`); no work created.
 * - `invalid_input` — new work whose input failed the type's validation
 *   (400 `payload_invalid`); no job, no key claim.
 * - `type_unknown` — the instruction named a qualified type this server has
 *   no installed policy for (403 `forbidden`); no job, no key claim.
 * - `closed` — the app's lifecycle generation is applied and archived, or
 *   older than the applied one: new work refused 403, final.
 * - `unseen` — the claimed generation is newer than anything the portal has
 *   delivered (or the app is not known here): retryable 503 until the
 *   control-plane delivery opens it (ADR-0007).
 * - `capacity_exceeded` — new work that fits no unfinished or retained
 *   capacity cap (per app/environment or server-wide): refused 429
 *   `jobs_capacity_exceeded`, no job, no key claim, nothing evicted. A busy
 *   refusal — clients back off and retry; the specific saturated cap and the
 *   occupancy numbers ride the refusal's log event, never a dimension here.
 * - `not_found` — an identical-bytes keyed replay of a job whose public
 *   record access has expired (the 30-day record horizon passed while the
 *   row is still physically retained): answered 404 like an unknown job, no
 *   work created, no slot taken. Different bytes still conflict (`conflict`)
 *   — the key-holder's own claim is what the 409 answers.
 * - `unavailable` — the acceptance store could not answer; nothing
 *   committed, answered with the retryable 503.
 */
export const JOBS_SUBMIT_OUTCOMES = [
  "accepted",
  "recovered",
  "conflict",
  "invalid_input",
  "type_unknown",
  "closed",
  "unseen",
  "capacity_exceeded",
  "not_found",
  "unavailable",
] as const;
export type JobsSubmitOutcome = (typeof JOBS_SUBMIT_OUTCOMES)[number];

/**
 * How the jobs service answered one owner-cancellation request — the final
 * `helix.outcome` on the `helix.jobs.cancel` route span (overwriting the
 * verification verdict once the operation runs). Bounded by construction:
 * each value is one exit of the cancellation decision.
 *
 * - `requested` — the intent is durable (including a harmless repeat while
 *   the job is still active) and the runner cancellation was driven; answered
 *   202. The acknowledgement confirms intent, not a terminal outcome.
 * - `not_found` — no record answers the reference, or its identity does not
 *   match the signed caller: the same 404 an unknown job answers with, never
 *   a disclosure of someone else's job.
 * - `forbidden` — the signed caller's grants do not cover the record's job
 *   type: 403, nothing recorded.
 * - `terminal` — the job already carries a terminal outcome: 409 with that
 *   status, and the outcome is left exactly as it was.
 * - `unavailable` — the cancellation store could not answer: nothing was
 *   recorded, answered with the retryable 503.
 */
export const JOBS_CANCEL_OUTCOMES = [
  "requested",
  "not_found",
  "forbidden",
  "terminal",
  "unavailable",
] as const;
export type JobsCancelOutcome = (typeof JOBS_CANCEL_OUTCOMES)[number];

/**
 * How the jobs service answered one owner status poll — the final
 * `helix.outcome` on the `helix.jobs.snapshot` route span (overwriting the
 * verification verdict once the operation runs). One word, one meaning on
 * this span:
 *
 * - `found` — the authorized owner's complete latest snapshot answered 200.
 * - `not_found` — no record answers the reference, its identity does not
 *   match the signed caller, or its public record access has expired (the
 *   30-day record horizon): the same 404 an unknown job answers with, never
 *   a disclosure of someone else's or an expired job.
 * - `forbidden` — the signed caller's grants do not cover the job's type:
 *   403, nothing disclosed about the state.
 * - `unavailable` — the observation store could not answer: the retryable
 *   503, and the last known state stays visibly stale (an observation
 *   failure, never an execution one).
 */
export const JOBS_SNAPSHOT_OUTCOMES = ["found", "not_found", "forbidden", "unavailable"] as const;
export type JobsSnapshotOutcome = (typeof JOBS_SNAPSHOT_OUTCOMES)[number];

/**
 * How the jobs service answered one owner result read — the final
 * `helix.outcome` on the `helix.jobs.result` route span. One word, one
 * meaning on this span:
 *
 * - `found` — the job's successful result answered 200 as the raw JSON
 *   value, JSON `null` included.
 * - `not_ready` — the job is unfinished (queued or running): the stateful
 *   409 `job_not_ready` with the job's status.
 * - `terminal` — the job reached a terminal outcome without a successful
 *   result (failed, crashed, cancelled): the stateful 409 `job_terminal`
 *   with that status and error.
 * - `expired` — the successful result's seven-day lifetime ended (the job
 *   reads `expired`): 410 `result_expired`, however delayed the physical
 *   cleanup is.
 * - `not_found` / `forbidden` / `unavailable` — as the snapshot's, the same
 *   answers an unknown, ungranted or unreadable store gives.
 */
export const JOBS_RESULT_OUTCOMES = [
  "found",
  "not_found",
  "forbidden",
  "not_ready",
  "terminal",
  "expired",
  "unavailable",
] as const;
export type JobsResultOutcome = (typeof JOBS_RESULT_OUTCOMES)[number];

/**
 * How the jobs worker disposed of one execution attempt — the final
 * `helix.outcome` on the `helix.jobs.execute` span, and the dimension on the
 * `helix.jobs.executions` counter. One word, one meaning, and every value is
 * one exit of the attempt wrapper:
 *
 * - `succeeded` — the handler returned a result inside the platform's bounds,
 *   the runner claim was settled (its own fenced complete), and the wrapper
 *   record projects the durable success.
 * - `failed` — the attempt ended in a failure the wrapper projected durably
 *   (a handler-reported reason, an execution-time input refusal, an
 *   unregistered handler, or an oversized/invalid result). The bounded
 *   `JobError` code rides the span's `helix.reason`, never a dimension;
 *   whether a retry follows is the type's own policy.
 * - `gate_refused` — the worker-start gate refused to run the job (its
 *   lifecycle generation is closed, or not yet delivered): the handler never
 *   executed and the wrapper record stays untouched.
 * - `deadline_exceeded` — the worker-start gate refused to run the job because
 *   its absolute deadline (from acceptance, queue wait and retries included)
 *   had passed, and terminated it with the platform's timeout outcome in the
 *   same transaction: recovery never authorizes execution after the deadline.
 * - `cancelled` — the worker-start gate found the record's durable
 *   cancellation intent and committed its terminal `cancelled` outcome in the
 *   gate's own transaction: the handler never executed, and the intent can
 *   never turn into a run or a retry.
 * - `terminal_fenced` — the attempt was fenced and no outcome was projected:
 *   the record was already terminal when the worker reached it, or the
 *   runner claim had lapsed before the attempt could settle (a late
 *   completion after a claim timeout, or a failure racing an already-settled
 *   claim).
 * - `unavailable` — the execution store could not answer; the attempt failed
 *   through the runner's own retry policy without a projected outcome.
 */
export const JOBS_EXECUTE_OUTCOMES = [
  "succeeded",
  "failed",
  "gate_refused",
  "deadline_exceeded",
  "cancelled",
  "terminal_fenced",
  "unavailable",
] as const;
export type JobsExecuteOutcome = (typeof JOBS_EXECUTE_OUTCOMES)[number];

/**
 * How the recovery sweeper disposed of one interrupted job — the final
 * `helix.outcome` on the `helix.jobs.recover` span and the dimension on the
 * `helix.jobs.recoveries` counter. One word, one meaning; every value is one
 * disposition of the reconciliation decision:
 *
 * - `deadline_exceeded` — the job's absolute deadline (from acceptance) had
 *   passed: the work was terminated with the timeout outcome and will not
 *   execute. Queue wait and retry delays consumed the deadline (criterion 24).
 * - `crashed` — the runner row said the execution was lost (its claim expired
 *   or its row settled without a projected outcome) with no attempt left: the
 *   wrapper record projects `crashed` with the platform-error reason.
 * - `failed` — the runner row carried a worker-reported failure whose wrapper
 *   projection had been lost (an execution-store outage during the attempt):
 *   the reported reason is projected now.
 * - `requeued` — the runner row was waiting to retry while the wrapper record
 *   still read `running`: the record is put back to `queued` with the failed
 *   attempt's attribution retained, and the next claim re-drives the work.
 * - `cancelled` — the runner row was cancelled while the wrapper record was
 *   not yet terminal; or the record carried a pending owner/lifecycle
 *   cancellation intent on a runner row still waiting or active (the pass
 *   re-drives that runner cancellation first); or the record's intent was
 *   pending on a code-less failed settle — the fence's own signature (the
 *   claim refused because the intent committed, or the drive was lost and
 *   the claim expired), never a platform crash: the cancellation is
 *   projected (recovery never reissues cancelled work).
 * - `row_missing` — no runner row answered for a non-terminal record: the
 *   store is inconsistent (the acceptance transaction commits both), reported
 *   loudly and left for the deadline arm's bounded termination.
 * - `fenced` — the reconciliation's conditional write lost a race against a
 *   concurrent terminal write (another replica's sweeper, a worker settling,
 *   a cancellation), or a pending cancellation's runner re-drive could not
 *   confirm the row stopped and the projection was left for the next pass:
 *   nothing was changed.
 */
export const JOBS_RECOVER_OUTCOMES = [
  "deadline_exceeded",
  "crashed",
  "failed",
  "requeued",
  "cancelled",
  "row_missing",
  "fenced",
] as const;
export type JobsRecoverOutcome = (typeof JOBS_RECOVER_OUTCOMES)[number];

/**
 * Why a `shared` list call was denied — the {@link ATTR_REASON} value on the
 * `helix.gateway.data` span, separating the deny path from an empty result
 * (ADR-0042 decision 7). Bounded by construction: these are the authorization
 * early-returns in `listShared` (`apps/edge/src/gateway/data-handler.ts`), and
 * the *response* stays an ordinary 403 — this records the reason internally,
 * like {@link SESSION_DENIAL_REASONS}, without changing a byte the caller sees.
 */
export const DATA_LIST_DENIAL_REASONS = ["prefix_not_granted"] as const;
export type DataListDenialReason = (typeof DATA_LIST_DENIAL_REASONS)[number];

/**
 * Outcome vocabularies for the consent-flow operations, the
 * `helix.outcome` values on the `helix.consent.operations` counter and the
 * operation spans. Bounded by construction — each list is exactly the early
 * returns of its operation in `apps/portal/src/connections/consent.ts` — and
 * deliberately free of identity: `userOid` is never a dimension.
 *
 * - consult: `started` (pending attempt written + authorize URL returned),
 *   `already_connected`, `not_available`, `error` (custody/DB failure — the
 *   edge's "couldn't start").
 * - cancel: `cancelled` (owner won the CAS), `not_cancellable` (unknown,
 *   expired, finished, or not the caller's attempt — indistinguishable on the
 *   wire), `error`.
 * - claim: `claimed` (single-use redeem won), or the refusal reason the
 *   callback renders — `expired`, `cancelled`, `not_found` — plus `error`.
 * - sweep: `ok` (cycle ran; the removed count rides the span) or `failed`.
 */
export const CONSENT_OPERATIONS = [
  "consult",
  "cancel",
  "claim",
  "sweep",
  "redeem",
  "callback",
  "status",
] as const;
export type ConsentOperation = (typeof CONSENT_OPERATIONS)[number];
export const CONSENT_CONSULT_OUTCOMES_TELEMETRY = [
  "started",
  "already_connected",
  "not_available",
  "error",
] as const;
export const CONSENT_CANCEL_OUTCOMES_TELEMETRY = ["cancelled", "not_cancellable", "error"] as const;
export const CONSENT_CLAIM_OUTCOMES_TELEMETRY = [
  "claimed",
  "expired",
  "cancelled",
  "not_found",
  "error",
] as const;
export const CONSENT_SWEEP_OUTCOMES_TELEMETRY = ["ok", "failed"] as const;
export const CONSENT_REDEEM_OUTCOMES_TELEMETRY = [
  "redeemed",
  "not_found",
  "replayed",
  "expired",
  "cancelled",
  "provider_changed",
  "error",
] as const;

/**
 * Why the connect callback answered as it did — the
 * `helix.outcome` values on the `helix.consent.callback` span and the
 * `helix.consent.operations` counter's `callback` operation. This is the
 * ten-word vocabulary, verbatim: the terminal
 * outcomes the callback's completion pages render.
 *
 * - `connected` — the exchange succeeded and the row saved (CAS winner).
 * - `already_connected` — in the vocabulary for the design's completeness; the
 *   callback's CAS maps a live-row race to `conflict` (a
 *   competing attempt reports a conflict, never silent replacement), so today
 *   no path emits this word.
 * - `denied` — the vendor returned an OAuth error (the declined page), or the
 *   `state` claimed nothing (forged, reused, cross-context — unknown states
 *   render the fixed refusal page; there is no not-found word to emit).
 * - `expired` / `cancelled` / `disconnected` — the attempt refused or the
 *   connection row's state says this attempt can no longer establish anything.
 * - `failed_permissions` / `failed_provider` / `failed_service` — the egress
 *   exchange's rejections (`missing_permissions`), provider unavailability and
 *   gate rejections, and transport/service failure respectively.
 */
export const CONSENT_CALLBACK_OUTCOMES = [
  "connected",
  "already_connected",
  "denied",
  "expired",
  "conflict",
  "cancelled",
  "disconnected",
  "failed_permissions",
  "failed_provider",
  "failed_service",
] as const;
export type ConsentCallbackOutcome = (typeof CONSENT_CALLBACK_OUTCOMES)[number];

/**
 * Why the edge's consent-start route answered as it did — the
 * `helix.outcome` values on the `helix.consent.start` span. Distinct from the
 * consult vocabulary above because the edge decides things the consult never
 * sees: `signin_required` (no usable session — detected before any consult is
 * made) and `forbidden` (the same-origin navigation guard refused). The
 * consult's own outcomes map onto `started` / `already_connected` /
 * `unavailable` (`not_available`), and every failure path — portal hop,
 * unconfigured seam, malformed response — is `error`.
 */
export const CONSENT_START_OUTCOMES = [
  "started",
  "signin_required",
  "already_connected",
  "unavailable",
  "forbidden",
  "error",
] as const;
export type ConsentStartOutcome = (typeof CONSENT_START_OUTCOMES)[number];

/**
 * The dev-tier start route's outcome vocabulary — the
 * `helix.outcome` values on the `helix.consent.start.dev` span. The prod
 * vocabulary minus `signin_required`: a dev caller's identity is the bearer
 * token, not a session, so there is no sign-in state — the resolver's
 * refusals (missing/invalid token, wrong app, unregistered Origin, refused
 * before any consult) are `forbidden`.
 */
export const CONSENT_START_DEV_OUTCOMES = [
  "started",
  "already_connected",
  "unavailable",
  "forbidden",
  "error",
] as const;
export type ConsentStartDevOutcome = (typeof CONSENT_START_DEV_OUTCOMES)[number];

/**
 * Why the app-facing connection-status read answered as it did (ADR-0031 as
 * amended) — the `helix.outcome` values on the `helix.consent.status` /
 * `.status.edge` spans. The three row-state words pass through from the
 * portal's decision (`connected`, `not_connected`, `not_available` — the same
 * collapse the delegated-call error table makes); the edge adds `unauthorized`
 * (no usable session — a pseudonym or an anonymous visitor is refused the same
 * way) and `error` (portal hop failure or an unconfigured seam).
 */
export const CONSENT_STATUS_OUTCOMES = [
  "connected",
  "not_connected",
  "not_available",
  "unavailable",
  "unauthorized",
  "error",
] as const;
export type ConsentStatusOutcome = (typeof CONSENT_STATUS_OUTCOMES)[number];

/**
 * The dev-tier status route's outcome vocabulary — the prod set with
 * `forbidden` in place of `unauthorized`: a dev caller's identity is the
 * bearer token, and the dev resolver's refusals (missing/invalid token, wrong
 * app, unregistered Origin) are `forbidden` (the dev start route's posture).
 */
export const CONSENT_STATUS_DEV_OUTCOMES = [
  "connected",
  "not_connected",
  "not_available",
  "unavailable",
  "forbidden",
  "error",
] as const;
export type ConsentStatusDevOutcome = (typeof CONSENT_STATUS_DEV_OUTCOMES)[number];

/**
 * Why the edge's cancel-acknowledgement route answered as it did
 * — the `helix.outcome` values on the `helix.consent.cancel.edge` span. The
 * forwarded call's own outcomes (`cancelled`/`not_cancellable`) pass through;
 * the edge adds what only it decides: `unauthorized` (no usable session or a
 * cross-origin POST — the caller learns nothing either way) and
 * `unknown_attempt` (no live tag correlation on this replica — the helper's
 * acknowledgement then degrades to the attempt's five-minute expiry, the bound
 * the design already documents; the response body stays the indistinguishable
 * `not_cancellable`).
 */
export const CONSENT_CANCEL_EDGE_OUTCOMES = [
  "cancelled",
  "not_cancellable",
  "unknown_attempt",
  "unauthorized",
  "error",
] as const;
export type ConsentCancelEdgeOutcome = (typeof CONSENT_CANCEL_EDGE_OUTCOMES)[number];

/**
 * The egress code-exchange operation's outcome vocabulary —
 * the `helix.outcome` dimension on `helix.egress.exchanges` and
 * the `helix.egress.exchange` span. Bounded by construction: each value is
 * exactly one early-return class of the handler.
 *
 * - `exchanged` — the compatibility gate passed and both materials sealed.
 * - `rejected` — the gate refused at receipt (the distinguishable reason rides
 *   the span's `helix.reason`, never a metric dimension); nothing was sealed.
 * - `provider_unavailable` — unknown id, deleted, or stale revision.
 * - `exchange_failed` — the vendor token endpoint failed or sealing failed;
 *   the fixed-string outcome, no vendor content anywhere.
 * - `unauthorized` — the portal→egress token did not verify (refused before
 *   any vendor call).
 * - `malformed` — the body failed its schema parse.
 * - `unconfigured` — the exchange operation has no custody/providers wired.
 */
export const EGRESS_EXCHANGE_OUTCOMES = [
  "exchanged",
  "rejected",
  "provider_unavailable",
  "exchange_failed",
  "unauthorized",
  "malformed",
  "unconfigured",
] as const;
export type EgressExchangeOutcome = (typeof EGRESS_EXCHANGE_OUTCOMES)[number];

/**
 * The egress token-renewal operation's outcome vocabulary —
 * the `helix.outcome` values on the `helix.egress.renewal` span
 * and the `helix.egress.renewals` counter. This is the
 * operator-visible renewal vocabulary, verbatim; the delegated-call
 * resolver maps each word onto the gateway outcome the caller sees.
 *
 * - `refreshed` — fresh usable material is committed (renewed here, or a
 *   concurrent winner's renewal re-read after the advisory lock — ADR-0031
 *   decision 15).
 * - `temporary_failure` — vendor outage, rate limit, or a timeout with no
 *   certain token consumption; the connection row is untouched and a later
 *   request may try again. No vendor retry within the call.
 * - `uncertain_rotation` — the refresh token may have been consumed with no
 *   usable replacement saved; the row moves to reconnect-needed and the old
 *   token is never re-presented. Takes precedence over
 *   `temporary_failure`.
 * - `reconnect_required` — an explicit loss of required permissions; the row
 *   moves to reconnect-needed.
 * - `admin_action` — malformed client credentials or a missing usable
 *   lifetime; provider incompatibility an administrator must fix. The row is
 *   untouched (the connection is not the problem).
 */
export const EGRESS_RENEWAL_OUTCOMES = [
  "refreshed",
  "temporary_failure",
  "uncertain_rotation",
  "reconnect_required",
  "admin_action",
] as const;
export type EgressRenewalOutcome = (typeof EGRESS_RENEWAL_OUTCOMES)[number];

/**
 * The egress delegated-resolution operation's outcome vocabulary
 * — the `helix.outcome` values on the `helix.egress.resolution` span, the span
 * the proxy opens around resolving one delegated instruction's connection.
 * These are the operator-visible signals; how each word
 * answers the caller is the delegated-call error table:
 *
 * - `resolved` — a usable access token came off the row directly; the call
 *   dispatches.
 * - `refreshed` — the token was expired (or the renew-before-next-call flag
 *   was set), the
 *   renewal succeeded, and the call dispatches on the fresh token, invisible
 *   to the caller. The renewal span inside this one carries the
 *   same word.
 * - `connection_required` — no or dead connection, a caller kind that can
 *   never hold one, or a renewal that ended `uncertain_rotation` /
 *   `reconnect_required` — the caller must Connect (403).
 * - `reconnect_required` — the connection row itself is live but renewal said
 *   reconnection is required and the row has been flipped; emitted beside
 *   `connection_required`'s answer when the distinction matters on the span.
 *   (The app-facing answer is still `connection_required`.)
 * - `provider_unavailable` — the provider was deleted, or the row's revision
 *   stamp is behind the cached current one —
 *   503.
 * - `provider_misconfigured` — the provider row is malformed or its renewal
 *   answered `admin_action` — administrator action required (502).
 * - `error` — resolution could not complete: a temporary renewal failure
 *   (the state diagram's UpstreamError arm; the renewal span inside carries
 *   the specific `temporary_failure` word) or a custody/infrastructure
 *   failure. The app-facing answer is the existing 502 `upstream_error`.
 */
export const EGRESS_RESOLUTION_OUTCOMES = [
  "resolved",
  "refreshed",
  "connection_required",
  "reconnect_required",
  "provider_unavailable",
  "provider_misconfigured",
  "error",
] as const;
export type EgressResolutionOutcome = (typeof EGRESS_RESOLUTION_OUTCOMES)[number];

/**
 * What the egress credential-retirement sweep did with one ledger entry
 * (ADR-0031 amendment item 12) — the `helix.outcome` dimension on
 * `helix.egress.retirements`. Bounded by construction — each value is one
 * branch of the sweep's per-entry flow.
 *
 * - `retired` — the conditional claim won and the claimed material was
 *   destroyed; the row's ledger field is clear.
 * - `failed` — the claim won but the destroy did not succeed; the entry is
 *   restored to the ledger and retried on a later pass, and
 *   the fixed `egress.connection_retire_failed` warn event rides alongside.
 * - `claimed_lost` — the conditional claim matched zero rows: a writer
 *   (a reconnect's swap, a renewal's rotation, a newer mark) re-purposed the
 *   single-slot ledger between the sweep's read and its claim, so the sweep
 *   destroyed nothing (a current connection's material is
 *   never touched). Losing is the design working; it is counted, not alarmed.
 */
export const EGRESS_RETIREMENT_OUTCOMES = ["retired", "failed", "claimed_lost"] as const;
export type EgressRetirementOutcome = (typeof EGRESS_RETIREMENT_OUTCOMES)[number];

/**
 * The retirement sweep's pass-level outcome (the `helix.egress.retire` span) —
 * whether the pass could run at all. Per-entry results ride the
 * `helix.egress.retirements` counter, not this span; a pass full of failed
 * destroys still ran.
 */
export const EGRESS_RETIRE_PASS_OUTCOMES = ["ok", "failed"] as const;
export type EgressRetirePassOutcome = (typeof EGRESS_RETIRE_PASS_OUTCOMES)[number];

/**
 * Duration buckets in milliseconds. LLM streams often exceed OTel's default
 * 10-second upper bucket, so extend the range to measure tail latency.
 */
/**
 * Maximum recorded target-path length before the ellipsis. Match the
 * gateway_calls.path cap on both edge and egress.
 *
 * This bounds attacker-controlled retained data; it does not redact secrets
 * embedded in path segments. See fetchPathOf in apps/edge/src/gateway/usage.ts.
 */
export const TARGET_PATH_MAX = 512;

/**
 * Apply {@link TARGET_PATH_MAX}. Kept here rather than in either plane so the
 * one definition is reachable from both — this module imports nothing, which is
 * what lets egress use it without reaching into `apps/edge`.
 */
export function capTargetPath(pathname: string): string {
  return pathname.length > TARGET_PATH_MAX ? `${pathname.slice(0, TARGET_PATH_MAX)}…` : pathname;
}

export const DURATION_BUCKETS_MS = [
  0, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 120_000,
] as const;
