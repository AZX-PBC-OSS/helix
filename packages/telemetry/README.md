# `@azx-pbc/telemetry`

Boot-time OpenTelemetry for the three platform services — and the **only** place
in the repo that imports an OpenTelemetry SDK package.

Design: [ADR-0037](../../docs/adr/0037-platform-observability-otlp-boundary.md).

## The rule

**Services speak OTLP and nothing else.** The destination — App Insights today —
is a collector endpoint configured in `infra/azure`. **No vendor telemetry SDK
name appears anywhere outside `infra/`** — not Azure Monitor's in-process
exporter, not its client library, not any successor — now or later. ADR-0037
decision 1 names the specific packages this rules out. Changing backends is a
Bicep edit, which under ADR-0028's customer-deployed model is not hypothetical.

Auto-instrumentation is rejected outright (ADR-0037 decision 4): it monkey-patches
`http`, `undici` and `pg` at require time, inside the process that terminates
untrusted traffic. Spans are hand-placed at the seams that matter.

## Usage

```ts
// server.ts — and only server.ts
import { startTelemetry } from "@azx-pbc/telemetry";
import { buildApp, SERVICE_NAME } from "./app.js";

const telemetry = startTelemetry(SERVICE_NAME);
const app = buildApp(/* … */);
app.addHook("onClose", async () => {
  /* …existing teardown… */
  await telemetry.shutdown();
});
```

`serviceName` is the service's exported `SERVICE_NAME`, so the `service.name`
resource attribute and the `/health` `service` field cannot drift.

Only the three `server.ts` files import this package. Everything from
`buildApp()` inward imports `@opentelemetry/api` and nothing else — the facade
is dependency-free and no-ops when no provider is registered, which is what
keeps `buildApp()` pure and lets tests inject requests without an exporter.

## Off by default

`startTelemetry` constructs nothing — no SDK, no provider, no exporter, no
timer — and registers no global when any of:

| Condition                         | Why                                                                                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV === "test"`             | The same test-quiet branch `loggerOption()` has. Nothing else would catch a service that silently starts exporting from the test suite. |
| `OTEL_SDK_DISABLED` is `1`/`true` | The standard OTel kill switch.                                                                                                          |
| No OTLP endpoint configured       | The platform's default state.                                                                                                           |

Otherwise it reads the standard OTLP env:

| Variable                              | Effect                                             |
| ------------------------------------- | -------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | Base; `/v1/traces` and `/v1/metrics` are appended. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`  | Signal-specific override, used **verbatim**.       |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Likewise.                                          |

Both signals must resolve, or telemetry stays off — there is no half-on state. A
half-configured endpoint is the one case that also writes a `otel.config` warn
line to stderr: refusing to run half-on is the decision, refusing silently was a
bug. Configured nowhere at all stays quiet, because that is the default state.

The spec's per-signal switches `OTEL_TRACES_EXPORTER` and `OTEL_METRICS_EXPORTER`
are **deliberately not honoured** — the both-or-nothing rule above is the same
decision seen from the other side, and supporting `none` for one signal would
reintroduce exactly the half-on state it exists to prevent. `OTEL_SDK_DISABLED`
is the supported off switch, and it covers both.

## Failure is never a request's failure

Spans go through a `BatchSpanProcessor` (bounded queue, asynchronous flush);
there is no synchronous exporter anywhere, per ADR-0003's never-block-the-event-loop
rule. Exporter errors are logged at `warn` and dropped. A dead or hanging
collector must never change a response status or body.

**`startTelemetry` never throws.** It runs at module scope in each `server.ts`,
before the pools and before `buildApp()`, so a throw there is an uncaught
top-level exception and the service does not boot. A misconfigured endpoint —
`OTLPTraceExporter` validates its URL in the constructor — degrades to inert with
a `warn`, and anything half-built is unregistered and shut down on the way out.
A typo in one env var must not be able to stop the edge.

The `onClose` hook is where the final flush belongs, but **no service installs a
`SIGTERM`/`SIGINT` handler yet**, so on a real stop Node's default handler exits
immediately and the hook does not run. Graceful drain is tracked in
[`TODO.md`](../../TODO.md); until it lands, treat the last batch before a deploy
as lost.

## Locally

The devcontainer runs **Jaeger all-in-one** as the `otel-collector` compose
service, and `OTEL_EXPORTER_OTLP_ENDPOINT` already points at it — so the OTLP
path is exercised locally rather than first discovered in Azure, where its
failure mode is silence rather than an error. The trace UI is on
**<http://localhost:27686>**.

Drive an `/_api/fetch` call through a deployed app and you should see **one
trace spanning edge → egress**, with the app-user leg as a fresh root. That is
the thing ADR-0037's context paragraph says cannot be seen today.

Jaeger accepts metrics on the same endpoint and drops them — it stores traces
only. Assert metrics in tests (`@azx-pbc/telemetry/testing`), not here.

To get the platform's **default** state back — telemetry entirely inert, no
provider constructed, which is what a deployment with no collector runs —
comment out `OTEL_EXPORTER_OTLP_ENDPOINT` in
`.devcontainer/docker-compose.yml`, or set `OTEL_SDK_DISABLED=1`. Worth doing
occasionally so "works locally" does not quietly come to depend on an exporter.

## What is deliberately not here yet

Phase 1 is complete: spans and metrics on the three services, attribute
redaction (decision 6), and edge → egress propagation (decision 7).

Still deferred, each on its own merits (decision 11): the OpenTelemetry **log**
bridge — logs stay pino → stdout, and decision 9 holds it until decision 6's
redaction is demonstrated on that path with tests; browser/RUM telemetry for
`apps/portal-web`; per-app telemetry for hosted apps; tail sampling and
trace-based alerting; and `pg`/`undici` instrumentation depth beyond the
hand-placed seams.

The **alert rules themselves** are also still to build. This package makes them
possible — `helix.registry.stale_for_ms` is one threshold rule instead of KQL
string-matching over log messages — but nothing consumes the metrics yet
(`TODO.md`).
