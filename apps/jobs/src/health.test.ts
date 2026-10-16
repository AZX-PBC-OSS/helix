import { describe, expect, test } from "vitest";

import {
  HealthCheckSchema,
  JOBS_DATABASE_CHECK,
  JOBS_SWEEPER_CHECK,
  JOBS_WORKER_CHECK,
} from "@azx-pbc/shared";

import type { JobsStorageCompatibility } from "./compat.js";
import { jobsDatabaseCheck, jobsSweeperCheck, jobsWorkerCheck } from "./health.js";
import { JOBS_RECOVERY_STALE_AFTER_MS, type JobsRecoverySnapshot } from "./recovery.js";
import type { JobsRunnerSnapshot } from "./runner.js";
import type { JobsStorageSnapshot } from "./storage.js";

/**
 * The `jobs_database` grading table, over snapshots shaped exactly as the
 * supervisor's `recordProbe` writes them. `/health` is a lookup of this
 * function's answer, so the table is where every verdict kind's operator-facing
 * wording is pinned: the two rules that must never bend are that unknown
 * readiness never appears healthy and that no incompatible store ever reads as
 * merely degraded — a store either verifies compatible or it does not.
 */

const COMPATIBLE: JobsStorageCompatibility = { kind: "compatible", schemaVersion: 45 };

function snapshot(overrides: Partial<JobsStorageSnapshot>): JobsStorageSnapshot {
  return {
    state: "pending",
    verdict: null,
    lastReadyAt: null,
    unavailableSince: null,
    probes: 0,
    ...overrides,
  };
}

/** The "verified ready, then died" story the supervisor records: the last good instant survives. */
function unavailableWith(verdict: JobsStorageCompatibility, since = "2026-10-15T08:00:00.000Z") {
  return snapshot({
    state: "unavailable",
    verdict,
    lastReadyAt: "2026-10-15T07:30:00.000Z",
    unavailableSince: since,
    probes: 4,
  });
}

