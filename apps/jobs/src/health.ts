import { JOBS_DATABASE_CHECK, type HealthCheck } from "@azx-pbc/shared";

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
