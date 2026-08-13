# ADR-0037 — Platform observability: OpenTelemetry behind an OTLP-only boundary

## Status

Proposed — needs sign-off. Covers observability of **the platform itself** (edge,
portal, egress); hosted apps are explicitly out of scope. Relates to
[ADR-0003](0003-dependency-minimal-edge.md) (the dependency rule this must satisfy
to touch the edge at all), [ADR-0021](0021-metering-ledger.md) (the ledger this must
not absorb), [ADR-0025](0025-registry-projection-hardening.md) (the staleness signals
this finally makes alertable), [ADR-0028](0028-deployment-model-customer-deployed.md)
(why a hard Azure dependency in app code is a real cost, not a theoretical one), and
issue #20 / `packages/shared/src/logging.ts` (the redaction guarantee this extends).

## Context

The platform has logs and nothing else. Every service builds Fastify with
`loggerOption()` and writes pino JSON to stdout; on Azure, ACA ships that to a
per-environment Log Analytics workspace with 30-day retention
(`infra/azure/modules/aca-environment.bicep`). There are no metrics and no traces.

Three consequences of that are already biting:

- **The registry-staleness alert does not exist.** ADR-0025 landed the signals — the
  edge emits `registry.load_failed` / `registry.never_loaded` / `registry.load_recovered`
  with `consecutiveLoadFailures` / `staleForMs` / `lastSuccessfulLoadAt`, and `/health`
  carries a `registry-projection` sub-check whose `metrics` field exists precisely so a
  rule can key on it. Nothing consumes any of it (`TODO.md`). Building the alert on
  stdout means KQL string-matching over log messages, which is why it keeps not
  getting built.
- **A request cannot be followed across the trust boundary.** A `/_api/fetch` call
  crosses edge → egress → upstream, and the two hops correlate today only by a
  `requestId` that a human greps for in two workspaces. The one seam whose latency and
  failure modes we most need to understand is the one we can least see.
- **Nothing carries an operational answer for "is the platform slow, and where".**
  `gateway_calls` is deliberately not that: ADR-0021 states it is a metering and budget
  primitive with "no latency/error-detail/size — not an observability sink."

The obvious next step is Application Insights, and the obvious way to get there is the
Azure SDK in-process. That is the thing to avoid. ADR-0028 makes the platform
single-tenant and **customer-deployed** — the topology is what the customer's cloud
supports, and an operator who runs it on something other than Azure, or who already
standardizes on Grafana or Datadog, should not need a code change to get telemetry.
Wiring `@azure/monitor-opentelemetry-exporter` into `apps/edge` would put an Azure
client library, and its transitive tree, inside the process ADR-0003 exists to keep
small — and would do it in exchange for a coupling we would then have to unpick.

What makes a clean answer available is that OpenTelemetry already splits into two
independently-versioned halves: a deliberately dependency-free API facade that no-ops
when nothing is registered, and an SDK that does the actual work. That split maps onto
the trust boundary almost exactly.

## Decision

1. **OTLP is the only telemetry wire format any service knows.** No vendor
   telemetry SDK — no `applicationinsights`, no `@azure/monitor-opentelemetry`, no
   `@azure/monitor-opentelemetry-exporter` — in `apps/edge`, `apps/portal` or
   `apps/egress`, now or later. Services export OTLP/HTTP to an endpoint given by the
   standard `OTEL_EXPORTER_OTLP_*` environment variables. **App Insights is a
   destination configured in `infra/azure`, never a name that appears in
   `apps/` or `packages/`.**

   This is the whole point of the ADR and the one line that must not erode. The
   in-process Azure exporter is genuinely less infrastructure to operate, and it is
   still rejected: it buys convenience in the deployment we happen to run today at the
   cost of a code change in every future one, and it pays for it in the trusted path.

