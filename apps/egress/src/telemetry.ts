import {
  metrics,
  trace,
  type Histogram,
  type MeterProvider,
  type Tracer,
} from "@opentelemetry/api";
import { DURATION_BUCKETS_MS, INSTR_EGRESS_PROXY_DURATION } from "@azx-pbc/shared/telemetry";
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
  };
  return cached;
}
