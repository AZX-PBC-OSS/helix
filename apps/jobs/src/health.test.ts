import { describe, expect, test } from "vitest";

import {
  HealthCheckSchema,
  JOBS_CAPACITY_CHECK,
  JOBS_CLEANUP_CHECK,
  JOBS_DATABASE_CHECK,
  JOBS_INTAKE_CHECK,
  JOBS_LIFECYCLE_RECOVERY_CHECK,
  JOBS_SWEEPER_CHECK,
  JOBS_WORKER_CHECK,
  resolveJobsCapacityLimits,
} from "@azx-pbc/shared";

import { JOBS_CLEANUP_STALE_AFTER_MS, type JobsCleanupSnapshot } from "./cleanup.js";
import type { JobsStorageCompatibility } from "./compat.js";
import type { JobsIntakeSnapshot } from "./intake.js";
import {
  jobsCapacityCheck,
  jobsCleanupCheck,
  jobsDatabaseCheck,
  jobsIntakeCheck,
  jobsLifecycleRecoveryCheck,
  jobsSweeperCheck,
  jobsWorkerCheck,
} from "./health.js";
import {
  JOBS_LIFECYCLE_RECOVERY_OVERDUE_MS,
  JOBS_RECOVERY_STALE_AFTER_MS,
  type JobsRecoverySnapshot,
} from "./recovery.js";
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
      lifecycle: { outstanding: 0, oldestPendingAt: null },
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

describe("jobsLifecycleRecoveryCheck", () => {
  const NOW = Date.parse("2026-10-16T08:00:00.000Z");

  function recovery(overrides: Partial<JobsRecoverySnapshot>): JobsRecoverySnapshot {
    return {
      started: true,
      passes: 4,
      lastPassAt: new Date(NOW - 1_000).toISOString(),
      lastOkPassAt: new Date(NOW - 1_000).toISOString(),
      reconciled: 0,
      lifecycle: { outstanding: 0, oldestPendingAt: null },
      ...overrides,
    };
  }

  test("a sweeper that is not running, or has never completed a pass, is never healthy", () => {
    const notRunning = jobsLifecycleRecoveryCheck(
      recovery({ started: false, passes: 0, lastPassAt: null, lastOkPassAt: null }),
      { nowMs: NOW },
    );
    expect(HealthCheckSchema.parse(notRunning)).toBeTruthy();
    expect(notRunning.name).toBe(JOBS_LIFECYCLE_RECOVERY_CHECK);
    expect(notRunning.status).toBe("error");
    expect(notRunning.detail).toMatch(/sweeper is not running/);

    const neverPassed = jobsLifecycleRecoveryCheck(
      recovery({ lastOkPassAt: null, passes: 3, lastPassAt: new Date(NOW).toISOString() }),
      { nowMs: NOW },
    );
    expect(neverPassed.status).toBe("error");
    expect(neverPassed.detail).toMatch(/no successful pass/);
  });

  test("a stale sweeper degrades this check too — the backlog evidence is only as fresh as its pass", () => {
    const check = jobsLifecycleRecoveryCheck(
      recovery({ lastOkPassAt: new Date(NOW - 10 * 60_000).toISOString() }),
      { nowMs: NOW },
    );
    expect(check.status).toBe("degraded");
    expect(check.detail).toMatch(/last successful pass was 600s ago/);
  });

  test("a fresh pass that measured nothing pending is ok — an empty backlog reads ok", () => {
    const check = jobsLifecycleRecoveryCheck(recovery({}), { nowMs: NOW });
    expect(check.status).toBe("ok");
    expect(check.lastSuccessAt).toBe(new Date(NOW - 1_000).toISOString());
    expect(check.metrics).toEqual({ passes: 4, reconciled: 0, outstanding: 0, oldestSeconds: 0 });
  });

  test("a fresh pass that could not have measured is an error, never a healthy guess", () => {
    // Unreachable through the loop (a fresh pass always measures); the
    // refusal of the healthy reading is the point — missing evidence never
    // reports ok.
    const check = jobsLifecycleRecoveryCheck(recovery({ lifecycle: null }), { nowMs: NOW });
    expect(check.status).toBe("error");
    expect(check.detail).toMatch(/no archive-cancellation measurement/);
  });

  test("a backlog converging inside the healthy-service bound reads ok, with the count and age visible", () => {
    const check = jobsLifecycleRecoveryCheck(
      recovery({
        lifecycle: { outstanding: 3, oldestPendingAt: new Date(NOW - 20_000).toISOString() },
      }),
      { nowMs: NOW },
    );
    expect(check.status).toBe("ok");
    expect(check.metrics).toEqual({ passes: 4, reconciled: 0, outstanding: 3, oldestSeconds: 20 });
  });

  test("pending work older than the 60-second bound degrades, carrying the outstanding count and oldest age", () => {
    const check = jobsLifecycleRecoveryCheck(
      recovery({
        lifecycle: { outstanding: 2, oldestPendingAt: new Date(NOW - 120_000).toISOString() },
      }),
      { nowMs: NOW },
    );
    expect(HealthCheckSchema.parse(check)).toBeTruthy();
    expect(check.status).toBe("degraded");
    expect(check.metrics).toEqual({ passes: 4, reconciled: 0, outstanding: 2, oldestSeconds: 120 });
    expect(check.detail).toMatch(/2 job\(s\) still active under closed generations/);
    expect(check.detail).toMatch(/oldest pending 120s/);
  });

  test("the overdue threshold is strictly-greater on the milliseconds, not the displayed seconds", () => {
    // Work aged exactly 60s is the bound's last instant of healthy
    // convergence; 60.4s is past it — and must not display as 60 and read ok
    // (the same rounding trap the delivery check's own boundary leg pins).
    const atBound = recovery({
      lifecycle: {
        outstanding: 1,
        oldestPendingAt: new Date(NOW - JOBS_LIFECYCLE_RECOVERY_OVERDUE_MS).toISOString(),
      },
    });
    expect(jobsLifecycleRecoveryCheck(atBound, { nowMs: NOW }).status).toBe("ok");
    const pastBound = recovery({
      lifecycle: {
        outstanding: 1,
        oldestPendingAt: new Date(NOW - JOBS_LIFECYCLE_RECOVERY_OVERDUE_MS - 400).toISOString(),
      },
    });
    expect(jobsLifecycleRecoveryCheck(pastBound, { nowMs: NOW }).status).toBe("degraded");
    // The degraded reading displays 60s — the raw comparison is what decided.
    expect(jobsLifecycleRecoveryCheck(pastBound, { nowMs: NOW }).metrics?.oldestSeconds).toBe(60);
    // The bound itself is the contract's 60 seconds (criterion 52) — pinned
    // as a value, not just used, so a constant drift cannot move the
    // degradation contract silently (the sweeper check pins its own the same
    // way).
    expect(JOBS_LIFECYCLE_RECOVERY_OVERDUE_MS).toBe(60_000);
  });
});

