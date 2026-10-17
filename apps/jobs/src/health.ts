import {
  JOBS_CAPACITY_CHECK,
  JOBS_CLEANUP_CHECK,
  JOBS_DATABASE_CHECK,
  JOBS_SWEEPER_CHECK,
  JOBS_WORKER_CHECK,
  type HealthCheck,
  type JobsCapacityLimits,
} from "@azx-pbc/shared";

import { JOBS_CLEANUP_STALE_AFTER_MS, type JobsCleanupSnapshot } from "./cleanup.js";
import { JOBS_RECOVERY_STALE_AFTER_MS, type JobsRecoverySnapshot } from "./recovery.js";
import type { JobsRunnerSnapshot } from "./runner.js";
import type { JobsStorageSnapshot } from "./storage.js";

/**
 * Grade the jobs store's readiness into the `jobs_database` health check
 * (ADR-0009) — a pure function on the supervisor's snapshot, so `/health`
 * stays a lookup and the grading is table-testable without a server.
 *
 * The rule that names the shape: **unknown readiness never appears healthy**.
 * `pending` — no probe has completed — reports `error`, not `ok` and not
 * degraded, because "nothing has answered yet" is the same absence of evidence
 * the shared contract refuses to read as health. Every incompatible verdict is
 * an `error` too: until the store verifies compatible, no job operation can be
 * served, and there is no degraded-in-between state for a store that either
 * works or does not. (Saturation and cleanup-lag degradations belong to the
 * capacity/cleanup checks that land with their own seams.)
 */
export function jobsDatabaseCheck(snapshot: JobsStorageSnapshot): HealthCheck {
  const base = {
    name: JOBS_DATABASE_CHECK,
    metrics: { probes: snapshot.probes },
  };

  if (snapshot.state === "pending") {
    return {
      ...base,
      status: "error",
      detail: "storage readiness has never been verified; job operations are unavailable",
    };
  }
  if (snapshot.state === "ready") {
    return {
      ...base,
      status: "ok",
      ...(snapshot.lastReadyAt ? { lastSuccessAt: snapshot.lastReadyAt } : {}),
    };
  }

  const verdict = snapshot.verdict;
  if (!verdict || verdict.kind === "compatible") {
    // The compatible arm is unreachable through the supervisor (an unavailable
    // state always carries the failing verdict) — refuse the healthy reading
    // rather than assume one.
    return { ...base, status: "error", detail: "storage is unavailable with no verdict recorded" };
  }
  const since = snapshot.unavailableSince ? ` since ${snapshot.unavailableSince}` : "";
  switch (verdict.kind) {
    case "unreachable":
      return {
        ...base,
        status: "error",
        detail: `the store did not answer${since}: ${verdict.message}`,
      };
    case "schema_missing":
      return {
        ...base,
        status: "error",
        detail: `the runner schema is not installed${since} — run the migration command`,
      };
    case "schema_version":
      return {
        ...base,
        status: "error",
        detail: `the runner schema is at version ${verdict.found}, expected ${verdict.expected}${since} — run the migration command`,
      };
    case "queue_missing":
      return {
        ...base,
        status: "error",
        detail: `the platform queue is absent${since} — run the migration command`,
      };
    case "burn_missing":
      return {
        ...base,
        status: "error",
        detail: `the instruction burn store is absent${since} — run the migration command`,
      };
    case "lifecycle_missing":
      return {
        ...base,
        status: "error",
        detail: `the app lifecycle store is absent${since} — run the migration command`,
      };
    case "record_missing":
      return {
        ...base,
        status: "error",
        detail: `the job record store is absent${since} — run the migration command`,
      };
    case "record_schema":
      return {
        ...base,
        status: "error",
        detail: `the job record store is not at its expected shape (${verdict.problems.join("; ")})${since} — run the migration command`,
      };
    case "queue_policy":
      return {
        ...base,
        status: "error",
        detail: `the queue does not carry the platform policy${since}: ${verdict.diffs
          .map((d) => d.field)
          .join(", ")} — run the migration command`,
      };
    case "runtime_privileges":
      return {
        ...base,
        status: "error",
        detail: `the runtime identity is missing ${verdict.missing.join(", ")}${since}`,
      };
  }
}

/**
 * Grade the runner's supervision state into the `jobs_worker` health check
 * (ADR-0009) — the same pure-lookup shape as the store check: the runner
 * started AND its worker registration completed, or the body names which of
 * the two is missing. A listener that can answer HTTP but has no worker
 * executing must never read as healthy.
 */
