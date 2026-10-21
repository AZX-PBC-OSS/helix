# Logging: levels, correlation, and the `event` convention

What the platform's logs look like today and the rules that keep them useful.
Companion to [ADR-0037](../adr/0037-platform-observability-otlp-boundary.md) —
that ADR covers traces and metrics and **defers the OpenTelemetry log bridge**
(decision 9). Logs stay pino → stdout → the container platform's collector.

## The shape

Every Fastify service uses `loggerOption(nodeEnv, { prefix, mixin })` from
[`packages/shared/src/logging.ts`](../../packages/shared/src/logging.ts).
The shared factory makes log configuration consistent and lets tests verify
that logging stays quiet under NODE_ENV=test.

Lines are `pino.<level>(fields, message)`: an object first, a lowercase human
message second. That is already universal across ~75 call sites; keep it.

## Levels

`<PREFIX>_LOG_LEVEL ?? LOG_LEVEL ?? info`, where `<PREFIX>` is `EDGE`, `PORTAL`
or `EGRESS`. Same two-step fallback the repo uses for `EDGE_PORT ?? PORT`. One
line in `main.bicep` raises the whole platform; one prefixed override raises
only the noisy service.

An unrecognised value **falls back to `info` and says so on stderr; it never
throws.** pino validates the level in its constructor and `Fastify({ logger })`
runs at module scope, so throwing would mean a typo in an env var stops a
service booting. The security seams that *do* boot-fail on a bad value
(`EGRESS_ALLOW_PRIVATE`, the bundle limits) are distinguishable: a wrong value
there silently weakens a control, whereas the worst case here is "logs are at
info, which is what they were yesterday."

> **`debug`/`trace` on the edge is a data-exposure decision, not only a volume
> one.** Anything a `req.log.debug({ body })` writes lands in the retained log
> store. Deliberately not restricted in code — that would disable the knob in
> the exact incident it exists for.

## Correlation

Two identifiers, and they must not be merged:

| Field | What it is | Crosses the hop? |
| --- | --- | --- |
| `reqId` | A UUID minted per request. On the edge → egress hop it rides `x-helix-request-id` and egress adopts it, so both halves of a `/_api/fetch` call share one value across two log stores. | Yes, inward only |
| `trace_id` / `span_id` | The active span, via the `traceContextMixin` pino mixin. Absent unless an OTLP endpoint is configured. | Via `traceparent` |

`reqId` exists **as well as** `trace_id` because the platform's default state is
no exporter configured (ADR-0037 decision 5): a trace-id-only design would give
nothing in a deployment that has not turned telemetry on.

Rules:

- **Never trust an inbound request id on the edge, the portal or the dev
  gateway.** `requestIdHeader` is `false` everywhere; the inbound path lives
  inside `genReqId` so there is one code path and `parseRequestId` is on it.
  Same reasoning as ADR-0037 decision 7 for `traceparent`: unauthenticated
  metadata cannot carry authority.
- **Egress is the one adopter**, and it still shape-validates — a UUID or
  nothing. Its authority comes from the signed instruction, but a forged header
  could still put a newline (forging a log entry) or 8 KB into a retained field.
- **The instruction's `jti`/`requestId` is not a correlation id** and must stay
  a single-use replay nonce (ADR-0037 decision 7 says so explicitly).
- **No call site may log its own `trace_id` or `span_id`** — pino lets an
  explicit field win over the mixin, which would silently shadow them.

## Redacting URLs

Several platform URLs carry a live credential in the query string: the
Appendix A handoff `token`, the OIDC `code`, the consent flow's `state` (the
pending attempt's single-use lookup key) and PKCE `code_verifier`, and —
uncoverable by any name list — the fetch-proxy target's own query, which may
hold an app's API key or an Azure SAS `sig`.

**Log a URL under the top-level key `url`.** `loggerOption` installs a `url`
serializer, so that field is redacted automatically. That is the positive form
of the rule; the negative form ("don't forget `redactUrl`") was an honour system
nobody can keep. An ESLint rule rejects `req.url` / `.href` reaching a log call
unwrapped.

