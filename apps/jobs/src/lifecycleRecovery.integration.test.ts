import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { resolveJobsCapacityLimits, type JobsCapacityLimits } from "@azx-pbc/shared";

import { JobsExecution, JobsHandlerRegistry, type JobsHandler } from "./execution.js";
import { jobsLifecycleRecoveryCheck } from "./health.js";
import { JobsLifecycleStore } from "./lifecycle.js";
import { migrateJobsStorage } from "./migrate.js";
import {
  JOBS_JOB_RECORD_QUALIFIED,
  JOBS_PGBOSS_SCHEMA,
  JOBS_RUNTIME_ROLE,
  jobsRuntimeBossOptions,
} from "./policy.js";
import { JobsRecovery } from "./recovery.js";
import { cancelRunnerJob, readRunnerJobState } from "./runner.js";
import { seedRunnerJobWithRecord } from "./test/recordSeed.js";
import { applyRolesProvisioning } from "../../portal/src/test/provisionDatabases.js";

/**
 * The archive-cancellation recovery against the real store, the real runner
 * and the real role split: a delivered archive (or newer generation) stamps
 * every still-active closed-generation job of the app — both environments —
 * with durable intent before its acknowledgement, and the recovery sweeper
 * carries each stamped record to its terminal `cancelled` outcome across
 * passes, converging until none remains active. The backlog's remaining
 * count and oldest pending age are what the sweeper's pass measures for the
 * `jobs_lifecycle_recovery` health check; unarchive admits only the eligible
 * new generation; a claim racing the close reaches `cancelled`, never a
 * mislabeled crash.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

const SCRATCH_DB = `helix_jobs_lcr_${randomUUID().replaceAll("-", "")}`;

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

/**
 * The info events the composed components logged — the legs that assert the
 * service's documented log evidence read this (the pino surface's first
 * argument is the fields object carrying `event`).
 */
const INFO_EVENTS: Array<Record<string, unknown>> = [];

function lifecycleStampedEvents(): Array<Record<string, unknown>> {
  return INFO_EVENTS.filter((fields) => fields.event === "jobs.recovery.lifecycle_stamped");
}

const LOG = {
  info: (fields: Record<string, unknown>) => {
    INFO_EVENTS.push(fields);
  },
  warn: () => {},
  error: () => {},
};

const LIMITS: JobsCapacityLimits = resolveJobsCapacityLimits();