export function jobsWorkerCheck(snapshot: JobsRunnerSnapshot): HealthCheck {
  if (!snapshot.started) {
    return {
      name: JOBS_WORKER_CHECK,
      status: "error",
      detail: "the runner has not started — no worker is executing accepted work",
    };
  }
  if (!snapshot.workerRegistered) {
    return {
      name: JOBS_WORKER_CHECK,
      status: "error",
      detail:
        "the runner started but no worker is registered on it — accepted work cannot execute yet",
    };
  }
  return { name: JOBS_WORKER_CHECK, status: "ok" };
}

/**
 * Grade the recovery sweeper's supervision state into the `jobs_sweeper`
 * health check (ADR-0009) — the same pure-lookup shape as the other checks:
 * the sweeper is running, and its last successful reconciliation pass is
 * fresh, or the body names which of the two is missing. Staleness is judged
 * against a fixed multiple of the sweep cadence, never against the
 * snapshot's own report of it; a pass that cannot complete (its store or the
 * runner's instance unavailable) leaves `lastOkPassAt` behind and the check
 * degrades or errors accordingly. Stopped or stale recovery is never
 * healthy — interrupted work the sweeper is not reconciling is exactly the
 * "forgotten active work" this seam exists to prevent (spec criterion 55).
 */
export function jobsSweeperCheck(
  snapshot: JobsRecoverySnapshot,
  options?: { staleAfterMs?: number; nowMs?: number },
): HealthCheck {
  const staleAfterMs = options?.staleAfterMs ?? JOBS_RECOVERY_STALE_AFTER_MS;
  const nowMs = options?.nowMs ?? Date.now();
  const base = {
    name: JOBS_SWEEPER_CHECK,
    metrics: { passes: snapshot.passes, reconciled: snapshot.reconciled },
  };

  const freshness = passFreshness(snapshot, staleAfterMs, nowMs);
  switch (freshness.kind) {
    case "not_started":
      return {
        ...base,
        status: "error",
        detail: "the recovery sweeper is not running — interrupted work is not being reconciled",
      };
    case "no_pass":
      return {
        ...base,
        status: "error",
        detail: `the recovery sweeper has completed no successful pass${lastPassAgeSuffix(freshness.lastPassSeconds)} — interrupted work is not being reconciled`,
      };
    case "stale":
      return {
        ...base,
        status: "degraded",
        detail: `the recovery sweeper's last successful pass was ${freshness.sinceSeconds}s ago`,
        // Non-null in this arm by the skeleton's own decision (stale implies
        // a last successful pass); the schema's field is optional, not
        // nullable.
        lastSuccessAt: snapshot.lastOkPassAt ?? undefined,
      };
    case "fresh":
      return {
        ...base,
        status: "ok",
        lastSuccessAt: snapshot.lastOkPassAt ?? undefined,
      };
  }
}

/**
 * The freshness skeleton THREE loop-graded checks share — one grading of a
 * supervised pass loop's supervision state (is it running; has a pass ever
 * completed; is the last successful pass fresh), rendered by each check in
 * its own wording. The parameter is structural — the three fields the
 * grading reads — so the recovery sweeper's and the cleanup loop's
 * different snapshots grade through this one function and cannot drift into
 * different staleness semantics; a boundary correction here is all three
 * checks' correction, and no leg can pass on a private copy.
 */
type PassFreshness =
  | { kind: "not_started" }
  | { kind: "no_pass"; lastPassSeconds: number | null }
  | { kind: "stale"; sinceSeconds: number }
  | { kind: "fresh" };