describe("jobsCleanupCheck", () => {
  const NOW = Date.parse("2026-10-16T08:00:00.000Z");

  function cleaned(overrides: Partial<JobsCleanupSnapshot>): JobsCleanupSnapshot {
    return {
      started: true,
      passes: 4,
      lastPassAt: new Date(NOW - 1_000).toISOString(),
      lastOkPassAt: new Date(NOW - 1_000).toISOString(),
      resultsRemoved: 3,
      recordsRetired: 2,
      evidence: {
        retainedServer: 12,
        unfinishedServer: 4,
        overdueResults: 0,
        overdueRecords: 0,
      },
      ...overrides,
    };
  }

  test("a loop that is not running, or has never completed a pass, is never healthy", () => {
    const notRunning = jobsCleanupCheck(
      cleaned({ started: false, passes: 0, lastPassAt: null, lastOkPassAt: null, evidence: null }),
      { nowMs: NOW },
    );
    expect(HealthCheckSchema.parse(notRunning)).toBeTruthy();
    expect(notRunning.name).toBe(JOBS_CLEANUP_CHECK);
    expect(notRunning.status).toBe("error");
    expect(notRunning.detail).toMatch(/cleanup loop is not running/);

    const neverPassed = jobsCleanupCheck(cleaned({ lastOkPassAt: null, evidence: null }), {
      nowMs: NOW,
    });
    expect(neverPassed.status).toBe("error");
    // The last pass's own instant distinguishes a loop that never ran from
    // one that runs but cannot complete a pass — the shared grader's
    // `no_pass` arm, rendered here and by the sweeper check.
    expect(neverPassed.detail).toMatch(/no successful pass — its last pass was 1s ago/);
  });

  test("a fresh pass on a store with nothing overdue is ok, with the removal counts riding the metrics", () => {
    const check = jobsCleanupCheck(cleaned({}), { nowMs: NOW });
    expect(check.status).toBe("ok");
    expect(check.lastSuccessAt).toBe(new Date(NOW - 1_000).toISOString());
    expect(check.metrics).toEqual({ passes: 4, resultsRemoved: 3, recordsRetired: 2 });
  });

  test("a last successful pass older than the staleness bound degrades — stale evidence never reads as health", () => {
    const check = jobsCleanupCheck(
      cleaned({ lastOkPassAt: new Date(NOW - 10 * 60_000).toISOString() }),
      { nowMs: NOW },
    );
    expect(check.status).toBe("degraded");
    expect(check.detail).toMatch(/last successful pass was 600s ago/);
  });

  test("content standing past its 48-hour removal deadline degrades, naming both overdue counts", () => {
    const overdue = jobsCleanupCheck(
      cleaned({
        evidence: {
          retainedServer: 12,
          unfinishedServer: 4,
          overdueResults: 7,
          overdueRecords: 2,
        },
      }),
      { nowMs: NOW },
    );
    expect(HealthCheckSchema.parse(overdue)).toBeTruthy();
    expect(overdue.status).toBe("degraded");
    expect(overdue.detail).toMatch(/7 expired result\(s\) and 2 expired job record\(s\).*48-hour/s);
  });

  test("either overdue arm alone degrades — the check grades the pair's disjunction", () => {
    // Each one-sided shape is an ordinary lag story (an expired result still
    // stored; an expired record still holding its key and runner row), and
    // either alone is overdue cleanup — a conjunction here would let one
    // arm's backlog hide behind the other's absence.
    const recordsOnly = jobsCleanupCheck(
      cleaned({
        evidence: {
          retainedServer: 12,
          unfinishedServer: 4,
          overdueResults: 0,
          overdueRecords: 3,
        },
      }),
      { nowMs: NOW },
    );
    expect(recordsOnly.status).toBe("degraded");
    expect(recordsOnly.detail).toMatch(/0 expired result\(s\) and 3 expired job record\(s\)/);

    const resultsOnly = jobsCleanupCheck(
      cleaned({
        evidence: {
          retainedServer: 12,
          unfinishedServer: 4,
          overdueResults: 5,
          overdueRecords: 0,
        },
      }),
      { nowMs: NOW },
    );
    expect(resultsOnly.status).toBe("degraded");
    expect(resultsOnly.detail).toMatch(/5 expired result\(s\) and 0 expired job record\(s\)/);
  });

  test("a last successful pass at exactly the staleness bound still reads ok — degradation begins after it", () => {
    // The threshold is strictly-greater — the shared freshness skeleton's own
    // rule (the sweeper check pins the same boundary through its own
    // surface), so a pass exactly as old as the bound is the last instant the
    // loop's own cadence can still answer for.
    const atBound = cleaned({
      lastOkPassAt: new Date(NOW - JOBS_CLEANUP_STALE_AFTER_MS).toISOString(),
    });
    expect(jobsCleanupCheck(atBound, { nowMs: NOW }).status).toBe("ok");
    const pastBound = cleaned({
      lastOkPassAt: new Date(NOW - JOBS_CLEANUP_STALE_AFTER_MS - 1).toISOString(),
    });
    expect(jobsCleanupCheck(pastBound, { nowMs: NOW }).status).toBe("degraded");
  });

  test("a fresh pass that carried no measurement is refused, never read as healthy", () => {
    // A shape the loop never writes (a successful pass always measures) — the
    // fail-closed pin: if a refactor ever produces it, the answer is error,
    // not an assumed healthy reading.
    const check = jobsCleanupCheck(cleaned({ evidence: null }), { nowMs: NOW });
    expect(check.status).toBe("error");
    expect(check.detail).toMatch(/carried no measurement/);
  });

  test("the staleness bound is the cleanup cadence's fixed multiple", () => {
    expect(JOBS_CLEANUP_STALE_AFTER_MS).toBe(3 * 60_000);
  });
});