/** Bounded wait for a store state the machinery's own cadence produces. */
async function waitFor(what: string, probe: () => Promise<boolean>): Promise<void> {
  const by = Date.now() + 45_000;
  while (Date.now() < by) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

let boss: PgBoss;
let execution: JobsExecution;
let recovery: JobsRecovery;
let lifecycle: JobsLifecycleStore;
let direct: Pool;

beforeAll(async () => {
  await applyRolesProvisioning(SCRATCH_DB);
  await migrateJobsStorage(urlFor(SCRATCH_DB, "helix_jobs_migrate"));
  lifecycle = new JobsLifecycleStore({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    log: LOG,
  });
  lifecycle.start();
  boss = new PgBoss({ connectionString: RUNTIME_DSN, ...jobsRuntimeBossOptions() });
  await boss.start();
  execution = new JobsExecution({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    handlers: handlers,
    limits: LIMITS,
    log: LOG,
  });
  execution.start();
  await execution.registerOn(boss);
  // The sweeper's cadence is test-driven (every pass below is explicit); its
  // reads, re-drives and the lifecycle arm ride the production composition.
  recovery = new JobsRecovery({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    readRunnerJob: (runnerJobId) => readRunnerJobState(boss, runnerJobId),
    cancelRunnerJob: (runnerJobId) => cancelRunnerJob(boss, runnerJobId),
    intervalMs: 3_600_000,
    log: LOG,
  });
  recovery.start();
  await waitFor("the first recovery pass to complete", async () => recovery.snapshot().passes >= 1);
  direct = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
}, 60_000);

afterAll(async () => {
  await direct.end();
  await recovery.stop();
  await execution.stop();
  await lifecycle.stop();
  await boss.stop({ graceful: true, timeout: 5_000 }).catch(() => {});
  const pool = new Pool({ connectionString: urlFor("postgres"), max: 1 });
  await pool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
  await pool.end();
}, 30_000);

/** The leg's own mutable handler — the registry holds one entry per leg's behaviour. */
const handlers = new JobsHandlerRegistry();
let currentHandler: JobsHandler = async () => null;
handlers.register("jobs:fetch", (context) => currentHandler(context));

/** Each test's own app — the uuid the identity schemas accept, disjoint per leg. */
function anApp(): string {
  return randomUUID();
}

/** Deliver one lifecycle generation through the real store — the apply stamps with it. */
async function deliverGeneration(appId: string, generation: string, archived: boolean) {
  return lifecycle.apply(appId, { generation, archived });
}

/** Seed one queued job under an open generation, held off-claim so only the leg's own timing claims it. */
async function seedHeldJob(options: {
  appId: string;
  env?: "prod" | "dev";
  generation?: string;
}): Promise<string> {
  await deliverGeneration(options.appId, options.generation ?? "1", false);
  return seedRunnerJobWithRecord(boss, direct, {
    appId: options.appId,
    data: { url: "https://example.com/data.json" },
    startAfterSeconds: 3_600,
    env: options.env,
    generation: options.generation,
  });
}

/** The wrapper record of one job, read directly — not through any seam. */
async function recordRow(jobId: string): Promise<Record<string, unknown>> {
  const result = await direct.query<Record<string, unknown>>(
    `SELECT * FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE job_id = $1`,
    [jobId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no record row for job ${jobId}`);
  return row;
}

/** The runner row joined to a job by the stored runner id. */
async function runnerRow(jobId: string): Promise<Record<string, unknown>> {
  const result = await direct.query<Record<string, unknown>>(
    `SELECT r.* FROM ${JOBS_PGBOSS_SCHEMA}.job r
       JOIN ${JOBS_JOB_RECORD_QUALIFIED} w ON w.runner_job_id = r.id::text
      WHERE w.job_id = $1`,
    [jobId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no runner row for job ${jobId}`);
  return row;
}

describe("the archive-cancellation recovery", () => {
  test("a delivered archive stamps its queued work in both environments and the sweeper converges it until none remains active", async () => {
    const app = anApp();
    const prodJob = await seedHeldJob({ appId: app });
    const devJob = await seedHeldJob({ appId: app, env: "dev" });

    // The archive delivery: stamped BEFORE its acknowledgement — the apply's
    // own transaction committed the intent with the generation change.
    const applied = await deliverGeneration(app, "2", true);
    expect(applied.stamped).toBe(2);
    for (const jobId of [prodJob, devJob]) {
      const row = await recordRow(jobId);
      expect(row.cancellation_requested).toBe(true);
      expect(row.cancellation_requested_at).toBeInstanceOf(Date);
      expect(row.status).toBe("queued");
    }

    // One pass measures the backlog it is about to cancel...
    await recovery.runPass();
    const mid = recovery.snapshot().lifecycle;
    expect(mid?.outstanding).toBe(2);
    expect(mid?.oldestPendingAt).toEqual(expect.any(String));

    // ...and converges it: both records terminal cancelled, both runner rows
    // cancelled by the re-drive, and the next pass's measurement empty.
    await waitFor("both archived jobs to reach their cancelled outcome", async () => {
      const rows = await Promise.all([recordRow(prodJob), recordRow(devJob)]);
      return rows.every((row) => row.status === "cancelled" && row.error_code === "cancelled");
    });
    for (const jobId of [prodJob, devJob]) {
      expect((await runnerRow(jobId)).state).toBe("cancelled");
    }
    // And the emptying pass stays silent about stamping: the apply's own
    // stamps are never the healing arm's news — the documented event fires
    // once per pass when a stamp LANDED, never when a pass found nothing to
    // heal.
    const stampedEventsBefore = lifecycleStampedEvents().length;
    await recovery.runPass();
    expect(recovery.snapshot().lifecycle).toEqual({ outstanding: 0, oldestPendingAt: null });
    // The check grades the recovered posture ok — recovery without hiding
    // unfinished work while it ran, and an empty backlog once it settled.
    expect(jobsLifecycleRecoveryCheck(recovery.snapshot()).status).toBe("ok");
    expect(lifecycleStampedEvents().length).toBe(stampedEventsBefore);
  });

  test("a claim racing the close reaches cancelled through the intent, never a crashed mislabel", async () => {
    const app = anApp();
    const jobId = await seedHeldJob({ appId: app });
    await deliverGeneration(app, "2", true);

    // The held row's startAfter is far off, so no claim races the stamp here;
    // the leg pulls the claim forward by releasing the row and waits for the
    // worker to reach it: the gate refuses the closed generation, the claim
    // settles without a worker-reported code — and the intent on the record
    // is what keeps that settle from being reconciled as a platform crash.
    await direct.query(
      `UPDATE ${JOBS_PGBOSS_SCHEMA}.job SET start_after = now() WHERE id::text = $1`,
      [(await runnerRow(jobId)).id],
    );
    await waitFor("the refused claim to settle the runner row", async () => {
      return (await runnerRow(jobId)).state === "failed";
    });

    // The sweeper's code-less arm reads the record's intent, not the row's
    // silence: the outcome is the cancellation the archive promised.
    await recovery.runPass();
    await waitFor("the record to converge cancelled", async () => {
      const row = await recordRow(jobId);
      return row.status === "cancelled" && row.error_code === "cancelled";
    });
  });

  test("a running job the archive closes is aborted by the re-drive and converges cancelled", async () => {
    const app = anApp();
    const jobId = await seedHeldJob({ appId: app });
    // A handler that stalls until the leg releases it — the running work the
    // archive must stop.
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    currentHandler = async (context) => {
      // Abort-aware: the claim's loss is what ends the attempt's I/O.
      await Promise.race([
        stalled,
        new Promise((_, reject) =>
          context.signal.addEventListener("abort", () => reject(context.signal.reason)),
        ),
      ]);
      return null;
    };
    try {
      // Run the job now: the row's startAfter pulled forward, the worker
      // claims it, the gate admits (generation open), the record runs.
      await direct.query(
        `UPDATE ${JOBS_PGBOSS_SCHEMA}.job SET start_after = now() WHERE id::text = $1`,
        [(await runnerRow(jobId)).id],
      );
      await waitFor("the attempt to begin", async () => {
        return (await recordRow(jobId)).status === "running";
      });

      const applied = await deliverGeneration(app, "2", true);
      expect(applied.stamped).toBe(1);

      // The pass re-drives the fenced cancel: the claim is lost, the
      // worker's own signal aborts, and the record converges by the row's
      // own cancelled state — whatever the handler does afterwards.
      await recovery.runPass();
      expect((await runnerRow(jobId)).state).toBe("cancelled");
      await waitFor("the running job to converge cancelled", async () => {
        const row = await recordRow(jobId);
        return row.status === "cancelled" && row.error_code === "cancelled";
      });
    } finally {
      release();
      currentHandler = async () => null;
    }
  });

  test("an immediate archive followed by unarchive still cancels the pre-archive work, and the new generation executes", async () => {
    const app = anApp();
    const preArchive = await seedHeldJob({ appId: app });
    await deliverGeneration(app, "2", true); // the archive — stamps the pre-archive job
    await deliverGeneration(app, "3", false); // the unarchive — a new, open generation

    // The eligible new generation: admitted under the open generation 3 and
    // never stamped — it executes to its success.
    const newJob = await seedRunnerJobWithRecord(boss, direct, {
      appId: app,
      data: { url: "https://example.com/new.json" },
      generation: "3",
    });
    currentHandler = async () => ({ ok: true });

    await recovery.runPass();
    // The pass's opening measurement: the pre-archive job is the backlog's
    // one outstanding record, and the queued new-generation work is NOT
    // counted — the closed-set predicate's exclusion, on the evidence the
    // check grades.
    expect(recovery.snapshot().lifecycle).toEqual({
      outstanding: 1,
      oldestPendingAt: expect.any(String),
    });
    await waitFor("the pre-archive job to converge cancelled", async () => {
      const row = await recordRow(preArchive);
      return row.status === "cancelled" && row.error_code === "cancelled";
    });
    await waitFor("the new-generation job to succeed", async () => {
      return (await recordRow(newJob)).status === "succeeded";
    });
    // The new job's record was never a cancellation target: it succeeded
    // under the generation the unarchive opened, and the archive's stamp
    // never touched it (a stamped record cannot succeed — the intent arm
    // and the sweeper both fence it).
    expect((await recordRow(preArchive)).cancellation_requested).toBe(true);
  });

  test("the backlog's oldest age measures the pending cancellation, never the work's own age", async () => {
    // The pending-since instant is the 60-second bound's input: an old job
    // whose cancellation was requested just now is a fresh wait, and a
    // backlog age that read the work's own age would degrade the check on
    // every promptly-archived old job.
    const app = anApp();
    const jobId = await seedHeldJob({ appId: app });
    await direct.query(
      `UPDATE ${JOBS_JOB_RECORD_QUALIFIED} SET created_at = now() - interval '3 minutes'
        WHERE job_id = $1`,
      [jobId],
    );
    const backdated = await recordRow(jobId);
    expect(backdated.created_at).toBeInstanceOf(Date);
    const createdMs = backdated.created_at instanceof Date ? backdated.created_at.getTime() : NaN;
    expect(Date.now() - createdMs).toBeGreaterThan(150_000); // the arrangement: old work

    await deliverGeneration(app, "2", true); // the stamp dates the cancellation at now
    await recovery.runPass();
    const evidence = recovery.snapshot().lifecycle;
    expect(evidence?.outstanding).toBe(1);
    expect(evidence?.oldestPendingAt).toEqual(expect.any(String));
    // The wait the bound reads: the cancellation's own age, not the three
    // minutes the work has existed.
    const pendingMs = Date.now() - Date.parse(evidence?.oldestPendingAt ?? "");
    expect(pendingMs).toBeLessThan(30_000);
    // The grading agrees: a freshly archived old job is not overdue.
    expect(jobsLifecycleRecoveryCheck(recovery.snapshot()).status).toBe("ok");
  });

  test("the healing stamp re-records intent a store lost, and the backlog still converges", async () => {
    const app = anApp();
    const jobId = await seedHeldJob({ appId: app });
    await deliverGeneration(app, "2", true);
    // Simulate a store whose closed generation predates the apply's stamping:
    // the record carries no intent while the generation stands closed.
    await direct.query(
      `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
          SET cancellation_requested = false, cancellation_requested_at = NULL
        WHERE job_id = $1`,
      [jobId],
    );

    // The pass's healing arm stamps it and the reconciliation converges it —
    // the check recovers instead of degrading forever over unstamped work.
    // The documented evidence rides with it: the info event fires once for
    // the pass, carrying the count it stamped.
    const stampedEventsBefore = lifecycleStampedEvents().length;
    await recovery.runPass();
    const stampedEvents = lifecycleStampedEvents().slice(stampedEventsBefore);
    expect(stampedEvents).toHaveLength(1);
    expect(stampedEvents[0]?.stamped).toBe(1);
    expect((await recordRow(jobId)).cancellation_requested).toBe(true);
    await waitFor("the healed record to converge cancelled", async () => {
      const row = await recordRow(jobId);
      return row.status === "cancelled" && row.error_code === "cancelled";
    });
  });
});
