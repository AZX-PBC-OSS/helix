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
  test("a limit pair no worker can satisfy is refused at the resolver, before any caller sees it", () => {
    // `runningPerAppEnv` and `runningPerWorker` are validated independently by
    // the shared schema, so a deployment map carrying runningPerAppEnv >
    // runningPerWorker is a contradiction only a seam that sees the pair
    // together can refuse. The resolver is that seam — the derivation's first
    // production caller sits inside the runner's retry loop, which exists for
    // TRANSIENT store unavailability and can never converge on a
    // configuration fault — so the refusal lives at resolve time (boot),
    // where configuration failures belong, and the derivation re-runs the
    // same shared refusal only as the guard for hand-built limit sets that
    // bypassed the resolver.
    expect(() => resolveJobsCapacityLimits({ runningPerWorker: 1, runningPerAppEnv: 2 })).toThrow(
      /runningPerAppEnv/,
    );
    // A hand-built pair that bypassed the resolver still cannot become worker
    // options: the derivation runs the same shared refusal.
    expect(() =>
      jobsWorkOptions({ ...resolveJobsCapacityLimits(), runningPerAppEnv: 4, runningPerWorker: 2 }),
    ).toThrow(/unsatisfiable/);
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
