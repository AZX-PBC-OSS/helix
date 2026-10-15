import { metrics, type Counter, type MeterProvider } from "@opentelemetry/api";
import { INSTR_JOBS_STORAGE_PROBES } from "@azx-pbc/shared/telemetry";

import { SERVICE_NAME } from "./serviceName.js";

/**
 * The jobs service's instruments — the same shape as the edge's
 * (`apps/edge/src/telemetry.ts`).
 *
 * **This module imports `@opentelemetry/api` and nothing else** — the facade
 * is dependency-free and no-ops when no provider is registered, which is what
 * lets it be reached from inside `buildApp()` without dragging an SDK or an
 * exporter into the test path (ADR-0037 decision 3). The SDK lives in
 * `@azx-pbc/telemetry`, imported only by `server.ts`.
 */

/** Every metric the jobs service writes. One object so a call site can't miss one. */
export interface JobsInstruments {
  /** `outcome` ∈ `JOBS_STORAGE_PROBE_OUTCOMES` — the storage-readiness probes. */
  storageProbes: Counter;
}

/**
 * The last provider {@link instruments} built against, and what it built.
 *
 * **Not a plain module-level singleton** — `metrics.getMeter()` has no proxy:
 * it resolves the provider immediately, and with nothing registered that is
 * the noop meter whose instruments stay inert forever. ES imports are hoisted,
 * so `server.ts`'s import of `./app.js` evaluates this module *before* the
 * `startTelemetry(SERVICE_NAME)` call on the next line executes; a module-scope
 * meter would bind to the noop provider and **every metric would silently
 * vanish in production while every test passed**. Keying the cache on provider
 * identity makes the ordering irrelevant: the first call after a provider is
 * registered rebuilds against it, and a test that swaps providers gets fresh
 * instruments without a reset hook.
 */
let builtAgainst: MeterProvider | null = null;
let cached: JobsInstruments | null = null;

export function instruments(): JobsInstruments {
  const provider = metrics.getMeterProvider();
  if (cached && builtAgainst === provider) return cached;

  const meter = provider.getMeter(SERVICE_NAME);
  builtAgainst = provider;
  cached = {
    storageProbes: meter.createCounter(INSTR_JOBS_STORAGE_PROBES, {
      description:
        "Jobs storage-readiness probes by outcome. Operational only — a run of " +
        "unavailable with no ok is a store outage, and the health body names the reason for it.",
    }),
  };
  return cached;
}
