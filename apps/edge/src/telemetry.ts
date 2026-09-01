import {
  metrics,
  trace,
  type Counter,
  type Histogram,
  type MeterProvider,
  type ObservableGauge,
  type Tracer,
} from "@opentelemetry/api";
import {
  DURATION_BUCKETS_MS,
  INSTR_GATEWAY_CALLS,
  INSTR_GATEWAY_DURATION,
  INSTR_REGISTRY_LOAD_FAILURES,
  INSTR_REGISTRY_STALE_FOR_MS,
  INSTR_SESSION_GATE_DENIED,
} from "@azx-pbc/shared/telemetry";
import { SERVICE_NAME } from "./serviceName.js";

/**
 * The edge's tracer and instruments.
 *
 * **This module imports `@opentelemetry/api` and nothing else** — the facade is
 * dependency-free and no-ops when no provider is registered, which is what lets
 * it be reached from inside `buildApp()` without dragging an SDK or an exporter
 * into the test path (ADR-0037 decision 3). The SDK lives in
 * `@azx-pbc/telemetry`, imported only by `server.ts`.
 */

/**
 * Safe at module scope, unlike {@link instruments} below: `trace.getTracer()`
 * hands back a `ProxyTracer` that re-resolves its delegate on **every**
 * `startSpan`, so a tracer captured before `startTelemetry()` runs still emits
 * once a provider is registered.
 */
export const tracer: Tracer = trace.getTracer(SERVICE_NAME);

/** Every metric the edge writes. One object so a call site can't miss one. */
export interface EdgeInstruments {
  /** `capability`, `outcome`, `appId`. */
  gatewayCalls: Counter;
  /** `capability`, `outcome` — no `appId`, per ADR-0037 decision 8's table. */
  gatewayDuration: Histogram;
  /** `outcome` ∈ `REGISTRY_LOAD_OUTCOMES`. */
  registryLoadFailures: Counter;
  /**
   * Observable, and deliberately so: ADR-0025's age rule exists to catch
   * "loads stopped being *attempted* at all", and a synchronous gauge recorded
   * at each load attempt reports nothing in exactly that fault. The callback is
   * attached by whoever holds the freshness reader.
   */
  registryStaleForMs: ObservableGauge;
  /** `reason` ∈ `SESSION_DENIAL_REASONS`. */
  sessionGateDenied: Counter;
}

/**
 * The last provider {@link instruments} built against, and what it built.
 *
 * **Not a plain module-level singleton, and this is the whole point of the
 * function.** `metrics.getMeter()` has no proxy — it calls
 * `getMeterProvider().getMeter()` immediately, and with nothing registered that
 * is `NOOP_METER_PROVIDER`, which returns a permanently-inert meter. ES imports
 * are hoisted, so `server.ts`'s `import { buildApp } from "./app.js"` evaluates
 * this whole module graph *before* the `startTelemetry(SERVICE_NAME)` call on
 * the next line executes. A `const meter = metrics.getMeter(…)` at module scope
 * would therefore bind to the noop provider and **every metric would silently
 * vanish in production while every test passed** — the tests register their own
 * provider first, so they would never see it.
 *
 * Keying the cache on provider identity makes the ordering irrelevant: the
 * first call after a provider is registered rebuilds against it, and a test
 * that swaps providers gets fresh instruments without a reset hook.
 */
let builtAgainst: MeterProvider | null = null;
let cached: EdgeInstruments | null = null;

export function instruments(): EdgeInstruments {
  const provider = metrics.getMeterProvider();
  if (cached && builtAgainst === provider) return cached;

  const meter = provider.getMeter(SERVICE_NAME);
  builtAgainst = provider;
  cached = {
    gatewayCalls: meter.createCounter(INSTR_GATEWAY_CALLS, {
      description: "Gateway calls by capability and outcome. Operational only — never billing.",
    }),
    gatewayDuration: meter.createHistogram(INSTR_GATEWAY_DURATION, {
      description: "Gateway call duration, measured to stream close.",
      unit: "ms",
      // OTel's default buckets top out at 10s and an LLM stream runs longer.
      advice: { explicitBucketBoundaries: [...DURATION_BUCKETS_MS] },
    }),
    registryLoadFailures: meter.createCounter(INSTR_REGISTRY_LOAD_FAILURES, {
      description: "Registry projection load failures since boot.",
    }),
    registryStaleForMs: meter.createObservableGauge(INSTR_REGISTRY_STALE_FOR_MS, {
      description: "Age of the served registry projection. Absent until the first load succeeds.",
      unit: "ms",
    }),
    sessionGateDenied: meter.createCounter(INSTR_SESSION_GATE_DENIED, {
      description: "App-host session-gate denials by reason.",
    }),
  };
  return cached;
}
