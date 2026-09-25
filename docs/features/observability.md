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
| `helix.consent.start` | the app host's `/_api/connections/:ref/start` route (I-02 T-0014) — the consent popup's prod entry |
| `helix.consent.start.dev` | the dev gateway's `/:slug/_api/connections/:ref/start` route (I-02 T-0016) — the dev tier's bearer POST → single-use popup URL |
| `helix.consent.cancel.edge` | the app host's `/_api/connections/attempt/cancel` route (I-02 T-0017) — the connect helper's cancellation acknowledgement, forwarding to the portal's own `.cancel` span |
| `helix.egress.proxy` | egress `POST /proxy` |
| `helix.egress.resolution` | egress delegated-call resolution (I-02 T-0022) — the span the proxy opens around resolving a `provider`-bearing instruction's caller connection; nests inside the proxy span, with the renewal span inside it when a renewal runs |
| `helix.egress.exchange` | egress `POST /exchange` — the code-exchange operation (I-02 T-0019) |
| `helix.egress.renewal` | egress token renewal (I-02 T-0021) — the operation the delegated-call resolution runs when an access token is expired; nests inside the resolution span, and its own duration is where the advisory lock's bounded wait is visible (ADR-0007) |
| `helix.egress.retire` | egress credential-retirement sweep pass (I-02 T-0025, ADR-0008) — one background pass over the `pendingRetire` ledger; per-entry results ride the `helix.egress.retirements` counter |
| `helix.registry.load` | the projection reload |
| `helix.providers.reconcile` | the egress provider-cache reconcile (I-02 ADR-0011) |
| `helix.deploy.bundle` → `.validate` / `.upload` | the portal deploy path |
| `helix.consent.consult` / `.cancel` / `.claim` / `.sweep` / `.redeem` / `.callback` | the portal's consent-flow state machine (I-02 ADR-0002): the internal consult + cancel routes, the callback's claim probe, the expiry sweep, the dev journey's nonce redemption (T-0016), and the vendor redirect's completion state machine (T-0020) |
| `helix.connections.mine` | the portal's `GET /api/v1/connections/mine` route (I-02 T-0024) — My Connections' metadata-only list |
| `helix.connections.disconnect` | the portal's `DELETE /api/v1/connections/mine/:id` route (I-02 T-0024) — the one-transaction disconnect; carries `helix.outcome` ∈ {`disconnected`, `already_removed`}, `helix.provider_ref`, `helix.env`, and the killed-attempt count (`helix.attempts_killed`) — never the caller's identity |

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
  provider-bound one (I-02 T-0023; the ref is the admin-granted catalogue key,
  bounded by `PROVIDER_REF_MAX`). Nothing is recorded for a keyless origin, and
  an origin that failed the allowlist check is never recorded under either key.
- `helix.egress.proxy` spans carry `helix.credential_source` ∈ {`secret`,
  `managed-identity`, `delegated`} when a credential was injected — which custody
  path served the call (ADR-0046; `delegated` is the caller's own OAuth
  connection, I-02 T-0022), and the first thing to check when a Foundry-bound
  call misauthenticates. Bounded to those three values; on the egress allowlist,
  so never a header name, a credential, or a token claim. A delegated dispatch
  also carries `helix.provider_ref`.
- `helix.egress.resolution` spans carry `helix.outcome` ∈
  `EGRESS_RESOLUTION_OUTCOMES` (`resolved`, `refreshed`, `connection_required`,
  `reconnect_required`, `provider_unavailable`, `provider_misconfigured`,
  `error` — design.md's inventory plus the plane's generic `error` for the
  temporary-renewal-failure/custody paths, whose specific word the renewal span
  inside carries), `helix.env`, and `helix.provider_ref`. No token value, no
  vendor content, and no identity (`userOid` is never a dimension) appears on
  it; the app-facing answer for every 403 word is the ledger's
  `connection_required`.
