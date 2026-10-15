import { describe, expect, test } from "vitest";

import { JOBS_FETCH_QUALIFIED_TYPE, resolveJobsCapacityLimits } from "@azx-pbc/shared";

import {
  JOBS_FETCH_DEADLINE_SECONDS,
  JOBS_TYPE_POLICIES,
  jobTypePolicy,
  jobsWorkOptions,
} from "./policy.js";

/**
 * Adversarial attacks on the installed-handler policy registry — misuse the
 * type system allows, aimed at specific assumptions the module makes.
 */

describe("the worker-options derivation under hostile limits", () => {
  test("a limit pair the shared resolver accepts but pg-boss rejects cannot become worker options", () => {
    // `runningPerAppEnv` and `runningPerWorker` are validated independently by
    // the shared schema, so a deployment map carrying runningPerAppEnv >
    // runningPerWorker resolves cleanly. The derivation forwards the pair
    // straight into pg-boss WorkOptions, whose own worker validation refuses
    // localGroupConcurrency above localConcurrency — the combination can only
    // detonate later, at worker registration, as a dependency assert. The
    // platform's derivation seam is the earliest stage that can catch it.
    const contradictory = resolveJobsCapacityLimits({ runningPerWorker: 1, runningPerAppEnv: 2 });
    expect(contradictory).toEqual({ ...contradictory, runningPerWorker: 1, runningPerAppEnv: 2 });
    expect(() => jobsWorkOptions(contradictory)).toThrow();
  });

  test("the boundary case itself — equal limits — stays derivable", () => {
    const equal = resolveJobsCapacityLimits({ runningPerWorker: 2, runningPerAppEnv: 2 });
    expect(jobsWorkOptions(equal)).toEqual({ localConcurrency: 2, localGroupConcurrency: 2 });
  });
});

describe("the type-policy registry's immutability", () => {
  test("mutation through jobTypePolicy's returned reference does not retune the platform policy", () => {
    // Every other export in the module is frozen; the per-type policy values
    // are handed out by reference. A caller that writes through the returned
    // object would retune the platform's attempt/deadline policy in place —
    // the override surface the registry exists to close.
    const policy = jobTypePolicy(JOBS_FETCH_QUALIFIED_TYPE);
    policy.retryLimit = 99;
    policy.expireInSeconds = 999_999;

    expect(jobTypePolicy(JOBS_FETCH_QUALIFIED_TYPE).retryLimit).toBe(0);
    expect(jobTypePolicy(JOBS_FETCH_QUALIFIED_TYPE).expireInSeconds).toBe(
      JOBS_FETCH_DEADLINE_SECONDS,
    );
    expect(Object.values(JOBS_TYPE_POLICIES)[0]?.retryLimit).toBe(0);
  });
});