describe("jobsCapacityCheck", () => {
  const NOW = Date.parse("2026-10-16T08:00:00.000Z");
  const LIMITS = resolveJobsCapacityLimits();

  function measured(
    retainedServer: number,
    overrides: Partial<JobsCleanupSnapshot> = {},
  ): JobsCleanupSnapshot {
    return {
      started: true,
      passes: 2,
      lastPassAt: new Date(NOW - 1_000).toISOString(),
      lastOkPassAt: new Date(NOW - 1_000).toISOString(),
      resultsRemoved: 0,
      recordsRetired: 0,
      evidence: {
        retainedServer,
        unfinishedServer: LIMITS.unfinishedPerServer, // at its cap: busy answers, not an unhealthy worker
        overdueResults: 0,
        overdueRecords: 0,
      },
      ...overrides,
    };
  }

  test("no evidence — a stopped or never-passed measurement loop — is error, never healthy", () => {
    const notRunning = jobsCapacityCheck(
      measured(0, {
        started: false,
        passes: 0,
        lastPassAt: null,
        lastOkPassAt: null,
        evidence: null,
      }),
      LIMITS,
      { nowMs: NOW },
    );
    expect(HealthCheckSchema.parse(notRunning)).toBeTruthy();
    expect(notRunning.name).toBe(JOBS_CAPACITY_CHECK);
    expect(notRunning.status).toBe("error");
    expect(notRunning.detail).toMatch(/no occupancy evidence.*not running/s);

    const neverPassed = jobsCapacityCheck(
      measured(0, { lastOkPassAt: null, evidence: null }),
      LIMITS,
      {
        nowMs: NOW,
      },
    );
    expect(neverPassed.status).toBe("error");
    expect(neverPassed.detail).toMatch(/no occupancy evidence/);
  });

  test("stale measurement evidence degrades — a saturated store must not hide behind an old pass", () => {
    const check = jobsCapacityCheck(
      measured(0, { lastOkPassAt: new Date(NOW - 10 * 60_000).toISOString() }),
      LIMITS,
      { nowMs: NOW },
    );
    expect(check.status).toBe("degraded");
    expect(check.detail).toMatch(/measurement is stale/);
  });

  test("a last successful pass at exactly the staleness bound still reads ok — the bound is the cleanup cadence's own multiple, through the check's default", () => {
    // The capacity check carries its OWN default staleness constant, and
    // every other leg here is blind to which one it is: the stale leg's
    // snapshot is ten minutes past (degraded under any bound) and the ok
    // legs' snapshots are one second old (fine under any bound). A default
    // that drifted to the recovery sweeper's 45s sibling — or to a hardcoded
    // number — would flap the check degraded at the production cadence
    // (passes every 60s, requests landing 45–60s after one) with no red leg
    // anywhere. Grading the boundary through the DEFAULT pins the constant's
    // use, the same pin the cleanup check's boundary leg carries for its own
    // default.
    const atBound = measured(0, {
      lastOkPassAt: new Date(NOW - JOBS_CLEANUP_STALE_AFTER_MS).toISOString(),
    });
    expect(jobsCapacityCheck(atBound, LIMITS, { nowMs: NOW }).status).toBe("ok");
    const pastBound = measured(0, {
      lastOkPassAt: new Date(NOW - JOBS_CLEANUP_STALE_AFTER_MS - 1).toISOString(),
    });
    expect(jobsCapacityCheck(pastBound, LIMITS, { nowMs: NOW }).status).toBe("degraded");
  });

  test("retained storage at or past the server-wide cap degrades, with the occupancy riding the metrics", () => {
    const atCap = jobsCapacityCheck(measured(LIMITS.retainedPerServer), LIMITS, { nowMs: NOW });
    expect(atCap.status).toBe("degraded");
    expect(atCap.detail).toMatch(
      new RegExp(`${LIMITS.retainedPerServer} of ${LIMITS.retainedPerServer} retained jobs`),
    );
    expect(atCap.metrics).toEqual({
      retainedServer: LIMITS.retainedPerServer,
      unfinishedServer: LIMITS.unfinishedPerServer,
    });

    const pastCap = jobsCapacityCheck(measured(LIMITS.retainedPerServer + 1), LIMITS, {
      nowMs: NOW,
    });
    expect(pastCap.status).toBe("degraded");

    const belowCap = jobsCapacityCheck(measured(LIMITS.retainedPerServer - 1), LIMITS, {
      nowMs: NOW,
    });
    expect(belowCap.status).toBe("ok");
  });

  test("the saturated arm reports its measurement's freshness instant like every other time-based arm", () => {
    // The check's own declared consistency (the same one that added
    // `lastSuccessAt` to the stale and ok arms): the saturated arm grades the
    // measurement too — a fresh one, inside the `fresh` branch — so its
    // evidence is exactly as time-based, and an operator reading a degraded
    // `jobs_capacity` needs the instant as much as the occupancy to judge how
    // old the saturation reading is. The cleanup check's degraded (overdue)
    // arm carries it; this arm must not be the one time-based-graded arm in
    // the file that drops it.
    const saturated = jobsCapacityCheck(measured(LIMITS.retainedPerServer), LIMITS, {
      nowMs: NOW,
    });
    expect(saturated.status).toBe("degraded");
    expect(saturated.lastSuccessAt).toBe(new Date(NOW - 1_000).toISOString());
    expect(HealthCheckSchema.parse(saturated)).toBeTruthy();
  });

  test("unfinished saturation alone never degrades — a busy answer is not an unhealthy worker", () => {
    // Criterion 55's distinction: ordinary unfinished-capacity refusal is a
    // routine 429; only retained saturation degrades this check.
    const check = jobsCapacityCheck(measured(0), LIMITS, { nowMs: NOW });
    expect(check.status).toBe("ok");
    expect(check.metrics?.unfinishedServer).toBe(LIMITS.unfinishedPerServer);
  });

  test("a fresh pass that carried no measurement is refused, never read as healthy", () => {
    // The same fail-closed pin the cleanup check carries: a fresh pass always
    // measures, so a refactor that ever produces this shape must read as
    // error, not as an assumed healthy occupancy.
    const check = jobsCapacityCheck(measured(0, { evidence: null }), LIMITS, { nowMs: NOW });
    expect(check.status).toBe("error");
    expect(check.detail).toMatch(/carried no measurement/);
  });
});

