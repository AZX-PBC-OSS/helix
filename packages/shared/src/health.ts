import { z } from "zod";

/**
 * Health/readiness response shape, shared by every service's `/health` endpoint
 * so the contract is identical across edge, portal and egress.
 *
 * `status` is a three-state roll-up, not a liveness boolean: a service can be
 * **serving correctly from a degraded dependency** and must be able to say so.
 * The edge's registry projection is the motivating case (ADR-0025) — on a DB
 * failure it keeps serving its last-loaded copy (architecture §7), which is the
 * right call for availability and invisible without this field.
 *
 * **`/health` always answers HTTP 200**, on every state. The body carries the
 * degradation; the status code does not. A non-200 here would let a liveness
 * probe restart a replica that is serving correctly — turning the serve-stale
 * stance into the outage it exists to prevent. Operators alert on `status` /
 * `checks[].metrics` and on the structured log events, never on the code.
 */
export const HealthStateSchema = z.enum(["ok", "degraded", "error"]);
export type HealthState = z.infer<typeof HealthStateSchema>;

/**
 * One named sub-check. Generic on purpose — every service adds its own without
 * touching this schema (today only the edge reports one: the registry
 * projection's freshness).
 */
export const HealthCheckSchema = z.object({
  /** Stable identifier an alert rule can key on, e.g. `registry-projection`. */
  name: z.string(),
  status: HealthStateSchema,
  /** Operator-facing one-liner: what is wrong, and for how long. */
  detail: z.string().optional(),
  /** Wall-clock instant this check last succeeded. Report-only — never the
   *  basis of a staleness decision (see the monotonic note in the edge's
   *  registry projection). */
  lastSuccessAt: z.iso.datetime().optional(),
  /** Numeric facts a dashboard or a log-based metric can key on. */
  metrics: z.record(z.string(), z.number()).optional(),
});
export type HealthCheck = z.infer<typeof HealthCheckSchema>;

export const HealthStatusSchema = z.object({
  /** The roll-up: the worst state across `checks` (see `worstHealthState`). */
  status: HealthStateSchema,
  service: z.string(),
  /** Process uptime in seconds. */
  uptime: z.number().nonnegative(),
  /** Absent means the service reports liveness only (portal and egress today). */
  checks: z.array(HealthCheckSchema).optional(),
});
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

const STATE_RANK: Record<HealthState, number> = { ok: 0, degraded: 1, error: 2 };

/** Roll sub-checks up into the top-level `status`: the worst state wins. */
export function worstHealthState(states: Iterable<HealthState>): HealthState {
  let worst: HealthState = "ok";
  for (const state of states) {
    if (STATE_RANK[state] > STATE_RANK[worst]) worst = state;
  }
  return worst;
}