2. **The Azure knowledge lives in a collector, and the collector is preferably not
   ours to run.** The first choice is the Container Apps managed OpenTelemetry agent
   (`openTelemetryConfiguration` / `appInsightsConfiguration` on
   `Microsoft.App/managedEnvironments`), which accepts OTLP from every container in the
   environment and forwards to App Insights with no collector for us to operate. This
   requires moving `aca-environment.bicep` off `2024-03-01` to an API version that
   carries those properties — **verify availability and destination support against
   current ACA docs before committing to it**, since both have moved.

   The fallback, if the managed agent is unavailable or too restrictive, is an
   `otel-collector` container app in the apps environment. It costs a component to
   operate and buys tail sampling, redaction processors and multi-destination fan-out.
   **The service-side code is byte-identical under either choice**, which is what makes
   this a deferrable infrastructure decision rather than an architectural one.

   **Egress note, load-bearing and easy to miss:** `snet-apps` is deny-by-default
   outbound (`infra/azure/modules/firewall.bicep`) — the absence of an allow rule *is*
   the enforcement. `*.monitoring.azure.com` is in `acaPlatformFqdns`, but App Insights
   OTLP/ingestion endpoints are not. A self-hosted collector in the apps environment
   therefore needs an explicit firewall rule; the managed agent egresses from ACA
   infrastructure and likely does not. This fails as *silence*, not as an error, so it
   must be verified end-to-end and not assumed from a green deploy.

3. **A new `packages/telemetry` (`@azx-pbc/telemetry`) owns every SDK import.**
   It exports `startTelemetry(serviceName)` — resource attributes, exporter, batch
   processors, meter — and a `shutdownTelemetry()` for the flush. **Only the three
   `server.ts` files import it.** Everything from `buildApp()` inward imports
   `@opentelemetry/api` and nothing else.

   This mirrors the existing boot seam exactly: `server.ts` already does the impure
   work (`loadConfig`, pools, TLS files) and hands `buildApp()` its dependencies, so
   `buildApp()` stays pure and tests keep building the app and injecting requests
   without a listener or an exporter. `service.name` takes the value of each service's
   existing `SERVICE_NAME` constant (`azx-edge`, `azx-portal`, `azx-egress`) so the
   resource attribute and the `/health` `service` field cannot drift.

   **`packages/secret-store` does not gain this dependency.** Its zero-runtime-dependency
   property is a containment property of the mechanism plane, not a style preference;
   egress instruments at its own call sites instead.

4. **No auto-instrumentation. Hand-written spans only.** `@opentelemetry/auto-instrumentations-node`
   is rejected outright for all three services. It monkey-patches `http`, `undici` and
   `pg` at require time — in the process that terminates untrusted traffic, streams
   arbitrary bodies, and holds a DB pool whose grants are the platform's containment
   story. It also records, by default, exactly the attributes decision 6 forbids.

   This is the ADR-0003 justification, stated so review can weigh it: the edge gains
   `@opentelemetry/api` (dependency-free, no-ops unregistered, and the thing that makes
   the rest of the code portable across every backend) plus, in `server.ts` only, the
   SDK and OTLP exporter. That is a real addition to the trusted path, in exchange for
   the first ability to see across the fetch-proxy seam. The trade is worth stating out
   loud because ADR-0003's own challenge outcome is that hand-rolled code needs the same
   adversarial discipline as a dependency — decision 10 is where that lands.

   Instrument the seams, not the codebase: the `/_api/*` gateway handlers, egress
   `POST /proxy`, the registry projection load, the OIDC handoff, and the deploy path.
   Roughly fifteen spans, each one placed on purpose.

