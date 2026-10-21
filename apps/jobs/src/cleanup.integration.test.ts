import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { resolveJobsCapacityLimits, type JobsCapacityLimits } from "@azx-pbc/shared";
import {
  ATTR_JOBS_CLEANUP_RECORDS_RETIRED,
  ATTR_JOBS_CLEANUP_RESULTS_REMOVED,
  ATTR_OUTCOME,
  INSTR_JOBS_CLEANUPS,
  SPAN_JOBS_CLEANUP,
} from "@azx-pbc/shared/telemetry";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";

import {
  createPgbossEnqueuer,
  JobsAcceptanceStore,
  type JobsAdmissionResult,
} from "./acceptance.js";
import { JobsCleanup, type JobsCleanupSnapshot } from "./cleanup.js";
import { jobsCapacityCheck, jobsCleanupCheck } from "./health.js";
import { JobsLifecycleStore } from "./lifecycle.js";
import { migrateJobsStorage } from "./migrate.js";
import { JobsObservationStore } from "./observation.js";
import {
  JOBS_JOB_RECORD_QUALIFIED,
  JOBS_PGBOSS_SCHEMA,
  JOBS_QUEUE_NAME,
  JOBS_REMOVAL_GRACE_SECONDS,
  JOBS_RESULT_TTL_SECONDS,
  JOBS_RUNTIME_ROLE,
  jobsRuntimeBossOptions,
} from "./policy.js";
import { deleteRunnerJobs, type JobsRunnerDeleter } from "./runner.js";
import { applyRolesProvisioning } from "../../portal/src/test/provisionDatabases.js";
import { recordReadClaims, submitClaims, TEST_BODY, TEST_IDENTITY } from "./test/instructions.js";

