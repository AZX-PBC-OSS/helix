import {
  context,
  diag,
  DiagLogLevel,
  metrics,
  propagation,
  trace,
  type DiagLogger,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { resolveTelemetryConfig } from "./config.js";

export { resolveTelemetryConfig } from "./config.js";
export type { TelemetryConfig } from "./config.js";

/**
 * @azx-pbc/telemetry — the one place any OpenTelemetry **SDK** import lives
 * (ADR-0037 decision 3).
 *
 * Only the three `server.ts` files import this module. Everything from
 * `buildApp()` inward imports `@opentelemetry/api` and nothing else, which is
 * what keeps `buildApp()` pure: tests build the app and inject requests without
 * ever constructing a listener or an exporter.
 *
 * **Services speak OTLP and only OTLP.** The destination — App Insights today —
 * is configured in `infra/azure`, and no vendor telemetry SDK name appears in
 * `apps/` or `packages/`. That boundary is the entire point of ADR-0037.
 */

/** What `startTelemetry` hands back — inert or live, the same shape. */
export interface TelemetryHandle {
  /**
   * `false` when nothing was constructed. Exists so inertness is assertable
   * from a test: a boolean alone could drift from reality, so the suite checks
   * it *and* checks that no global provider was registered.
   */
  readonly enabled: boolean;
  /** Flush and stop. Always resolves; never throws, inert or not. */
  shutdown(): Promise<void>;
}

/** Options exist for the same reason `loggerOption` takes an `env`: testability. */
export interface StartTelemetryOptions {
  /**
   * Injectable for tests — the suite itself runs under `NODE_ENV=test`.
   *
   * **Reaches endpoint resolution only.** The OTLP exporters read the rest of
   * their configuration (`OTEL_EXPORTER_OTLP_HEADERS`, `_TIMEOUT`,
   * `_COMPRESSION`, the certificate vars) from the ambient `process.env`
   * themselves, and that is deliberate — see `config.ts`'s `signalUrl`.
   */
  env?: NodeJS.ProcessEnv;
}

const INERT: TelemetryHandle = Object.freeze({
  enabled: false as const,
  shutdown: () => Promise.resolve(),
});

/**
 * The process-wide **live** handle, so {@link shutdownTelemetry} has something
 * to shut down and a second {@link startTelemetry} can't register a second
 * provider over the first (which would leak the first one's exporter and its
 * timer).
 *
 * Only ever holds a live handle. Memoizing the inert one would be free at
 * runtime and quietly corrosive in tests: the suite calls `startTelemetry` once
 * per inertness condition, and a cached inert handle would short-circuit every
 * call after the first into asserting on a result no condition produced.
 */
let current: TelemetryHandle | null = null;

/**
 * Render one diag argument for the stderr line below.
 *
 * The `Error` branch is load-bearing, not defensive: `JSON.stringify(new
 * Error("boom"))` is `"{}"` — `message`, `stack` and `cause` are all
 * non-enumerable — and OTel reports every export failure as `diag.error(msg,
 * error)`. Without this, the one log path that exists to explain a broken
 * collector would report `{}` forever.
 */
function formatDiagArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) {
    const cause = arg.cause instanceof Error ? ` (cause: ${arg.cause.message})` : "";
    return `${arg.name}: ${arg.message}${cause}`;
  }
  try {
    // `undefined` stringifies to the VALUE undefined, not a string.
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg); // circular, or a throwing `toJSON`
  }
}

/**
 * Route OTel's internal diagnostics into a single stderr line, capped at `warn`.
 *
 * `startTelemetry` runs before `buildApp()` in every service, so there is no
 * Fastify logger to borrow yet — this writes pino-ish JSON by hand rather than
 * inventing a logger seam nothing else would use.
 *
 * OTel reports a failed export at `diag.error`; here that becomes a `warn` and
 * stops. **A dead or hanging collector must never change a response status or
 * body** (ADR-0037 decision 5) — telemetry that can take the platform down is
 * worse than no telemetry.
 *
 * Note for the decision-6 follow-up: this is the one log path in the repo that
 * does NOT go through `packages/shared/src/logging.ts`'s redacting serializer.
 * Nothing carrying request data reaches it today (there are no spans yet), but
 * the redaction work has to cover it too.
 */
function diagSink(serviceName: string): DiagLogger {
  const emit = (level: "warn", args: unknown[]): void => {
    const msg = args.map(formatDiagArg).join(" ");
    process.stderr.write(
      `${JSON.stringify({ level, service: serviceName, event: "otel.diag", msg })}\n`,
    );
  };
  return {
    // Exporter failures arrive here. Deliberately demoted, deliberately dropped.
    error: (...args) => emit("warn", args),
    warn: (...args) => emit("warn", args),
    info: () => {},
    debug: () => {},
    verbose: () => {},
  };
}

/**
 * Start telemetry for a service, or return an inert handle.
 *
 * Inert — no SDK, no provider, no exporter, no timer constructed, and no global
 * registered — when {@link resolveTelemetryConfig} returns `null`: under
 * `NODE_ENV=test`, under `OTEL_SDK_DISABLED`, or with no OTLP endpoint
 * configured. The default state of the platform is the last one, so running it
 * with no OTel env produces exactly the telemetry it produced before this
 * package existed.
 *
 * **Never throws.** A misconfigured endpoint degrades to inert, because this
 * runs at module scope in each `server.ts` — before the pools, before
 * `buildApp()` — where a throw is an uncaught top-level exception and the
 * service never boots. `OTLPTraceExporter`'s constructor throws synchronously
 * on a URL it cannot parse, so `OTEL_EXPORTER_OTLP_ENDPOINT="//collector:4318"`
 * would otherwise take the edge down over a typo in an env var. OTel's own env
 * path degrades the same way (`appendResourcePathToUrl` warns and falls back);
 * resolving the URL ourselves opts out of that, so we have to replace it.
 *
 * `serviceName` is each service's exported `SERVICE_NAME`, so the `service.name`
 * resource attribute and the `/health` `service` field cannot drift.
 */