5. **Telemetry is off unless configured, and its failure is never a request's
   failure.** `startTelemetry` returns a no-op when `OTEL_SDK_DISABLED=1`, when
   `NODE_ENV === "test"`, or when no OTLP endpoint is configured — the same
   test-quiet branch `loggerOption()` already has, and assertable for the same reason
   (nothing else catches a service that silently starts exporting from the test suite).
   Exporter errors log at `warn` and are dropped; a span processor must never throw
   into a handler, and a failed collector must never turn into a 5xx.

   Use `BatchSpanProcessor` — bounded queue, asynchronous flush. **No synchronous
   exporter anywhere**, per ADR-0003's never-block-the-event-loop rule. Register
   `shutdownTelemetry()` on each service's existing `onClose` hook so the final batch
   flushes on a graceful stop.

   **Spans over streamed responses end on stream close, not on response headers.** The
   LLM and fetch-proxy paths pipe rather than buffer by design; a span ended at headers
   records every streamed call at approximately zero milliseconds, which is worse than
   no metric because it looks like data.

6. **Span and metric attributes are subject to the issue #20 redaction guarantee,
   which they extend rather than inherit.** `packages/shared/src/logging.ts` is a
   security control: several platform URLs carry a live credential in the query string
   (the Appendix A handoff `token`, the OIDC `code`, and — uncoverable by any name list
   — the fetch-proxy target's own query, which may hold an app's API key or an Azure
   SAS `sig`). The module's guarantee is scoped to the pino `req.url` **field**, and its
   own docblock says so.

   A span attribute is a new field on a new path, and semantic-convention `url.full` /
   `http.url` is precisely the one that carries those values. Therefore:

   - Record `url.path` and `http.route`. **Never `url.full` or `http.url`**, and never
     a raw query string.
   - Anything URL-shaped that does reach an attribute goes through `redactUrl()` first
     — the same rule the module already states for hand-rolled log calls.
   - **Egress attributes are a hardcoded allowlist**, not an exclusion list. It is the
     one process holding plaintext connection secrets, and its own error handler already
     returns a fixed opaque body specifically because a thrown message can embed a
     fragment of credential material. Never record request or response headers there:
     the injected credential *is* a header.
   - If the OTel **log** bridge is adopted later (decision 9 defers it), it goes through
     the same redacting serializer, not around it.