describe("jobsDatabaseCheck", () => {
  test("pending is error — nothing has answered yet is the absence of evidence, not health", () => {
    const check = jobsDatabaseCheck(snapshot({}));
    expect(HealthCheckSchema.parse(check)).toBeTruthy();
    expect(check.name).toBe(JOBS_DATABASE_CHECK);
    expect(check.status).toBe("error");
    expect(check.detail).toMatch(/never been verified/);
    expect(check.metrics).toEqual({ probes: 0 });
  });

  test("ready is ok with the last verified instant, and the probe count rides the metrics", () => {
    const check = jobsDatabaseCheck(
      snapshot({
        state: "ready",
        verdict: COMPATIBLE,
        lastReadyAt: "2026-10-15T08:00:00.000Z",
        probes: 7,
      }),
    );
    expect(HealthCheckSchema.parse(check)).toBeTruthy();
    expect(check.status).toBe("ok");
    expect(check.lastSuccessAt).toBe("2026-10-15T08:00:00.000Z");
    expect(check.detail).toBeUndefined();
    expect(check.metrics).toEqual({ probes: 7 });
  });

  test("every incompatible verdict is an error whose detail names the specific answer", () => {
    const rows: Array<{
      verdict: JobsStorageCompatibility;
      detailMatches: RegExp;
      detailExcludes?: RegExp;
    }> = [
      {
        verdict: { kind: "unreachable", message: "connect ECONNREFUSED 10.1.2.3:5432" },
        detailMatches: /did not answer.*connect ECONNREFUSED 10\.1\.2\.3:5432/s,
      },
      {
        verdict: { kind: "schema_missing" },
        detailMatches: /runner schema is not installed.*run the migration command/s,
      },
      {
        verdict: { kind: "schema_version", found: 3, expected: 45 },
        detailMatches: /version 3, expected 45.*run the migration command/s,
      },
      {
        verdict: { kind: "queue_missing" },
        detailMatches: /platform queue is absent.*run the migration command/s,
      },
      {
        verdict: { kind: "burn_missing" },
        detailMatches: /instruction burn store is absent.*run the migration command/s,
      },
      {
        verdict: { kind: "lifecycle_missing" },
        detailMatches: /app lifecycle store is absent.*run the migration command/s,
      },
      {
        verdict: { kind: "record_missing" },
        detailMatches: /job record store is absent.*run the migration command/s,
      },
      {
        verdict: {
          kind: "record_schema",
          problems: ['column "attempt" is missing', 'column "result" is jsonb, expected text'],
        },
        detailMatches:
          /not at its expected shape \(column "attempt" is missing; column "result" is jsonb, expected text\).*run the migration command/s,
      },
      {
        verdict: {
          kind: "queue_policy",
          diffs: [
            { field: "retry_limit", expected: 5, actual: 0 },
            { field: "dead_letter", expected: true, actual: false },
          ],
        },
        detailMatches:
          /does not carry the platform policy.*retry_limit, dead_letter.*migration command/s,
      },
      {
        verdict: {
          kind: "runtime_privileges",
          missing: ["SELECT on pgboss.job", "INSERT on pgboss.job"],
        },
        detailMatches: /missing SELECT on pgboss\.job, INSERT on pgboss\.job/,
        detailExcludes: /run the migration command/,
      },
    ];

    for (const { verdict, detailMatches, detailExcludes } of rows) {
      const check = jobsDatabaseCheck(unavailableWith(verdict));
      expect(HealthCheckSchema.parse(check), `verdict ${verdict.kind}`).toBeTruthy();
      expect(check.status, `verdict ${verdict.kind}`).toBe("error");
      expect(check.name, `verdict ${verdict.kind}`).toBe(JOBS_DATABASE_CHECK);
      expect(check.detail, `verdict ${verdict.kind}`).toMatch(detailMatches);
      if (detailExcludes) {
        expect(check.detail, `verdict ${verdict.kind}`).not.toMatch(detailExcludes);
      }
    }
  });

  test("an unavailable episode carries how long it has been unusable", () => {
    const check = jobsDatabaseCheck(unavailableWith({ kind: "schema_missing" }));
    expect(check.detail).toContain("since 2026-10-15T08:00:00.000Z");
  });

  test("the last verified instant survives an outage; the episode start does not outlive recovery", () => {
    // The snapshot's own discipline, visible through the grading: lastReadyAt
    // persists into the unavailable body, and recovery replaces it.
    const lost = jobsDatabaseCheck(unavailableWith({ kind: "unreachable", message: "down" }));
    expect(lost.status).toBe("error");
    expect(lost.lastSuccessAt).toBeUndefined(); // only a ready check carries it

    const recovered = jobsDatabaseCheck(
      snapshot({
        state: "ready",
        verdict: COMPATIBLE,
        lastReadyAt: "2026-10-15T08:05:00.000Z",
        probes: 9,
      }),
    );
    expect(recovered.status).toBe("ok");
    expect(recovered.lastSuccessAt).toBe("2026-10-15T08:05:00.000Z");
  });

  test("unavailable with no verdict is refused, never read as healthy", () => {
    // A shape the supervisor never writes (an unavailable state always carries
    // its failing verdict) — and the fail-closed pin: if a refactor ever
    // produces it, the answer is error, not an assumed healthy reading.
    const check = jobsDatabaseCheck(snapshot({ state: "unavailable", verdict: null, probes: 2 }));
    expect(check.status).toBe("error");
    expect(check.detail).toMatch(/no verdict recorded/);
  });
});

describe("jobsWorkerCheck", () => {
  test("a started runner with its worker registered is ok", () => {
    const check = jobsWorkerCheck({ started: true, workerRegistered: true });
    expect(HealthCheckSchema.parse(check)).toBeTruthy();
    expect(check.name).toBe(JOBS_WORKER_CHECK);
    expect(check.status).toBe("ok");
  });

  test("an unstarted runner is error — no worker is executing", () => {
    const check = jobsWorkerCheck({ started: false, workerRegistered: false });
    expect(check.status).toBe("error");
    expect(check.detail).toMatch(/runner has not started/);
  });

  test("a started runner with no worker is error — a listener without execution never reads healthy", () => {
    const check = jobsWorkerCheck({ started: true, workerRegistered: false });
    expect(HealthCheckSchema.parse(check)).toBeTruthy();
    expect(check.status).toBe("error");
    expect(check.detail).toMatch(/no worker is registered/);
  });

  test("the check is named for the alert rules and carries the runner snapshot's own shape", () => {
    // The runner's snapshot type is the grading's whole input — an extra
    // field the runner later adds must not silently change this check.
    const snapshot: JobsRunnerSnapshot = { started: true, workerRegistered: true };
    expect(jobsWorkerCheck(snapshot)).toEqual({ name: JOBS_WORKER_CHECK, status: "ok" });
  });
});