- `helix.egress.proxy` spans' `helix.outcome` ∈ {`ok`, `upstream_throttled`,
  `refusal`, `error`} — `upstream_throttled` is a proxied upstream `429`: the
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
  `helix.reason` on a criterion-27 rejection (the bounded gate vocabulary —
  `unusable_lifetime`, `missing_refresh_token`, `missing_permissions`). The
  vendor token endpoint's failures are the ONE word `exchange_failed`: the
  fixed-string discipline (I-02 ADR-0009) keeps vendor error bodies — which can
  echo client credentials — off the wire, out of logs, and off this span; the
  span records no exception, like every egress span.
- `helix.egress.renewal` spans carry `helix.outcome` ∈ `EGRESS_RENEWAL_OUTCOMES`
  (`refreshed`, `temporary_failure`, `uncertain_rotation`, `reconnect_required`,
  `admin_action` — design.md's renewal vocabulary, criteria 35/37–39),
  `helix.env`, and `helix.provider_ref`. No token value and no vendor error
  content appears anywhere on it: the OAuth error code is read only to choose
  the bounded outcome word, never recorded. Span status is graded ERROR for
  `temporary_failure` and `admin_action` (operator-actionable); the
  reconnect-needing outcomes are the platform working as designed.
- `helix.auth.connections.proxy` (the auth host's `/connections/*` reverse
  proxy) records `url.path` only — the vendor's redirect lands there with
  `code` and `state` in the URL, so the query is dropped wholesale
  (`spanUrlAttributes`), and nothing about the internal JWT it mints — value,
  header name — is ever an attribute. Pinned by `spanRedaction.test.ts`'s
  T-0015 case and `traceBoundary.test.ts`'s route case.
- `helix.consent.start` (the consent popup's entry route) records
  `helix.outcome` ∈ {`started`, `signin_required`, `already_connected`,
  `unavailable`, `forbidden`, `error`} (`CONSENT_START_OUTCOMES` — the six
  answers the route can give; `forbidden` is the same-origin navigation guard,
  `signin_required` the pre-consult session check), plus `helix.provider_ref`
  and `helix.app.slug`, and `url.path` only — the start URL's `attempt`
  correlation tag is app-chosen and the 302's target is the vendor authorize
  URL carrying `state` + the PKCE challenge, so the query is dropped wholesale
  and no redirect target is ever an attribute. Pinned by `spanRedaction`'s
  T-0014 cases and `traceBoundary`'s route case.
- `helix.consent.start.dev` (the dev tier's bearer POST, T-0016) records the
  same shape with `CONSENT_START_DEV_OUTCOMES` — the prod vocabulary minus
  `signin_required` (a dev caller's identity is the token, not a session; the
  resolver's refusals are `forbidden`) — and `url.path` only: the returned
  popup URL carries the single-use nonce, so the query is dropped wholesale
  and the dev bearer token is never an attribute. Pinned by `spanRedaction`'s
  T-0016 case and `traceBoundary`'s route case.
- `helix.consent.cancel.edge` (the helper's cancellation acknowledgement,
  T-0017) records `helix.outcome` ∈ {`cancelled`, `not_cancellable`,
  `unknown_attempt`, `unauthorized`, `error`} (`CONSENT_CANCEL_EDGE_OUTCOMES`)
  — the forwarded call's outcomes pass through, and the edge adds what only it
  decides: `unauthorized` (no usable session / cross-origin POST) and
  `unknown_attempt` (no live tag correlation on this replica — the response
  body stays the indistinguishable `not_cancellable`, and the attempt is still
  bounded by the five-minute expiry). `helix.provider_ref` rides the decided
  paths, and `url.path` only (the body's attempt tag is a correlation tag, not
  secret material, but it is app-chosen — it is never an attribute).
- `helix.consent.callback` (the vendor redirect lands here, T-0020) records
  `helix.outcome` ∈ `CONSENT_CALLBACK_OUTCOMES` — design.md §Operator-visible
  signals' ten-word terminal vocabulary (`connected`, `already_connected`,
  `denied`, `expired`, `conflict`, `cancelled`, `disconnected`,
  `failed_permissions`, `failed_provider`, `failed_service`), plus
  `helix.provider_ref` and `helix.app_id` once the attempt claims, and
  `url.path` only — the redirect's `code` and `state` are credential-class and
  the query is dropped wholesale. Unknown-state refusals also answer `denied`
  (there is no not-found word to emit; the page is the fixed refusal). Pinned
  by `routes/connectionsCallback.integration.test.ts`'s global attribute scan.
- The `helix.consent.*` spans carry `helix.consent.operation` (bounded to
  consult/cancel/claim/sweep/redeem/callback), `helix.outcome` from the operation's bounded
  vocabulary, and on the consult `helix.app.slug`, `helix.app_id` and
  `helix.provider_ref` — never the `state`, the nonce, the PKCE verifier, or any
  identity (pinned by `routes/connectionsInternal.test.ts`'s global attribute
  scan and `routes/connectionsPages.test.ts`'s redemption scan).

| Instrument | Kind | Attributes |
| --- | --- | --- |
| `helix.registry.stale_for_ms` | observable gauge | — |
| `helix.registry.load_failures` | counter | `outcome` |
| `helix.gateway.calls` | counter | `capability`, `outcome`, `appId` |
| `helix.gateway.duration` | histogram (ms) | `capability`, `outcome` |
| `helix.egress.proxy.duration` | histogram (ms) | `outcome` |
| `helix.egress.exchanges` | counter | `outcome`, `env` (I-02 T-0019) |
| `helix.egress.renewals` | counter | `outcome`, `env` (I-02 T-0021 — the renewal taxonomy; alert on a run of `temporary_failure`/`admin_action`, and treat any `uncertain_rotation` as a user-visible reconnection) |
| `helix.egress.retirements` | counter | `outcome`, `env` (I-02 T-0025 — the retirement ledger's consumption: `retired` / `failed` / `claimed_lost`. `failed` is the alertable word — it also fires the fixed `egress.connection_retire_failed` warn event, and the entry is restored and retried on a later pass within criterion 47's 15-minute bound. `claimed_lost` is the sweep losing a claim race to a writer (a reconnect's swap, a newer mark) — the conditional re-check working, never a fault; see ADR-0008 for why the claim must be CAS) |
| `helix.providers.reconciles` | counter | `outcome` |
| `helix.providers.listen_status` | observable gauge | — |
| `helix.session.gate_denied` | counter | `reason` |
| `helix.edge.trust_proxy.unresolved` | observable gauge | — |
| `helix.consent.operations` | counter | `operation`, `outcome` (I-02 ADR-0002; the portal's first instrument — see the `helix.outcome` vocabularies in `@azx-pbc/shared/telemetry`) |

`appId` is a dimension; **`userOid` never is** — unbounded and personal data, it
belongs in the ledger under the basis ADR-0021 reasoned about, not in a retained
metrics backend.

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
  stop — a missed NOTIFY self-heals at the next reconcile (I-02 ADR-0011), so
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
  reconciled against it. The two provably differ — the ledger throttles
  allowlist-denial rows and the counter does not.

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
  hosted apps, tail sampling, and `pg`/`undici` instrumentation depth beyond the
  hand-placed seams — all deferred, each on its own merits (decision 11).

Graceful shutdown is built: every service installs a `SIGTERM`/`SIGINT` handler
(`@azx-pbc/shared/lifecycle`) that drains in-flight requests under a hard
deadline (default 10 s, `SHUTDOWN_GRACE_MS`) and runs the `onClose` hooks — the
final telemetry batch now lands on a real stop. The batch interval (1 s) is
what still covers crashes, `SIGKILL` and never-delivered signals; see
[`packages/telemetry/README.md`](../../packages/telemetry/README.md).
