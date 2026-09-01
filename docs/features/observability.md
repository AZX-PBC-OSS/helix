# Observability

What the platform emits about **itself** today, and where it goes. Hosted apps
are out of scope — per-app telemetry is a product surface with a tenancy model,
deliberately deferred ([ADR-0037](../adr/0037-platform-observability-otlp-boundary.md)
decision 11).

Design: ADR-0037 (traces + metrics, and the OTLP-only boundary) and
[`docs/design/logging.md`](../design/logging.md) (levels, correlation, the
`event` convention).

## Three signals, two pipelines

| Signal | How it leaves the process | Where it goes |
| --- | --- | --- |
| **Logs** | pino JSON → stdout | The container platform's log store (on Azure: per-environment Log Analytics, 30-day retention) |
| **Traces** | OTLP/HTTP | Whatever `OTEL_EXPORTER_OTLP_ENDPOINT` names |
| **Metrics** | OTLP/HTTP | Same |

**Services speak OTLP and nothing else.** No vendor telemetry SDK appears in
`apps/` or `packages/` — the destination is configured in `infra/azure`, and
changing backends is a Bicep edit. Under ADR-0028's customer-deployed model that
is not hypothetical: an operator running this on something other than Azure, or
already standardised on Grafana or Datadog, should not need a code change.

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
| `helix.egress.proxy` | egress `POST /proxy` |
| `helix.registry.load` | the projection reload |
| `helix.deploy.bundle` → `.validate` / `.upload` | the portal deploy path |

| Instrument | Kind | Attributes |
| --- | --- | --- |
| `helix.registry.stale_for_ms` | observable gauge | — |
| `helix.registry.load_failures` | counter | `outcome` |
| `helix.gateway.calls` | counter | `capability`, `outcome`, `appId` |
| `helix.gateway.duration` | histogram (ms) | `capability`, `outcome` |
| `helix.egress.proxy.duration` | histogram (ms) | `outcome` |
| `helix.session.gate_denied` | counter | `reason` |

`appId` is a dimension; **`userOid` never is** — unbounded and personal data, it
belongs in the ledger under the basis ADR-0021 reasoned about, not in a retained
metrics backend.

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

## Not built yet

- **The alert rules.** This is the gap that matters: the signals exist and
  nothing consumes them. `TODO.md` carries it.
- **Nothing probes `/health`.** It always answers 200 by design (a non-200 would
  let a liveness probe restart a replica serving correctly from a stale copy), so
  a probe has to read the body.
- The OTel **log** bridge, browser/RUM for the portal SPA, per-app telemetry for
  hosted apps, tail sampling, and `pg`/`undici` instrumentation depth beyond the
  hand-placed seams — all deferred, each on its own merits (decision 11).
- **Graceful shutdown.** No service installs a `SIGTERM` handler, so the
  `onClose` telemetry flush does not run on a real stop. `TODO.md`.