function passFreshness(
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
function lastPassAgeSuffix(lastPassSeconds: number | null): string {
  return lastPassSeconds === null ? "" : ` — its last pass was ${lastPassSeconds}s ago`;
}

/**
 * Grade the cleanup loop's supervision into the `jobs_cleanup` health check
 * (ADR-0009) — the same pure-lookup shape as the other checks. Beyond the
 * shared freshness skeleton (a stopped or never-passed loop errors, a stale
 * one degrades), the check carries the lag evidence the retention contract
 * binds: content that has stood past its 48-hour physical-removal deadline
 * — an expired result still in storage, an expired record still holding its
 * retry key and runner row — degrades until a pass opens on it cleared
 * (spec criteria 36, 55). Removal finishing within the bound is the loop's
 * own steady behavior; the degraded reading is for the outage story an
 * operator must see until recovery completes it.
 */
export function jobsCleanupCheck(
  snapshot: JobsCleanupSnapshot,
  options?: { staleAfterMs?: number; nowMs?: number },
): HealthCheck {
  const staleAfterMs = options?.staleAfterMs ?? JOBS_CLEANUP_STALE_AFTER_MS;
  const nowMs = options?.nowMs ?? Date.now();
  const base = {
    name: JOBS_CLEANUP_CHECK,
    metrics: {
      passes: snapshot.passes,
      resultsRemoved: snapshot.resultsRemoved,
      recordsRetired: snapshot.recordsRetired,
    },
  };
  const freshness = passFreshness(snapshot, staleAfterMs, nowMs);
  switch (freshness.kind) {
    case "not_started":
      return {
        ...base,
        status: "error",
        detail:
          "the cleanup loop is not running — expired results and records are not being removed",
      };
    case "no_pass":
      return {
        ...base,
        status: "error",
        detail: `the cleanup loop has completed no successful pass${lastPassAgeSuffix(freshness.lastPassSeconds)} — expired content is not being removed`,
      };
    case "stale":
      return {
        ...base,
        status: "degraded",
        detail: `the cleanup loop's last successful pass was ${freshness.sinceSeconds}s ago — its lag and saturation evidence is stale`,
        lastSuccessAt: snapshot.lastOkPassAt ?? undefined,
      };
    case "fresh": {
      const evidence = snapshot.evidence;
      if (!evidence) {
        // Unreachable through the loop (a fresh pass always measures) —
        // refuse the healthy reading rather than assume one.
        return { ...base, status: "error", detail: "the cleanup pass carried no measurement" };
      }
      if (evidence.overdueResults > 0 || evidence.overdueRecords > 0) {
        return {
          ...base,
          status: "degraded",
          detail:
            `${evidence.overdueResults} expired result(s) and ${evidence.overdueRecords} expired ` +
            "job record(s) stand past their 48-hour physical-removal deadline — cleanup is overdue until a pass removes them",
          lastSuccessAt: snapshot.lastOkPassAt ?? undefined,
        };
      }
      return { ...base, status: "ok", lastSuccessAt: snapshot.lastOkPassAt ?? undefined };
    }
  }
}

/**
 * Grade the measured retained-storage occupancy into the `jobs_capacity`
 * health check (ADR-0009) — the producer the capacity-enforcement ticket
 * deferred to this loop, because saturation is visible only through occupancy
 * evidence measured on a cadence. Retained saturation degrades (spec
 * criterion 55): reads, recovery and cancellation remain available, and new
 * work is being refused 429 — but a saturated retained cap blocks new work
 * until cleanup frees it, and that state must not read as healthy.
 * Unfinished-capacity refusal alone deliberately does not degrade anything
 * here (criterion 55: ordinary busy answers are not unhealthy) — the
 * unfinished count rides the metrics as context, never the grade.
 */
export function jobsCapacityCheck(
  snapshot: JobsCleanupSnapshot,
  limits: JobsCapacityLimits,
  options?: { staleAfterMs?: number; nowMs?: number },
): HealthCheck {
  const staleAfterMs = options?.staleAfterMs ?? JOBS_CLEANUP_STALE_AFTER_MS;
  const nowMs = options?.nowMs ?? Date.now();
  const freshness = passFreshness(snapshot, staleAfterMs, nowMs);
  switch (freshness.kind) {
    case "not_started":
      return {
        name: JOBS_CAPACITY_CHECK,
        status: "error",
        detail:
          "no occupancy evidence — the cleanup loop that measures retained storage is not running",
      };
    case "no_pass":
      return {
        name: JOBS_CAPACITY_CHECK,
        status: "error",
        detail:
          "no occupancy evidence — the cleanup loop that measures retained storage has completed no successful pass",
      };
    case "stale":
      return {
        name: JOBS_CAPACITY_CHECK,
        status: "degraded",
        detail: `the retained-storage measurement is stale — its last successful pass was ${freshness.sinceSeconds}s ago`,
        lastSuccessAt: snapshot.lastOkPassAt ?? undefined,
      };
    case "fresh": {
      const evidence = snapshot.evidence;
      if (!evidence) {
        return {
          name: JOBS_CAPACITY_CHECK,
          status: "error",
          detail: "the cleanup pass carried no measurement",
        };
      }
      const metrics = {
        retainedServer: evidence.retainedServer,
        unfinishedServer: evidence.unfinishedServer,
      };
      if (evidence.retainedServer >= limits.retainedPerServer) {
        return {
          name: JOBS_CAPACITY_CHECK,
          status: "degraded",
          metrics,
          detail:
            `retained storage is saturated: ${evidence.retainedServer} of ` +
            `${limits.retainedPerServer} retained jobs server-wide — new work is refused until cleanup frees capacity`,
          // The degraded arm grades the same measurement as the ok arm — its
          // evidence is exactly as time-based, and the state where new work
          // is refused is where the reading's instant matters most.
          lastSuccessAt: snapshot.lastOkPassAt ?? undefined,
        };
      }
      return {
        name: JOBS_CAPACITY_CHECK,
        status: "ok",
        metrics,
        lastSuccessAt: snapshot.lastOkPassAt ?? undefined,
      };
    }
  }
}
