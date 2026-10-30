# Observability

This document lists platform logs, traces, and metrics. Telemetry for hosted apps
is deferred because it needs a separate product and tenancy model
([ADR-0037](../adr/0037-platform-observability-otlp-boundary.md), decision 11).

Design: ADR-0037 (traces + metrics, and the OTLP-only boundary) and
[`docs/design/logging.md`](../design/logging.md) (levels, correlation, the
`event` convention).

## Three signals, two pipelines

| Signal | How it leaves the process | Where it goes |
| --- | --- | --- |
| **Logs** | pino JSON → stdout | The container platform's log store (on Azure: per-environment Log Analytics, 30-day retention) |
| **Traces** | OTLP/HTTP | Whatever `OTEL_EXPORTER_OTLP_ENDPOINT` names |
| **Metrics** | OTLP/HTTP | Same |

Services export traces and metrics through OTLP. Vendor telemetry SDKs stay out
of `apps/` and `packages/`; `infra/azure` configures the destination. Operators
can use a different telemetry backend without changing service code.

## Off unless configured

`startTelemetry` constructs nothing — no provider, no exporter, no timer — and
registers no global when `NODE_ENV=test`, when `OTEL_SDK_DISABLED` is set, or
when no OTLP endpoint is configured. **The last is the platform's default
state**, so a deployment that has not opted in behaves exactly as it did before
any of this existed. A boot line reports which state you are in
(`event: "boot.serving"`, field `telemetry`).

Locally the devcontainer runs Jaeger as `otel-collector` and points the services
at it; the trace UI is on <http://localhost:27686>.

## What is instrumented

Hand-placed spans at the seams, never auto-instrumentation — that would
monkey-patch `http`, `undici` and `pg` at require time inside the process that
terminates untrusted traffic (decision 4).

| Span | Where |
| --- | --- |
| `helix.gateway.llm` / `.fetch` / `.data` | the `/_api/*` handlers |
| `helix.auth.oidc.start` / `.callback`, `helix.auth.handoff.complete` | the auth routes |
| `helix.auth.connections.proxy` | the auth host's `/connections/*` reverse proxy |
| `helix.consent.start` | the app host's `/_api/connections/:ref/start` route — the consent popup's prod entry |
| `helix.consent.start.dev` | the dev gateway's `/:slug/_api/connections/:ref/start` route — the dev tier's bearer POST → single-use popup URL |
| `helix.consent.cancel.edge` | the app host's `/_api/connections/attempt/cancel` route — the connect helper's cancellation acknowledgement, forwarding to the portal's own `.cancel` span |
| `helix.consent.status.edge` | the app host's `GET /_api/connections/:ref/status` route (ADR-0031 as amended) — the app-facing connection-status read, forwarding to the portal's own `.status` span |
| `helix.consent.status.dev` | the dev gateway's `GET /:slug/_api/connections/:ref/status` — the dev tier's bearer status read |
| `helix.jobs.submit.edge` | the app host's `POST /_api/jobs/:server/types/:type` — the app-facing jobs submission route, forwarding to the receiver's own `helix.jobs.submit` span |
| `helix.jobs.submit.dev` | the dev gateway's `POST /:slug/_api/jobs/:server/types/:type` — the dev tier's submission route over the same forwarding seam |
| `helix.jobs.snapshot.edge` / `.result.edge` / `.cancel.edge` | the app host's `GET /_api/jobs/:server/:jobId` (poll), `GET …/:jobId/result` (result read) and `DELETE …/:jobId` (cancellation) — the app-facing reference routes, each forwarding to the receiver's own `helix.jobs.snapshot` / `.result` / `.cancel` span |
| `helix.jobs.snapshot.dev` / `.result.dev` / `.cancel.dev` | the dev gateway's `/:slug`-prefixed reference routes over the same forwarding seam |
| `helix.egress.proxy` | egress `POST /proxy` |
| `helix.egress.resolution` | egress delegated-call resolution — the span the proxy opens around resolving a `provider`-bearing instruction's caller connection; nests inside the proxy span, with the renewal span inside it when a renewal runs |
| `helix.egress.exchange` | egress `POST /exchange` — the code-exchange operation |
| `helix.egress.renewal` | egress token renewal — the operation the delegated-call resolution runs when an access token is expired; nests inside the resolution span, and its own duration is where the advisory lock's bounded wait is visible (ADR-0031 decision 15) |
| `helix.egress.retire` | egress credential-retirement sweep pass — one background pass over the `pendingRetire` ledger; per-entry results ride the `helix.egress.retirements` counter |
| `helix.registry.load` | the projection reload; carries `helix.registry.apps` and `helix.registry.operator_settings` ∈ {`ok`, `failed`, `skipped`} (a `failed` settings read never fails the load, see [platform-settings.md](./platform-settings.md)) |
| `helix.providers.reconcile` | the egress provider-cache reconcile |
| `helix.deploy.bundle` → `.validate` / `.upload` | the portal deploy path |
| `helix.deploy.repo` | the portal's CI deploy route, `POST /api/v1/apps/:slug/ci/versions` (ADR-0051); wraps `helix.deploy.bundle` when the token is accepted. Carries `helix.app_id` (once the slug resolves) and `helix.outcome` ∈ `REPO_DEPLOY_OUTCOMES`. A refusal is not an error status; never the repo name, the GitHub actor or the token |
| `helix.consent.consult` / `.cancel` / `.claim` / `.sweep` / `.redeem` / `.callback` / `.status` | the portal's consent-flow state machine: the internal consult + cancel + connection-status routes, the callback's claim probe, the expiry sweep, the dev journey's nonce redemption, the vendor redirect's completion state machine, and the read-only status decision (ADR-0031 as amended) |
| `helix.jobs.submit` / `.snapshot` / `.result` / `.cancel` / `.lifecycle` | the jobs receiver's five signed internal operation routes — one root span each, named for the operation the ROUTE serves (never a name read from the token); verification outcomes and reject reasons ride `helix.outcome` / `helix.reason`, and `http.route` is the operation matrix's own path. Once an operation's semantics have landed, its own outcome supersedes the verification verdict on that span: the lifecycle delivery answers `applied` / `stale` / `invalid_body` / `unavailable` (`JOBS_LIFECYCLE_OUTCOMES`), with the delivered app, generation and archived flag as span attributes plus the delivery's cancellation reach on `helix.jobs.lifecycle.stamped` (the still-active closed-generation records the apply stamped with durable intent before its commit — the work its recovery paths carry to terminal outcomes); the submission answers `JOBS_SUBMIT_OUTCOMES` (see below), with the submitting app and its claimed generation as span attributes; the cancellation answers `JOBS_CANCEL_OUTCOMES` (see below), with the addressed app and the job's public id as span attributes |
| `helix.jobs.fetch.edge` / `.dev` | the signed jobs→edge fetch-callback receivers (`POST /internal/jobs/v1/fetch`) — the production edge's platform-host route and the dev gateway's own — one root span each (the callback edge starts a new root, ADR-0009). Verification outcomes and reject reasons ride `helix.outcome` / `helix.reason` until the dispatch runs; its own outcome supersedes, per `JOBS_FETCH_CALLBACK_OUTCOMES` (see below), beside the verified app id, job id, generation and type |
| `helix.jobs.lifecycle.outbox` | the portal's lifecycle outbox write — the span around appending one intent per configured serving/retiring target inside the app transition's transaction (ADR-0007); carries `helix.app_id`, `helix.jobs.generation`, `helix.jobs.archived` and `helix.jobs.lifecycle.targets`. Not emitted when the deployment map is empty (fully disabled jobs writes no backlog) |
| `helix.jobs.lifecycle.deliver` | the portal sender's delivery of one pending lifecycle intent to one target — a root consumer span, one per delivery attempt (a retry is a fresh attempt and a fresh span); carries `helix.jobs.server` (the bounded target name), `helix.app_id`, `helix.jobs.generation` and `helix.jobs.archived`, with the final `helix.outcome` ∈ `JOBS_LIFECYCLE_DELIVERY_OUTCOMES` (`acknowledged` / `stale_ack` / `refused` / `unreachable` / `invalid_response`) and a refusal's bounded error code on `helix.reason`. The endpoint URL and the instruction token never appear on it. The receiver's `helix.jobs.lifecycle` route span is the same hop's other end; the portal's `jobs_lifecycle_delivery` health check grades the loop and its backlog, not this span |
| `helix.jobs.lifecycle.sync` | the portal sender's synchronization step — a root consumer span, one per configured target per pass, run before the pass measures its backlog. It enqueues the current `{generation, archived}` of every app (archived apps included) that has no outbox intent for that generation and target: the initial synchronization when a server is first enabled, the resynchronization when it is re-enabled, and any transition a portal replica wrote without that target. Carries only `helix.jobs.server` and `helix.jobs.lifecycle.sync.enqueued` (the count); no app id, endpoint or token. In steady state the count is 0. The enqueued intents are delivered by the same pass's `helix.jobs.lifecycle.deliver` attempts, and the portal's `jobs_lifecycle_delivery` health check reports each target's synchronization (`targets` / `synchronizedTargets` metrics, plus a detail naming each target that still has pending intents) |
| `helix.jobs.execute` | the jobs worker's execution of one attempt of one job — a root consumer span (background work has no inbound context to continue), one per attempt; carries `helix.app_id`, `helix.jobs.type` (the qualified type — a bounded deployment-catalogue dimension; `jobs:diagnostic` appears here only on a non-production stack that opted in), `helix.jobs.job_id` (the public reference, the join between a trace and the snapshot the app polls) and `helix.jobs.attempt` (1-based). Its final `helix.outcome` is `JOBS_EXECUTE_OUTCOMES` (see below) |
| `helix.jobs.fetch.dispatch` | the outbound fetch handler's dispatch of its one governed GET — the mint→answer hop to the edge's signed callback (ADR-0006), a client child span of the attempt's own `helix.jobs.execute` root. Carries the same bounded identity as the execute span; the final `helix.outcome` is `JOBS_FETCH_DISPATCH_OUTCOMES` (see below) and the callback's own error code / the abort's classification ride `helix.reason`. The target URL, the callback base and the instruction token never appear on it |
| `helix.jobs.recover` | the jobs recovery sweeper's disposition of one interrupted job — a root consumer span, one per job a pass dispositioned (never for consistent work the pass passes through); carries the same bounded identity as the execute span. Its final `helix.outcome` is `JOBS_RECOVER_OUTCOMES` (see below) |
| `helix.jobs.cleanup` | the jobs cleanup loop's physical-retention pass — a root consumer span, one per pass (the loop's cadence, never per row). Its final `helix.outcome` is `JOBS_CLEANUP_OUTCOMES` (`ok` / `failed`), and the pass's batch-bounded removal counts ride `helix.jobs.cleanup.results_removed` / `helix.jobs.cleanup.records_retired`; the lag and saturation measurements the pass took are graded by the `jobs_cleanup` / `jobs_capacity` health checks, not carried here |
| `helix.jobs.intake` | the jobs service's intake apply — a root consumer span, one per attempt to make the configured `JOBS_ACCEPTING` posture durable on the store under the admission lock (boot, then capped-backoff retries while the store does not answer). Its final `helix.outcome` is `JOBS_INTAKE_OUTCOMES` (`opened` / `closed` / `refused` / `unavailable`; the last two grade ERROR), with `helix.jobs.server` and, on an applied posture, `helix.jobs.intake.changed`. `refused` is the repointing guard: the store is bound to, or holds records of, another server. The resulting state and a closed server's drain progress are graded by the `jobs_intake` health check |
| `helix.connections.mine` | the portal's `GET /api/v1/connections/mine` route — My Connections' metadata-only list |
| `helix.connections.disconnect` | the portal's `DELETE /api/v1/connections/mine/:id` route — the one-transaction disconnect; carries `helix.outcome` ∈ {`disconnected`, `already_removed`}, `helix.provider_ref`, `helix.env`, and the killed-attempt count (`helix.attempts_killed`) — never the caller's identity |