What none of that reaches, stated plainly rather than papered over: a URL
assigned to a variable first, a URL inside an `err.message`, and Fastify's own
two `%s` interpolations. See `TODO.md` (issue #20 residual b).

Span attributes are **stricter**: `spanUrlAttributes` drops the query wholesale
rather than scanning it (ADR-0037 decision 6). A log line's query is
occasionally useful for debugging; a span's never is.

## The `event` convention

`event: "<domain>.<verb>"` — lowercase, snake_case verb, past tense for
outcomes (`load_failed`, not `load_fail`). Introduced by ADR-0025, which needed
a stable field a log-based metric could count because the platform had no
metrics channel.

Registered domains: `boot`, `db`, `registry`, `auth`, `gateway`, `data`,
`egress`, `edge`, `portal`, `secret`, `session`, `jobs`, `otel`, `log`.

Reserved field names, never reused for anything else: `trace_id`, `span_id`,
`reqId`, `err`, `req`, `res`, `url`, `event`, `service`.

### The scoping rule — read this before adding one

**`event` is required only on a line an alert or a dashboard would key on.**

> **Add `event` when you write the alert, not before.**

That is an honest description of what ADR-0025 actually did: it added four
events because it had four signals. Most of the ~75 log lines in this repo do
not want one, and a convention that is 90% ceremony teaches people to ignore it.
There is deliberately no lint rule requiring the field.

Now that ADR-0037's metrics exist, prefer a **metric** for anything you want to
count or threshold, and keep the log line for the detail an operator reads once
the alert fires. Where both exist for one signal they must agree —
`registry.load_failed` and `helix.registry.load_failures` split `failed` vs
`never_loaded` the same way on purpose. Two vocabularies for one signal is the
failure mode.

### Currently in use

| Event | Where |
| --- | --- |
| `boot.serving` | all four services, after `listen` |
| `db.pool_client_error` | every pooled DB client, all services |
| `registry.load_failed` / `registry.never_loaded` / `registry.load_recovered` | `apps/edge/src/registry/listener.ts` |
| `auth.oidc_discovery_ready` / `auth.oidc_discovery_failed` / `auth.code_exchange_failed` | `apps/edge/src/auth/oidc.ts` |
| `auth.oidc_missing_principal` | `apps/edge/src/auth/oidc.ts` — the login refused because the ID token lacks the configured principal claim (ADR-0048 decision 2, as amended; no fallback exists, so this line is the whole diagnosis) |
| `auth.token_missing_principal` | `apps/portal/src/auth/verifier.ts` — the access-token mirror of the same refusal: a correctly signed token with no usable principal claim yields no actor |
| `gateway.usage_record_failed` | the ledger-write failure path — ADR-0021 makes `gateway_calls` the billing and audit authority, so a dropped row matters |
| `edge.unhandled_error` / `portal.unhandled_error` / `egress.unhandled_error` | each service's error handler |
| `secret.destroy_failed` / `secret.audit_write_failed` | `apps/portal/src/routes/secrets.ts` |
| `consent.start_consult_failed` / `consent.start_cross_site_refused` / `consent.cancel_ack_failed` | `apps/edge/src/routing/consentStart.ts`, `consentCancel.ts` — the consent-start route's consult seam failing, a navigation-guard refusal (fail closed), and the helper's cancel-acknowledgement failing (the attempt still expires at the five-minute TTL) |
| `consent.dev_start_consult_failed` | `apps/edge/src/devGateway/consentStart.ts` — the dev-tier handoff's consult failure, mirror of the prod start route's |
| `consent.nonce_entry_failed` | `apps/portal/src/connections/pages.ts` — the dev journey's nonce redemption failing |
| `providers.load_failed` / `providers.load_recovered` / `providers.listen_down` / `providers.row_dropped` | `apps/egress/src/providerListener.ts` — the provider cache's listener lifecycle (ADR-0011); a dropped row is one that failed the shared row parse, so the cache stays fail-closed |
| `exchange.failed` / `exchange.rejected` | `apps/egress/src/exchange.ts` — the code-exchange operation's opaque outcomes; fixed strings only, no vendor response content |
| `egress.renewal.failed` / `egress.renewal.row_unparseable` / `egress.renewal.permissions_lost` / `egress.renewal.uncertain_rotation` / `egress.renewal.seal_failed_after_rotation` | `apps/egress/src/renewal.ts` — the renewal taxonomy's log half (ADR-0007); the last is the rotated-out orphan whose seal failed, which the retirement sweep's ledger re-covers |
| `egress.connection_retire_failed` | `apps/egress/src/retire.ts` — a retirement-sweep destroy failed after its conditional claim; the ledger mark is restored and the pass retries (ADR-0008, criterion 47) |
| `jobs.storage.unavailable` / `jobs.storage.pool_error` / `jobs.storage.probe_error` / `jobs.storage.ready` / `jobs.storage.probe_rejected` | `apps/jobs/src/storage.ts` — the storage supervisor's transitions (the transition is the signal; the probe counter and the health body carry the continuation); `probe_rejected` is a probe whose own failure reporting threw (a broken reporting sink) — the cadence and the release continue, and the report is the only trace of it |
| `jobs.burn.pool_error` / `jobs.burn.sweep_failed` / `jobs.burn.sweep_backlog` / `jobs.burn.sweep_rejected` | `apps/jobs/src/burns.ts` — the burn store's lifecycle: a dropped pooled client, a sweep pass that could not run (expired nonces remain until a later pass), a pass that removed a full batch (either steady volume or a growing backlog), and a sweep whose own failure reporting threw (the release continues; same class as `probe_rejected`) |
| `jobs.<component>.pool_error`'s `phase` field | every jobs pool event carries `phase` ∈ {`idle`, `checked-out`} (`apps/jobs/src/pool.ts`): `idle` is a client that died sitting in the pool — routine, the pool rebuilds; `checked-out` is a socket death under a live transaction (the acceptance transaction, the lifecycle apply, the compat check) — the store's own rejection answers the caller with the retryable unavailability and the dead client is destroyed on release, never parked back. A run of `checked-out` is a Postgres the service keeps losing mid-statement |
| `jobs.instruction.rejected` / `jobs.instruction.replayed` / `jobs.instruction.burn_failed` | `apps/jobs/src/instructionAuth.ts` — the signed-instruction denials: verification failed (the bounded reason rides the event, never the token or a claim), a verified nonce was already spent, and the burn store could not record the nonce (denied without a verdict) |
| `edge.jobs_burn.sweep_backlog` / `edge.jobs_burn.sweep_failed` | `apps/edge/src/jobs/burns.ts` — the edge's jobs-callback burn store (and the dev-gateway's, same class): a pass that removed a full batch (steady volume or a growing backlog) and a pass that could not run (expired nonces remain until a later pass). The jobs plane's own burn store logs the same conditions under `jobs.burn.*` |
| `edge.jobs_reachability.unreachable` / `edge.jobs_reachability.recovered` / `edge.jobs_reachability.pass_failed` / `edge.jobs_reachability.pass_rejected` | `apps/edge/src/jobs/reachability.ts` — the edge's bounded jobs-reachability probe (and the dev-gateway's, same class): a configured server that stopped answering the health contract (warn, once per server per episode — the transition is the signal; the probe counter and the `jobs_reachability` check's body carry the continuation), a server answering again after an episode (info), a pass whose measurement could not be recorded (error — the observation stands until the next pass), and a pass whose own failure reporting threw (error, sink-guarded — the cadence continues). The events carry the bounded server id and a bounded reason word — never the endpoint URL and never a transport error's text |
| `edge.jobs_callback.rejected` / `edge.jobs_callback.replayed` / `edge.jobs_callback.burn_failed` | `apps/edge/src/gateway/jobsCallback.ts` — the signed jobs→edge callback receiver's denials, the jobs receiver's `jobs.instruction.*` events mirrored at this receiver: verification failed (the bounded reason rides the event, never the token or a claim), a verified nonce was already spent, and the burn store could not record the nonce (denied without a verdict). The same receiver also emits `edge.jobs_callback.upstream_refused` (the upstream answered a governed GET non-2xx — the job's own failure evidence; the status rides, never the upstream body) and `edge.jobs_callback.forward_failed` / `edge.jobs_callback.unavailable` (the egress forward failed after the instruction was burned, and a fetch-policy dependency could not decide a verified callback — nothing was dialled, the retryable 503 is the answer) |
| `edge.jobs_submit.unreachable` / `edge.jobs_submit.invalid_response` | `apps/edge/src/gateway/jobs.ts` — the app-facing submission route's two uncertain answers: the configured server did not answer the signed forward at all, or answered an unusable response. Both answer the retryable 503 (acceptance is never proven or disproven by them — the client's keyed retry recovers a committed job); the events carry the bounded app id and, for an unusable answer, the status that arrived — never the input, the retry key, or the token |
| `edge.jobs_submit.refusal_ledger_suppressed` | `apps/edge/src/gateway/jobs.ts` — the submission throttle's refusal rows over their per-(app, env) denial budget: past the first N per window, the 429's ledger row is dropped and this summary carries the magnitude instead (the attempt count so far), so a refusal flood's audit trail stays bounded. The event carries the bounded app id and env — never the input, the retry key, or the token. The refusals themselves stay counted on `helix.jobs.submissions{outcome=rate_limited}` regardless |
| `edge.jobs_snapshot.unreachable` / `edge.jobs_snapshot.invalid_response`, `edge.jobs_result.unreachable` / `edge.jobs_result.invalid_response`, `edge.jobs_cancel.unreachable` / `edge.jobs_cancel.invalid_response` | `apps/edge/src/gateway/jobs.ts` — the app-facing reference routes' (poll / result read / cancellation) two uncertain answers, the same pair the submission route emits per operation: the configured server did not answer the signed forward, or answered an unusable response. Both answer the retryable 503 — an observation failure, never an execution one: the last known state stays visibly stale, nothing is cancelled or resubmitted, and a failed poll or cancellation is never a fabricated 404 or acknowledgement. The events carry the bounded app id and, for an unusable answer, the status that arrived — never the reference, the owner, or the token |
| `jobs.operation.unimplemented` | `apps/jobs/src/app.ts` — a verified instruction reached its route but the operation's semantics have not landed yet; the 503 `jobs_unavailable` answer is the honest one until the owning ticket's seam replaces it |
| `jobs.lifecycle.rejected_body` / `jobs.lifecycle.unavailable` / `jobs.lifecycle.pool_error` | `apps/jobs/src/app.ts` and `apps/jobs/src/lifecycle.ts` — the lifecycle delivery's refusals: a verified delivery whose body is not a lifecycle update (answered 400, nothing applied), a delivery the store could not apply (answered with the retryable 503, nothing applied, nothing acknowledged — the portal's sender delivers again), and a dropped pooled store client (`phase` above) |
| `jobs.delivery.pass` / `jobs.delivery.sync_enqueued` / `jobs.delivery.synchronized` / `jobs.delivery.acknowledged` / `jobs.delivery.stale_ack` / `jobs.delivery.refused` / `jobs.delivery.unavailable` / `jobs.delivery.unreachable` / `jobs.delivery.invalid_response` / `jobs.delivery.attempt_threw` / `jobs.delivery.pass_failed` / `jobs.delivery.pass_rejected` / `jobs.delivery.target_unknown` | `apps/portal/src/jobs/delivery.ts` — the portal sender's lifecycle-delivery evidence, one line per ending and pass, each carrying the bounded target server and app id (never the endpoint or the token): a pass that delivered or failed deliveries (the counts and duration ride the line; a pass with nothing to deliver is routine silence); app lifecycle states the synchronization step enqueued for a target that had no intent for them (info, the target and count ride — initial synchronization, re-enablement, or a transition written without that target); a target that has acknowledged every app's current lifecycle state (info, once per transition into that state — the operator's signal that enablement finished); one intent cleared by a covering acknowledgement (the cleared count includes the older intents the covering generation settles); an acknowledgement naming an OLDER generation than the row it answered — nothing cleared, the receiver is behind or misrouted (error, both generations ride); a 4xx-class per-row refusal (the bounded error code rides — the intent stays pending until the refusal's cause is fixed); the receiver's own 5xx unavailability (warn — retryable, the server's remaining rows skip the pass); no answer at all (warn — the server's remaining rows skip the pass, the next pass retries); an answer off the protocol's envelope (error — a misbehaving or wrong receiver); an attempt that threw out of its own transport (error — that row's failure, the scan continues); a pass whose own store work failed (error — pending intents stay pending until a later pass); a pass whose own failure reporting threw (error, sink-guarded — the cadence and the release continue); and pending intents naming a server this portal does not deliver to (error — retirement keeps a target addressable until it acknowledges, so this is a deployment-map mistake the evidence must surface, and the backlog keeps aging into the `jobs_lifecycle_delivery` health check) |
| `jobs.admission.unavailable` / `jobs.admission.pool_error` | `apps/jobs/src/app.ts` and `apps/jobs/src/acceptance.ts` — a submission the acceptance store could not decide (answered with the retryable 503, nothing committed — the client retries with a fresh instruction and the same retry identity), and a dropped pooled store client (`phase` above; a `checked-out` death under the acceptance transaction rejects the decision instead of killing the process). The admission's own decisions (recovery, conflict, validation and intake refusals) are the span's outcome vocabulary and the request reporting's, never per-refusal log lines. The one exception is the capacity refusal: `jobs.admission.capacity_refused` logs one bounded line per refusal (which cap bound, its limit, the occupancy it saw, the app and environment) because saturation is the operator-visible state the health checks and alerts key on — the volume is bounded by the signed-instruction rate the edge throttles, and it is a log line, never a persistent audit row |
| `jobs.cancellation.unavailable` / `jobs.cancellation.pool_error` / `jobs.cancellation.runner_unavailable` / `jobs.cancellation.runner_terminal` | `apps/jobs/src/app.ts` and `apps/jobs/src/cancellation.ts` — the owner-cancellation seam's events: a request the cancellation store could not decide (error level — answered with the retryable 503, nothing recorded, the client repeats with a fresh instruction), a dropped pooled store client (`phase` above), a recorded cancellation whose runner drive could not answer (the intent stays pending — the recovery sweeper's cancellation arm re-drives it every pass), and a drive that found the runner row already terminal (the competing outcome won its race; the next request's 409 carries that state). The seam's own verdicts (the acknowledged intent, the identity and grant refusals, the terminal preservation) are the span's `JOBS_CANCEL_OUTCOMES` and the route's responses, never per-verdict log lines |
| `jobs.runner.started` / `jobs.runner.start_failed` / `jobs.runner.instance_error` / `jobs.runner.discard_stop_failed` / `jobs.runner.attempt_rejected` | `apps/jobs/src/runner.ts` — the runtime runner's supervised start converging (the one-time transition), a start attempt the store could not accept yet (retried with capped backoff; a run of these is a store that will not come up), an error the runner's own loops emitted (kept alive; the causes ride the operations' own failures), a discarded half-started instance whose own stop failed (its pool is left for the server to reap — reported, never silent), and a start attempt whose own failure reporting threw (the loop's scheduling and the release continue; same class as `probe_rejected`) |
| `jobs.execution.pool_error` / `jobs.execution.unavailable` / `jobs.execution.gate_refused` / `jobs.execution.deadline_exceeded` / `jobs.execution.cancelled_before_start` / `jobs.execution.terminal_fenced` / `jobs.execution.claim_lapsed` / `jobs.execution.platform_error` / `jobs.execution.failed` / `jobs.execution.settle_uncertain` / `jobs.execution.projection_failed` / `jobs.execution.outcome_raced` / `jobs.execution.progress_refused` | `apps/jobs/src/execution.ts` — the worker's attempt dispositions, one line each at the site that decides it: the store could not begin/report/settle (the attempt fails through the runner's own retry policy; a run of `unavailable` is an execution store that stopped answering), the start gate's three refusals (an ineligible lifecycle generation; an absolute deadline passed — the record is terminated with the timeout outcome; the durable cancellation intent recorded before the attempt — the record is terminated with the cancellation outcome, the handler never runs), a claim settled elsewhere (the late result discarded, never stored), an attempt that failed without a job-level reason (error level — the defect class), an attempt's own reported failure (the reason rides the line), a settlement whose answer was lost and a projection the store refused (the recovery sweeper reconciles the record), a terminal write that lost its race, and a progress report refused (off the bounded shape, or its attempt lost currency) |
| `jobs.recovery.pool_error` / `jobs.recovery.runner_unavailable` / `jobs.recovery.pass_failed` / `jobs.recovery.pass_rejected` / `jobs.recovery.pass` / `jobs.recovery.row_missing` / `jobs.recovery.lifecycle_stamped` / `jobs.recovery.cancellation_resume_failed` / `jobs.recovery.cancellation_raced` / `jobs.recovery.terminated` / `jobs.recovery.reconciled` | `apps/jobs/src/recovery.ts` — the recovery sweeper's lifecycle and dispositions: a dropped pooled client; a pass that could not read the runner's state (the reconciliation retries on the next pass); a pass whose own store query failed (error level — interrupted work stays mid-flight until a later pass); a pass whose own failure reporting threw (error level, sink-guarded — the cadence and the release continue); a pass that dispositioned work (the counts and duration ride the line); a non-terminal record with no runner row (error level — a corrupt store, left for the deadline arm); closed-generation work that carried no cancellation intent stamped by the healing arm (info, once per pass when any landed — the store's closed generations outran their per-record intent; the recovery arms carry each to its terminal outcome); a pending cancellation's runner re-drive that could not answer (the intent stays pending and the next pass retries) and one that found the runner row already terminal (nothing projected over an unseen state — the next pass reconciles the row's own outcome); and the two per-job dispositions — `terminated` (`crashed` or the deadline's `timeout`: interrupted work reaching its truthful terminal outcome) and `reconciled` (requeued with its attribution, a lost reported failure projected with its own reason, a cancellation projected — a cancelled runner row, a pending intent's confirmed re-drive, or a code-less settle under intent, the fence's own signature). The per-job outcome vocabulary is the span's `JOBS_RECOVER_OUTCOMES`; `fenced` is counted on the span and counter, never a log line |
| `jobs.cleanup.pool_error` / `jobs.cleanup.pass_failed` / `jobs.cleanup.pass_rejected` / `jobs.cleanup.pass` / `jobs.cleanup.overdue` / `jobs.cleanup.backlog` | `apps/jobs/src/cleanup.ts` — the cleanup loop's lifecycle and evidence: a dropped pooled client; a pass whose store work failed (error level — expired content stays retained until a later pass); a pass whose own failure reporting threw (error level, sink-guarded — the cadence and the release continue); a pass that removed content (the counts and duration ride the line; a pass that removes nothing is routine silence); content standing past its 48-hour removal deadline (warn, once per pass until a pass opens on it cleared — the overdue story the `jobs_cleanup` check grades, criterion 36); and a pass that removed a full batch (either drained volume or a growing backlog — the next pass follows immediately). The removal counts also ride the pass span's `helix.jobs.cleanup.*` attributes; the saturation and lag grades are the health checks', never metric dimensions |
| `jobs.internal.unhandled_error` / `jobs.internal.rejected_request` | `apps/jobs/src/app.ts` — the internal routes' error boundary: an unhandled throw (answered with the fixed envelope, detail only here) and a bounded pre-verification refusal (oversized/unparsable/unknown media type) |
| `jobs.fetch.dispatch_refused` / `jobs.fetch.unreachable` / `jobs.fetch.outbound_timeout` / `jobs.fetch.stream_failed` / `jobs.fetch.result_invalid` / `jobs.fetch.result_too_large` / `jobs.fetch.callback_invalid` | `apps/jobs/src/fetchJob.ts` — the outbound fetch handler's dispatch evidence, one line at each distinct exit: the callback's bounded refusal (the error code and status ride, never any upstream or protocol text), the jobs→edge transport failing, the 30-second outbound bound expiring before or mid-answer, the streamed response failing after the headers, a 200 body that is not a complete JSON value, a body that passed the result allowance (the stream stopped at the cap, nothing stored), and a failure status outside the protocol's error envelope. None of these retry — one attempt is the type's own policy — and the dispatch span plus `helix.jobs.fetch.dispatches` carry the same exits for the alerts |
| `jobs.diagnostics.enabled` | `apps/jobs/src/server.ts` — warn at boot when the non-production diagnostic job type is registered (the `JOBS_DIAGNOSTICS` knob); the type id rides the event. A production boot never emits it — the knob is refused there |
| `otel.diag` / `otel.config` / `log.level_invalid` | config resolution, written straight to stderr because no logger exists yet |

## What is deliberately not here

- **The OTel log bridge.** ADR-0037 decision 9 defers it until decision 6's
  redaction is demonstrated on that path with tests. The failure mode is a
  retained credential; there is no urgency.
- **A `LOG_EVENTS` constant.** It would make adding a log line a two-file change
  and guard the writer while the reader — an alert rule keying on the string —
  gets nothing.
- **A lint rule requiring `event`.** See the scoping rule.
- **A `hooks.logMethod` message scan.** A per-log-call string scan in the
  trusted path, for a failure mode that needs a double-send bug to reach.