describe("jobsIntakeCheck", () => {
  const NOW = Date.parse("2026-10-16T08:00:00.000Z");

  function intake(overrides: Partial<JobsIntakeSnapshot>): JobsIntakeSnapshot {
    return {
      configuredAccepting: true,
      phase: "applied",
      boundServer: null,
      appliedAt: new Date(NOW - 1_000).toISOString(),
      lastAttemptAt: new Date(NOW - 1_000).toISOString(),
      ...overrides,
    };
  }

  function cleaned(overrides: Partial<JobsCleanupSnapshot> = {}): JobsCleanupSnapshot {
    return {
      started: true,
      passes: 2,
      lastPassAt: new Date(NOW - 1_000).toISOString(),
      lastOkPassAt: new Date(NOW - 1_000).toISOString(),
      resultsRemoved: 0,
      recordsRetired: 0,
      evidence: {
        retainedServer: 0,
        unfinishedServer: 0,
        overdueResults: 0,
        overdueRecords: 0,
      },
      ...overrides,
    };
  }

  test("a state not yet applied degrades — with the closed posture naming the window other replicas still admit through", () => {
    for (const phase of ["not_started", "pending"] as const) {
      const open = jobsIntakeCheck(intake({ phase, configuredAccepting: true }), cleaned(), {
        nowMs: NOW,
      });
      expect(HealthCheckSchema.parse(open), phase).toBeTruthy();
      expect(open.name, phase).toBe(JOBS_INTAKE_CHECK);
      expect(open.status, phase).toBe("degraded");
      expect(open.detail, phase).toMatch(/has not been applied to the store yet/);
      expect(open.detail, phase).not.toMatch(/other replicas/);

      const closed = jobsIntakeCheck(intake({ phase, configuredAccepting: false }), cleaned(), {
        nowMs: NOW,
      });
      expect(closed.status, phase).toBe("degraded");
      expect(closed.detail, phase).toMatch(/other replicas may still admit new work until it is/);
    }
  });

  test("a refused store is an error naming the namespace it is bound to", () => {
    const check = jobsIntakeCheck(
      intake({ phase: "refused", configuredAccepting: true, boundServer: "jobs" }),
      cleaned(),
      { nowMs: NOW },
    );
    expect(HealthCheckSchema.parse(check)).toBeTruthy();
    expect(check.status).toBe("error");
    expect(check.detail).toMatch(/bound to the "jobs" server namespace/);
    expect(check.detail).toMatch(/repoint/);
  });

  test("applied and configured open is ok with no detail", () => {
    const check = jobsIntakeCheck(intake({}), cleaned(), { nowMs: NOW });
    expect(check.status).toBe("ok");
    expect(check.detail).toBeUndefined();
  });

  test("applied and closed degrades on stale drain evidence — a closed intake must not claim a drain it cannot see", () => {
    const check = jobsIntakeCheck(
      intake({ configuredAccepting: false }),
      cleaned({ lastOkPassAt: new Date(NOW - 10 * 60_000).toISOString() }),
      { nowMs: NOW },
    );
    expect(check.status).toBe("degraded");
    expect(check.detail).toMatch(
      /drain progress is unknown — its last successful pass was 600s ago/,
    );
    expect(check.lastSuccessAt).toBe(new Date(NOW - 10 * 60_000).toISOString());
  });

  test("applied and closed degrades when the measuring loop is down or has never passed", () => {
    const notRunning = jobsIntakeCheck(
      intake({ configuredAccepting: false }),
      cleaned({ started: false, passes: 0, lastPassAt: null, lastOkPassAt: null, evidence: null }),
      { nowMs: NOW },
    );
    expect(notRunning.status).toBe("degraded");
    expect(notRunning.detail).toMatch(/drain progress is unknown.*not running/s);

    const neverPassed = jobsIntakeCheck(
      intake({ configuredAccepting: false }),
      cleaned({ lastOkPassAt: null, evidence: null }),
      { nowMs: NOW },
    );
    expect(neverPassed.status).toBe("degraded");
    expect(neverPassed.detail).toMatch(/drain progress is unknown.*no successful pass/s);
  });

  test("applied and closed reads ok with the drain counts once the measurement is fresh", () => {
    const draining = jobsIntakeCheck(
      intake({ configuredAccepting: false }),
      cleaned({
        evidence: { retainedServer: 5, unfinishedServer: 3, overdueResults: 0, overdueRecords: 0 },
      }),
      { nowMs: NOW },
    );
    expect(HealthCheckSchema.parse(draining)).toBeTruthy();
    expect(draining.status).toBe("ok");
    expect(draining.metrics).toEqual({ unfinishedServer: 3, retainedServer: 5 });
    expect(draining.detail).toMatch(/3 unfinished and 5 retained jobs remain/);
    expect(draining.detail).toMatch(/retirement is complete only when both reach zero/);
    expect(draining.lastSuccessAt).toBe(new Date(NOW - 1_000).toISOString());

    const drained = jobsIntakeCheck(intake({ configuredAccepting: false }), cleaned(), {
      nowMs: NOW,
    });
    expect(drained.status).toBe("ok");
    expect(drained.metrics).toEqual({ unfinishedServer: 0, retainedServer: 0 });
    expect(drained.detail).toMatch(/intake is closed and drained/);
  });

  test("a fresh pass that carried no measurement is refused, never read as healthy", () => {
    // The same fail-closed pin the capacity check carries: a fresh pass
    // always measures, so a refactor that ever produces this shape must read
    // as error, not as an assumed drained store.
    const check = jobsIntakeCheck(
      intake({ configuredAccepting: false }),
      cleaned({ evidence: null }),
      { nowMs: NOW },
    );
    expect(check.status).toBe("error");
    expect(check.detail).toMatch(/carried no measurement/);
  });

  test("the drain evidence's staleness bound is the cleanup cadence's own multiple, overridable for the leg", () => {
    const snapshot = cleaned({ lastOkPassAt: new Date(NOW - 30_000).toISOString() });
    expect(
      jobsIntakeCheck(intake({ configuredAccepting: false }), snapshot, { nowMs: NOW }).status,
    ).toBe("ok");
    expect(
      jobsIntakeCheck(intake({ configuredAccepting: false }), snapshot, {
        nowMs: NOW,
        staleAfterMs: 20_000,
      }).status,
    ).toBe("degraded");
    // The default is derived from the cleanup cadence constant, like the
    // capacity check's.
    expect(JOBS_CLEANUP_STALE_AFTER_MS).toBe(3 * 60_000);
  });
});
