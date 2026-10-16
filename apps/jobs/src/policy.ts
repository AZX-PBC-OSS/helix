import type { ConstructorOptions, Queue, WorkOptions } from "pg-boss";
import type { z } from "zod";

import {
  FetchJobInputSchema,
  JOB_TYPE_CATALOGUE,
  JOBS_FETCH_QUALIFIED_TYPE,
  type JobsCapacityLimits,
} from "@azx-pbc/shared";

/**
 * The installed-handler policy for the jobs runner — the one registry read by
 * both the private migration/configuration command (`src/migrate.ts`) and
 * worker registration. Every value here is platform-owned: manifests, job
 * inputs and approvals cannot set attempt limits, retry delays, execution
 * deadlines, concurrency allowances or retention periods, so they are defined
 * once, here, and every runner configuration is derived from or verified
 * against this module.
 *
 * Values come from the background-jobs design (§§1, 6, 7): one pg-boss queue
 * for the installed types, the 60-minute absolute platform deadline, the
 * fetch type's five-minute deadline with a single execution attempt, and the
 * 30-day record retention. The pg-boss dependency itself is exact-pinned in
 * the pnpm catalog (the tested PoC baseline); the compat check in
 * `src/compat.ts` reads the installed package's schema version, so a pin
 * bump is forced through that check rather than floating silently.
 */

/** The pg-boss schema the runner installs in the jobs database. */
export const JOBS_PGBOSS_SCHEMA = "pgboss";

/**
 * The schema holding the jobs service's OWN durable state — the instruction
 * burn store now, the job wrapper identity with its retry mappings as the
 * acceptance tickets land — separate from the `pgboss` schema so the runner's
 * native maintenance can never touch platform state (background-jobs-plane
 * design §8: jobs owns its wrapper tables; only the migration command owns
 * DDL here).
 */
export const JOBS_SCHEMA = "jobs";

/** The durable nonce-burn table — one row per consumed instruction `jti`, keyed by signing scope — as every SQL reference spells it. */
export const JOBS_INSTRUCTION_BURNS_QUALIFIED = `${JOBS_SCHEMA}.instruction_burns`;

/**
 * The app-lifecycle table — one row per known app, carrying the highest
 * lifecycle generation this server has durably applied and whether that
 * generation is archived (closed to new work). It is the admission/start
 * gate's authority (ADR-0007) and the serialization point every admission and
 * worker-start transaction locks against a concurrent lifecycle apply.
 */
export const JOBS_APP_LIFECYCLE_QUALIFIED = `${JOBS_SCHEMA}.app_lifecycle`;

/**
 * The job-record store — the wrapper identity a job is accepted under: its
 * immutable attribution, the lifecycle generation it was admitted under, its
 * public status projection, the optional retry key's scoped claim, and the
 * digest of the exact original input bytes. One row per accepted job; the
 * runner job it was enqueued as is joined by the row's `runner_job_id`. The
 * scoped-key unique constraint (the retry namespace) and the row's own
 * lifetime are the durable retry-identity contract (ADR-0003).
 */
export const JOBS_JOB_RECORD_QUALIFIED = `${JOBS_SCHEMA}.job_record`;

/**
 * The jobs-owned qualified table names are interpolated into SQL statements —
 * assert the bare-identifier invariant once, at the definition, so the
 * interpolation can never become a second input path (the same screen the
 * probes in `src/compat.ts` apply to the pg-boss objects).
 */
for (const table of [
  JOBS_INSTRUCTION_BURNS_QUALIFIED,
  JOBS_APP_LIFECYCLE_QUALIFIED,
  JOBS_JOB_RECORD_QUALIFIED,
]) {
  if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(table)) {
    throw new Error(
      `the jobs-owned table's qualified name is not a bare identifier pair: ${table}`,
    );
  }
}

/** The single queue all installed types run on — cross-type concurrency applies per process. */
export const JOBS_QUEUE_NAME = "jobs";

/** The role the jobs runtime connects as; the migration identity is `helix_jobs_migrate`. */
export const JOBS_RUNTIME_ROLE = "helix_jobs";

// ── Platform timing policy (design §§6–7) ────────────────────────────────────

/** The absolute job deadline, in seconds, from acceptance to a terminal outcome (60 minutes). */
export const JOBS_DEADLINE_SECONDS = 3_600;
/** The fetch type's shorter deadline, in seconds, from acceptance (five minutes). */
export const JOBS_FETCH_DEADLINE_SECONDS = 300;
/** Expected worker heartbeat, in seconds — pg-boss requires at least 10. */
export const JOBS_HEARTBEAT_SECONDS = 10;

