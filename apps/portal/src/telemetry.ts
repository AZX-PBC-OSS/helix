import {
  metrics,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Counter,
  type MeterProvider,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { INSTR_CONSENT_OPERATIONS } from "@azx-pbc/shared/telemetry";
import { SERVICE_NAME } from "./serviceName.js";

/**
 * The portal's tracer. Imports `@opentelemetry/api` and nothing else — see
 * `apps/edge/src/telemetry.ts` for the reasoning.
 *
 * **One instrument object, and why the portal has one now.** ADR-0037
 * decision 8's table originally gave the portal none: its throughput was low
 * enough that a counter answered nothing a span search did. The consent-flow
 * state machine (I-02 ADR-0002) is the exception that makes the rule — its
 * consult/cancel/claim/sweep outcomes are a *rate* an operator alerts on
 * (a consult that only ever answers `not_available` is a misconfigured
 * deployment, and only a counter sees the rate), so `helix.consent.operations`
 * exists, and this is the deliberate decision to give the portal an
 * `instruments()` object rather than a detail. Everything else still gets a
 * span first and a counter only with a rule to write on it.
 */

/** Safe at module scope — `ProxyTracer` re-resolves per `startSpan`. */
export const tracer: Tracer = trace.getTracer(SERVICE_NAME);

/** Every metric the portal writes. One object so a call site can't miss one. */
export interface PortalInstruments {
  /** `operation` ∈ consent operations, `outcome` ∈ the bounded vocabularies. */
  consentOperations: Counter;
}

/**
 * Built against the current meter provider, never a module-scope singleton —
 * `metrics.getMeter()` binds immediately, so a module-scope meter would cache
 * the noop provider before `startTelemetry` runs and every metric would
 * silently vanish in production while every test passed. See
 * `apps/edge/src/telemetry.ts` for the full reasoning.
 */
let builtAgainst: MeterProvider | null = null;
let cached: PortalInstruments | null = null;

export function instruments(): PortalInstruments {
  const provider = metrics.getMeterProvider();
  if (cached && builtAgainst === provider) return cached;

  const meter = provider.getMeter(SERVICE_NAME);
  builtAgainst = provider;
  cached = {
    consentOperations: meter.createCounter(INSTR_CONSENT_OPERATIONS, {
      description:
        "Consent-flow operations by operation and outcome (I-02 ADR-0002). " +
        "Operational only — never billing; identity is never a dimension.",
    }),
  };
  return cached;
}

/**
 * Run `fn` inside one span, failed-and-ended when it throws — the
 * `deploy/upload.ts` shape, extracted so the consent state machine's
 * operations (and the next portal span) don't re-roll the try/finally.
 * Portal callers are verified platform planes, but the span is still a fresh
 * root: the portal never extracts an inbound `traceparent` (ADR-0037
 * decision 7), so nothing foreign can graft onto this trace.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { kind: SpanKind.SERVER, attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}