Per-span attributes beyond the semconv keys, so a new one has one place to be
looked up:

- `helix.gateway.data` spans carry `helix.data.verb` (the handler name, bounded
  by the handler set), `helix.data.match_count` on the list verb (bounded by its
  200-key page cap), and `helix.reason` = `prefix_not_granted` on a list deny —
  never a `url.path`: four data routes carry an app-chosen **key** as the
  path's last segment, and prefix grants (ADR-0042) make those keys unbounded
  and attacker-choosable, so the wrapper records `http.route` + verb only.
  Pinned by `spanRedaction.test.ts`'s planted-key case.
- `helix.gateway.fetch` spans carry `helix.target.origin`, `helix.target.path`,
  and — per credential source, once the target matched the manifest allowlist —
  `helix.connection` for a secret-bound origin or `helix.provider_ref` for a
  provider-bound one (the ref is the admin-granted catalogue key,
  bounded by `PROVIDER_REF_MAX`). Nothing is recorded for a keyless origin, and
  an origin that failed the allowlist check is never recorded under either key.
- `helix.egress.proxy` spans carry `helix.credential_source` ∈ {`secret`,
  `managed-identity`, `delegated`} when a credential was injected — which custody
  path served the call (ADR-0046; `delegated` is the caller's own OAuth
  connection), and the first thing to check when a Foundry-bound
  call misauthenticates. Bounded to those three values; on the egress allowlist,
  so never a header name, a credential, or a token claim. A delegated dispatch
  also carries `helix.provider_ref`.
- `helix.egress.resolution` spans carry `helix.outcome` ∈
  `EGRESS_RESOLUTION_OUTCOMES` (`resolved`, `refreshed`, `connection_required`,
  `reconnect_required`, `provider_unavailable`, `provider_misconfigured`,
  `error` — the outcome vocabulary's inventory plus the plane's generic `error` for the
  temporary-renewal-failure/custody paths, whose specific word the renewal span
  inside carries), `helix.env`, and `helix.provider_ref`. No token value, no
  vendor content, and no identity (`userOid` is never a dimension) appears on
  it; the app-facing answer for every 403 word is the ledger's
  `connection_required`.