/**
 * The platform-owned queue policy, applied by the migration command when it
 * creates the queue and verified by the startup compatibility check.
 *
 * The two retention arms of pg-boss's native deletion sweep are both closed:
 * `deleteAfterSeconds: 0` never deletes a terminal row, and
 * `retentionSeconds` (a bound on created/retry rows) is set to the largest
 * value the column holds, so native maintenance cannot prune a row ahead of
 * the jobs cleanup loop — which alone removes primary rows and their wrapper
 * identity atomically, at the 30-day record horizon. Without this, a native
 * sweep racing the cleanup loop would orphan retry mappings and silently drop
 * accepted work.
 *
 * `retryLimit: 0` is the safe default for the shared queue — a type that
 * permits automatic retries must say so in its own policy below.
 * `expireInSeconds` is the per-attempt claim bound; the queue level carries
 * the platform's absolute deadline, and each type's policy tightens it.
 */
export const JOBS_QUEUE_POLICY: Omit<Queue, "name"> = Object.freeze({
  policy: "standard",
  retryLimit: 0,
  retryDelay: 0,
  retryBackoff: false,
  expireInSeconds: JOBS_DEADLINE_SECONDS,
  retentionSeconds: 2_147_483_647,
  deleteAfterSeconds: 0,
  heartbeatSeconds: JOBS_HEARTBEAT_SECONDS,
});

/**
 * The `pgboss.queue` row the policy above must produce, derived from it so
 * the migration command's verification and the compatibility check compare
 * against one expectation. The names are the queue table's columns; the
 * values mirror pg-boss's create-queue mapping of {@link JOBS_QUEUE_POLICY}
 * (unset fields resolve to pg-boss's neutral defaults: no warning threshold,
 * no dead letter, unpartitioned).
 */
export const JOBS_QUEUE_POLICY_EFFECTIVE = Object.freeze({
  policy: JOBS_QUEUE_POLICY.policy ?? "standard",
  retry_limit: JOBS_QUEUE_POLICY.retryLimit ?? 2,
  retry_delay: JOBS_QUEUE_POLICY.retryDelay ?? 0,
  retry_backoff: JOBS_QUEUE_POLICY.retryBackoff ?? false,
  retry_delay_max: JOBS_QUEUE_POLICY.retryDelayMax ?? null,
  expire_seconds: JOBS_QUEUE_POLICY.expireInSeconds ?? 900,
  retention_seconds: JOBS_QUEUE_POLICY.retentionSeconds ?? 1_209_600,
  deletion_seconds: JOBS_QUEUE_POLICY.deleteAfterSeconds ?? 604_800,
  warning_queued: JOBS_QUEUE_POLICY.warningQueueSize ?? 0,
  dead_letter: JOBS_QUEUE_POLICY.deadLetter ?? null,
  partition: JOBS_QUEUE_POLICY.partition ?? false,
  // The policy never partitions the queue, so pg-boss stores its jobs in the
  // shared table; a partitioned queue would use a per-queue hash-named one.
  table_name: "job_common",
  heartbeat_seconds: JOBS_QUEUE_POLICY.heartbeatSeconds ?? null,
  notify: JOBS_QUEUE_POLICY.notify ?? false,
});

/**
 * The policy a send-site must pass for one installed type: its execution
 * limits and the input contract admission validates NEW work against.
 */
export interface JobsTypePolicy {
  /** Automatic retries after a failed attempt. */
  retryLimit: number;
  /** Per-attempt claim bound, in seconds. */
  expireInSeconds: number;
  /**
   * The input contract admission validates new work against, before
   * acceptance. Carried by the type's policy so the installed-type registry
   * stays exhaustive in both directions — a type cannot be installed for
   * execution without an input contract, and a catalogue type cannot exist
   * without a policy. The retry-identity comparison deliberately precedes
   * this validation (a retained key's identical bytes recover even when this
   * schema has since changed), so it serves new-work admission only.
   */
  inputSchema: z.ZodType;
}

/**
 * The policy of every installed type, keyed by qualified type. Both
 * directions are screened at import — every key must be a production
 * catalogue type, and every catalogue type must carry a policy — so
 * production registration matches the catalogue in both directions and a
 * drift fails the process at boot, not at the first send.
 */
export const JOBS_TYPE_POLICIES: Record<string, JobsTypePolicy> = Object.freeze(
  screenTypePolicies({
    // One execution attempt, no automatic outbound retry; the five-minute
    // type deadline bounds the claim (the absolute deadline machinery and the
    // 30-second outbound timeout close work earlier).
    [JOBS_FETCH_QUALIFIED_TYPE]: {
      retryLimit: 0,
      expireInSeconds: JOBS_FETCH_DEADLINE_SECONDS,
      inputSchema: FetchJobInputSchema,
    },
  }),
);

