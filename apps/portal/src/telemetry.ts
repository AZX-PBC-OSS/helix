import { trace, type Tracer } from "@opentelemetry/api";
import { SERVICE_NAME } from "./serviceName.js";

/**
 * The portal's tracer. Imports `@opentelemetry/api` and nothing else — see
 * `apps/edge/src/telemetry.ts` for the reasoning.
 *
 * **No instruments.** ADR-0037 decision 8's table gives the portal none: the
 * control plane's interesting signal is the deploy path's shape, which is a
 * trace, and its throughput is low enough that a counter would answer nothing a
 * span search doesn't. Add one when there is a rule to write on it, not before.
 */

/** Safe at module scope — `ProxyTracer` re-resolves per `startSpan`. */
export const tracer: Tracer = trace.getTracer(SERVICE_NAME);
