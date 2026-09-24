import { context, trace } from "@opentelemetry/api";

/**
 * Pino mixin that adds active trace/span ids to logs. Import only the
 * @opentelemetry/api facade because buildApp uses this module; SDK startup
 * belongs to the package root and server.ts (ADR-0037 decision 3).
 *
 * Keep this out of shared/logging: shared is also installed by the published
 * CLI and browser SPA, which should not acquire telemetry dependencies.
 */

/** What {@link traceContextMixin} adds to a log line. Empty when tracing is off. */
export interface TraceCorrelation {
  trace_id?: string;
  span_id?: string;
}

/**
 * A pino `mixin` returning the active span's ids, or `{}`.
 *
 * `snake_case`, unlike every other field this platform logs. That is
 * deliberate: `trace_id` / `span_id` is what the OpenTelemetry log data model
 * specifies and what every OTel-aware backend keys its log-to-trace jump off.
 * Matching the local convention here would buy consistency and lose the
 * integration that is the entire point.
 *
 * Returns `{}` when no SDK is registered — the platform's default state
 * (decision 5) — so this costs one function call and adds no fields until
 * someone configures a collector. It also returns `{}` for a non-recording
 * span, so a sampled-out request does not get an id nothing will resolve.
 *
 * **No call site may log its own `trace_id` or `span_id`.** pino's default
 * `mixinMergeStrategy` lets an explicitly-logged object win over the mixin,
 * which is the right way round for every other field and would silently
 * shadow these.
 */
export function traceContextMixin(): TraceCorrelation {
  const span = trace.getSpan(context.active());
  if (!span) return {};
  const ctx = span.spanContext();
  if (!trace.isSpanContextValid(ctx)) return {};
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}
