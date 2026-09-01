import { context, trace } from "@opentelemetry/api";

/**
 * Log ↔ trace correlation: the pino `mixin` that stamps the active span's ids
 * on every log line.
 *
 * **This module imports `@opentelemetry/api` and nothing else**, which is the
 * whole reason it is a separate subpath rather than part of the package root.
 * The root owns the SDK and only the three `server.ts` files may import it
 * (ADR-0037 decision 3); this is reached from inside `buildApp()`, so its module
 * graph has to stay the dependency-free facade. The ESLint boundary rule
 * encodes the split: the root specifier is banned outside `server.ts`, subpaths
 * are not.
 *
 * It does **not** live in `@azx-pbc/shared/logging` beside `loggerOption`, even
 * though that is where it is used. `packages/shared` is a dependency of
 * `packages/cli` (published to public npm, ADR-0032) and `apps/portal-web` (a
 * browser bundle); a subpath export would keep the facade out of their
 * *imports* but not out of their install graph, and decision 11 defers browser
 * telemetry precisely to avoid that direction.
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
