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
 * touching this schema (the edge reports the registry projection's freshness;
 * the portal reports its jobs lifecycle-delivery loop and backlog; the jobs
 * service reports its own supervision states).
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
  /** Absent means the service reports liveness only — egress always; the portal when jobs is not configured on the install. */
  checks: z.array(HealthCheckSchema).optional(),
});
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

/**
 * The name the jobs service stamps in its `/health` body's `service` field —
 * the value `apps/jobs/src/serviceName.ts` exports as its own `SERVICE_NAME`
 * and stamps in the OTel resource attribute, the boot log line and this
 * field. Defined here because it has a second consumer that must never
 * disagree with the first: the edge's reachability probe verifies the body it
 * received was answered by the jobs service and not by some other helix
 * process sharing the same wire contract — a misrouted endpoint must never
 * read as a reachable jobs server.
 */
export const JOBS_SERVICE_NAME = "helix-jobs";

const STATE_RANK: Record<HealthState, number> = { ok: 0, degraded: 1, error: 2 };

/** Roll sub-checks up into the top-level `status`: the worst state wins. */
export function worstHealthState(states: Iterable<HealthState>): HealthState {
  let worst: HealthState = "ok";
  for (const state of states) {
    if (STATE_RANK[state] > STATE_RANK[worst]) worst = state;
  }
  return worst;
}

// ── Grading a supervised pass loop ───────────────────────────────────────────

/**
 * The freshness skeleton every loop-graded health check shares — one grading
 * of a supervised pass loop's supervision state (is it running; has a pass
 * ever completed; is the last successful pass fresh). Check-specific evidence
 * (backlog age, lag, saturation) is graded by each check after this returns
 * `fresh`. The parameter is structural — the three fields the grading reads —
 * so different loops' snapshots grade through this one function and cannot
 * drift into different staleness semantics; a boundary correction here is
 * every loop-graded check's correction, and no leg can pass on a private
 * copy.
 */
export type PassFreshness =
  | { kind: "not_started" }
  | { kind: "no_pass"; lastPassSeconds: number | null }
  | { kind: "stale"; sinceSeconds: number }
  | { kind: "fresh" };

export function passFreshness(
  snapshot: { started: boolean; lastPassAt: string | null; lastOkPassAt: string | null },
  staleAfterMs: number,
  nowMs: number,
): PassFreshness {
  if (!snapshot.started) return { kind: "not_started" };
  if (snapshot.lastOkPassAt === null) {
    return {
      kind: "no_pass",
      lastPassSeconds: snapshot.lastPassAt
        ? Math.round((nowMs - Date.parse(snapshot.lastPassAt)) / 1000)
        : null,
    };
  }
  const sinceMs = nowMs - Date.parse(snapshot.lastOkPassAt);
  if (sinceMs > staleAfterMs) return { kind: "stale", sinceSeconds: Math.round(sinceMs / 1000) };
  return { kind: "fresh" };
}

/** The distinction the last pass's own instant buys: a loop that never ran at all and one that runs but cannot complete a pass read differently. */
export function lastPassAgeSuffix(lastPassSeconds: number | null): string {
  return lastPassSeconds === null ? "" : ` — its last pass was ${lastPassSeconds}s ago`;
}