describe("jobsSweeperCheck", () => {
  const NOW = Date.parse("2026-10-16T08:00:00.000Z");

  function sweeper(overrides: Partial<JobsRecoverySnapshot>): JobsRecoverySnapshot {
    return {
      started: true,
      passes: 4,
      lastPassAt: new Date(NOW - 1_000).toISOString(),
      lastOkPassAt: new Date(NOW - 1_000).toISOString(),
      reconciled: 2,
      ...overrides,
    };
  }

  test("a sweeper that is not running, or has never completed a pass, is never healthy", () => {
    const notRunning = jobsSweeperCheck(
      sweeper({ started: false, passes: 0, lastPassAt: null, lastOkPassAt: null }),
      {
        nowMs: NOW,
      },
    );
    expect(HealthCheckSchema.parse(notRunning)).toBeTruthy();
    expect(notRunning.name).toBe(JOBS_SWEEPER_CHECK);
    expect(notRunning.status).toBe("error");
    expect(notRunning.detail).toMatch(/sweeper is not running/);

    const neverPassed = jobsSweeperCheck(
      sweeper({ lastOkPassAt: null, passes: 3, lastPassAt: new Date(NOW).toISOString() }),
      { nowMs: NOW },
    );
    expect(neverPassed.status).toBe("error");
    // The last pass's own instant distinguishes a loop that never ran from
    // one that runs but cannot complete a pass.
    expect(neverPassed.detail).toMatch(/no successful pass — its last pass was 0s ago/);
  });

  test("a fresh successful pass is ok and names when it last succeeded; the counts ride the metrics", () => {
    const check = jobsSweeperCheck(sweeper({}), { nowMs: NOW });
    expect(check.status).toBe("ok");
    expect(check.lastSuccessAt).toBe(new Date(NOW - 1_000).toISOString());
    expect(check.metrics).toEqual({ passes: 4, reconciled: 2 });
  });

  test("a last successful pass older than the staleness bound degrades, naming its age", () => {
    const check = jobsSweeperCheck(
      sweeper({ lastOkPassAt: new Date(NOW - 10 * 60_000).toISOString() }),
      { nowMs: NOW },
    );
    expect(check.status).toBe("degraded");
    expect(check.detail).toMatch(/last successful pass was 600s ago/);
  });

  test("a pass at exactly the staleness bound still reads ok — degradation begins after it", () => {
    // The threshold is strictly-greater: a check exactly as old as the bound
    // is the last instant the loop's own cadence can still answer for.
    const atBound = sweeper({ lastOkPassAt: new Date(NOW - 45_000).toISOString() });
    expect(jobsSweeperCheck(atBound, { nowMs: NOW }).status).toBe("ok");
    const pastBound = sweeper({ lastOkPassAt: new Date(NOW - 45_001).toISOString() });
    expect(jobsSweeperCheck(pastBound, { nowMs: NOW }).status).toBe("degraded");
  });

  test("the staleness bound is a fixed multiple of the sweep cadence, overridable for the leg", () => {
    const at30s = sweeper({ lastOkPassAt: new Date(NOW - 30_000).toISOString() });
    expect(jobsSweeperCheck(at30s, { nowMs: NOW }).status).toBe("ok");
    expect(jobsSweeperCheck(at30s, { nowMs: NOW, staleAfterMs: 20_000 }).status).toBe("degraded");
    // The default is derived from the sweeper's own cadence constant.
    expect(JOBS_RECOVERY_STALE_AFTER_MS).toBe(45_000);
  });
});