7. **The edge never continues a trace from an app-user request.** Incoming
   `traceparent` / `tracestate` on any request to an app subdomain or `/_api/*` is not
   used as a parent. The edge starts a fresh root span; if the value is worth keeping it
   is recorded as an ordinary attribute, subject to decision 6.

   Every request into the edge originates from untrusted app code (ADR-0019, and the
   platform's founding stance). Honouring `traceparent` from that side would let an app
   graft itself onto platform traces, forge parentage between unrelated requests, and
   mint unbounded distinct trace IDs at no cost. Trace context is unauthenticated
   metadata by construction and can never carry authority.

   **Propagation runs inward only**, on the edge → egress hop, where the request's
   authority already comes from the signed attested instruction (ADR-0013). The
   `traceparent` header rides alongside it and is treated as correlation only — never
   read for policy, never trusted by the verifier. It joins `requestId` / `jti`, which
   stay exactly as they are: the instruction's replay defense is not a tracing concern
   and must not be refactored into one.

8. **`appId` is a metric dimension; `userOid` never is.** Per-app breakdown is the
   point (ADR-0023 partitions on `appId` everywhere) and its cardinality is bounded by
   the tenant. `userOid` is unbounded *and* personal data; it belongs in the ledger and,
   where justified, on a span — never as a metric label, where it multiplies every time
   series and lands in a retained backend under a different lawful basis than the one
   ADR-0021 reasoned about.

   Initial instruments, all `helix.`-prefixed:

   | Instrument | Kind | Attributes |
   |---|---|---|
   | `helix.registry.stale_for_ms` | gauge | — |
   | `helix.registry.load_failures` | counter | `outcome` |
   | `helix.gateway.calls` | counter | `capability`, `outcome`, `appId` |
   | `helix.gateway.duration` | histogram | `capability`, `outcome` |
   | `helix.egress.proxy.duration` | histogram | `outcome` |
   | `helix.session.gate_denied` | counter | `reason` |

9. **OTel replaces neither `gateway_calls` nor the pino logs.** The ledger stays the
   sole source of truth for metering, budgets and audit: it is append-only by grant
   under `helix_edge`'s INSERT-only privilege, and that grant is the integrity story
   (ADR-0021). A dropped span costs a data point; a dropped ledger row costs money and
   an audit trail. `helix.gateway.calls` is an operational counter that happens to count
   the same events — **it is never reconciled against the ledger, never used to bill, and
   never presented as the authority.** Recorded here so a later "consolidation" has to
   argue with a decision instead of with a comment.

   Logs stay on pino → stdout → Log Analytics for now. The OTel log bridge is deferred
   until decision 6's redaction is demonstrated on that path with tests; there is no
   urgency, and the failure mode is a retained credential.

10. **Adversarial tests ship with the change, per project plan §6.** At minimum: no span
    attribute carries a raw URL or query string across the credential-bearing routes
    (`/_auth/complete`, the OIDC callback, `/_api/fetch/*`) — the direct sibling of the
    existing `logging.test.ts`; an inbound `traceparent` on an app-user request does not
    become the parent of the resulting span; `startTelemetry` is inert under
    `NODE_ENV=test` and under `OTEL_SDK_DISABLED=1`; an exporter that fails or hangs
    changes no response status or body; and egress records no header name or value.

11. **Phase 1 is traces and metrics on the three services.** Deferred, each on its own
    merits: the OTel log bridge (9); browser/RUM telemetry for `apps/portal-web` — a
    separate decision, and the one place the obvious implementation would ship an
    App Insights JS snippet into a browser, re-introducing exactly the coupling (1)
    exists to prevent; per-app telemetry for hosted apps, which is a product surface with
    a tenancy model, not an operations concern; tail sampling and trace-based alerting;
    and `pg`/`undici` instrumentation depth beyond the hand-placed seams.

## Consequences

- **The ADR-0025 staleness alert becomes buildable, which is the near-term payoff.**
  `helix.registry.stale_for_ms` is one threshold rule instead of a KQL query over log
  message strings, and it makes the `/health` `registry-projection` sub-check probeable
  rather than merely present. The open `TODO.md` item should be re-pointed at this ADR
  rather than closed by it — the alert rule is still a separate piece of work.

- **The edge takes a real dependency-surface increase, and there is no automated gate
  on it.** ADR-0003's consequences already say the discipline is enforced in review with
  no CI check; this ADR adds the heaviest new tree since `openid-client` and does not
  fix that. Making the rule mechanical — a CI dependency allowlist, as ADR-0003's
  challenge outcome suggests — would be a good thing to land alongside, and this is the
  change that makes the case for it concrete.

- **Telemetry becomes a second egress path from the apps environment**, in a subnet
  whose deny-by-default outbound posture is a stated security property. Whatever route
  is chosen in (2) widens that surface by exactly one destination and should be reviewed
  as such, not waved through as plumbing.

- **Observability data inherits the credential-handling rules, permanently.** Spans and
  metrics land in a retained backend with the same 30-day exposure that motivated issue
  #20, and the redaction module's guarantee does not extend to them on its own —
  decision 6 is a rule someone must keep applying at each new span. This is the most
  likely way the decision decays.

- **A partial adoption is a legitimate resting state.** Because the API facade no-ops
  when unregistered, a service with spans and no configured exporter costs approximately
  nothing and behaves identically. Phases can land per-service and per-seam without a
  flag day, and local development can run against a collector or Jaeger in the
  devcontainer compose — the same shape as Azurite standing in for Blob — so the OTLP
  path is exercised locally rather than first discovered in Azure.

- **The costs of the vendor-neutral boundary are paid up front and are real:** one more
  package, an infrastructure component or a preview API version, and a slightly worse
  out-of-the-box App Insights experience than the in-process exporter would give
  (no automatic dependency map without instrumenting the calls we choose to
  instrument). The return is that changing backends is a Bicep edit, which under
  ADR-0028's customer-deployed model is not a hypothetical.