/**
 * The retention contract's physical half against the real store, the real
 * runner and the real role split: the result arm's removal at the seven-day
 * horizon, the record arm's ATOMIC retirement of the primary record together
 * with its runner row and retry-key mapping at the thirty-day horizon, the
 * active work that age never prunes, the key-release and replacement-job
 * interleavings criterion 14 binds, and the overdue/saturation evidence the
 * `jobs_cleanup` and `jobs_capacity` health checks grade (criteria 20, 35,
 * 36, 55). The logical horizons' projection and its readers are pinned in
 * `observation.integration.test.ts` and `acceptance.integration.test.ts`;
 * these legs prove the physical removal those suites deliberately do not
 * perform.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

const SCRATCH_DB = `helix_jobs_clean_${randomUUID().replaceAll("-", "")}`;

function urlFor(database: string, role?: string): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  if (role) {
    url.username = role;
    url.password = role;
  }
  return url.toString();
}

const RUNTIME_DSN = urlFor(SCRATCH_DB, JOBS_RUNTIME_ROLE);

const LOG = { info: () => {}, warn: () => {}, error: () => {} };

/** Bounded wait for a state the machinery's own start produces. */
async function waitFor(what: string, probe: () => boolean): Promise<void> {
  const by = Date.now() + 45_000;
  while (Date.now() < by) {
    if (probe()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const LIMITS = resolveJobsCapacityLimits();

/** Far outside every arm's reach — a queued runner row no pass may touch. */
const PARKED_START_AFTER_SECONDS = 3_600;

const BODY = new TextEncoder().encode(TEST_BODY);
const OTHER_BODY = new TextEncoder().encode('{"url":"https://example.com/other.json"}');

let boss: PgBoss;
let cleanup: JobsCleanup;
let admission: JobsAcceptanceStore;
let lifecycle: JobsLifecycleStore;
let observation: JobsObservationStore;
let direct: Pool;

beforeAll(async () => {
  await applyRolesProvisioning(SCRATCH_DB);
  await migrateJobsStorage(urlFor(SCRATCH_DB, "helix_jobs_migrate"));
  boss = new PgBoss({ connectionString: RUNTIME_DSN, ...jobsRuntimeBossOptions() });
  await boss.start();
  lifecycle = new JobsLifecycleStore({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    log: LOG,
  });
  lifecycle.start();
  admission = new JobsAcceptanceStore({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    limits: LIMITS,
    accepting: true,
    enqueuer: createPgbossEnqueuer(boss),
    log: LOG,
  });
  admission.start();
  observation = new JobsObservationStore({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    log: LOG,
  });
  observation.start();
  // The cadence is test-driven (every pass below is explicit); the runner
  // deletes ride the same adapter call the composition's runner getter
  // delegates to — one spelling, so the retirement cannot drift from it.
  cleanup = new JobsCleanup({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    deleteRunnerRows: {
      delete: (withinTx, runnerJobIds) => deleteRunnerJobs(boss, withinTx, runnerJobIds),
    },
    intervalMs: 3_600_000,
    log: LOG,
  });
  cleanup.start();
  // The start's own immediate pass must be settled before the legs: a pass
  // coalesces into an in-flight one, so a leg driving `runPass` while the
  // first pass was still open would never run its own.
  await waitFor("the first cleanup pass to complete", () => cleanup.snapshot().passes >= 1);
  direct = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
}, 60_000);

afterAll(async () => {
  await direct.end();
  await cleanup.stop();
  await observation.stop();
  await admission.stop();
  await lifecycle.stop();
  await boss.stop({ graceful: true, timeout: 5_000 }).catch(() => {});
  const pool = new Pool({ connectionString: urlFor("postgres"), max: 1 });
  await pool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
  await pool.end();
}, 30_000);

/** Each test's own app — the uuid the identity schemas accept, disjoint per leg. */
function anApp(): string {
  return randomUUID();
}

/** One runner row enqueued the way admission does, with its wrapper record seeded behind it. */
async function seedJob(appId: string, retryKey: string | null = null): Promise<string> {
  const runnerJobId = await boss.send(
    JOBS_QUEUE_NAME,
    { url: "https://example.com/data.json" },
    {
      retryLimit: 0,
      expireInSeconds: 300,
      startAfter: PARKED_START_AFTER_SECONDS,
      group: { id: `${appId}:prod` },
    },
  );
  if (runnerJobId === null) throw new Error("the seeded runner job was not enqueued");
  const jobId = randomUUID();
  await direct.query(
    `INSERT INTO ${JOBS_JOB_RECORD_QUALIFIED}
       (server, job_id, runner_job_id, app_id, env, owner_kind, owner_oid, type,
        generation, status, retry_key, body_sha256, created_at)
     VALUES ($1, $2, $3, $4, 'prod', $5, $6, 'jobs:fetch', '1', 'queued', $7, $8, $9)`,
    [
      "jobs",
      jobId,
      runnerJobId,
      appId,
      TEST_IDENTITY.ownerKind,
      TEST_IDENTITY.ownerOid,
      retryKey,
      "seed-digest",
      new Date().toISOString(),
    ],
  );
  return jobId;
}

/**
 * Force one seeded record to a terminal outcome with its instant backdated —
 * the way elapsed time actually reaches the horizons' input. The result is
 * only legal on a row projecting success; the error code must be the stored
 * vocabulary or null.
 */
async function forceTerminal(
  jobId: string,
  status: "succeeded" | "failed" | "crashed" | "cancelled" | "expired",
  secondsAgo: number,
  result: string | null = null,
): Promise<void> {
  const errorCode =
    status === "failed"
      ? "upstream_error"
      : status === "crashed"
        ? "platform_error"
        : status === "cancelled"
          ? "cancelled"
          : null;
  await direct.query(
    `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
        SET status = $2, error_code = $3, result = $4,
            terminal_at = now() - ($5 * interval '1 second')
      WHERE job_id = $1`,
    [jobId, status, errorCode, result, secondsAgo],
  );
}

/** The wrapper record of one job, or null once the record arm has removed it. */
async function recordOf(jobId: string): Promise<Record<string, unknown> | null> {
  const result = await direct.query<Record<string, unknown>>(
    `SELECT * FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE job_id = $1`,
    [jobId],
  );
  return result.rows[0] ?? null;
}

/** The runner row one record was accepted under, by the id the record stored. */
async function runnerRowOf(jobId: string): Promise<Record<string, unknown> | null> {
  const record = await recordOf(jobId);
  const runnerJobId = record?.runner_job_id as string | undefined;
  if (runnerJobId === undefined) return null;
  // The wrapper stores the runner id as bounded opaque text; the runner's
  // own column is a uuid — the join casts, as every reader of the pair does.
  const result = await direct.query<Record<string, unknown>>(
    `SELECT * FROM ${JOBS_PGBOSS_SCHEMA}.job WHERE id = $1::uuid`,
    [runnerJobId],
  );
  return result.rows[0] ?? null;
}

/** One explicit pass, and the snapshot it left. */
async function runPass(): Promise<JobsCleanupSnapshot> {
  await cleanup.runPass();
  return cleanup.snapshot();
}

/**
 * A cleanup loop over the shared scratch store whose cadence never fires —
 * every pass is the caller's — started, with its own immediate first pass
 * settled, so the leg's passes are its own.
 */
async function drivenLoop(options: {
  deleteRunnerRows: JobsRunnerDeleter;
  batch?: number;
}): Promise<{ loop: JobsCleanup; settle: () => Promise<JobsCleanupSnapshot> }> {
  const loop = new JobsCleanup({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    intervalMs: 3_600_000,
    ...(options.batch !== undefined ? { batch: options.batch } : {}),
    deleteRunnerRows: options.deleteRunnerRows,
    log: LOG,
  });
  loop.start();
  await loop.runPass(); // settle start()'s own immediate pass
  return {
    loop,
    settle: async () => {
      await loop.runPass();
      return loop.snapshot();
    },
  };
}

/** A keyed submission through the real acceptance transaction, over this file's fixed identity. */
async function submitKeyed(
  appId: string,
  retryKey: string,
  body: Uint8Array = BODY,
): Promise<JobsAdmissionResult> {
  return admission.admit({
    claims: submitClaims({
      generation: "1",
      idempotencyKey: retryKey,
      identity: { ...TEST_IDENTITY, appId },
    }),
    body,
  });
}

/** The owner-scoped reads for one job under the leg's own app identity. */
function readsFor(appId: string, jobId: string) {
  return {
    snapshot: () =>
      observation.snapshot({
        claims: recordReadClaims("snapshot", {
          jobId,
          identity: { ...TEST_IDENTITY, appId },
        }),
        jobId,
      }),
    result: () =>
      observation.result({
        claims: recordReadClaims("result", {
          jobId,
          identity: { ...TEST_IDENTITY, appId },
        }),
        jobId,
      }),
  };
}

describe("the result arm", () => {
  test(
    "a successful result past its seven days is removed from live storage, and the record stays readable as expired",
    { timeout: 30_000 },
    async () => {
      const appId = anApp();
      const jobId = await seedJob(appId);
      await forceTerminal(jobId, "succeeded", JOBS_RESULT_TTL_SECONDS + 7_200, '{"kept":true}');

      const snapshot = await runPass();
      expect(snapshot.resultsRemoved).toBeGreaterThanOrEqual(1);

      const row = await recordOf(jobId);
      expect(row).not.toBeNull();
      expect(row?.status).toBe("expired");
      expect(row?.result).toBeNull();
      // The record itself is untouched: publicly readable as `expired`
      // through the observation seam, with the result read answering the
      // expiry — however the removal lagged behind the logical boundary.
      const reads = readsFor(appId, jobId);
      const snapshotVerdict = await reads.snapshot();
      expect(snapshotVerdict.outcome).toBe("found");
      if (snapshotVerdict.outcome === "found") {
        expect(snapshotVerdict.snapshot.status).toBe("expired");
        expect(snapshotVerdict.snapshot.recordExpiresAt).toEqual(expect.any(String));
      }
      expect(await reads.result()).toMatchObject({ outcome: "expired" });
    },
  );

  test(
    "a result inside its seven days is untouched — expiry is the boundary, not the pass",
    { timeout: 30_000 },
    async () => {
      const appId = anApp();
      const jobId = await seedJob(appId);
      await forceTerminal(jobId, "succeeded", JOBS_RESULT_TTL_SECONDS - 7_200, '{"fresh":true}');

      await runPass();

      const row = await recordOf(jobId);
      expect(row?.status).toBe("succeeded");
      expect(row?.result).toBe('{"fresh":true}');
      const reads = readsFor(appId, jobId);
      expect(await reads.result()).toMatchObject({
        outcome: "found",
        resultText: '{"fresh":true}',
      });
    },
  );
});

describe("the record arm", () => {
  test(
    "every terminal outcome past its thirty days is retired with its runner row in one pass — the same retention for all of them",
    { timeout: 30_000 },
    async () => {
      const pastRecordHorizon = 30 * 24 * 60 * 60 + 7_200;
      const seeds = [] as Array<{ status: string; jobId: string }>;
      for (const [status, result] of [
        ["succeeded", '{"gone":true}'],
        ["failed", null],
        ["crashed", null],
        ["cancelled", null],
        ["expired", null],
      ] as const) {
        const jobId = await seedJob(anApp());
        await forceTerminal(jobId, status, pastRecordHorizon, result);
        expect(await runnerRowOf(jobId)).not.toBeNull();
        seeds.push({ status, jobId });
      }

      const snapshot = await runPass();
      expect(snapshot.recordsRetired).toBeGreaterThanOrEqual(seeds.length);

      for (const seed of seeds) {
        expect(await recordOf(seed.jobId), `record status ${seed.status}`).toBeNull();
        expect(await runnerRowOf(seed.jobId), `runner row for ${seed.status}`).toBeNull();
      }
    },
  );

  test(
    "a terminal record inside its thirty days is untouched — retirement is the boundary, not the pass",
    { timeout: 30_000 },
    async () => {
      const appId = anApp();
      const jobId = await seedJob(appId);
      await forceTerminal(jobId, "failed", 29 * 24 * 60 * 60);

      await runPass();

      const row = await recordOf(jobId);
      expect(row?.status).toBe("failed");
      expect(await runnerRowOf(jobId)).not.toBeNull();
    },
  );

  test(
    "active work is never pruned by age — a queued record with no terminal instant survives every arm",
    { timeout: 30_000 },
    async () => {
      const appId = anApp();
      const jobId = await seedJob(appId);
      // Even a created_at ancient past every horizon: the arms select on the
      // record's terminal instant, and a non-terminal record has none.
      await direct.query(
        `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
            SET created_at = now() - ($2 * interval '1 second')
          WHERE job_id = $1`,
        [jobId, 100 * 24 * 60 * 60],
      );

      await runPass();

      const row = await recordOf(jobId);
      expect(row?.status).toBe("queued");
      expect(await runnerRowOf(jobId)).not.toBeNull();
    },
  );

  test(
    "the retired runner row's stored input leaves the queue with the record — asserted by id, not through the record's pointer",
    { timeout: 30_000 },
    async () => {
      const appId = anApp();
      const jobId = await seedJob(appId);
      await forceTerminal(jobId, "failed", 31 * 24 * 60 * 60);
      // The runner id is captured BEFORE retirement: once the record is gone,
      // the record's own pointer cannot name the row — a lookup through it
      // would answer null regardless of whether the queue row survived.
      const record = await recordOf(jobId);
      const runnerJobId = record?.runner_job_id as string;
      const before = await direct.query(
        `SELECT id FROM ${JOBS_PGBOSS_SCHEMA}.job WHERE id::text = $1`,
        [runnerJobId],
      );
      expect(before.rows).toHaveLength(1);

      await runPass();

      expect(await recordOf(jobId)).toBeNull();
      const after = await direct.query(
        `SELECT id, state FROM ${JOBS_PGBOSS_SCHEMA}.job WHERE id::text = $1`,
        [runnerJobId],
      );
      expect(after.rows).toHaveLength(0);
    },
  );

  test(
    "a retired record reads exactly as an unknown one — physical retirement extends no public access",
    { timeout: 30_000 },
    async () => {
      const appId = anApp();
      const jobId = await seedJob(appId);
      await forceTerminal(jobId, "succeeded", 31 * 24 * 60 * 60, '{"retired":true}');

      await runPass();

      // Both owner reads answer the same 404-shaped verdict a job that never
      // existed answers — no status leaks past the removal, and neither read
      // throws for a row that is no longer there.
      const reads = readsFor(appId, jobId);
      expect(await reads.snapshot()).toMatchObject({ outcome: "not_found" });
      expect(await reads.result()).toMatchObject({ outcome: "not_found" });
      expect(await recordOf(jobId)).toBeNull();
    },
  );
});

describe("the retirement is atomic", () => {
  test(
    "a runner delete that cannot answer rolls the record retirement back — no half-retired job",
    { timeout: 30_000 },
    async () => {
      const { loop, settle } = await drivenLoop({
        deleteRunnerRows: {
          delete: async () => {
            throw new Error("injected runner-delete failure");
          },
        },
      });
      try {
        const appId = anApp();
        const jobId = await seedJob(appId);
        await forceTerminal(jobId, "failed", 31 * 24 * 60 * 60);

        await settle();

        // The pass failed, and NOTHING was retired: the wrapper record — and
        // the retry key it holds — are still in place, together with the
        // runner row they were accepted under.
        expect(loop.snapshot().lastPassAt).not.toBeNull();
        const row = await recordOf(jobId);
        expect(row?.status).toBe("failed");
        expect(await runnerRowOf(jobId)).not.toBeNull();

        // The real loop's next pass retires the whole unit.
        const snapshot = await runPass();
        expect(snapshot.recordsRetired).toBeGreaterThanOrEqual(1);
        expect(await recordOf(jobId)).toBeNull();
        expect(await runnerRowOf(jobId)).toBeNull();
      } finally {
        await loop.stop();
      }
    },
  );

  test(
    "a pass whose record arm fails still counts the results its committed result arm removed",
    { timeout: 30_000 },
    async () => {
      const { loop, settle } = await drivenLoop({
        deleteRunnerRows: {
          delete: async () => {
            throw new Error("injected runner-delete failure");
          },
        },
      });
      try {
        const appId = anApp();
        const resultJobId = await seedJob(appId);
        await forceTerminal(
          resultJobId,
          "succeeded",
          JOBS_RESULT_TTL_SECONDS + 7_200,
          '{"removed":true}',
        );
        const recordJobId = await seedJob(appId);
        await forceTerminal(recordJobId, "failed", 31 * 24 * 60 * 60);
        const before = loop.snapshot();

        const after = await settle();

        // The pass failed on the runner delete, after the result arm's own
        // statement committed: the bytes are gone, and the snapshot that
        // health reports counts them.
        expect(after.lastOkPassAt).toBe(before.lastOkPassAt);
        expect((await recordOf(resultJobId))?.result).toBeNull();
        expect(after.resultsRemoved).toBeGreaterThanOrEqual(before.resultsRemoved + 1);
        expect(after.recordsRetired).toBe(before.recordsRetired);
        expect(await recordOf(recordJobId)).not.toBeNull();

        // Retire the held-back record so later legs' backlog counts start clean.
        await runPass();
        expect(await recordOf(recordJobId)).toBeNull();
      } finally {
        await loop.stop();
      }
    },
  );

  test(
    "two replicas' passes racing the same backlog each retire exactly their own statement's rows — the backlog drains exactly once, with no orphaned runner row",
    { timeout: 45_000 },
    async () => {
      // The spec's interleaving claim (criterion 14's release, the replica
      // story): two independent loops' record arms race the same rows. Each
      // pass's runner deletes are exactly its own statement's RETURNING ids,
      // so the loser of the race must retire nothing and still succeed —
      // never double-delete (its counts would overstate) and never leave the
      // race's loser holding a runner row whose record is gone.
      const first = await drivenLoop({
        deleteRunnerRows: {
          delete: (withinTx, runnerJobIds) => deleteRunnerJobs(boss, withinTx, runnerJobIds),
        },
      });
      const second = await drivenLoop({
        deleteRunnerRows: {
          delete: (withinTx, runnerJobIds) => deleteRunnerJobs(boss, withinTx, runnerJobIds),
        },
      });
      try {
        const seeds: Array<{ jobId: string; runnerJobId: string }> = [];
        for (let i = 0; i < 6; i += 1) {
          const jobId = await seedJob(anApp());
          await forceTerminal(jobId, "crashed", 31 * 24 * 60 * 60);
          const record = await recordOf(jobId);
          seeds.push({ jobId, runnerJobId: record?.runner_job_id as string });
        }
        for (const seed of seeds) {
          const queued = await direct.query(
            `SELECT id FROM ${JOBS_PGBOSS_SCHEMA}.job WHERE id::text = $1`,
            [seed.runnerJobId],
          );
          expect(queued.rows).toHaveLength(1);
        }

        // The two passes run concurrently — one transaction's record delete
        // blocks on the other's locks, rechecks, and returns exactly what it
        // itself can name.
        const [left, right] = await Promise.all([first.settle(), second.settle()]);
        expect(left.recordsRetired + right.recordsRetired).toBe(seeds.length);

        for (const seed of seeds) {
          expect(await recordOf(seed.jobId)).toBeNull();
        }
        for (const seed of seeds) {
          const gone = await direct.query(
            `SELECT id FROM ${JOBS_PGBOSS_SCHEMA}.job WHERE id::text = $1`,
            [seed.runnerJobId],
          );
          expect(gone.rows).toHaveLength(0);
        }

        // And the store converges: a further pass on either replica removes
        // nothing and fails nothing.
        const beforeSettled = cleanup.snapshot().recordsRetired;
        const settled = await runPass();
        expect(settled.recordsRetired - beforeSettled).toBe(0);
        expect(jobsCleanupCheck(settled, { nowMs: Date.now() }).status).toBe("ok");
      } finally {
        await first.loop.stop();
        await second.loop.stop();
      }
    },
  );

  test(
    "two replicas' passes racing a MIXED backlog — the result arm's convergence and the record arm's retirement each land exactly once, and in-horizon records survive both arms of both replicas",
    { timeout: 45_000 },
    async () => {
      // The other half of the replica story: the RESULT arm raced. Its
      // recheck direction is the nastier one — the race's winner CHANGES the
      // row the loser's predicate reads (result → NULL), so the loser's
      // EvalPlanQual must re-evaluate `result IS NOT NULL` against the new
      // version and update nothing, never double-converge (overstated
      // counts) and never converge a row twice. And the same pass carries
      // both arms over the same rows: a succeeded record past the record
      // horizon is result-converged AND retired in one pass, while a
      // result-expired record inside its record horizon must survive BOTH
      // replicas' record arms with its runner row still attached.
      const first = await drivenLoop({
        deleteRunnerRows: {
          delete: (withinTx, runnerJobIds) => deleteRunnerJobs(boss, withinTx, runnerJobIds),
        },
      });
      const second = await drivenLoop({
        deleteRunnerRows: {
          delete: (withinTx, runnerJobIds) => deleteRunnerJobs(boss, withinTx, runnerJobIds),
        },
      });
      try {
        // Inside the record horizon, past the result horizon: only the
        // result arm may ever touch these.
        const gapRows: Array<{ jobId: string; runnerJobId: string }> = [];
        for (let i = 0; i < 4; i += 1) {
          const jobId = await seedJob(anApp());
          await forceTerminal(jobId, "succeeded", JOBS_RESULT_TTL_SECONDS + 7_200, '{"gap":1}');
          const record = await recordOf(jobId);
          gapRows.push({ jobId, runnerJobId: record?.runner_job_id as string });
        }
        // Past the record horizon, carrying results: both arms touch these
        // in the same pass.
        const retiredRows: Array<{ jobId: string; runnerJobId: string }> = [];
        for (let i = 0; i < 4; i += 1) {
          const jobId = await seedJob(anApp());
          await forceTerminal(jobId, "succeeded", 31 * 24 * 60 * 60, '{"gone":1}');
          const record = await recordOf(jobId);
          retiredRows.push({ jobId, runnerJobId: record?.runner_job_id as string });
        }
        for (const row of [...gapRows, ...retiredRows]) {
          const queued = await direct.query(
            `SELECT id FROM ${JOBS_PGBOSS_SCHEMA}.job WHERE id::text = $1`,
            [row.runnerJobId],
          );
          expect(queued.rows).toHaveLength(1);
        }

        const [left, right] = await Promise.all([first.settle(), second.settle()]);
        // Each row's convergence and each retirement happened exactly once
        // across the two racing passes — and both passes succeeded (a failed
        // pass contributes nothing, which the sums and the surviving rows
        // would expose).
        expect(left.resultsRemoved + right.resultsRemoved).toBe(
          gapRows.length + retiredRows.length,
        );
        expect(left.recordsRetired + right.recordsRetired).toBe(retiredRows.length);
        expect(left.lastOkPassAt).not.toBeNull();
        expect(right.lastOkPassAt).not.toBeNull();

        // The gap rows: converged to the stored expired form exactly once —
        // and the record, its retry key and its runner row all still there.
        for (const row of gapRows) {
          const record = await recordOf(row.jobId);
          expect(record?.status).toBe("expired");
          expect(record?.result).toBeNull();
          const runnerRow = await direct.query(
            `SELECT id FROM ${JOBS_PGBOSS_SCHEMA}.job WHERE id::text = $1`,
            [row.runnerJobId],
          );
          expect(runnerRow.rows).toHaveLength(1);
        }
        // The past-horizon rows: the whole unit gone, through the race.
        for (const row of retiredRows) {
          expect(await recordOf(row.jobId)).toBeNull();
          const runnerRow = await direct.query(
            `SELECT id FROM ${JOBS_PGBOSS_SCHEMA}.job WHERE id::text = $1`,
            [row.runnerJobId],
          );
          expect(runnerRow.rows).toHaveLength(0);
        }

        // And the store converges: the next pass opens on a cleared store.
        const beforeSettled = cleanup.snapshot().recordsRetired;
        const settled = await runPass();
        expect(settled.recordsRetired - beforeSettled).toBe(0);
        expect(settled.evidence?.overdueResults).toBe(0);
        expect(settled.evidence?.overdueRecords).toBe(0);
      } finally {
        await first.loop.stop();
        await second.loop.stop();
      }
    },
  );
});

describe("the retry key's release", () => {
  test(
    "physical removal releases the key — an identical replay after retirement creates new work, and the replacement survives the passes that follow",
    { timeout: 30_000 },
    async () => {
      const appId = anApp();
      await lifecycle.apply(appId, { generation: "1", archived: false });
      const first = await submitKeyed(appId, "release-key");
      expect(first).toMatchObject({ outcome: "accepted" });
      if (first.outcome !== "accepted") return;
      const originalJobId = first.jobId;

      await forceTerminal(originalJobId, "failed", 31 * 24 * 60 * 60);
      const snapshot = await runPass();
      expect(snapshot.recordsRetired).toBeGreaterThanOrEqual(1);
      expect(await recordOf(originalJobId)).toBeNull();
      expect(await runnerRowOf(originalJobId)).toBeNull();

      // The key is free: the identical replay is NEW work now — a fresh job,
      // its own runner row, no aliasing of the retired one.
      const replay = await submitKeyed(appId, "release-key");
      expect(replay).toMatchObject({ outcome: "accepted" });
      if (replay.outcome !== "accepted") return;
      expect(replay.jobId).not.toBe(originalJobId);

      // And the replacement survives every later pass: the retired job's
      // runner id was consumed by the retirement that released the key, so
      // no pass can ever name the replacement's rows.
      await runPass();
      await runPass();
      const replacementRow = await recordOf(replay.jobId);
      expect(replacementRow?.status).toBe("queued");
      expect(await runnerRowOf(replay.jobId)).not.toBeNull();
      expect(await submitKeyed(appId, "release-key")).toMatchObject({
        outcome: "recovered",
        jobId: replay.jobId,
      });
    },
  );

  test(
    "the result arm removes bytes, never the key — a replay during the logical gap recovers the original as expired, and changed bytes still conflict",
    { timeout: 30_000 },
    async () => {
      const appId = anApp();
      await lifecycle.apply(appId, { generation: "1", archived: false });
      const first = await submitKeyed(appId, "gap-key");
      expect(first).toMatchObject({ outcome: "accepted" });
      if (first.outcome !== "accepted") return;
      const originalJobId = first.jobId;

      // Past the result horizon, inside the record horizon: exactly the gap
      // the cleanup's result arm owns.
      await forceTerminal(
        originalJobId,
        "succeeded",
        JOBS_RESULT_TTL_SECONDS + 7_200,
        '{"kept":1}',
      );
      await runPass();
      const row = await recordOf(originalJobId);
      expect(row?.status).toBe("expired");
      expect(row?.result).toBeNull();

      // The key stayed attached to the record the pass did NOT remove: the
      // identical replay recovers the original job with its projected
      // status, creating no work; different bytes still conflict with it.
      expect(await submitKeyed(appId, "gap-key")).toMatchObject({
        outcome: "recovered",
        jobId: originalJobId,
        status: "expired",
      });
      expect(await submitKeyed(appId, "gap-key", OTHER_BODY)).toMatchObject({
        outcome: "conflict",
        status: "expired",
      });
    },
  );
});

describe("the evidence the health checks grade", () => {
  /** Content past both horizons' 48-hour removal deadlines — the overdue shape. */
  const OVERDUE_RESULT_SECONDS = JOBS_RESULT_TTL_SECONDS + JOBS_REMOVAL_GRACE_SECONDS + 7_200;
  const OVERDUE_RECORD_SECONDS = 30 * 24 * 60 * 60 + JOBS_REMOVAL_GRACE_SECONDS + 7_200;

  test(
    "content past its 48-hour removal deadline reads overdue until a pass opens on it cleared",
    { timeout: 30_000 },
    async () => {
      // Settle whatever earlier legs left behind, so the leg's counts are its own.
      await runPass();

      const overdueResults: string[] = [];
      for (let i = 0; i < 2; i += 1) {
        const jobId = await seedJob(anApp());
        await forceTerminal(jobId, "succeeded", OVERDUE_RESULT_SECONDS, '{"stale":true}');
        overdueResults.push(jobId);
      }
      const overdueRecord = await (async () => {
        const jobId = await seedJob(anApp());
        await forceTerminal(jobId, "failed", OVERDUE_RECORD_SECONDS);
        return jobId;
      })();

      // The pass measures its OPENING state: the overdue evidence is what
      // the loop found, even when this very pass removes it — the degraded
      // reading persists until a pass OPENS on a cleared store.
      const during = await runPass();
      expect(during.evidence?.overdueResults).toBeGreaterThanOrEqual(2);
      expect(during.evidence?.overdueRecords).toBeGreaterThanOrEqual(1);
      const degraded = jobsCleanupCheck(during, { nowMs: Date.now() });
      expect(degraded.status).toBe("degraded");
      expect(degraded.detail).toMatch(/48-hour physical-removal deadline/);

      // The pass removed the overdue content; the next pass opens on a
      // cleared store and the check reads ok again. The overdue RESULTS'
      // records stay — the result arm removes bytes, the record's own
      // retirement is the record arm's at its own horizon.
      for (const jobId of overdueResults) {
        const row = await recordOf(jobId);
        expect(row?.status).toBe("expired");
        expect(row?.result).toBeNull();
      }
      expect(await recordOf(overdueRecord)).toBeNull();
      const after = await runPass();
      expect(after.evidence?.overdueResults).toBe(0);
      expect(after.evidence?.overdueRecords).toBe(0);
      expect(jobsCleanupCheck(after, { nowMs: Date.now() }).status).toBe("ok");
    },
  );

  test(
    "retained saturation degrades the capacity check until the cleanup frees it",
    { timeout: 30_000 },
    async () => {
      await runPass();
      const before = (await runPass()).evidence?.retainedServer ?? 0;

      // Two retained rows that nothing removes until the leg retires them —
      // queued work, the age-immune occupancy the retained cap counts.
      const parked = [await seedJob(anApp()), await seedJob(anApp())];
      const saturated = await runPass();
      expect(saturated.evidence?.retainedServer).toBe(before + 2);

      // At the cap: the grade is degraded, naming the occupancy and the
      // limit — the state where new work is refused and only cleanup frees it.
      const legLimits: JobsCapacityLimits = { ...LIMITS, retainedPerServer: before + 2 };
      const degraded = jobsCapacityCheck(saturated, legLimits, { nowMs: Date.now() });
      expect(degraded.status).toBe("degraded");
      expect(degraded.detail).toMatch(
        new RegExp(`${before + 2} of ${before + 2} retained jobs server-wide`),
      );
      // Inside the cap — and under the platform's own defaults — it is ok.
      expect(
        jobsCapacityCheck(
          saturated,
          { ...legLimits, retainedPerServer: before + 3 },
          { nowMs: Date.now() },
        ).status,
      ).toBe("ok");
      expect(jobsCapacityCheck(saturated, LIMITS, { nowMs: Date.now() }).status).toBe("ok");

      // Retire the parked rows; the freed occupancy clears the saturation.
      // The evidence is the pass's OPENING measurement, so the freed count
      // is visible to the pass AFTER the one that retired them.
      for (const jobId of parked) {
        await forceTerminal(jobId, "failed", 31 * 24 * 60 * 60);
      }
      await runPass();
      const freed = await runPass();
      expect(freed.evidence?.retainedServer).toBe(before);
      expect(jobsCapacityCheck(freed, legLimits, { nowMs: Date.now() }).status).toBe("ok");
    },
  );
});

describe("the pass is bounded", () => {
  test(
    "one arm of one pass touches at most its batch cap, and the next pass continues the work",
    { timeout: 30_000 },
    async () => {
      const { loop, settle } = await drivenLoop({
        deleteRunnerRows: {
          delete: (withinTx, runnerJobIds) => deleteRunnerJobs(boss, withinTx, runnerJobIds),
        },
        batch: 2,
      });
      try {
        const seeds: string[] = [];
        for (let i = 0; i < 5; i += 1) {
          const jobId = await seedJob(anApp());
          await forceTerminal(jobId, "failed", 31 * 24 * 60 * 60);
          seeds.push(jobId);
        }

        // Each pass retires at most the cap of the leg's seeds — the loop
        // drains a backlog over passes, never in one unbounded sweep.
        let remaining = seeds.length;
        let passes = 0;
        while (remaining > 0 && passes < 10) {
          passes += 1;
          const before = remaining;
          await settle();
          let stillThere = 0;
          for (const jobId of seeds) {
            if ((await recordOf(jobId)) !== null) stillThere += 1;
          }
          expect(before - stillThere).toBeLessThanOrEqual(2);
          remaining = stillThere;
        }
        expect(remaining).toBe(0);
        for (const jobId of seeds) {
          expect(await runnerRowOf(jobId)).toBeNull();
        }
      } finally {
        await loop.stop();
      }
    },
  );

  test(
    "the result arm is batch-bounded too — an expired-result backlog drains over passes, never in one sweep",
    { timeout: 30_000 },
    async () => {
      const { loop, settle } = await drivenLoop({
        deleteRunnerRows: {
          delete: (withinTx, runnerJobIds) => deleteRunnerJobs(boss, withinTx, runnerJobIds),
        },
        batch: 2,
      });
      try {
        const seeds: string[] = [];
        for (let i = 0; i < 5; i += 1) {
          const jobId = await seedJob(anApp());
          await forceTerminal(jobId, "succeeded", JOBS_RESULT_TTL_SECONDS + 7_200, '{"gone":3}');
          seeds.push(jobId);
        }

        // Each pass removes at most the cap of the leg's stored results — the
        // same bound the record arm's leg pins, on the other arm's statement.
        let remaining = seeds.length;
        let passes = 0;
        while (remaining > 0 && passes < 10) {
          passes += 1;
          const beforeRemoved = loop.snapshot().resultsRemoved;
          await settle();
          expect(loop.snapshot().resultsRemoved - beforeRemoved).toBeLessThanOrEqual(2);
          let stillStored = 0;
          for (const jobId of seeds) {
            const row = await recordOf(jobId);
            if (row !== null && row.result !== null) stillStored += 1;
          }
          remaining = stillStored;
        }
        expect(remaining).toBe(0);
        for (const jobId of seeds) {
          expect((await recordOf(jobId))?.status).toBe("expired");
        }
      } finally {
        await loop.stop();
      }
    },
  );
});

describe("supervision and pool discipline", () => {
  test(
    "the loop reports start and stop honestly, and stop is safe twice",
    { timeout: 30_000 },
    async () => {
      const loop = new JobsCleanup({
        databaseUrl: RUNTIME_DSN,
        statementTimeoutMs: 10_000,
        deleteRunnerRows: {
          delete: (withinTx, runnerJobIds) => deleteRunnerJobs(boss, withinTx, runnerJobIds),
        },
        intervalMs: 3_600_000,
        log: LOG,
      });
      expect(loop.snapshot().started).toBe(false);
      loop.start();
      expect(loop.snapshot().started).toBe(true);
      await loop.stop();
      expect(loop.snapshot().started).toBe(false);
      // Safe twice — and after a stop the loop does not restart itself.
      await loop.stop();
      expect(loop.snapshot().started).toBe(false);
    },
  );
});

describe("the signals", () => {
  // The shared span-vocabulary constants, imported rather than spelled: the
  // red-line below is about EXTRA keys, so the allowlist must follow the
  // same definitions the emitter uses — a renamed constant cannot quietly
  // become an unbounded span.
  const BOUNDED_SPAN_KEYS = [
    ATTR_OUTCOME,
    ATTR_JOBS_CLEANUP_RESULTS_REMOVED,
    ATTR_JOBS_CLEANUP_RECORDS_RETIRED,
  ];

  test(
    "a pass counts itself ok with its removed counts on the span, and a failed pass counts failed",
    { timeout: 30_000 },
    async () => {
      // One recording for the whole leg: a module-scope tracer keeps its
      // first delegate after a restore, so a second recording in the same
      // process cannot capture spans — the reset between the halves is what
      // separates their evidence.
      const recording: RecordingTelemetry = startRecordingTelemetry();
      try {
        const appId = anApp();
        const jobId = await seedJob(appId);
        await forceTerminal(jobId, "succeeded", JOBS_RESULT_TTL_SECONDS + 7_200, '{"gone":2}');

        await runPass();

        const cleanups = (await recording.metrics()).filter(
          (m) => m.name === "helix.jobs.cleanups" && m.attributes["helix.outcome"] === "ok",
        );
        expect(cleanups.reduce((sum, m) => sum + m.value, 0)).toBeGreaterThanOrEqual(1);
        const passSpan = recording
          .spans()
          .filter((s) => s.name === "helix.jobs.cleanup")
          .at(-1);
        expect(passSpan?.attributes["helix.outcome"]).toBe("ok");
        expect(passSpan?.attributes["helix.jobs.cleanup.results_removed"]).toBeGreaterThan(0);
        expect(passSpan?.attributes["helix.jobs.cleanup.records_retired"]).toBe(0);

        // The red line the pass span lives by: a pass is not about one job.
        // Every attribute of every captured span stays inside the shared
        // bounded vocabulary, and no attribute's value carries this leg's
        // app or owner identity — the rows the pass removed carried both,
        // so a leak here is a retained-backend privacy event. A mutation
        // that stamps a job id, an owner or a URL onto the span turns this
        // leg red; the recovery span's suite carries the same line for its
        // own seam.
        const cleanupSpans = recording.spans().filter((s) => s.name === SPAN_JOBS_CLEANUP);
        expect(cleanupSpans.length).toBeGreaterThanOrEqual(1);
        for (const span of cleanupSpans) {
          for (const [key, value] of Object.entries(span.attributes)) {
            expect(BOUNDED_SPAN_KEYS, `the pass span carries ${key}`).toContain(key);
            expect(String(value), `attr ${key} carries an app id`).not.toContain(appId);
            expect(String(value), `attr ${key} carries an owner oid`).not.toContain(
              TEST_IDENTITY.ownerOid,
            );
          }
        }

        // The failing pass's own evidence: a run of failed is a store (or,
        // as here, a runner retirement) that stopped answering. The reset
        // drops the ok span; the counters' cumulative totals persist — per
        // outcome dimension, so the failed total is still exact.
        recording.reset();
        const { loop, settle } = await drivenLoop({
          deleteRunnerRows: {
            delete: async () => {
              throw new Error("injected runner-delete failure");
            },
          },
        });
        try {
          const appId = anApp();
          const jobId = await seedJob(appId);
          await forceTerminal(jobId, "failed", 31 * 24 * 60 * 60);

          await settle();

          const failed = (await recording.metrics()).filter(
            (m) => m.name === "helix.jobs.cleanups" && m.attributes["helix.outcome"] === "failed",
          );
          expect(failed.reduce((sum, m) => sum + m.value, 0)).toBe(1);
          const failedSpan = recording
            .spans()
            .filter((s) => s.name === "helix.jobs.cleanup")
            .at(-1);
          expect(failedSpan?.attributes["helix.outcome"]).toBe("failed");

          // The counter's dimension set is the outcome alone — no job id,
          // no app, no attempt: the pass is not about one job, and the
          // metric's cardinality stays bounded whatever the store holds.
          for (const metric of await recording.metrics()) {
            if (metric.name === INSTR_JOBS_CLEANUPS) {
              expect(Object.keys(metric.attributes).sort()).toEqual([ATTR_OUTCOME]);
            }
          }
          // The failing span answers to the same bounded vocabulary as the
          // ok one (the red-line scan above ran over the ok half's spans;
          // this is the failed half's).
          for (const span of recording.spans().filter((s) => s.name === SPAN_JOBS_CLEANUP)) {
            for (const [key, value] of Object.entries(span.attributes)) {
              expect(BOUNDED_SPAN_KEYS, `the pass span carries ${key}`).toContain(key);
              expect(String(value), `attr ${key} carries an app id`).not.toContain(appId);
              expect(String(value), `attr ${key} carries an owner oid`).not.toContain(
                TEST_IDENTITY.ownerOid,
              );
            }
          }
        } finally {
          await loop.stop();
        }

        // A pass that SUCCEEDED but whose own routine success report hit a
        // throwing sink must keep its ok classification everywhere — the
        // counter already counted ok before the report (the exactly-once
        // discipline), the snapshot recorded the success, and the removal
        // landed; the span cannot be the one signal that disagrees. The burn
        // sweep sink-guards its success-path report for exactly this reason.
        recording.reset();
        const cleanupTotals = async (): Promise<{ ok: number; failed: number }> => {
          const all = await recording.metrics();
          const sum = (outcome: string): number =>
            all
              .filter(
                (m) =>
                  m.name === "helix.jobs.cleanups" && m.attributes["helix.outcome"] === outcome,
              )
              .reduce((total, m) => total + m.value, 0);
          return { ok: sum("ok"), failed: sum("failed") };
        };
        const beforePass = await cleanupTotals();
        const sinkLog = {
          info: (fields: Record<string, unknown>): void => {
            if (String(fields["event"]) === "jobs.cleanup.pass") {
              throw new Error("the reporting sink is down");
            }
          },
          warn: () => {},
          error: () => {},
        };
        const sinkAppId = anApp();
        const sinkJobId = await seedJob(sinkAppId);
        await forceTerminal(sinkJobId, "succeeded", JOBS_RESULT_TTL_SECONDS + 7_200, '{"gone":4}');
        const sinked = new JobsCleanup({
          databaseUrl: RUNTIME_DSN,
          statementTimeoutMs: 10_000,
          deleteRunnerRows: {
            delete: (withinTx, runnerJobIds) => deleteRunnerJobs(boss, withinTx, runnerJobIds),
          },
          intervalMs: 3_600_000,
          log: sinkLog,
        });
        sinked.start();
        try {
          await sinked.runPass();
          const snap = sinked.snapshot();
          expect(snap.lastOkPassAt).not.toBeNull(); // the pass succeeded
          expect(snap.resultsRemoved).toBeGreaterThanOrEqual(1); // and removed
          // The counter counted the pass ok — the exactly-once accounting
          // lands before the reporting — and never counted a failure.
          const afterPass = await cleanupTotals();
          expect(afterPass.ok - beforePass.ok).toBe(1);
          expect(afterPass.failed - beforePass.failed).toBe(0);
          // The pass's span is the same pass's evidence: it must not be the
          // one signal calling the succeeded pass a failure.
          const passSpan = recording
            .spans()
            .filter((s) => s.name === SPAN_JOBS_CLEANUP)
            .at(-1);
          expect(passSpan?.attributes["helix.outcome"]).toBe("ok");
        } finally {
          await sinked.stop();
        }
      } finally {
        await recording.restore();
      }
    },
  );
});

/**
 * The loop's own supervision — the same legs the recovery sweeper's suite
 * carries for its instance of the supervised-loop shape, plus the two
 * behaviors only this loop has (the failed pass's backoff and the full
 * batch's drain). Every pass below is driven or timer-produced by the loop
 * itself; the legs assert the snapshot, the log events and the check grades
 * the supervision is there to produce.
 */
describe("the loop's own supervision", () => {
  test("passes that arrive while one is running coalesce — the cadence never overlaps itself", async () => {
    const before = cleanup.snapshot().passes;
    await Promise.all([cleanup.runPass(), cleanup.runPass(), cleanup.runPass()]);
    expect(cleanup.snapshot().passes).toBe(before + 1);
  });

  test("a pass driven before start() is a no-op that counts nothing and reports not running", async () => {
    // The unstarted no-op is invisible by design (no log, no throw) — no
    // pass is counted, no instant recorded, and the snapshot the
    // `jobs_cleanup` check grades still reads not-started.
    const dormant = new JobsCleanup({
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      deleteRunnerRows: {
        delete: (withinTx, runnerJobIds) => deleteRunnerJobs(boss, withinTx, runnerJobIds),
      },
      intervalMs: 3_600_000,
      log: LOG,
    });
    await dormant.runPass();
    const snap = dormant.snapshot();
    expect(snap.started).toBe(false);
    expect(snap.passes).toBe(0);
    expect(snap.lastPassAt).toBeNull();
    expect(snap.lastOkPassAt).toBeNull();
    expect(snap.evidence).toBeNull();
    expect(jobsCleanupCheck(snap).status).toBe("error");
    await dormant.stop();
  });

  test("runPass is safe after stop, and the loop does not restart", async () => {
    const once = new JobsCleanup({
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      deleteRunnerRows: {
        delete: (withinTx, runnerJobIds) => deleteRunnerJobs(boss, withinTx, runnerJobIds),
      },
      intervalMs: 3_600_000,
      log: LOG,
    });
    once.start();
    await once.stop();
    await once.runPass(); // a no-op, never a throw
    once.start(); // refused — the loop does not restart after stop
    expect(once.snapshot().started).toBe(false);
  });

  test(
    "a pass with nothing to retire makes no runner call — an idle store never fails on a runner that cannot answer",
    { timeout: 30_000 },
    async () => {
      const { loop, settle } = await drivenLoop({
        deleteRunnerRows: {
          delete: async () => {
            throw new Error("the runner must not even be asked");
          },
        },
      });
      try {
        const snap = await settle();
        // The pass measured, removed nothing, succeeded — and the adapter
        // round trip never happened: an empty retirement is not a call.
        expect(snap.lastOkPassAt).not.toBeNull();
        expect(snap.resultsRemoved).toBe(0);
        expect(snap.recordsRetired).toBe(0);
        expect(jobsCleanupCheck(snap).status).toBe("ok");
      } finally {
        await loop.stop();
      }
    },
  );

  test(
    "a failed pass leaves the previous successful pass's evidence and counts standing",
    { timeout: 30_000 },
    async () => {
      let failDeletes = false;
      const { loop, settle } = await drivenLoop({
        deleteRunnerRows: {
          delete: (withinTx, runnerJobIds) => {
            if (failDeletes) throw new Error("injected runner-delete failure");
            return deleteRunnerJobs(boss, withinTx, runnerJobIds);
          },
        },
      });
      try {
        const appId = anApp();
        const jobId = await seedJob(appId);
        await forceTerminal(jobId, "failed", 31 * 24 * 60 * 60);
        await settle(); // the ok pass retires it
        const after = loop.snapshot();
        expect(after.recordsRetired).toBeGreaterThanOrEqual(1);
        const okAt = after.lastOkPassAt;
        const okEvidence = after.evidence;
        expect(okAt).not.toBeNull();
        expect(okEvidence).not.toBeNull();

        // The next pass fails at the runner delete: it is counted, its own
        // instant is recorded, and nothing else moves — the stale-evidence
        // story the health checks grade is exactly this snapshot shape.
        failDeletes = true;
        const straggler = await seedJob(anApp());
        await forceTerminal(straggler, "failed", 31 * 24 * 60 * 60);
        await settle();
        const failed = loop.snapshot();
        expect(failed.passes).toBe(after.passes + 1);
        expect(failed.lastPassAt).not.toBeNull();
        expect(failed.lastOkPassAt).toBe(okAt);
        expect(failed.evidence).toEqual(okEvidence);
        expect(failed.recordsRetired).toBe(after.recordsRetired);

        // And the loop recovers: the next pass retires the straggler.
        failDeletes = false;
        const recovered = await settle();
        expect(recovered.recordsRetired).toBeGreaterThan(after.recordsRetired);
        expect(recovered.lastOkPassAt).not.toBe(okAt);
      } finally {
        await loop.stop();
      }
    },
  );

  test(
    "a failed pass retries on the backoff ladder, not the steady cadence",
    { timeout: 45_000 },
    async () => {
      // A store that refuses connections: every pass fails fast, and the
      // ladder's rungs (1s, then 2s) bring the next pass — the steady
      // one-hour cadence would leave the pass count at one.
      const loop = new JobsCleanup({
        databaseUrl: "postgresql://helix_jobs:pw@127.0.0.1:59999/none",
        statementTimeoutMs: 2_000,
        deleteRunnerRows: {
          delete: async () => {
            throw new Error("unreachable");
          },
        },
        intervalMs: 3_600_000,
        log: LOG,
      });
      loop.start();
      try {
        await waitFor("the backoff ladder's third pass", () => loop.snapshot().passes >= 3);
        const snap = loop.snapshot();
        expect(snap.started).toBe(true);
        expect(snap.lastOkPassAt).toBeNull();
        expect(snap.evidence).toBeNull();
        // The failing loop never reads healthy: no successful pass is the
        // `jobs_cleanup` check's error arm, whatever its cadence does.
        expect(jobsCleanupCheck(snap).status).toBe("error");
      } finally {
        await loop.stop();
      }
    },
  );

  test(
    "a pass that removed a full batch is followed by the next within the drain gap, not the steady cadence",
    { timeout: 45_000 },
    async () => {
      // Settle whatever earlier legs left behind, so the leg's batch is its own.
      await runPass();
      const backlogEvents: string[] = [];
      const recordingLog = {
        info: () => {},
        warn: (fields: Record<string, unknown>): void => {
          if (String(fields["event"]) === "jobs.cleanup.backlog") {
            backlogEvents.push("jobs.cleanup.backlog");
          }
        },
        error: () => {},
      };
      const seeds = [await seedJob(anApp()), await seedJob(anApp())];
      for (const jobId of seeds) {
        await forceTerminal(jobId, "failed", 31 * 24 * 60 * 60);
      }
      const loop = new JobsCleanup({
        databaseUrl: RUNTIME_DSN,
        statementTimeoutMs: 10_000,
        batch: seeds.length, // the pass removes exactly the cap → the drain
        deleteRunnerRows: {
          delete: (withinTx, runnerJobIds) => deleteRunnerJobs(boss, withinTx, runnerJobIds),
        },
        intervalMs: 3_600_000,
        log: recordingLog,
      });
      loop.start();
      try {
        // The start's own pass removes the full batch and the drain gap (1s)
        // brings the next pass — the steady cadence this loop was built with
        // would not fire again within the window.
        await waitFor("the drained next pass", () => loop.snapshot().passes >= 2);
        const drained = loop.snapshot();
        expect(drained.recordsRetired).toBeGreaterThanOrEqual(seeds.length);
        expect(backlogEvents).toContain("jobs.cleanup.backlog");
        // The drained pass opened on the cleared store: the backlog is gone.
        expect(drained.evidence?.overdueRecords).toBe(0);
        expect(drained.evidence?.overdueResults).toBe(0);
      } finally {
        await loop.stop();
      }
    },
  );

  test(
    "the success reports are the sink's to lose — the counting, the span and the scheduling tail never depend on it",
    { timeout: 45_000 },
    async () => {
      // The sink throws on every success report — the overdue warning, the
      // pass line, the backlog line — while the pass's own work (a full
      // batch of overdue content, removed) and its accounting land first.
      // The burn sweep's standard, and this loop's: a sink that threw must
      // not fail the counted pass into a failure it did not have, and must
      // not skip the scheduling tail — the drain is exactly what a backlog
      // left by an outage needs, and the backlog line is the one reporting
      // it. The red this leg watches: an unguarded report would reject the
      // pass after its accounting, and the tail (the drain's reschedule)
      // would never run.
      await runPass(); // settle whatever earlier legs left behind
      const thrownReports: string[] = [];
      const sinkLog = {
        info: (): void => {
          throw new Error("the reporting sink is down");
        },
        warn: (fields: Record<string, unknown>): void => {
          thrownReports.push(String(fields["event"]));
          throw new Error("the reporting sink is down");
        },
        error: () => {},
      };
      const seconds = 30 * 24 * 60 * 60 + JOBS_REMOVAL_GRACE_SECONDS + 7_200;
      const seeds = [await seedJob(anApp()), await seedJob(anApp())];
      for (const jobId of seeds) {
        // Past the record horizon AND past its removal deadline: the pass's
        // opening measurement reads overdue, the retirement is a full batch.
        await forceTerminal(jobId, "failed", seconds);
      }
      const loop = new JobsCleanup({
        databaseUrl: RUNTIME_DSN,
        statementTimeoutMs: 10_000,
        batch: seeds.length,
        deleteRunnerRows: {
          delete: (withinTx, runnerJobIds) => deleteRunnerJobs(boss, withinTx, runnerJobIds),
        },
        intervalMs: 3_600_000,
        log: sinkLog,
      });
      loop.start();
      try {
        // Every success report the pass attempted threw — and the pass
        // still resolved, counted ok, removed its batch, and the tail
        // scheduled the drain: the next pass arrives in seconds, not the
        // steady cadence the tail-less reschedule would have left.
        await waitFor("the drain the sinkless tail scheduled", () => loop.snapshot().passes >= 2);
        const snap = loop.snapshot();
        expect(thrownReports).toContain("jobs.cleanup.overdue");
        expect(thrownReports).toContain("jobs.cleanup.backlog");
        expect(snap.lastOkPassAt).not.toBeNull();
        expect(snap.recordsRetired).toBeGreaterThanOrEqual(seeds.length);
        expect(snap.resultsRemoved).toBe(0);
        // The work landed: the batch is retired through the real adapter.
        for (const jobId of seeds) {
          expect(await recordOf(jobId)).toBeNull();
          expect(await runnerRowOf(jobId)).toBeNull();
        }
        // And the drained pass opened on the cleared store.
        expect(snap.evidence?.overdueRecords).toBe(0);
        expect(jobsCleanupCheck(snap).status).toBe("ok");
      } finally {
        await loop.stop();
      }
    },
  );

  test(
    "the pass reports its own evidence — the overdue warning and the pass line with its counts",
    { timeout: 30_000 },
    async () => {
      const events = new Map<string, Record<string, unknown>>();
      const eventLog = {
        info: (fields: Record<string, unknown>): void => {
          events.set(String(fields["event"]), fields);
        },
        warn: (fields: Record<string, unknown>): void => {
          events.set(String(fields["event"]), fields);
        },
        error: () => {},
      };
      const loop = new JobsCleanup({
        databaseUrl: RUNTIME_DSN,
        statementTimeoutMs: 10_000,
        deleteRunnerRows: {
          delete: (withinTx, runnerJobIds) => deleteRunnerJobs(boss, withinTx, runnerJobIds),
        },
        intervalMs: 3_600_000,
        log: eventLog,
      });
      loop.start();
      try {
        await loop.runPass(); // the start's own pass on a quiet store: no events

        // Past the record horizon AND past its 48-hour removal deadline —
        // the shape the overdue warning is about.
        const seconds = 30 * 24 * 60 * 60 + JOBS_REMOVAL_GRACE_SECONDS + 7_200;
        const jobId = await seedJob(anApp());
        await forceTerminal(jobId, "failed", seconds);

        await loop.runPass();
        const snap = loop.snapshot();

        // The overdue warning names both counts — the pass's OPENING
        // measurement, even when this very pass cleared it.
        const overdue = events.get("jobs.cleanup.overdue");
        expect(overdue?.overdueRecords).toBeGreaterThanOrEqual(1);
        expect(overdue?.overdueResults).toBe(0);

        // The pass line carries the removal counts and the duration — the
        // operational evidence (criterion 56) an operator greps for.
        const pass = events.get("jobs.cleanup.pass");
        expect(pass?.recordsRetired).toBeGreaterThanOrEqual(1);
        expect(pass?.durationMs).toEqual(expect.any(Number));
        expect(snap.recordsRetired).toBeGreaterThanOrEqual(1);
        expect(await recordOf(jobId)).toBeNull();
      } finally {
        await loop.stop();
      }
    },
  );

  test(
    "a pass whose own failure reporting threw rejects to the caller, and the guard clears for the next pass",
    { timeout: 30_000 },
    async () => {
      // The one way a pass rejects out of runPass: its own failure report's
      // sink threw. The rejection must surface (never a silently swallowed
      // pass), and the in-flight guard must clear on the rejection so the
      // next call runs its own pass instead of coalescing into a settled one
      // forever.
      const failureEvents: string[] = [];
      const sinkLog = {
        info: () => {},
        warn: () => {},
        error: (fields: Record<string, unknown>): void => {
          failureEvents.push(String(fields["event"]));
          throw new Error("the reporting sink is down");
        },
      };
      // The retirement fails exactly twice — the two rejecting passes — and
      // answers for real afterwards, so the leg leaves nothing overdue behind.
      let remainingFailures = 2;
      const broken = new JobsCleanup({
        databaseUrl: RUNTIME_DSN,
        statementTimeoutMs: 10_000,
        deleteRunnerRows: {
          delete: (withinTx, runnerJobIds) => {
            if (remainingFailures > 0) {
              remainingFailures -= 1;
              throw new Error("injected runner-delete failure");
            }
            return deleteRunnerJobs(boss, withinTx, runnerJobIds);
          },
        },
        intervalMs: 3_600_000,
        log: sinkLog,
      });
      broken.start();
      try {
        await broken.runPass(); // the start's own pass: nothing overdue, settles silently

        const jobId = await seedJob(anApp());
        await forceTerminal(jobId, "failed", 31 * 24 * 60 * 60);
        const before = broken.snapshot().passes;

        await expect(broken.runPass()).rejects.toThrow();
        expect(broken.snapshot().passes).toBe(before + 1);
        expect(failureEvents).toContain("jobs.cleanup.pass_failed");

        // The guard cleared: the second call runs its OWN pass — counted
        // again — rather than returning the settled one's rejection forever.
        await expect(broken.runPass()).rejects.toThrow();
        expect(broken.snapshot().passes).toBe(before + 2);

        // With the sink failing every failure report, the retirement the
        // passes could not make is still the loop's next word: the real
        // delete answers and the record retires.
        await broken.runPass();
        expect(await recordOf(jobId)).toBeNull();
        expect(await runnerRowOf(jobId)).toBeNull();
      } finally {
        await broken.stop();
      }
    },
  );

  test(
    "the timer's cadence survives passes that reject through their own failure reporting — the reschedule's rejection arm, and no unhandled rejection",
    { timeout: 45_000 },
    async () => {
      // The rejection legs above drive runPass explicitly; the TIMER path is
      // a different call site: `pass.then(reschedule, reschedule)`, whose
      // second arm is the only thing that keeps the cadence alive when a
      // pass rejects. If a refactor ever dropped that arm (a bare
      // `pass.then(reschedule)`), the loop would brick silently during
      // exactly the outage the backoff exists for — and the rejected pass
      // would surface as an unhandled rejection besides. A sink that throws
      // on `error` makes every failing pass reject, so three passes on the
      // backoff ladder prove the arm is load-bearing: the same proof the
      // healthy-sink backoff leg makes, through the rejection path.
      const loop = new JobsCleanup({
        databaseUrl: "postgresql://helix_jobs:pw@127.0.0.1:59999/none",
        statementTimeoutMs: 2_000,
        deleteRunnerRows: {
          delete: async () => {
            throw new Error("unreachable");
          },
        },
        intervalMs: 3_600_000,
        log: {
          info: () => {},
          warn: () => {},
          error: () => {
            throw new Error("the reporting sink is down");
          },
        },
      });
      loop.start();
      try {
        await waitFor(
          "the backoff ladder's third pass through rejecting passes",
          () => loop.snapshot().passes >= 3,
        );
        const snap = loop.snapshot();
        expect(snap.started).toBe(true);
        expect(snap.lastOkPassAt).toBeNull();
        // The cadence kept its head: still failing, still retrying, never
        // bricked and never an unhandled rejection (vitest fails the run on
        // one — this leg passing is also that proof).
        expect(jobsCleanupCheck(snap).status).toBe("error");
      } finally {
        await loop.stop();
      }
    },
  );

  test(
    "stop releases through a rejected in-flight pass — the release chain survives",
    { timeout: 30_000 },
    async () => {
      // The pass is held mid-flight at its runner delete while stop() waits
      // it out; the rejection travels through the pass's own reporting (the
      // sink is down here too), and the release must still resolve and end
      // the pool — a shutdown that hung or threw here would strand the
      // process's exit on its own failure reporting.
      const failureEvents: string[] = [];
      const sinkLog = {
        info: () => {},
        warn: () => {},
        error: (fields: Record<string, unknown>): void => {
          failureEvents.push(String(fields["event"]));
          throw new Error("the reporting sink is down");
        },
      };
      // The gate is released only once the pass is parked at the delete —
      // its await attached — so the rejection is never handler-less.
      let releaseDeleter!: (error: unknown) => void;
      let signalCalled!: () => void;
      const deleterCalled = new Promise<void>((resolve) => {
        signalCalled = resolve;
      });
      const gatedDelete = new Promise<number>((_, reject) => {
        releaseDeleter = reject;
      });
      const broken = new JobsCleanup({
        databaseUrl: RUNTIME_DSN,
        statementTimeoutMs: 10_000,
        deleteRunnerRows: {
          delete: () => {
            signalCalled();
            return gatedDelete;
          },
        },
        intervalMs: 3_600_000,
        log: sinkLog,
      });
      broken.start();
      try {
        await broken.runPass(); // the start's own pass settles before the leg

        const jobId = await seedJob(anApp());
        await forceTerminal(jobId, "failed", 31 * 24 * 60 * 60);

        const pass = broken.runPass(); // in flight, held at the gated delete
        await deleterCalled; // the pass's await is attached at the gate
        const release = broken.stop();
        releaseDeleter(new Error("injected runner-delete failure"));

        await expect(pass).rejects.toThrow();
        await expect(release).resolves.toBeUndefined();
        expect(broken.snapshot().started).toBe(false);
        // Both reports were attempted — the pass's own failure report and
        // the stop path's guarded rejection report — and neither broke the
        // release.
        expect(failureEvents).toContain("jobs.cleanup.pass_failed");
        expect(failureEvents).toContain("jobs.cleanup.pass_rejected");
      } finally {
        await broken.stop(); // safe twice
      }
    },
  );
});