- `helix.egress.proxy` spans' `helix.outcome` ∈ {`ok`, `upstream_throttled`,
  `refusal`, `error`, `caller_gone`} — `caller_gone` is the caller (the edge)
  closing the request before the upstream answered: egress aborts the upstream
  request, records status 499 and `helix.client_disconnected`, and logs
  `egress.proxy.caller_gone` at `info`. `upstream_throttled` is a proxied upstream `429`: the
  proxy worked, the vendor said slow down. Without the distinct label a real
  vendor throttle (an app pushing past its TPM) presented as a wall of `ok`
  spans, and anything keyed on outcome missed it entirely. The gateway LLM span
  records `http.route` per surface — `/_api/llm/chat` or
  `/_api/openai/v1/chat/completions` — so throttles on the OpenAI-compatible
  route are findable by route.
- `helix.egress.exchange` spans carry `helix.outcome` ∈
  `EGRESS_EXCHANGE_OUTCOMES` (`exchanged`, `rejected`, `provider_unavailable`,
  `exchange_failed`, `unauthorized`, `malformed`, `unconfigured` — the seven
  early-return classes of the handler), `helix.provider_ref`, and
  `helix.reason` on a bounded gate-vocabulary rejection (
  `unusable_lifetime`, `missing_refresh_token`, `missing_permissions`). The
  vendor token endpoint's failures are the ONE word `exchange_failed`: the
  fixed-string discipline keeps vendor error bodies — which can
  echo client credentials — off the wire, out of logs, and off this span; the
  span records no exception, like every egress span.
