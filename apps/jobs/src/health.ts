import {
  JOBS_DATABASE_CHECK,
  JOBS_SWEEPER_CHECK,
  JOBS_WORKER_CHECK,
  type HealthCheck,
} from "@azx-pbc/shared";

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

  if (!snapshot.started) {
    return {
      ...base,
      status: "error",
      detail: "the recovery sweeper is not running — interrupted work is not being reconciled",
    };
  }
  if (snapshot.lastOkPassAt === null) {
    // The distinction the last pass's own instant buys: a loop that never ran
    // at all and one that runs but cannot complete a pass read differently.
    const lastPass = snapshot.lastPassAt
      ? ` — its last pass was ${Math.round((nowMs - Date.parse(snapshot.lastPassAt)) / 1000)}s ago`
      : "";
    return {
      ...base,
      status: "error",
      detail: `the recovery sweeper has completed no successful pass${lastPass} — interrupted work is not being reconciled`,
    };
  }
  const sinceMs = nowMs - Date.parse(snapshot.lastOkPassAt);
  if (sinceMs > staleAfterMs) {
    return {
      ...base,
      status: "degraded",
      detail: `the recovery sweeper's last successful pass was ${Math.round(sinceMs / 1000)}s ago`,
      lastSuccessAt: snapshot.lastOkPassAt,
    };
  }
  return {
    ...base,
    status: "ok",
    lastSuccessAt: snapshot.lastOkPassAt,
  };
}