/**
 * The catalogue↔policy exhaustiveness screen, both directions — applied to
 * the registry at import, and exported because its refusals are the
 * enforcement the module-state tests pin. Each policy is frozen in place as
 * well: the outer freeze stops keys being added or replaced, not writes
 * through an inner object's reference.
 */
export function screenTypePolicies(
  policies: Record<string, JobsTypePolicy>,
): Record<string, JobsTypePolicy> {
  const catalogueIds = new Set(JOB_TYPE_CATALOGUE.map((entry) => entry.id));
  for (const id of Object.keys(policies)) {
    if (!catalogueIds.has(id)) {
      throw new Error(`an execution policy is installed for non-catalogue type "${id}"`);
    }
  }
  for (const id of catalogueIds) {
    if (!(id in policies)) {
      throw new Error(`no execution policy is installed for catalogue type "${id}"`);
    }
  }
  for (const policy of Object.values(policies)) {
    Object.freeze(policy);
  }
  return policies;
}

/**
 * The execution policy for a qualified type, as a copy — never the live
 * registry object, so a caller writing through the returned reference
 * retunes nothing but its own value. Unknown types throw: a type with no
 * installed policy is not runnable work, and this is the boundary where that
 * refusal is unavoidable and loud.
 */
export function jobTypePolicy(qualifiedType: string): JobsTypePolicy {
  const policy = (JOBS_TYPE_POLICIES as Record<string, JobsTypePolicy | undefined>)[qualifiedType];
  if (!policy) {
    throw new Error(`no execution policy is installed for job type "${qualifiedType}"`);
  }
  return { ...policy };
}

/**
 * The trusted (appId, env) pair as one runner group id — the identity a send
 * site scopes a job to and the worker's per-app/environment fairness counts
 * by. One spelling for both ends (admission's send options, the fairness
 * verification's expectations), so they cannot drift.
 */
export function jobsAppEnvGroupId(appId: string, env: string): string {
  return `${appId}:${env}`;
}

/**
 * The worker concurrency for the single queue, from the resolved capacity
 * limits: the cross-type totals per process, and the per-`group` allowance a
 * send-site scopes to the job's trusted (appId, env) pair. Read by worker
 * registration; the values are the platform's fairness defaults, never
 * app-tunable.
 *
 * The shared resolver validates each control independently, so an operator
 * override can carry a per-group allowance above the per-process total — a
 * pair pg-boss's own worker validation refuses at registration. This
 * derivation is the earliest stage that can see the pair together, so the
 * contradiction is refused here, as a platform-owned error, instead of
 * detonating later as a raw dependency assert.
 */
export function jobsWorkOptions(limits: JobsCapacityLimits): WorkOptions {
  if (limits.runningPerAppEnv > limits.runningPerWorker) {
    throw new Error(
      `the per-app/environment running limit (${limits.runningPerAppEnv}) cannot exceed ` +
        `the per-process total (${limits.runningPerWorker}) — a group allowance above ` +
        `the worker's own concurrency is unsatisfiable`,
    );
  }
  return Object.freeze({
    localConcurrency: limits.runningPerWorker,
    localGroupConcurrency: limits.runningPerAppEnv,
  });
}

// ── pg-boss constructor policy ───────────────────────────────────────────────

/** Shared by both option sets: one frozen object, so a write through a nested reference retunes nothing. */
const OPEN_TELEMETRY_DISABLED: ConstructorOptions["openTelemetry"] = Object.freeze({
  enabled: false,
});

/**
 * The runner's constructor options for the long-lived runtime instance.
 * `migrate: false` is the load-bearing decision: pg-boss runs a read-only
 * schema check at start and refuses to run against a missing or behind
 * schema, so a runtime credential can never migrate its own store — the
 * separately executed migration command owns every DDL step. Schedules are
 * off: the platform registers no cron or recurring entry point. pg-boss's
 * native OpenTelemetry stays off — the platform's signals are the hand-placed
 * ones behind the shared telemetry boundary.
 */
export function jobsRuntimeBossOptions(): ConstructorOptions {
  return Object.freeze({
    schema: JOBS_PGBOSS_SCHEMA,
    migrate: false,
    schedule: false,
    openTelemetry: OPEN_TELEMETRY_DISABLED,
  });
}

/**
 * The migration command's constructor options: pg-boss installs and migrates
 * its own schema here, and nowhere else. Consumed only by `src/migrate.ts`.
 */
export function jobsMigrationBossOptions(): ConstructorOptions {
  return Object.freeze({
    schema: JOBS_PGBOSS_SCHEMA,
    migrate: true,
    schedule: false,
    supervise: false,
    openTelemetry: OPEN_TELEMETRY_DISABLED,
  });
}