- `helix.egress.renewal` spans carry `helix.outcome` ∈ `EGRESS_RENEWAL_OUTCOMES`
  (`refreshed`, `temporary_failure`, `uncertain_rotation`, `reconnect_required`,
  `admin_action` — the renewal vocabulary's other refusals),
  `helix.env`, and `helix.provider_ref`. No token value and no vendor error
  content appears anywhere on it: the OAuth error code is read only to choose
  the bounded outcome word, never recorded. Span status is graded ERROR for
  `temporary_failure` and `admin_action` (operator-actionable); the
  reconnect-needing outcomes are the platform working as designed.
- `helix.providers.reconcile` spans carry `helix.providers.rows` — how many
  provider rows the cache holds after the reconcile (bounded by
  the tenant, the table is administrator-created) — and `helix.providers.rows.dropped`
  when rows failed their parse and were dropped from the cache (the fixed
  `providers.row_dropped` warn event rides alongside; a dropped row answers
  `provider_unavailable` until the next good reconcile).
- `helix.auth.connections.proxy` (the auth host's `/connections/*` reverse
  proxy) records `url.path` only — the vendor's redirect lands there with
  `code` and `state` in the URL, so the query is dropped wholesale
  (`spanUrlAttributes`), and nothing about the internal JWT it mints — value,
  header name — is ever an attribute. Pinned by `spanRedaction.test.ts`'s
  consent-proxy case and `traceBoundary.test.ts`'s route case.
- `helix.consent.start` (the consent popup's entry route) records
  `helix.outcome` ∈ {`started`, `signin_required`, `already_connected`,
  `unavailable`, `forbidden`, `error`} (`CONSENT_START_OUTCOMES` — the six
  answers the route can give; `forbidden` is the same-origin navigation guard,
  `signin_required` the pre-consult session check), plus `helix.provider_ref`
  and `helix.app.slug`, and `url.path` only — the start URL's `attempt`
  correlation tag is app-chosen and the 302's target is the vendor authorize
  URL carrying `state` + the PKCE challenge, so the query is dropped wholesale
  and no redirect target is ever an attribute. Pinned by `spanRedaction`'s
  consent-start cases and `traceBoundary`'s route case.
- `helix.consent.start.dev` (the dev tier's bearer POST) records the
  same shape with `CONSENT_START_DEV_OUTCOMES` — the prod vocabulary minus
  `signin_required` (a dev caller's identity is the token, not a session; the
  resolver's refusals are `forbidden`) — and `url.path` only: the returned
  popup URL carries the single-use nonce, so the query is dropped wholesale
  and the dev bearer token is never an attribute. Pinned by `spanRedaction`'s
  consent-start.dev case and `traceBoundary`'s route case.
- `helix.consent.cancel.edge` (the helper's cancellation acknowledgement) records `helix.outcome` ∈ {`cancelled`, `not_cancellable`,
  `unknown_attempt`, `unauthorized`, `error`} (`CONSENT_CANCEL_EDGE_OUTCOMES`)
  — the forwarded call's outcomes pass through, and the edge adds what only it
  decides: `unauthorized` (no usable session / cross-origin POST) and
  `unknown_attempt` (no live tag correlation on this replica — the response
  body stays the indistinguishable `not_cancellable`, and the attempt is still
  bounded by the five-minute expiry). `helix.provider_ref` rides the decided
  paths, and `url.path` only (the body's attempt tag is a correlation tag, not
  secret material, but it is app-chosen — it is never an attribute).
- `helix.consent.callback` (the vendor redirect lands here) records
  `helix.outcome` ∈ `CONSENT_CALLBACK_OUTCOMES` — the ten-word terminal
  vocabulary (`connected`, `already_connected`,
  `denied`, `expired`, `conflict`, `cancelled`, `disconnected`,
  `failed_permissions`, `failed_provider`, `failed_service`), plus
  `helix.provider_ref` and `helix.app_id` once the attempt claims, and
  `url.path` only — the redirect's `code` and `state` are credential-class and
  the query is dropped wholesale. Unknown-state refusals also answer `denied`
  (there is no not-found word to emit; the page is the fixed refusal). Pinned
  by `routes/connectionsCallback.integration.test.ts`'s global attribute scan.
- `helix.consent.status.edge` / `helix.consent.status.dev` (the app-facing
  connection-status reads, ADR-0031 as amended) record `helix.outcome` ∈
  {`connected`, `not_connected`, `not_available`, `unavailable`,
  `unauthorized` (prod; the dev twin's refusals are `forbidden`), `error`}
  (`CONSENT_STATUS_OUTCOMES` / `CONSENT_STATUS_DEV_OUTCOMES`), plus
  `helix.provider_ref`, `helix.app.slug`, and `url.path` only. The response
  body is the status word and nothing else, and no identity is ever an
  attribute. Pinned by `spanRedaction`'s status cases.
- The `helix.consent.*` spans carry `helix.consent.operation` (bounded to
  consult/cancel/claim/sweep/redeem/callback/status), `helix.outcome` from the operation's bounded
  vocabulary, on the consult `helix.app.slug`, `helix.app_id` and
  `helix.provider_ref`, and on the sweep the removed count
  (`helix.consent.sweep_removed`) — never the `state`, the nonce, the PKCE
  verifier, or any identity (pinned by `routes/connectionsInternal.test.ts`'s global attribute
  scan and `routes/connectionsPages.test.ts`'s redemption scan).
- The `helix.jobs.*` operation spans (the receiver's signed internal routes)
  carry `helix.jobs.operation` (the route's own operation, bounded by the
  matrix), `http.route` (the operation's path template), `helix.outcome` ∈
  `JOBS_INSTRUCTION_OUTCOMES`, and `helix.reason` on a rejection — the
  verifier's bounded reject reason, plus `missing`/`malformed`/`resource` for
  the request-level refusals. Never the token, a claim value, a retry key
  or a URL; the owner oid never appears on any of them (pinned by
  `instructionTelemetry.test.ts`'s
  every-attribute scan). The spans are always roots: the caller is not
  authenticated when the span opens, so an inbound `traceparent` never chooses
  their parentage — background-jobs-plane §9's post-authentication extraction
  is the operation handlers' seam as they land, not this wrapper's. When an
  operation's semantics have landed, the span's final `helix.outcome` is the
  operation's own bounded vocabulary — the lifecycle delivery's is
  `JOBS_LIFECYCLE_OUTCOMES` (`applied`/`stale`/`invalid_body`/`unavailable`),
  beside `helix.app_id`, `helix.jobs.generation` and `helix.jobs.archived`
  (pinned by the same suite's lifecycle scan) — and the submission's is
  `JOBS_SUBMIT_OUTCOMES`: `accepted` (new work committed),
  `recovered` (a keyed resubmission's identical bytes recovered the original
  job — deliberately not `replayed`, which stays the nonce's word),
  `conflict` (different bytes for a retained key), `forbidden` (an
  identical-bytes replay of a readable job whose type the signed
  `allowedTypes` no longer cover — the read paths' 403), `invalid_input`
  (new work refused at validation), `type_unknown` (no installed policy for
  the claimed type), `closed`/`unseen` (the lifecycle gate's final refusal
  and its retryable wait for the portal's delivery), `capacity_exceeded`
  (new work that fit no unfinished or retained cap — the busy 429; the
  specific saturated cap and its occupancy ride the
  `jobs.admission.capacity_refused` log event, never a dimension here),
  `not_found` (an identical-bytes replay of a job whose public record access
  has expired — the 404 an unknown job answers with, no work created while
  the row is still retained), `intake_closed` (new work refused because this
  server's intake is closed by its own configuration or by the durable intake
  row — 503 `jobs_disabled`; retained-key recovery is decided before it), and
  `unavailable` (the acceptance store could not decide) — beside
  `helix.app_id` and `helix.jobs.generation` (pinned by the same suite's
  submit scan). The cancellation's is `JOBS_CANCEL_OUTCOMES`: `requested`
  (the durable intent committed — a repeat while active answers the same),
  `not_found` (no record answers the reference, its identity does not
  match the signed caller, or its public record access has expired — the
  same 404 an unknown job answers with),
  `forbidden` (the signed grants do not cover the record's type),
  `terminal` (the job already carries a terminal outcome; the 409 leaves it
  exactly as it was, and a successful result past its seven days reads
  `expired`), and `unavailable` (the cancellation store could not
  decide) — beside `helix.app_id` and `helix.jobs.job_id` (pinned by the
  same suite's cancel scan). The status poll's is `JOBS_SNAPSHOT_OUTCOMES`
  (`found` — the complete latest snapshot; `not_found`/`forbidden`/
  `unavailable` as the cancellation's, the same unknown-job 404, lapsed-grant
  403 and retryable 503) and the result read's is `JOBS_RESULT_OUTCOMES`
  (`found` — the raw JSON result, JSON `null` included; `not_ready` — the
  stateful 409 while the job is unfinished; `terminal` — the stateful 409
  for a terminal job without a successful result; `expired` — the 410 from
  the result horizon's boundary onward; plus the shared
  `not_found`/`forbidden`/`unavailable`) — beside `helix.app_id` and
  `helix.jobs.job_id` on both (pinned by the same suite's observation scan).
- The `helix.jobs.submit.edge` / `helix.jobs.submit.dev` spans (the two
  app-facing submission routes) carry `helix.jobs.operation` = `submit` (the
  operation the route forwards, taken from the route's own registration),
  `http.route` (the surface's route pattern), `helix.app.slug` once the
  serving entry resolves, `helix.app_id` once the grant check passes, and
  `helix.outcome` ∈ `JOBS_SUBMISSION_OUTCOMES` — the caller-facing route's own
  answer, one word per early return: `accepted` (a validated 202 forwarded),
  `server_refused` (the server's validated error response forwarded as
  received), `unreachable` / `invalid_response` (no answer, or an unusable
  one — acceptance is uncertain, answered with the retryable 503),
  `disabled`, `server_unknown`, `forbidden` (the origin guard, then the jobs
  authorization check), `unauthorized` / `unavailable` (the caller and
  serving gates' own preserved responses), `key_invalid`,
  `payload_invalid`, `payload_too_large`, and `rate_limited` (a submission
  bucket was exhausted — 429; the attempt still counted). `server_unknown`
  and `forbidden` are decided before the buckets and charge neither. No `url.path` — the
  route's `:server`/`:type` segments are caller-chosen — and never the retry
  key, the input bytes, the instruction token or the owner oid (pinned by
  `gateway/jobs.test.ts`'s attribute scan).
- The `helix.jobs.snapshot` / `.result` / `.cancel` `.edge` / `.dev` spans
  (the app-facing reference routes — poll, result read, cancellation) carry
  the same shape: `helix.jobs.operation` = the route's own operation,
  `http.route`, `helix.app.slug` once the serving entry resolves,
  `helix.app_id` and `helix.jobs.job_id` (the validated reference) once the
  request is on its way to a forward, and `helix.outcome` ∈
  `JOBS_REFERENCE_OUTCOMES` — one word per early return: `found` (a validated
  snapshot / raw result / acknowledgement forwarded as received),
  `server_refused`, `unreachable` / `invalid_response` (the retryable 503 —
  an observation failure, never an execution one), `disabled`,
  `server_unknown` and `reference_invalid` (both the unknown-job 404 — an
  unconfigured server and a reference outside the grammar respectively),
  `forbidden` (the cancellation's origin guard, then the jobs authorization
  check), `unauthorized` / `unavailable` (the caller and serving gates' own
  preserved responses). No `url.path` — the route's `:server`/`:jobId`
  segments are caller-chosen — and never the owner oid (pinned by
  `gateway/jobsRecord.telemetry.test.ts`'s attribute scan).
- The `helix.jobs.fetch.edge` / `.dev` spans (the signed jobs→edge callback
  receivers) carry `helix.jobs.operation` = `fetch` (the route's own
  registration, never the token), `http.route` = the operation matrix's
  `/internal/jobs/v1/fetch`, and `helix.outcome` ∈
  `JOBS_FETCH_CALLBACK_OUTCOMES` — one word per early return: `disabled`
  (unwired, 503), `rejected` / `replayed` / `unavailable` (the instruction
  seam's verdicts — verification failed, the nonce was spent, the burn store
  could not answer), `wrong_tier` (verified for the opposite environment
  tier — refused before the burn, so the token stays usable at its own
  receiver), `payload_invalid` / `payload_too_large` (the presented body —
  read only after the instruction header verifies, so an unauthenticated
  request is `rejected`, never `payload_too_large`; a body that fails the
  signed digest is `rejected` with `helix.reason` = `body`), and
  once the dispatch runs `forbidden` (unknown/archived app, stale lifecycle
  generation, ungranted origin — the core's denial reason rides
  `helix.reason`), `delegated_unattended`, `quota_blocked`, `dispatched`
  (the upstream 2xx streamed), `upstream_refused` / `upstream_failed` (the
  bounded `upstream_error` refusals). The verified app id, job id, generation
  and type ride the span once the body phase has verified the instruction (a
  `rejected` or `wrong_tier` span carries none); the target URL, its path and query, the token, the
  claims' owner oid and the upstream body never do (pinned by
  `gateway/jobsCallback.test.ts`'s telemetry scan).
- The `helix.jobs.execute` span (the worker's attempt) carries `helix.outcome`
  ∈ `JOBS_EXECUTE_OUTCOMES` — `succeeded` (the handler's result, inside the
  platform's bounds, projected durably in the same transaction as the
  claim's own fenced settlement), `failed` (the attempt's failure projected durably; the bounded
  `JobError` code rides `helix.reason`), `gate_refused` (the worker-start gate
  refused an ineligible lifecycle generation — the handler never ran),
  `deadline_exceeded` (the worker-start gate terminated the job — its absolute
  deadline, queue wait and retries included, passed before the attempt; the
  timeout outcome was committed in the same transaction that decided it),
  `cancelled` (the gate found the record's durable cancellation intent and
  committed its terminal `cancelled` outcome in the gate's own transaction —
  the handler never ran and the intent can never turn into a run or a retry),
  `terminal_fenced` (the record was already terminal or the runner claim had
  lapsed — no outcome overwritten), and `unavailable` (the execution store
  could not answer, or the outcome transaction could not commit — nothing
  was projected and the claim fails through the retry policy). The grading is a decided contract, uniform at every exit:
  a designed failure (`failed` with the job's own reason) and the refusals
  (`gate_refused`, `deadline_exceeded`, `cancelled`, `terminal_fenced`) stay
  UNSET — the
  platform working as designed; `failed` with reason `platform_error` and
  `unavailable` grade
  ERROR — a platform fault and an infrastructure outage are what a trace
  backend's error views exist to surface, and the
  `helix.jobs.executions` counter's dimensions tell the same story. Never the
  input, the result, a retry key, an owner oid or a URL (pinned by the
  execution suite's every-attribute scan and its span-status pins); the
  "links to enqueue" join of ADR-0009 is the span's own
  `helix.jobs.job_id` attribute — no trace context is stored on jobs, so
  there is nothing to link against.
- The `helix.jobs.fetch.dispatch` span (the outbound fetch handler's
  governed-GET hop to the edge's signed callback) carries the execute span's
  bounded identity (`helix.app_id`, `helix.jobs.type`, `helix.jobs.job_id`)
  with `helix.outcome` ∈ `JOBS_FETCH_DISPATCH_OUTCOMES` and `helix.reason`
  naming the exit (the callback's own error code for a refusal, the abort's
  classification for an unanswered dispatch). Grading is the execute span's
  contract: a designed answer (`refused`, `upstream_error`, the result
  refusals, `unreachable` for the timeout or the attempt's own cancellation)
  stays UNSET; `callback_unavailable`, `invalid_response` and a transport
  `unreachable` — the callback seam failing or drifting, all answered
  `platform_error` — grade ERROR. Never the target URL, the callback base,
  the instruction token, the input bytes or the owner oid (pinned by
  `apps/jobs/src/fetchJob.test.ts`'s every-attribute scan).
- The `helix.jobs.recover` span (the recovery sweeper's disposition of one
  interrupted job — one per job a pass dispositioned, never for consistent
  work it passes through) carries the same bounded identity (`helix.app_id`,
  `helix.jobs.type`, `helix.jobs.job_id`, `helix.jobs.attempt` when the
  record names one) with `helix.outcome` ∈ `JOBS_RECOVER_OUTCOMES` and the
  projected reason on `helix.reason`. Everything stays UNSET but
  `row_missing` (a corrupt store grades ERROR): every other disposition is
  the sweeper working as designed — `crashed` is the truthful outcome of
  lost execution, not a fault of the sweep. Pinned by the recovery suite's
  every-attribute scan.

| Instrument | Kind | Attributes |
| --- | --- | --- |
| `helix.registry.stale_for_ms` | observable gauge | — |
| `helix.registry.load_failures` | counter | `outcome` |
| `helix.gateway.calls` | counter | `capability`, `outcome`, `appId` |
| `helix.gateway.duration` | histogram (ms) | `capability`, `outcome` |
| `helix.egress.proxy.duration` | histogram (ms) | `outcome` |
| `helix.egress.exchanges` | counter | `outcome`, `env` |
| `helix.egress.renewals` | counter | `outcome`, `env` (the renewal taxonomy; alert on a run of `temporary_failure`/`admin_action`, and treat any `uncertain_rotation` as a user-visible reconnection) |
| `helix.egress.retirements` | counter | `outcome`, `env` (the retirement ledger's consumption: `retired` / `failed` / `claimed_lost`. `failed` is the alertable word — it also fires the fixed `egress.connection_retire_failed` warn event, and the entry is restored and retried on a later pass within the 15-minute recovery bound. `claimed_lost` is the sweep losing a claim race to a writer (a reconnect's swap, a newer mark) — the conditional re-check working, never a fault; see ADR-0031 amendment item 12 for why the claim must be CAS) |
| `helix.providers.reconciles` | counter | `outcome` |
| `helix.providers.listen_status` | observable gauge | — |
| `helix.session.gate_denied` | counter | `reason` |
| `helix.edge.trust_proxy.unresolved` | observable gauge | — |
| `helix.app.visits` | counter | `appId`, `outcome` (`recorded` / `failed` / `dropped` / `deduplicated`; the fire-and-forget `app_visits` write, ADR-0050. Alert on a sustained `failed` or `dropped` rate. The owner's numbers come from the table, never this counter) |
| `helix.consent.operations` | counter | `operation`, `outcome` (ADR-0031 as amended; the portal's first instrument — see the `helix.outcome` vocabularies in `@azx-pbc/shared/telemetry`) |
| `helix.jobs.storage.probes` | counter | `outcome` ∈ {`ok`, `unavailable`} — the jobs service's storage-readiness probes (`JOBS_STORAGE_PROBE_OUTCOMES`). An attempt counter, like `helix.providers.reconciles`: a run of `unavailable` with no `ok` is a store outage, and the *reason* (unreachable / schema / queue-policy / burn store / privileges) is carried by the `jobs_database` check's body (which the jobs health relay carries to the `-alert-jobs-execution` rule) and the `jobs.storage.unavailable` log event. The count includes the early probe a job request that failed against the store asks for (at most one per second) |
| `helix.jobs.reachability.probes` | counter | `outcome` ∈ {`reachable`, `unreachable`, `invalid_response`} (`JOBS_REACHABILITY_PROBE_OUTCOMES`) — the edge's bounded jobs-reachability probes (`jobs/reachability.ts`), one point per configured server per pass, on the probe's own cadence and independent of user requests (a quiet deployment is still observed). A run of `unreachable` with no `reachable` is a jobs server this edge cannot forward to (no answer inside the bound); a run of `invalid_response` is an endpoint that ANSWERED but not as the jobs service — a redirect, a wrong status, a body past the hop's response allowance, or a contract body naming another helix service — the misroute the counter's words exist to separate from a dead endpoint. The *reason* (no answer / off-protocol) and the per-server story ride the `jobs_reachability` check's body and the `edge.jobs_reachability.*` transition events; what a reachable server reported about itself is the detail's evidence, never this counter's grade — the server's own body stays authoritative for its state |
| `helix.jobs.instructions` | counter | `helix.jobs.operation` ∈ {`submit`, `snapshot`, `result`, `cancel`, `lifecycle`} (the route's own name, never read from the token), `outcome` ∈ {`accepted`, `replayed`, `rejected`, `unavailable`} (`JOBS_INSTRUCTION_OUTCOMES`) — every presentation of a signed internal instruction, refused or not. A run of `replayed` is a capture-and-replay attempt (the burn caught it; no effect ran); a run of `rejected` is a forged or misconfigured minter, and the *reason* rides the span's `helix.reason` (`JOBS_INSTRUCTION_REJECT_REASONS`, plus `missing`/`malformed` for a header that never was a token, and `resource` for a path that cannot name one) — never a metric dimension; a run of `unavailable` is the burn store failing closed. Identity, token and retry-key material never appear in any dimension |
| `helix.jobs.burn.sweeps` | counter | `outcome` ∈ {`ok`, `failed`} — the burn store's bounded cleanup passes, emitted by BOTH planes that run a burn store: the jobs service (its `instruction_burns` table) and the edge (its `jobs_callback_jti` table, prod tier; the dev-gateway emits the same instrument for the dev tier). Passes that remove rows are routine silence; a run of `failed` with no `ok` is a store that stopped answering its cleanup, and burned nonces then grow with instruction volume until it answers |
| `helix.jobs.submissions` | counter | `outcome` ∈ `JOBS_SUBMISSION_OUTCOMES` — the app-facing submission routes' answers (the `helix.jobs.submit.edge` / `.dev` spans), one point per request including the local refusals that never mint an instruction. An attempt counter over submissions, NOT an accepted-job count: keyed replays and uncertain outcomes are all in here, and the receiver's `helix.jobs.instructions` counts the same operations' presentations from the other side — the two are never reconciled. Per-app attribution is the request ledger's job (ADR-0004), never this counter's. A run of `rate_limited` is the submission buckets doing their job (an app or the deployment is over its attempt window, sized by `EDGE_JOBS_LIMITS`); the throttled app's identity is in its ledger rows, not here. On the `.dev` route the windows are the dev gateway's own process-local counts, never the edge's shared deployment-wide window |
| `helix.jobs.callbacks` | counter | `outcome` ∈ `JOBS_FETCH_CALLBACK_OUTCOMES` — the signed jobs→edge callback receivers' answers (the `helix.jobs.fetch.edge` / `.dev` spans), one point per presentation including the verification verdicts that never dispatch. A run of `replayed` is a capture-and-replay attempt (the burn caught it; no effect ran); a run of `rejected` is a forged or misconfigured minter — the bounded reject reason rides the span's `helix.reason`, never a dimension; `wrong_tier` marks instructions misrouted to the other tier's receiver (refused without spending the nonce); `upstream_refused` / `upstream_failed` mark the job's upstream failure classes, distinguishable here and on the span while jobs sees the same bounded refusal for both. Per-app attribution is the fetch ledger's job (the policy core writes it), never this counter's |
| `helix.jobs.executions` | counter | `outcome` ∈ {`succeeded`, `failed`, `gate_refused`, `deadline_exceeded`, `cancelled`, `terminal_fenced`, `unavailable`} (`JOBS_EXECUTE_OUTCOMES`) — every execution attempt's disposition, one per attempt. A run of `unavailable` is an execution store that stopped answering; `gate_refused` marks work whose lifecycle generation closed before it could start (its durable cancellation is the recovery loop's); `deadline_exceeded` marks work the absolute deadline terminated before an attempt; `cancelled` marks work whose durable cancellation intent the worker-start gate committed as the terminal outcome before the handler ran; the failure *reason* rides the span's `helix.reason`, never a dimension. The attempt number is a span attribute, never a metric dimension |
| `helix.jobs.recoveries` | counter | `outcome` ∈ {`deadline_exceeded`, `crashed`, `failed`, `requeued`, `cancelled`, `row_missing`, `fenced`} (`JOBS_RECOVER_OUTCOMES`) — interrupted jobs the recovery sweeper dispositioned, one per `helix.jobs.recover` span. A run of `crashed` is worker loss recovering to its truthful terminal outcome; a run of `deadline_exceeded` is deadline pressure (queue wait or retries consuming the acceptance-to-close bound); `cancelled` covers a cancelled runner row reconciled into its record, a pending owner/lifecycle cancellation intent the pass re-drove to its terminal outcome, and a code-less failed settle under intent — the fence's own signature (the claim refused because the intent committed, or the drive was lost and the claim expired); a run of `row_missing` is an inconsistent store. The pass cadence itself is graded by the `jobs_sweeper` health check, never a dimension here. The archive-cancellation backlog the same pass heals and measures is the `jobs_lifecycle_recovery` check's evidence (`jobs_lifecycle_recovery`: outstanding count and oldest pending age of still-active closed-generation work — older than 60 s degrades, criterion 52), kept separately visible from the portal's `jobs_lifecycle_delivery` lag; the evidence is taken at each pass's START, so a pass that clears the backlog reports the state it opened on until the next pass measures again |
| `helix.jobs.cleanups` | counter | `outcome` ∈ {`ok`, `failed`} (`JOBS_CLEANUP_OUTCOMES`) — the cleanup loop's physical-retention passes, one per `helix.jobs.cleanup` span. Passes that remove nothing are routine silence; a run of `failed` with no `ok` is a store that stopped answering its cleanup, and expired content then grows past its 48-hour removal bound — the state the `jobs_cleanup` check's overdue evidence and the `jobs_capacity` check's saturation evidence degrade on |
| `helix.jobs.fetch.dispatches` | counter | `outcome` ∈ `JOBS_FETCH_DISPATCH_OUTCOMES` — the outbound fetch handler's governed-GET dispatches (the `helix.jobs.fetch.dispatch` spans), one per job attempt's single dispatch. The dispatch is never retried (one attempt is the type's own policy), so these are also the job's outbound-fate rates: a run of `refused` is current policy/budget/delegated refusals (the callback's error code rides `helix.reason`); `unreachable` is the callback not answering or the 30-second outbound bound expiring; `callback_unavailable` / `invalid_response` are the callback seam failing or answering off-protocol; `result_invalid` / `result_too_large` are the streamed answer failing the result contract at its two distinct reasons. The target URL, the callback base and the token never appear in any dimension |
| `helix.deploy.repo_requests` | counter | `outcome`, `appId` when the slug resolved (ADR-0051; one per CI deploy decision. A burst of `repo_mismatch` is someone probing with tokens from other repos; a run of `event_rejected` or `ref_mismatch` on one app is a misconfigured workflow. Refusals also log `event: "repo_deploy.denied"` at `warn` with the same reason) |

`appId` is a dimension; **`userOid` never is** — unbounded and personal data, it
belongs in the ledger under the basis ADR-0021 reasoned about, not in a retained
metrics backend.
### Audit events and ledger outcomes (the ledger, not OTel)

Two signal families from the OAuth-connections work live in platform tables rather than the telemetry
pipelines — listed here because the operator-facing inventory is the point, and
because they are what the audit and usage pages show.

**Audit events** (the portal's `AuditEvent` table; dotted actions on the
`secret.*` precedent, actor-stamped, metadata bounded to refs, envs, ids,
counts, and changed-field names — never a credential, sealed material, or an
endpoint URL):

| Action | Actor | Metadata (bounded) |
| --- | --- | --- |
| `provider.created` / `provider.updated` | admin | ref, env, kind, whether the secret rotated or the client identity changed; a sensitive edit adds the sensitive field names and the impact counts (invalidated connections, killed attempts) |
| `provider.deleted` | admin | ref, env, providerId, bound apps, connections, pending attempts — the repeat-delete `already_removed` answer reads this row, so it commits with the removal or not at all |
| `provider.imported` | admin | mode (`create`/`update`), ref, env, kind; an update carries the same sensitive/impact metadata as `provider.updated` |
| `provider.exported` | admin | providerId, ref, env, kind |
| `provider.destroy_failed` | admin (the failed release) | ref, env, field, reason, and the `kv:` vault reference when the material is vault-held — dev envelope ciphertext is never copied anywhere |
| `connection.connected` | connecting user | providerRef, env, appId |
| `connection.disconnected` | disconnecting user | providerRef, env |

**Ledger outcome**: `gateway_calls` gains one outcome label,
`connection_required` — the delegated call answered "the caller has no usable
connection". It is kept distinct from `refusal` so the audit page and usage
rollups separate "user not connected" from "policy refused" ); the other provider-shaped codes (`provider_unavailable`,
`provider_misconfigured`) meter as the existing `refusal`.

**Jobs submissions in the ledger** (ADR-0004): each counted submission attempt
is one `gateway_calls` row with capability `jobs`, the requested qualified type
in the `model` column, the caller-facing status, and a bounded jobs-error
catalogue word in `errorDetail` — never input, a retry key, a URL or exception
text. These are **recorded submission requests, not accepted jobs**: a keyed
replay records a second `ok` row, and an uncertain ending (`unreachable` /
`invalid_response`) records `error` without proving anything about whether
work was accepted. Rows may be missing after a ledger failure — the write is
best-effort and never changes acceptance — and the throttle refusals' rows and
the server/type refusals' rows are each capped per (app, env) (the
`jobs-denial:` and `jobs-grant-denial:` budgets), so a flood's audit trail is
bounded by design. Status/result/cancel requests are not ledger rows.

### Things to know before writing an alert on these

- **`gate_denied{reason="no_session"}` has a permanent baseline.** It fires on
  every first, anonymous navigation to a non-public app — the ordinary
  pre-login redirect — so it tracks normal traffic, not anomalies. It is a
  useful *ratio* against total requests and a useless absolute threshold. An
  "unexpected denials" signal needs the navigation-redirect case split out
  first.
- **`helix.app.slug` is unbounded on spans.** The root span opens before the app
  is resolved, so a request to a well-formed but nonexistent subdomain still
  produces one, and an unauthenticated scanner can mint arbitrary distinct slug
  values into a retained backend. `SLUG_PATTERN` bounds the shape, not the
  cardinality. This is consistent with ADR-0037 deferring tail sampling
  (decision 11), and it is a span attribute rather than a metric label, so it
  costs retention rather than time series — but it is the first thing to revisit
  if span volume becomes a cost question.
- **`helix.edge.trust_proxy.unresolved` is absent below N, by design.** A gauge
  reading `0` on a replica that has seen no proxied traffic would claim
  "verified healthy" about a state nobody has measured — the same
  direction-wrongness rule 2 above exists because of. The gauge appears at `0`
  or `1` only once the last 50 forwarded-header requests exist to grade
  (ADR-0011); an alert on it fires on presence, so no-data is not an alert.
- **The app-data gateway's spans carry no `url.path`, by decision.** Four of its
  routes put an app-chosen key in the path's last segment, and prefix grants
  (ADR-0042) exist so those keys are invented at runtime — a path attribute
  there is unbounded, attacker-choosable app data in a retained backend (the
  same reasoning as the slug bullet, but with data rather than noise). The
  wrapper records `http.route` + `helix.data.verb` instead;
  `spanRedaction.test.ts` fails if a path is re-added.
- **`helix.providers.reconciles{outcome="failed"}` is an attempt counter, and
  the alert is a run, not a rate.** A provider-config cache reconcile fails
  when the DB does; the cache serves its previous snapshot meanwhile (egress
  has no `/health` grade to ladder into — it reports liveness only), so the
  signal that matters is a streak of `failed` with no `ok`, not a single blip.
  `helix.providers.listen_status` is the second half: `1` while a dedicated
  LISTEN client is connected, `0` while down, absent before start and after
  stop — a missed NOTIFY self-heals at the next reconcile, so
  a `0` is a page about cadence, not correctness.

## The rules that are easy to break

- **No `url.full`, `http.url`, `http.target` or `url.query`, ever.** Several
  platform URLs carry a live credential in the query string. Record `url.path`
  via `spanUrlAttributes`, which redacts *and then* drops the query wholesale —
  stricter than the log serializer, because nothing about a span needs a query.
- **Egress attributes are a hardcoded allowlist**, and include no header name or
  value. The injected credential *is* a header. Egress spans also record no
  exception: an error message on that plane can embed credential material, which
  is why its error handler already returns a fixed opaque body.
- **The edge never continues a trace from an app-user request.** Propagation
  runs inward only, edge → egress. An inject-only propagator makes an inbound
  `traceparent` unextractable, every inbound span is `root: true`, and a lint
  rule bans `propagation.extract` in the edge and the portal.
- **OTel replaces neither `gateway_calls` nor the pino logs.** The ledger stays
  the sole authority for metering, budgets and audit; `helix.gateway.calls` is
  an operational counter that happens to count the same events and is never
  reconciled against it. The two provably differ — the ledger throttles fetch
  denial rows and the counter does not. Each category has its own per-(app,
  env) budget and its own summary log line when the budget runs out:
  allowlist denials (`denial:`, "allowlist-denial metering suppressed"),
  pre-egress size refusals (`fetch-size-denial:`, "fetch size-refusal metering
  suppressed"), and the jobs callback's policy refusals
  (`jobs-callback-denial:`, "jobs callback fetch-denial metering
  suppressed").

An ESLint rule enforces the SDK boundary and the forbidden attribute keys; the
adversarial suites (`spanRedaction.test.ts`, `traceBoundary.test.ts`,
`apps/egress/src/spanAttributes.test.ts`) scan every attribute of every span
rather than checking one field, so a span added later without thought fails a
test instead of leaking quietly.

## What consumes it

On Azure, both collectors export to one workspace-based Application Insights
component, so traces and metrics land in the same Log Analytics workspace the
environment already ships stdout to. Metrics arrive in `customMetrics`
(`AppMetrics` under the workspace schema — the two names are the same table).

Two alert rules read the registry gauges, and they read **different signals on
purpose** (`infra/azure/modules/alerts.bicep`); a third reads the trust-proxy
one:

| Rule | Signal | Why that one |
| --- | --- | --- |
| projection stale | `helix.registry.stale_for_ms` metric | An age needs a threshold, and this is the metric that made it one rule instead of KQL over log messages |
| projection never loaded | `registry.never_loaded` log event | The gauge is *absent* in this state by design, and the counter that reports it is cumulative, so a threshold on it never stops firing |
| trust proxy unresolved | `helix.edge.trust_proxy.unresolved` metric | A `degraded` /health alerts nobody by itself — this is the rule that makes the edge's `EDGE_TRUST_PROXY` self-reporting (ADR-0011) |

The jobs plane's health bodies have their own module,
`infra/azure/modules/alerts-jobs.bicep`, deployed with `deployAlerts` and
`deployJobs`. The jobs app and, by default, the portal have internal ingress,
so no outside probe can read their bodies. A scheduled Container Apps Job in the
apps environment, the **health relay** (`apps/jobs/scripts/health-relay.ts`),
reads each configured jobs server's `/health` and the portal's every 5 minutes,
validates the body against `HealthStatusSchema` and the expected `service`, and
writes two bounded stdout events: `jobs.health.check` (one per expected
`jobs_*` check: `kind`, `target`, `check`, `status`, `detail` capped at 400
characters, `metrics`) and `jobs.health.observed` (one per target: `outcome` ∈
`observed`/`no_answer`/`off_protocol`, the roll-up `status`, and the `missing`
expected checks). It never writes a URL or an error message. These are log
lines in the workspace, not OTel signals, so the rules work with
`deployTelemetry=false`.

| Rule | Reads | Covers |
| --- | --- | --- |
| `jobs-execution` | `jobs_database`, `jobs_worker`, `jobs_intake` | Storage unreachable or at the wrong schema, no registered worker, intake not applied or refused. Throttle and capacity refusals never reach these checks |
| `jobs-capacity` | `jobs_capacity` | Retained storage at its server-wide bound, or the measurement stale |
| `jobs-cleanup` | `jobs_cleanup` | Expired content past its 48-hour removal deadline, or the cleanup loop stopped |
| `jobs-lifecycle` | `jobs_lifecycle_delivery` (portal), `jobs_lifecycle_recovery`, `jobs_sweeper` | Delivery or archive cancellation pending over 60 s, or the sender or sweeper stopped |
| `jobs-unobserved` | `jobs.health.observed`, and its absence | No relay line for a target in the window, no answer, an off-protocol answer, or a missing check. Missing evidence never reads as healthy |

Each rule takes the latest reading per target and check, and alerts split by
target, so each jobs server alerts on its own. The diagnostic step for each rule
is in `infra/azure/README.md`. The edge's `jobs_reachability` check is not
relayed. It is in the edge's public body and is capped at `degraded`, so the
edge availability test (which fails on `error`) never pages a jobs outage as an
edge outage; the rules above cover the jobs plane being down.

The operator procedures these alerts lead to — telling the portal's delivery
backlog from the jobs service's cancellation backlog, cleanup and expiry,
retirement and recovery — are in
[Operating background jobs](../../apps/docs/src/deploy/jobs.md).

Four more modules alert on signals this platform does **not** emit, which is the
point of them — everything above goes quiet in exactly the failures that stop the
process:

| Module | Reads | Covers |
| --- | --- | --- |
| `alerts-availability.bicep` | Application Insights **standard tests** against `auth.<appsDomain>/health` (+ the portal when external, + any `availabilityExtraTargets`) | Reachability, the health **body**, and TLS cert validity/expiry — from five Azure regions, i.e. from outside the platform |
| `alerts-infra.bicep` | Azure platform metrics: `is_db_alive`, `storage_percent`, `RestartCount`, ingress `Requests` 5xx, Service Health | Postgres down or filling, container crash loops, edge server errors, Azure's own incidents |
| `alerts-cost.bicep` | Billing | A monthly budget over the platform-infra resource groups (LLM spend is excluded by topology — the Foundry account has its own group). Notifies; never enforces |
| `alerts-cost-foundry.bicep` | Billing | With `deployFoundry`: a monthly budget on the Foundry account's group — the LLM axis. Notifies; never enforces |

The availability tests are the probe this page used to list under "not built":
`/health` always answers 200, so grading it means reading the body, and a
standard test's content match does that — it fails on `"status":"error"`. It also
watches the wildcard certificate's remaining lifetime, which is the cheapest
monitor on ADR-0029's certbot job because it reads the **outcome** (a cert with
days left) rather than the mechanism (a job that ran). Note the two things it
structurally cannot see: **egress** (internal-only, no public LB — ADR-0001
working as designed) and `dev-api.<appsDomain>` (a valid app slug, so the edge
serves assets there rather than platform health).

All of them are optional (`deployAlerts`, `deployAvailabilityTests`,
`deployInfraAlerts`, `deployCostBudget`) and notify one shared action group built
from a parameterized list of addresses (`alertEmails`). **With no addresses the
rules still deploy and still fire, into nothing** — the deployment's
`alertsNotify` output says which, because a rule nobody hears from looks exactly
like coverage.

## Not built yet
- The OTel **log** bridge, browser/RUM for the portal SPA, per-app telemetry for
  hosted apps (the owner-facing visit counts in ADR-0050 are product data in
  Postgres, not this pipeline), tail sampling, and `pg`/`undici` instrumentation depth beyond the
  hand-placed seams — all deferred, each on its own merits (decision 11).

Graceful shutdown is built: every service installs a `SIGTERM`/`SIGINT` handler
(`@azx-pbc/shared/lifecycle`) that drains in-flight requests under a hard
deadline (default 10 s, `SHUTDOWN_GRACE_MS`) and runs the `onClose` hooks — the
final telemetry batch now lands on a real stop. The batch interval (1 s) is
what still covers crashes, `SIGKILL` and never-delivered signals; see
[`packages/telemetry/README.md`](../../packages/telemetry/README.md).
