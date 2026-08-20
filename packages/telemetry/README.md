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

Both signals must resolve, or telemetry stays off — there is no half-on state.

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

Each `server.ts` closes the app on `SIGTERM`/`SIGINT`, which is what makes the
`onClose` flush reachable: Node's default signal handler exits immediately, so
without it the last batch — and every other teardown in that hook — is dropped.

## What is deliberately not here yet

Spans, metrics, span-attribute redaction (ADR-0037 decision 6 — a live credential
in a 30-day-retained backend is the failure mode), and edge → egress trace-context
propagation (decision 7). Each lands as its own reviewed change.
