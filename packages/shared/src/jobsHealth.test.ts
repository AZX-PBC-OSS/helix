import { describe, expect, it } from "vitest";

import {
  JOBS_CAPACITY_CHECK,
  JOBS_CLEANUP_CHECK,
  JOBS_DATABASE_CHECK,
  JOBS_HEALTH_CHECK_NAMES,
  JOBS_LIFECYCLE_DELIVERY_CHECK,
  JOBS_LIFECYCLE_RECOVERY_CHECK,
  JOBS_REACHABILITY_CHECK,
  JOBS_SWEEPER_CHECK,
  JOBS_WORKER_CHECK,
} from "./jobsHealth.js";

describe("the jobs health-check vocabulary", () => {
  it("carries the eight ADR-0009 names, spelled exactly as the architecture fixes them", () => {
    expect(JOBS_HEALTH_CHECK_NAMES).toEqual([
      "jobs_database",
      "jobs_worker",
      "jobs_sweeper",
      "jobs_reachability",
      "jobs_capacity",
      "jobs_lifecycle_delivery",
      "jobs_lifecycle_recovery",
      "jobs_cleanup",
    ]);
  });

  it("keeps every individual constant inside the bounded set", () => {
    const names = [
      JOBS_DATABASE_CHECK,
      JOBS_WORKER_CHECK,
      JOBS_SWEEPER_CHECK,
      JOBS_REACHABILITY_CHECK,
      JOBS_CAPACITY_CHECK,
      JOBS_LIFECYCLE_DELIVERY_CHECK,
      JOBS_LIFECYCLE_RECOVERY_CHECK,
      JOBS_CLEANUP_CHECK,
    ];
    for (const name of names) {
      expect((JOBS_HEALTH_CHECK_NAMES as readonly string[]).includes(name)).toBe(true);
    }
    expect(new Set(names).size).toBe(JOBS_HEALTH_CHECK_NAMES.length);
  });
});
