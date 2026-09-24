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
 * In-memory span and metric providers for tests. `startTelemetry` is disabled
 * under NODE_ENV=test, so handler assertions need these providers to record
 * telemetry. SDK imports stay in this package (ADR-0037 decisions 3 and 10).
 * SimpleSpanProcessor makes ended spans immediately available to assertions.
 *
 * For span tests, create one recording in beforeAll, restore it in afterAll,
 * and reset exported data in afterEach. Module-level ProxyTracers cache their
 * first provider; replacing it within a file can leave those tracers recording
 * to the old provider.
 *
 * For metric-only tests, create a fresh recording per test. Cumulative counters
 * live in MeterProvider and survive reset(); instruments() rebuilds instruments
 * when the provider changes. Tests that assert both spans and metrics should
 * share one recording and account for cumulative counters across cases.
 * Production registers one provider, so these test lifecycle issues do not apply.
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
