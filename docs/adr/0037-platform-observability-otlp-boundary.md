# ADR-0037 — Platform observability: OpenTelemetry behind an OTLP-only boundary

## Status

Accepted. Phase 1 (decision 11) is implemented: traces and metrics on the three
services, attribute redaction, edge → egress propagation, and the adversarial
tests. See the **Amendments** section at the end for six things the
implementation found that this text got wrong or under-specified — read those
alongside the decisions they touch.

Covers observability of **the platform itself** (edge,
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

## Amendments (2026-09-01, from implementing phase 1)

Six things this ADR got wrong or left under-specified. Each is recorded here
rather than edited into the decision above, so the reasoning that produced the
original text stays legible.

1. **Decision 5's streamed-span rule invites the wrong fix.** The text says
   spans over streamed responses must "end on stream close, not on response
   headers", which reads as though a handler ending with
   `return reply.send(stream)` needs special handling — and the implementation
   plan duly specified two helpers, one per streaming shape.

   That is unnecessary. **Fastify's `Reply` is thenable and resolves when the
   response finishes**, so an async handler returning `reply.send(stream)`
   already awaits the whole transfer. Measured against the pinned Fastify
   5.12.0: a ~90 ms body gives a ~98 ms awaited handler, and the thenable
   settles at the same instant `reply.raw` emits `close`. One `try/finally`
   helper is correct for both shapes.

   The rule still matters — a span ended at headers really would record every
   proxied call at ~0 ms — but it is a property of a *dependency*, not of our
   code, so it is pinned by a test with a deliberately slow body
   (`apps/edge/src/spans.test.ts`) rather than by a comment.

2. **Decision 3 says "only the three `server.ts` files". There are four server
   entrypoints.** `apps/edge/src/devGateway/server.ts` builds a full app and
   never calls `startTelemetry`. Leaving the dev-only plane uninstrumented is
   right; the count is a tripwire for the next reader.

3. **Decision 3's boundary is a rule about _shipped_ code, and decision 10 is
   unimplementable without saying so.** The adversarial tests need a real
   in-memory provider — the API facade no-ops when unregistered, so a test that
   drives a handler and asks "what did the span carry?" otherwise gets nothing
   and passes while proving nothing. The SDK import lives in
   `@azx-pbc/telemetry/testing` and the apps take `@opentelemetry/sdk-*` as
   **devDependencies**; an ESLint rule encodes the line. Similarly
   `@azx-pbc/telemetry/correlation` is importable from `buildApp()` because its
   module graph is the API facade only — the *root* specifier is what pulls the
   SDK, and that is what the rule bans.

4. **Decision 8's instrument table needs units and bucket boundaries.**
   OpenTelemetry's default explicit-bucket histogram tops out at 10 000 ms and
   an LLM stream routinely runs longer, so on the defaults every slow call lands
   in the overflow bucket and p95/p99 answer nothing. Both duration histograms
   carry `unit: "ms"` and an explicit boundary list
   (`DURATION_BUCKETS_MS`). A latency metric that cannot represent its own tail
   is the same failure decision 5 describes, arriving by a different route.

5. **`helix.registry.stale_for_ms` must be an _observable_ gauge, and must
   report nothing before the first successful load.** ADR-0025 grades staleness
   on two conditions because they catch different faults, and the age rule
   exists to catch "loads stopped being *attempted* at all" — a fault in which a
   gauge recorded at each load attempt is silent, its last value sitting there
   looking healthy. A callback is read at collection time. And a gauge reading
   `0` for "never loaded" would say "perfectly fresh" when every app host is
   serving 503; that state is `load_failures{outcome:"never_loaded"}` instead.

6. **Decision 9 should say the counter is deliberately _not_ denial-throttled.**
   `gateway_calls` suppresses allowlist-denial rows past a per-window budget
   (`denialThrottle`) — a write-amplification defence on an append-only table.
   `helix.gateway.calls` is **not** suppressed there, because "an app is
   hammering an origin it was never granted" is exactly what an operator wants
   to see and the ledger is blind to it by design. This strengthens the decision
   rather than bending it: the two now provably differ, so nobody can reconcile
   them.

One thing the ADR got exactly right and is worth repeating: the consequence that
decision 6 "is a rule someone must keep applying at each new span" and is "the
most likely way the decision decays." The countermeasures are mechanical —
`spanUrlAttributes` drops the query wholesale rather than scanning it, egress
uses a hardcoded attribute allowlist, an ESLint rule bans the whole-URL keys,
and the redaction tests scan *every attribute of every span* rather than
checking one field.

### Amendment 7 — decision 2's preferred route does not work for us (verified 2026-09-01)

Decision 2 names the Container Apps **managed OpenTelemetry agent** as the first
choice, "which requires moving `aca-environment.bicep` off `2024-03-01` to an
API version that carries those properties — **verify availability and
destination support against current ACA docs before committing to it**."

Verified. It is not viable for this platform, for two independent reasons, and
**either one alone is disqualifying**:

1. **The Application Insights destination does not accept metrics.** Microsoft's
   own destination table lists App Insights as Logs ✅ / Traces ✅ / **Metrics
   ❌**, and the known-limitations section says it outright. Our near-term payoff
   — the ADR-0025 staleness alert — *is* a metric
   (`helix.registry.stale_for_ms`). The managed agent plus App Insights delivers
   traces and nothing this ADR was written to unblock.

2. **The managed agent only speaks gRPC.** It injects
   `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` and its docs state "the managed agent only
   supports `grpc`". `packages/telemetry` uses the OTLP/**HTTP** exporters.
   Switching means `@opentelemetry/exporter-*-otlp-grpc` and the `@grpc/grpc-js`
   tree in the trusted path — a much larger dependency-surface increase than the
   one ADR-0003 already grudgingly accepted here, taken to reach a destination
   that still cannot store our metrics.

Also relevant, though not disqualifying on their own: the feature is **preview**
(`2024-10-02-preview`), against a topology currently pinned to a GA API version;
configuration is environment-level so it cannot be split per app (we have two
environments and would configure both); and secrets must be inline in templates
with no Key Vault integration.

**So the fallback becomes the plan**: an `otel-collector` container app in the
apps environment, which accepts OTLP/HTTP unchanged, and fans out per signal.
Decision 2 anticipated this and stated the important half — **the service-side
code is byte-identical either way**, which is exactly why this reversal costs
nothing already written.

Two things it now forces, which decision 2 did not anticipate because it assumed
App Insights could take everything:

- **A metrics destination has to be chosen.** App Insights is out. The options
  are an Azure Monitor workspace (Prometheus-compatible, which is what Azure
  metric alert rules key on), or a non-Azure backend, or the collector
  translating metrics into Log Analytics. This is an open decision, recorded in
  `TODO.md` — and it is the one that gates the staleness alert, so it is not
  optional.
- **The firewall rule is now certain, not conditional.** Decision 2's egress
  note said a self-hosted collector "therefore needs an explicit firewall rule"
  while the managed agent "likely does not". With the self-hosted route chosen,
  that rule is required. `snet-apps` is deny-by-default outbound and the absence
  of a rule *is* the enforcement, so **this fails as silence** — it must be
  verified end to end against the live environment, never inferred from a green
  deploy.

Everything in `apps/` and `packages/` stands unchanged. That is the OTLP-only
boundary (decision 1) doing precisely the job it was written for: the vendor
question moved and no service code moved with it.
