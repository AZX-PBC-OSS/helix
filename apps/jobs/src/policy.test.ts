import { describe, expect, test } from "vitest";

import {
  FetchJobInputSchema,
  JOBS_FETCH_QUALIFIED_TYPE,
  JOB_TYPE_CATALOGUE,
  resolveJobsCapacityLimits,
} from "@azx-pbc/shared";

import {
  JOBS_APP_LIFECYCLE_QUALIFIED,
  JOBS_DEADLINE_SECONDS,
  JOBS_FETCH_DEADLINE_SECONDS,
  JOBS_HEARTBEAT_SECONDS,
  JOBS_INSTRUCTION_BURNS_QUALIFIED,
  JOBS_INTAKE_QUALIFIED,
  JOBS_JOB_RECORD_QUALIFIED,
  JOBS_PGBOSS_SCHEMA,
  JOBS_QUEUE_NAME,
  JOBS_QUEUE_POLICY,
  JOBS_QUEUE_POLICY_EFFECTIVE,
  JOBS_RECORD_TTL_SECONDS,
  JOBS_REMOVAL_GRACE_SECONDS,
  JOBS_RESULT_TTL_SECONDS,
  JOBS_TYPE_POLICIES,
  JOBS_RUNTIME_ROLE,
  JOBS_SCHEMA,
  type JobsTypePolicy,
  jobTypePolicy,
  jobsAbsoluteDeadline,
  jobsAppEnvGroupId,
  jobsMigrationBossOptions,
  jobsRuntimeBossOptions,
  jobsWorkOptions,
  screenTypePolicies,
} from "./policy.js";