export function startTelemetry(
  serviceName: string,
  options: StartTelemetryOptions = {},
): TelemetryHandle {
  if (current) return current;

  const config = resolveTelemetryConfig(serviceName, options.env);
  if (!config) return INERT;

  diag.setLogger(diagSink(serviceName), DiagLogLevel.WARN);

  // Declared outside the `try` so the failure path can tear down whatever half
  // of the pipeline was already built.
  let tracerProvider: NodeTracerProvider | undefined;
  let meterProvider: MeterProvider | undefined;

  try {
    // A supplied resource REPLACES the SDK default in OTel JS 2.x — both
    // providers are `options.resource ?? defaultResource()` — so merging is not
    // tidiness: without it every span and metric the platform ever exports
    // carries `service.name` and no `telemetry.sdk.*` at all, which backends key
    // language grouping, SDK-version filtering and ingestion shims off. Nothing
    // breaks loudly; it is permanently degraded metadata. `resourceFromAttributes`
    // wins on conflict, so `service.name` still comes from SERVICE_NAME and the
    // no-drift guarantee above holds.
    const resource = defaultResource().merge(
      resourceFromAttributes({ [ATTR_SERVICE_NAME]: config.serviceName }),
    );

    // BatchSpanProcessor, never Simple: bounded queue, asynchronous flush. A
    // synchronous exporter in the edge would put a network round-trip on the
    // event loop that terminates untrusted traffic (ADR-0003, ADR-0037 §5). If a
    // future debugging session wants SimpleSpanProcessor, it has to argue with
    // this comment first.
    tracerProvider = new NodeTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: config.tracesUrl }))],
    });
    // Registers the global tracer provider, plus a context manager and the W3C
    // propagator. Nothing extracts context yet — and when propagation lands, it
    // runs INWARD ONLY (edge → egress). The edge never takes `traceparent` from an
    // app-user request as a parent: it is unauthenticated metadata from untrusted
    // code, and honouring it would let an app graft itself onto platform traces
    // (ADR-0037 decision 7).
    tracerProvider.register();

    meterProvider = new MeterProvider({
      resource,
      // The reader unrefs its own interval, so a configured service still exits
      // on its own; shutdown below is what makes the last batch land.
      readers: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: config.metricsUrl }),
        }),
      ],
    });
    metrics.setGlobalMeterProvider(meterProvider);
  } catch (err) {
    diag.warn("telemetry failed to start; continuing without it", err);
    // Undo the half-built pipeline — but ONLY the half that got installed. There
    // are two throw shapes and they leave different amounts standing:
    //
    //  - the trace exporter's constructor throws while the `spanProcessors`
    //    array is being evaluated, i.e. before `register()`, so no global exists;
    //  - the metrics exporter's throws after it, leaving a globally-registered
    //    tracer provider with no owner — `current` is never assigned, so
    //    `shutdownTelemetry()` could not reach it and its processor and exporter
    //    would outlive the failure.
    //
    // Disabling unconditionally would, in the first shape, reset a context
    // manager, propagator and meter provider that some *other* component
    // installed and still owns. Nothing else in the repo registers OTel globals
    // today; the day something does, that bug reads as "context propagation
    // randomly stopped working" and points at the wrong file entirely. Each
    // provider variable is assigned only once its own construction succeeded, so
    // it doubles as the record of what was registered.
    //
    // Disabling before the async shutdown means any span the service takes later
    // no-ops rather than queueing into a provider that is on its way down.
    if (tracerProvider) {
      trace.disable();
      context.disable();
      propagation.disable();
    }
    if (meterProvider) metrics.disable();
    void Promise.allSettled([tracerProvider?.shutdown(), meterProvider?.shutdown()]);
    // Last, so the warn above still lands: a failed start must not leave the
    // stderr diag sink installed for the life of the process.
    diag.disable();
    return INERT;
  }

  const startedTracerProvider = tracerProvider;
  const startedMeterProvider = meterProvider;
  current = {
    enabled: true,
    shutdown: async () => {
      // Settle both, then swallow. Shutdown runs from Fastify's `onClose`; a
      // rejection there would turn a clean stop into a noisy one over telemetry
      // nobody is waiting for.
      const results = await Promise.allSettled([
        startedTracerProvider.shutdown(),
        startedMeterProvider.shutdown(),
      ]);
      for (const r of results) {
        if (r.status === "rejected") {
          diag.warn("telemetry shutdown failed", r.reason);
        }
      }
      // Deregister the API globals too, mirroring the failure path above.
      // `registerGlobal` defaults to `allowOverride = false` and `trace`,
      // `context`, `propagation` and `metrics` all call it that way, so leaving
      // them installed makes a *restart* silently inert: a second
      // `startTelemetry` sees `current === null`, proceeds, builds a second
      // provider pair, and `register()` refuses it. The handle it returns says
      // `enabled: true` while every span goes to the dead first provider — the
      // exact drift {@link TelemetryHandle} exists to prevent.
      trace.disable();
      context.disable();
      propagation.disable();
      metrics.disable();
      current = null;
    },
  };
  return current;
}

/**
 * Shut down whatever {@link startTelemetry} last started; a no-op if nothing
 * is running. The three services call `handle.shutdown()` on the handle they
 * already hold — this is here for callers that don't keep one.
 */
export function shutdownTelemetry(): Promise<void> {
  return current ? current.shutdown() : Promise.resolve();
}
