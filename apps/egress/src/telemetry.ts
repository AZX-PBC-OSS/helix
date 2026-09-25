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
  INSTR_EGRESS_EXCHANGES,
  INSTR_EGRESS_PROXY_DURATION,
  INSTR_EGRESS_RENEWALS,
  INSTR_PROVIDERS_LISTEN_STATUS,
  INSTR_PROVIDERS_RECONCILES,
} from "@azx-pbc/shared/telemetry";
import { SERVICE_NAME } from "./serviceName.js";

/**
 * Egress's tracer and instruments. Imports `@opentelemetry/api` and nothing
 * else — see `apps/edge/src/telemetry.ts` for the reasoning, which applies with
 * more force here: this is the one process holding plaintext connection
 * secrets, so its dependency surface is a containment property.
 */

/** Safe at module scope — `ProxyTracer` re-resolves per `startSpan`. */
export const tracer: Tracer = trace.getTracer(SERVICE_NAME);

export interface EgressInstruments {
  /** `outcome` only. Never `appId`: see the allowlist note below. */
  proxyDuration: Histogram;
  /** Reconcile attempts by `outcome` ∈ PROVIDERS_RECONCILE_OUTCOMES. */
  providersReconciles: Counter;
  /**
   * Observable — 1 while a dedicated LISTEN client is live, 0 while down.
   * Attached/detached by whoever holds the listener's lifecycle.
   */
  providersListenStatus: ObservableGauge;
  /** Code-exchange operations by `outcome` and `env` (I-02 T-0019). */
  exchanges: Counter;
  /**
   * Token-renewal operations by `outcome` and `env` (I-02 T-0021) — the
   * EGRESS_RENEWAL_OUTCOMES vocabulary. No identity dimension.
   */
  renewals: Counter;
}

/**
 * Provider-keyed, not a singleton — `metrics.getMeter()` resolves eagerly
 * against whatever provider is global at call time, and this module is
 * evaluated before `server.ts` calls `startTelemetry`. See the long-form
 * explanation in `apps/edge/src/telemetry.ts`.
 */
let builtAgainst: MeterProvider | null = null;
let cached: EgressInstruments | null = null;

export function instruments(): EgressInstruments {
  const provider = metrics.getMeterProvider();
  if (cached && builtAgainst === provider) return cached;

  const meter = provider.getMeter(SERVICE_NAME);
  builtAgainst = provider;
  cached = {
    proxyDuration: meter.createHistogram(INSTR_EGRESS_PROXY_DURATION, {
      description: "Outbound proxy duration, measured to stream close.",
      unit: "ms",
      advice: { explicitBucketBoundaries: [...DURATION_BUCKETS_MS] },
    }),
    providersReconciles: meter.createCounter(INSTR_PROVIDERS_RECONCILES, {
      description: "Provider-cache reconcile attempts by outcome.",
    }),
    providersListenStatus: meter.createObservableGauge(INSTR_PROVIDERS_LISTEN_STATUS, {
      description:
        "1 while the provider LISTEN client is connected; 0 while down; absent before start / after stop.",
    }),
    exchanges: meter.createCounter(INSTR_EGRESS_EXCHANGES, {
      description: "Code-exchange operations by outcome and provider env.",
    }),
    renewals: meter.createCounter(INSTR_EGRESS_RENEWALS, {
      description: "Token-renewal operations by outcome and provider env.",
    }),
  };
  return cached;
}