describe("the installed-handler policy registry", () => {
  test("every production catalogue type carries an execution policy, and no other type does", () => {
    const catalogueIds = JOB_TYPE_CATALOGUE.map((entry) => entry.id).sort();
    const policyIds = Object.keys(JOBS_TYPE_POLICIES).sort();
    expect(policyIds).toEqual(catalogueIds);
  });

  test("the fetch type has one execution attempt and the five-minute deadline", () => {
    const policy = jobTypePolicy(JOBS_FETCH_QUALIFIED_TYPE);
    expect(policy.retryLimit).toBe(0);
    expect(policy.expireInSeconds).toBe(JOBS_FETCH_DEADLINE_SECONDS);
    // The absolute deadline is the type's own: five minutes from acceptance,
    // queue wait and retries included (spec criterion 24).
    expect(policy.deadlineSeconds).toBe(JOBS_FETCH_DEADLINE_SECONDS);
  });

  test("the absolute deadline a record answers to is the type's own, or the platform's default under registration drift", () => {
    expect(jobsAbsoluteDeadline(JOBS_FETCH_QUALIFIED_TYPE)).toBe(JOBS_FETCH_DEADLINE_SECONDS);
    expect(jobsAbsoluteDeadline("jobs:nosuchtype")).toBe(JOBS_DEADLINE_SECONDS);
  });

  test("the import-time screen refuses an absolute deadline below the type's own claim bound", () => {
    // A claim ceiling above the absolute deadline could run one attempt past
    // the type's own close; the registry is where that contradiction fails.
    expect(() =>
      screenTypePolicies({
        [JOBS_FETCH_QUALIFIED_TYPE]: {
          ...fetchPolicyFixture(),
          expireInSeconds: 300,
          deadlineSeconds: 60,
        },
      }),
    ).toThrow(/absolute deadline \(60s\) below its own per-attempt claim bound \(300s\)/);
  });

  test("an unknown type has no execution policy", () => {
    expect(() => jobTypePolicy("jobs:nosuchtype")).toThrow(
      'no execution policy is installed for job type "jobs:nosuchtype"',
    );
  });

  test("the import-time screen refuses a policy for a type the catalogue does not install", () => {
    expect(() =>
      screenTypePolicies({
        [JOBS_FETCH_QUALIFIED_TYPE]: fetchPolicyFixture(),
        "jobs:ghost": fetchPolicyFixture(),
      }),
    ).toThrow('an execution policy is installed for non-catalogue type "jobs:ghost"');
  });

  test("the import-time screen refuses a catalogue type left without a policy", () => {
    expect(() => screenTypePolicies({})).toThrow(
      /no execution policy is installed for catalogue type/,
    );
  });

  test("the queue policy never lets the runner retry or prune a row on its own", () => {
    expect(JOBS_QUEUE_POLICY.retryLimit).toBe(0);
    // pg-boss deletes terminal rows after deleteAfterSeconds and nonterminal
    // (created/retry) rows after retentionSeconds; both arms closed means the
    // jobs cleanup loop is the only deleter of primary rows.
    expect(JOBS_QUEUE_POLICY.deleteAfterSeconds).toBe(0);
    expect(JOBS_QUEUE_POLICY.retentionSeconds).toBe(2_147_483_647);
  });

  test("the queue-level claim bound is the platform's absolute deadline", () => {
    expect(JOBS_QUEUE_POLICY.expireInSeconds).toBe(JOBS_DEADLINE_SECONDS);
    // Every type policy tightens the queue-level bound, never loosens it.
    for (const policy of Object.values(JOBS_TYPE_POLICIES)) {
      expect(policy.expireInSeconds).toBeLessThanOrEqual(JOBS_DEADLINE_SECONDS);
      expect(policy.expireInSeconds).toBeGreaterThan(0);
      expect(policy.retryLimit).toBeGreaterThanOrEqual(0);
    }
  });

  test("the queue carries a heartbeat window workers must keep, at pg-boss's minimum", () => {
    expect(JOBS_QUEUE_POLICY.heartbeatSeconds).toBe(JOBS_HEARTBEAT_SECONDS);
    expect(JOBS_HEARTBEAT_SECONDS).toBeGreaterThanOrEqual(10);
  });

  test("the public-read horizons are the spec's own lifetimes — seven days for a result, thirty for the record", () => {
    // The values are the spec's (criteria 35 and 36), not derivable: the
    // horizon suites compute their boundaries FROM these constants, so a
    // drifted value would pass them while silently shortening or extending
    // the contract's lifetimes.
    expect(JOBS_RESULT_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(JOBS_RECORD_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
    // The physical-removal bound is the third constant of the same kind: the
    // cleanup suites compute their overdue boundaries FROM it, so a drifted
    // value would pass them while silently moving the 48-hour deadline the
    // `jobs_cleanup` check and the design both speak of.
    expect(JOBS_REMOVAL_GRACE_SECONDS).toBe(48 * 60 * 60);
  });

  test("the expected effective queue row is derived from the policy, not restated", () => {
    expect(JOBS_QUEUE_POLICY_EFFECTIVE).toEqual({
      policy: JOBS_QUEUE_POLICY.policy,
      retry_limit: JOBS_QUEUE_POLICY.retryLimit,
      retry_delay: JOBS_QUEUE_POLICY.retryDelay,
      retry_backoff: JOBS_QUEUE_POLICY.retryBackoff,
      retry_delay_max: null,
      expire_seconds: JOBS_QUEUE_POLICY.expireInSeconds,
      retention_seconds: JOBS_QUEUE_POLICY.retentionSeconds,
      deletion_seconds: JOBS_QUEUE_POLICY.deleteAfterSeconds,
      warning_queued: 0,
      dead_letter: null,
      partition: false,
      table_name: "job_common",
      heartbeat_seconds: JOBS_QUEUE_POLICY.heartbeatSeconds,
      notify: false,
    });
  });

  test("worker concurrency comes from the resolved capacity limits, not a second copy of the numbers", () => {
    const resolved = resolveJobsCapacityLimits();
    expect(jobsWorkOptions(resolved)).toEqual({
      localConcurrency: resolved.runningPerWorker,
      localGroupConcurrency: resolved.runningPerAppEnv,
    });
    expect(jobsWorkOptions(resolved)).toEqual({ localConcurrency: 8, localGroupConcurrency: 2 });

    const tuned = jobsWorkOptions(resolveJobsCapacityLimits({ runningPerWorker: 4 }));
    expect(tuned).toEqual({
      localConcurrency: 4,
      localGroupConcurrency: resolveJobsCapacityLimits().runningPerAppEnv,
    });
  });

  test("the contradictory-limit refusal carries both numbers, so the boot failure names its cause", () => {
    // The resolver refuses the pair at boot; the derivation's own guard is
    // what a HAND-BUILT limit set (bypassing the resolver) meets. The
    // refusal names the controls as the operator's configuration spells
    // them, and the numbers identify the occurrence; the wording is free.
    const contradictory = {
      ...resolveJobsCapacityLimits(),
      runningPerWorker: 1,
      runningPerAppEnv: 2,
    };
    expect(() => jobsWorkOptions(contradictory)).toThrow(/\(2\).*\(1\)/);
  });

  test("writes through the exported registry and the derived worker options retune nothing", () => {
    // The registry is the platform's override surface: every line in the
    // runtime process can import these objects, so a replaced key, a mutated
    // policy value, or a retuned concurrency option must refuse at the write.
    expect(() => {
      (JOBS_TYPE_POLICIES as Record<string, JobsTypePolicy>)["jobs:ghost"] = fetchPolicyFixture();
    }).toThrow();
    expect(() => {
      (JOBS_TYPE_POLICIES[JOBS_FETCH_QUALIFIED_TYPE] as { retryLimit: number }).retryLimit = 99;
    }).toThrow();
    const options = jobsWorkOptions(resolveJobsCapacityLimits());
    expect(() => {
      (options as { localConcurrency: number }).localConcurrency = 99;
    }).toThrow();
    // The attempted writes left the platform policy exactly as installed.
    expect(Object.keys(JOBS_TYPE_POLICIES)).toEqual([JOBS_FETCH_QUALIFIED_TYPE]);
    expect(jobTypePolicy(JOBS_FETCH_QUALIFIED_TYPE)).toEqual({
      retryLimit: 0,
      expireInSeconds: JOBS_FETCH_DEADLINE_SECONDS,
      deadlineSeconds: JOBS_FETCH_DEADLINE_SECONDS,
      inputSchema: expect.anything(),
    });
  });
});

/** A policy fixture for the screen's refusals — the shape, not a second copy of the platform values. */
function fetchPolicyFixture(): JobsTypePolicy {
  return {
    retryLimit: 0,
    expireInSeconds: 60,
    deadlineSeconds: 60,
    inputSchema: FetchJobInputSchema,
  };
}

describe("the runner's pg-boss constructor policy", () => {
  test("the runtime never migrates, never schedules, and never auto-instruments", () => {
    const options = jobsRuntimeBossOptions();
    expect(options.migrate).toBe(false);
    expect(options.schedule).toBe(false);
    expect(options.openTelemetry).toEqual({ enabled: false });
    expect(options.schema).toBe(JOBS_PGBOSS_SCHEMA);
    // No `supervise` key on purpose: pg-boss defaults supervision on, and the
    // supervision pass is what runs the expiration and worker-loss machinery
    // the heartbeat window exists for — a pinned `supervise: false` here
    // would stand that machinery down silently.
    expect(options.supervise).toBeUndefined();
  });

  test("the supervision cadence is pinned to the heartbeat, below the dependency's own 60-second defaults", () => {
    // The supervise pass runs the expiry and heartbeat-failure arms, gated
    // per queue by the monitor interval; at the dependency's own 60-second
    // supervise/monitor defaults, detection alone could exceed the 60-second
    // healthy-service bound before any reconciliation ran. The cadence is
    // the recovery bound's first half — worker loss is detected within
    // roughly one missed heartbeat. (The dependency's hour-scale default is
    // its deletion arm's interval, which this platform disables outright.)
    const options = jobsRuntimeBossOptions();
    expect(options.superviseIntervalSeconds).toBe(JOBS_HEARTBEAT_SECONDS);
    expect(options.monitorIntervalSeconds).toBe(JOBS_HEARTBEAT_SECONDS);
  });

  test("the migration command is the one configuration that migrates", () => {
    const options = jobsMigrationBossOptions();
    expect(options.migrate).toBe(true);
    expect(options.supervise).toBe(false);
    expect(options.schedule).toBe(false);
    expect(options.openTelemetry).toEqual({ enabled: false });
  });

  test("a write through the constructor options' nested reference retunes nothing", () => {
    // The same mutation class the registry's own exports were hardened
    // against: the outer freeze stops key replacement, not writes through the
    // nested openTelemetry object's reference.
    const options = jobsRuntimeBossOptions();
    expect(() => {
      (options.openTelemetry as { enabled: boolean }).enabled = true;
    }).toThrow();
    expect(jobsRuntimeBossOptions().openTelemetry).toEqual({ enabled: false });
    // The migration set carries the same disabled posture: its own nested
    // reference refuses the write too. The outcome is the contract for both
    // sets — how the frozen objects come to exist is not.
    const migrationOptions = jobsMigrationBossOptions();
    expect(() => {
      (migrationOptions.openTelemetry as { enabled: boolean }).enabled = true;
    }).toThrow();
    expect(jobsMigrationBossOptions().openTelemetry).toEqual({ enabled: false });
  });

  test("the pg-boss schema and queue names are the platform constants", () => {
    expect(JOBS_PGBOSS_SCHEMA).toBe("pgboss");
    expect(JOBS_QUEUE_NAME).toBe("jobs");
    expect(JOBS_RUNTIME_ROLE).toBe("helix_jobs");
  });

  test("the instruction burn table's qualified name is the jobs schema's own — the identifier every SQL statement interpolates", () => {
    // The burn table's name rides into `burns.ts`'s INSERT and the sweep's
    // DELETE by interpolation, and the migration and compat probes spell the
    // same pair — one rename must move them together, and the value is the
    // bare-identifier pair the module's own load guard demands.
    expect(JOBS_SCHEMA).toBe("jobs");
    expect(JOBS_INSTRUCTION_BURNS_QUALIFIED).toBe("jobs.instruction_burns");
  });

  test("the app-lifecycle table's qualified name is the jobs schema's own — the identifier every gate and apply interpolates", () => {
    // The lifecycle table's name rides into the store's apply, the gate's
    // FOR UPDATE read, the compat probes and the migration's DDL by
    // interpolation — one rename must move them together, under the same
    // bare-identifier load guard as the burn table's.
    expect(JOBS_SCHEMA).toBe("jobs");
    expect(JOBS_APP_LIFECYCLE_QUALIFIED).toBe("jobs.app_lifecycle");
  });

  test("the job-record table's qualified name is the jobs schema's own — the identifier every acceptance statement interpolates", () => {
    // The record table's name rides into the acceptance transaction's lookup
    // and insert, the compat probes and the migration's DDL by interpolation
    // — one rename must move them together, under the same bare-identifier
    // load guard as the other stores'.
    expect(JOBS_SCHEMA).toBe("jobs");
    expect(JOBS_JOB_RECORD_QUALIFIED).toBe("jobs.job_record");
  });

  test("the intake table's qualified name is the jobs schema's own — the identifier the gate, the apply and the migration interpolate", () => {
    // The intake table's name rides into the admission gate's read, the
    // applier's transaction, the compat probes and the migration's DDL by
    // interpolation — one rename must move them together, under the same
    // bare-identifier load guard as the other stores'.
    expect(JOBS_SCHEMA).toBe("jobs");
    expect(JOBS_INTAKE_QUALIFIED).toBe("jobs.intake");
  });

  test("every installed type's policy carries the input contract admission validates new work against", () => {
    // The input schema rides the policy registry so a type cannot be
    // installed for execution without one; the fetch type's is the shared
    // wire contract's.
    for (const policy of Object.values(JOBS_TYPE_POLICIES)) {
      expect(policy.inputSchema).toBeDefined();
    }
    expect(jobTypePolicy(JOBS_FETCH_QUALIFIED_TYPE).inputSchema).toBe(FetchJobInputSchema);
  });

  test("the runner fairness group id is the trusted (appId, env) pair, spelled once", () => {
    expect(jobsAppEnvGroupId("0b9e8c3e-6f2a-4c9b-9e1f-2a4b6c8d0e2f", "prod")).toBe(
      "0b9e8c3e-6f2a-4c9b-9e1f-2a4b6c8d0e2f:prod",
    );
  });
});
