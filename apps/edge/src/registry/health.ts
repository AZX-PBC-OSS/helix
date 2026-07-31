/**
 * The staleness policy for the registry projection (ADR-0025 item 1): turn
 * `freshness()` into the `/health` sub-check an operator and an alert rule read.
 *
 * A pure function on purpose — no clock, no I/O — so the thresholds are
 * table-testable without standing up a server, and `/health` stays a lookup.
 *
 * Two independent conditions, because they catch two different faults:
 *   - the **failure counter** catches "loads are being attempted and failing";
 *   - the **age** catches "loads stopped being attempted at all" — a stalled or
 *     cleared reconcile timer produces zero failures, forever, and the counter
 *     alone would report perfect health while the copy rots.
 * The age rule is therefore the authority for `error`.
 */
import type { HealthCheck } from "@azx-pbc/shared";
import type { RegistryFreshness } from "./projection.js";

/** Staleness, in multiples of the reconcile interval, that degrades / errors. */
export const STALE_DEGRADED_INTERVALS = 5;
export const STALE_ERROR_INTERVALS = 20;
/** Consecutive load failures that degrade `/health` (≈3 min at the 60 s default). */
export const FAILURES_DEGRADED = 3;

/** Stable check name — this is what an alert rule keys on; don't rename lightly. */
export const REGISTRY_CHECK_NAME = "registry-projection";

/** Fallback when the configured interval is unusable (see the guard below). */
const FALLBACK_RECONCILE_INTERVAL_MS = 60_000;

function seconds(ms: number): number {
  return Math.round(ms / 1000);
}

/**
 * Grade the projection's freshness. Never throws: `/health` must answer even
 * when the config it reasons about is nonsense.
 */
export function registryFreshnessCheck(
  freshness: RegistryFreshness,
  reconcileIntervalMs: number,
): HealthCheck {
  // `EDGE_RECONCILE_INTERVAL_MS` goes through a bare `Number()` (config.ts), so
  // NaN/0/negative are all reachable — and each would silently disable the age
  // rule (every comparison against NaN is false). Fall back instead.
  const interval =
    Number.isFinite(reconcileIntervalMs) && reconcileIntervalMs > 0
      ? reconcileIntervalMs
      : FALLBACK_RECONCILE_INTERVAL_MS;

  const { loaded, staleForMs, consecutiveLoadFailures, lastSuccessfulLoadAt } = freshness;
  const metrics: Record<string, number> = { consecutiveLoadFailures };
  if (staleForMs !== null) metrics.staleForSeconds = seconds(staleForMs);
  const base = {
    name: REGISTRY_CHECK_NAME,
    metrics,
    ...(lastSuccessfulLoadAt !== null ? { lastSuccessAt: lastSuccessfulLoadAt } : {}),
  };

  // Cold start (ADR-0025 item 3's health signal): every app host is 503ing, and
  // before this check that state reported green.
  if (!loaded || staleForMs === null) {
    return {
      ...base,
      status: "error",
      detail: "registry projection has never loaded; app hosts are serving 503",
    };
  }

  const age = `projection last loaded ${seconds(staleForMs)}s ago`;
  const intervalSuffix = `the ${seconds(interval)}s reconcile interval`;

  if (staleForMs > STALE_ERROR_INTERVALS * interval) {
    return {
      ...base,
      status: "error",
      detail: `${age} (> ${STALE_ERROR_INTERVALS}× ${intervalSuffix}); serving stale`,
    };
  }
  if (staleForMs > STALE_DEGRADED_INTERVALS * interval) {
    return {
      ...base,
      status: "degraded",
      detail: `${age} (> ${STALE_DEGRADED_INTERVALS}× ${intervalSuffix}); serving stale`,
    };
  }
  if (consecutiveLoadFailures >= FAILURES_DEGRADED) {
    return {
      ...base,
      status: "degraded",
      detail: `${consecutiveLoadFailures} consecutive projection load failures; serving stale`,
    };
  }
  return { ...base, status: "ok" };
}
