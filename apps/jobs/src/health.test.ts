import { describe, expect, test } from "vitest";

import { HealthCheckSchema, JOBS_DATABASE_CHECK } from "@azx-pbc/shared";

import type { JobsStorageCompatibility } from "./compat.js";
import { jobsDatabaseCheck } from "./health.js";
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
