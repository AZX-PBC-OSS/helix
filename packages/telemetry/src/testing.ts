import { metrics, trace, type Attributes } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

/**
 * A recording telemetry provider pair, for tests.
 *
 * **Why this exists at all.** The whole suite runs under `NODE_ENV=test`, where
 * `startTelemetry` is inert by design, and `@opentelemetry/api` no-ops when no
 * provider is registered. So a test that drives a handler and asks "what did
 * the span carry?" gets nothing — which is exactly the shape of a test that
 * passes while proving nothing. ADR-0037 decision 10's adversarial tests (no
 * raw URL on any attribute, no inbound `traceparent` as a parent, no header on
 * an egress span) are unimplementable without a real in-memory provider.
 *
 * **Why it lives here rather than in each app's `src/test/`.** Decision 3 keeps
 * every OpenTelemetry SDK import in this package. That rule is about *shipped*
 * code — a test-only import ships nowhere — but the cheapest way to keep it
 * true without arguing the exception at every call site is to put the SDK
 * import in the package that already owns one. The apps take
 * `@opentelemetry/sdk-*` as devDependencies to reach this module's types; the
 * ESLint boundary rule encodes where a runtime import is allowed.
 *
 * `SimpleSpanProcessor`, not `Batch`: a test wants the span the moment it ends,
 * and the never-block-the-event-loop rule that forbids Simple in the services
 * has nothing to say about a test process.
 *
 * **Lifecycle differs for spans and metrics, and getting it backwards breaks
 * things quietly in both directions.**
 *
 * *Span* assertions want **one recording per file**. A module-level
 * `const tracer = trace.getTracer(…)` is a `ProxyTracer`, and once it resolves
 * a delegate it caches it (`ProxyTracer._getTracer`) — so a tracer captured at
 * import time keeps pointing at the first provider that was registered, even
 * after {@link RecordingTelemetry.restore} unregisters it. A second
 * `startRecordingTelemetry()` in the same file therefore records **nothing**,
 * silently, and every assertion after the first fails on an empty array. Use
 * `beforeAll`/`afterAll` with {@link RecordingTelemetry.reset} in `afterEach`.
 *
 * *Metric* assertions want the opposite: **a fresh recording per test.**
 * `reset()` clears the exported batches, but CUMULATIVE accumulation lives in
 * the `MeterProvider`, not the exporter — so a counter incremented in one case
 * is still counted in the next. Only a new provider gives clean isolation, and
 * metric instruments have no caching problem to prevent it: `instruments()` is
 * keyed on provider identity precisely so it rebuilds.
 *
 * A file asserting both should use one recording and expect counters to
 * accumulate across its cases.
 *
 * Neither hazard exists in production, where exactly one provider is ever
 * registered.
 */
export interface RecordingTelemetry {
  /** Spans ended so far, oldest first. */
  spans(): ReadableSpan[];
  /**
   * Flush the metric reader and return the current value of every data point.
   *
   * Idempotent: calling it twice reports the same numbers, so a test may poll
   * it in a loop without the polling itself moving the total.
   */
  metrics(): Promise<RecordedMetric[]>;
  /**
   * Drop everything recorded so far, keeping the providers registered.
   *
   * What a span-asserting file's `afterEach` should call. It does **not** reset
   * a counter's cumulative total — that lives in the `MeterProvider` — so a
   * metric-asserting file wants a fresh recording per test instead. See the
   * lifecycle note on this module.
   */
  reset(): void;
  /** Unregister both globals and shut the providers down. Always safe twice. */
  restore(): Promise<void>;
}

/** One metric data point, flattened to what an assertion actually reads. */
export interface RecordedMetric {
  name: string;
  attributes: Attributes;
  /** Counter/gauge value, or a histogram's observation count. */
  value: number;
  /** Present for histograms only. */
  sum?: number;
}

/**
 * Register in-memory trace and metric providers as the OTel globals.
 *
 * Call `restore()` in an `afterEach`. Registering twice without restoring is a
 * no-op on the second call (`registerGlobal` defaults to `allowOverride: false`)
 * and would silently record into the *first* provider — the same drift
 * `startTelemetry`'s shutdown path guards against.
 */
export function startRecordingTelemetry(serviceName = "test-service"): RecordingTelemetry {
  // Honour `serviceName` rather than discarding it: recorded spans and metrics
  // carry `service.name`, so a test can assert the edge and egress halves of a
  // trace are attributed to different services — the join this whole package
  // exists to enable.
  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName });

  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  tracerProvider.register();

  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  // A very long interval: tests drive collection through `forceFlush` rather
  // than waiting on a timer, and an interval that fires mid-assertion would
  // make counts racy.
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 2 ** 30,
  });
  const meterProvider = new MeterProvider({ resource, readers: [metricReader] });
  metrics.setGlobalMeterProvider(meterProvider);

  let stopped = false;

  return {
    spans: () => spanExporter.getFinishedSpans(),
    reset: () => {
      spanExporter.reset();
      metricExporter.reset();
    },
    metrics: async () => {
      await metricReader.forceFlush();
      const out: RecordedMetric[] = [];
      // ONLY the last snapshot. `InMemoryMetricExporter` appends every batch it
      // is handed (`_metrics.push`) and `getMetrics()` returns the whole array,
      // while CUMULATIVE temporality means each batch already carries the
      // running total. Flattening all of them makes this non-idempotent —
      // successive calls report double, then triple — and that silently
      // defeats any test that polls until a total grows, because the polling
      // itself grows it.
      const latest = metricExporter.getMetrics().at(-1);
      for (const scope of latest?.scopeMetrics ?? []) {
        for (const metric of scope.metrics) {
          for (const point of metric.dataPoints) {
            const value = point.value;
            if (typeof value === "number") {
              out.push({ name: metric.descriptor.name, attributes: point.attributes, value });
            } else {
              // Histogram: `count` is the observation count, `sum` the total.
              out.push({
                name: metric.descriptor.name,
                attributes: point.attributes,
                value: value.count,
                sum: value.sum ?? 0,
              });
            }
          }
        }
      }
      return out;
    },
    restore: async () => {
      if (stopped) return;
      stopped = true;
      // Disable before shutdown, mirroring `startTelemetry`'s teardown: a span
      // taken after this point should no-op rather than queue into a provider
      // on its way down.
      trace.disable();
      metrics.disable();
      await Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown()]);
      spanExporter.reset();
      metricExporter.reset();
    },
  };
}
