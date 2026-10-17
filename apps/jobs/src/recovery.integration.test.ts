import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import {
  JOB_TERMINAL_STATUSES,
  resolveJobsCapacityLimits,
  type JobsCapacityLimits,
} from "@azx-pbc/shared";
import { sha256BodyDigest } from "@azx-pbc/shared/jobsSigning";
import { JOBS_RECOVER_OUTCOMES } from "@azx-pbc/shared/telemetry";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";

import {
  JobsExecution,
  JobsExecutionError,
  JobsExecutionStore,
  JobsHandlerRegistry,
  terminatePastDeadline,
  type JobsHandler,
} from "./execution.js";
import { jobsSweeperCheck } from "./health.js";
import { JobsLifecycleStore } from "./lifecycle.js";
import { migrateJobsStorage } from "./migrate.js";
import {
  JOBS_JOB_RECORD_QUALIFIED,
  JOBS_PGBOSS_SCHEMA,
  JOBS_QUEUE_NAME,
  JOBS_RUNTIME_ROLE,
  jobsRuntimeBossOptions,
} from "./policy.js";
import { JobsRecovery, type JobsRecoveryLogger } from "./recovery.js";
import type { RunnerJobCanceller } from "./cancellation.js";
import { cancelRunnerJob, readRunnerJobState } from "./runner.js";
import { seedRunnerJobWithRecord } from "./test/recordSeed.js";
import { applyRolesProvisioning } from "../../portal/src/test/provisionDatabases.js";
import { TEST_IDENTITY } from "./test/instructions.js";

/**
 * The recovery sweeper against the real store, the real runner machinery and
 * the real role split: a dead worker's single-attempt job recovering to its
 * crashed outcome, a lost attempt under a retriable policy being requeued
 * with its attribution and then re-driven by the attempt policy itself, the
 * absolute deadline terminating work from the sweeper and from the
 * worker-start gate, and the runner-row reconciliation's remaining branches
 * (a lost reported failure, a cancelled row, a lost result, a missing row).
 * The decision table's every branch is pinned pure in `recovery.test.ts`;
 * these legs prove the branches against the state the real machinery
 * actually produces, with the sweeper reading the runner through the
 * production mapping (`readRunnerJobState`).
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

const SCRATCH_DB = `helix_jobs_rec_${randomUUID().replaceAll("-", "")}`;

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

const LOG = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const LIMITS: JobsCapacityLimits = resolveJobsCapacityLimits();

/**
 * The stub canceller every leg that arranges no pending cancellation runs
 * with: if a decision ever reaches it, the leg's arrangement is wrong and
 * the throw fails the pass loudly, never silently.
 */
const neverCancel: RunnerJobCanceller = async () => {
  throw new Error("no pending cancellation is arranged in this leg");
};

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
  // The worker is on for the whole suite (the production shape): the legs
  // that need unclaimed work hold the runner row off-claim with startAfter.
  await execution.registerOn(boss);
  // The sweeper's cadence is test-driven (every pass below is explicit);
  // its runner-row reads and its cancellation re-drives are the production
  // mappings over a started instance.
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
let handlerRuns = 0;
handlers.register("jobs:fetch", (context) => currentHandler(context));

/** Each test's own app — the uuid the identity schemas accept, disjoint per leg. */
function anApp(): string {
  return randomUUID();
}

/** Deliver one lifecycle generation through the real store — the gate's admit side. */
async function deliverGeneration(appId: string, generation: string, archived: boolean) {
  await lifecycle.apply(appId, { generation, archived });
}

/** Seed one arrangement on the real store, its generation delivered. */
async function seedJob(options: {
  appId: string;
  data?: object;
  retryLimit?: number;
  expireInSeconds?: number;
  retryDelay?: number;
  startAfterSeconds?: number;
}): Promise<string> {
  await deliverGeneration(options.appId, "1", false);
  return seedRunnerJobWithRecord(boss, direct, {
    ...options,
    data: options.data ?? { url: "https://example.com/data.json" },
  });
}

/** The stored runner id a seeded job was enqueued as. */
async function runnerJobIdOf(jobId: string): Promise<string> {
  const result = await direct.query<{ runner_job_id: string }>(
    `SELECT runner_job_id FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE job_id = $1`,
    [jobId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no record row for job ${jobId}`);
  return row.runner_job_id;
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

/** Backdate a record's acceptance instant — the absolute deadline's input. */
async function backdateAcceptance(jobId: string, minutesAgo: number): Promise<void> {
  await direct.query(
    `UPDATE ${JOBS_JOB_RECORD_QUALIFIED} SET created_at = now() - ($1 * interval '1 minute')
      WHERE job_id = $2`,
    [minutesAgo, jobId],
  );
}

/** A deferred the stalled-attempt legs control. */
function stalledUntilResolved(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * The competing-write store the fence legs share, and the sweeper builder
 * whose runner read performs a leg's competing write on its own job first.
 * Module scope so the span-asserting telemetry leg (the file's one
 * recording) and the fence describe use the same mechanism.
 */
let fenceStore: JobsExecutionStore;

function sweeperWithInterleavedRead(
  runnerJobId: string,
  interleave: () => Promise<void>,
): JobsRecovery {
  return new JobsRecovery({
    cancelRunnerJob: neverCancel, // no pending cancellation is arranged in these legs
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    readRunnerJob: async (candidate) => {
      if (candidate !== runnerJobId) {
        return { verdict: "found", state: "active", output: null };
      }
      await interleave();
      return readRunnerJobState(boss, runnerJobId);
    },
    intervalMs: 3_600_000,
    log: LOG,
  });
}

beforeAll(() => {
  fenceStore = new JobsExecutionStore({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    log: LOG,
  });
  fenceStore.start();
});

afterAll(async () => {
  await fenceStore.stop();
});

/**
 * Settle a leg's leftover record to a terminal state — a leg whose job ends
 * `queued` (its runner row waiting out a 60s retry delay) would otherwise
 * present the pass-bound legs' oldest-first read with a candidate created
 * between their backdated acceptance instants, consuming a batch slot that
 * belongs to the leg's own records.
 */
async function settleLeftover(jobId: string): Promise<void> {
  await direct.query(
    `UPDATE ${JOBS_JOB_RECORD_QUALIFIED} SET status = 'cancelled', error_code = 'cancelled'
      WHERE job_id = $1`,
    [jobId],
  );
}

describe("worker loss", () => {
  test(
    "a dead worker's single-attempt job recovers to its crashed outcome, its reference unchanged, without a reissue",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      const jobId = await seedJob({ appId, expireInSeconds: 2 });
      const runnerJobId = await runnerJobIdOf(jobId);
      const stall = stalledUntilResolved();
      handlerRuns = 0;
      currentHandler = async () => {
        handlerRuns += 1;
        await stall.promise;
        return "too late";
      };
      try {
        // The worker claims and stalls past the claim bound; the runner's
        // own maintenance settles the expired claim (one attempt, none left)
        // — the state a worker's death leaves, without needing the death.
        await waitFor("the claim expiry to fail the runner row", async () =>
          Boolean((await runnerRow(jobId)).state === "failed"),
        );
      } finally {
        stall.release();
      }
      await recovery.runPass();

      const row = await recordRow(jobId);
      expect(row.status).toBe("crashed");
      expect(row.error_code).toBe("platform_error");
      expect(row.attempt).toBe(1);
      // The reference is the accepted one and the work was never reissued.
      expect(handlerRuns).toBe(1);
      expect(await runnerJobIdOf(jobId)).toBe(runnerJobId);
      // A second pass changes nothing: the record is terminal.
      await recovery.runPass();
      expect((await recordRow(jobId)).status).toBe("crashed");
    },
  );

  test(
    "a lost attempt under a retriable policy is requeued with its attribution while the retry waits",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      const jobId = await seedJob({ appId, retryLimit: 1, retryDelay: 60, expireInSeconds: 2 });
      const stall = stalledUntilResolved();
      currentHandler = async (context) => {
        await context.report({ step: 1, of: 2, label: "lost attempt" });
        if (context.attempt === 1) {
          await stall.promise;
          throw new JobsExecutionError("upstream_error");
        }
        return "unused";
      };
      try {
        await waitFor("the claim expiry to requeue the runner row", async () =>
          Boolean((await runnerRow(jobId)).state === "retry"),
        );
      } finally {
        stall.release();
      }
      await recovery.runPass();

      const row = await recordRow(jobId);
      expect(row.status).toBe("queued");
      expect(row.error_code).toBe("timeout");
      expect(row.attempt).toBe(1);
      expect(row.progress).toEqual({ step: 1, of: 2, label: "lost attempt" });
      // The leftover's runner row waits out a 60 s retry delay and would
      // re-fire mid-file, running whatever handler a later leg installed;
      // the terminal wrapper fences the retry at its own begin (the claim
      // fence's admission-side twin), so the leg leaves nothing live behind.
      await settleLeftover(jobId);
    },
  );

  test(
    "the attempt policy itself re-drives a requeued retry — the next attempt resets the attribution and succeeds",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      const jobId = await seedJob({ appId, retryLimit: 1, expireInSeconds: 2 });
      const firstAttempt = stalledUntilResolved();
      currentHandler = async (context) => {
        if (context.attempt === 1) {
          await firstAttempt.promise;
          throw new JobsExecutionError("upstream_error");
        }
        return { recovered: true };
      };
      try {
        // No sweeper pass needed: the retry delay has elapsed by policy, the
        // worker re-claims, and the begin resets the record to the new
        // attempt — visible as the record's attempt moving to 2 while the
        // first attempt's handler is still stalled on its claim.
        await waitFor(
          "the retry's begin to take the record",
          async () => Number((await recordRow(jobId)).attempt) === 2,
        );
      } finally {
        firstAttempt.release();
      }
      await waitFor(
        "the retry to succeed",
        async () => (await recordRow(jobId)).status === "succeeded",
      );
      const row = await recordRow(jobId);
      expect(row.attempt).toBe(2);
      expect(row.error_code).toBeNull();
      expect(row.progress).toBeNull();
    },
  );
});

describe("the absolute deadline", () => {
  test(
    "queue wait that consumed the deadline terminates the work with the timeout outcome — from the sweeper, without a claim",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      // startAfter keeps the runner row unclaimable: the deadline passes
      // while the job waits in queue, which is the wait the deadline counts.
      const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
      await backdateAcceptance(jobId, 6);
      handlerRuns = 0;
      currentHandler = async () => {
        handlerRuns += 1;
        return "must never run";
      };

      const before = recovery.snapshot().reconciled;
      await recovery.runPass();
      const row = await recordRow(jobId);
      expect(row.status).toBe("failed");
      expect(row.error_code).toBe("timeout");
      expect(handlerRuns).toBe(0);
      // The pass dispositioned exactly this work; a second pass is a no-op.
      expect(recovery.snapshot().reconciled).toBe(before + 1);
      await recovery.runPass();
      expect(recovery.snapshot().reconciled).toBe(before + 1);
      expect((await recordRow(jobId)).status).toBe("failed");
    },
  );

  test(
    "the worker-start gate terminates work whose deadline passed, and the claim never runs the handler",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      const jobId = await seedJob({ appId });
      await backdateAcceptance(jobId, 6);
      handlerRuns = 0;
      currentHandler = async () => {
        handlerRuns += 1;
        return "must never run";
      };
      await waitFor("the gate to terminate the past-deadline claim", async () =>
        Boolean((await recordRow(jobId)).status === "failed"),
      );
      const row = await recordRow(jobId);
      expect(row.error_code).toBe("timeout");
      expect(handlerRuns).toBe(0);
    },
  );

  test("in-deadline consistent work passes through the sweeper untouched", async () => {
    const appId = anApp();
    const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
    const before = recovery.snapshot().reconciled;
    await recovery.runPass();
    expect((await recordRow(jobId)).status).toBe("queued");
    expect((await runnerRow(jobId)).state).toBe("created");
    expect(recovery.snapshot().reconciled).toBe(before);
  });
});

describe("the runner-row reconciliation's remaining branches", () => {
  test("a worker-reported failure whose wrapper projection was lost reconciles with its own reason", async () => {
    const appId = anApp();
    const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
    const runnerJobId = await runnerJobIdOf(jobId);
    // The settle the execution seam issues for a reported failure that
    // exhausts the attempt policy (unfenced: the row was never claimed), and
    // the output shape the seam's own settle carries; the wrapper write that
    // follows the settle is the one an execution-store outage loses, and the
    // reconciliation is what answers that debt.
    const settle = (await boss.fail(JOBS_QUEUE_NAME, [runnerJobId], {
      code: "upstream_error",
    })) as {
      affected?: number;
    };
    expect(settle.affected ?? 0).toBe(1);

    await recovery.runPass();
    const row = await recordRow(jobId);
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("upstream_error");
  });

  test("a cancelled runner row projects the cancellation — recovery never reissues cancelled work", async () => {
    const appId = anApp();
    const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
    const runnerJobId = await runnerJobIdOf(jobId);
    // The runner-side cancellation (the owner-cancellation seam's runner half,
    // unfenced on a row that was never claimed).
    const cancelled = (await boss.cancel(JOBS_QUEUE_NAME, [runnerJobId])) as {
      affected?: number;
    };
    expect(cancelled.affected ?? 0).toBe(1);

    await recovery.runPass();
    const row = await recordRow(jobId);
    expect(row.status).toBe("cancelled");
    expect(row.error_code).toBe("cancelled");
  });

  test("a completed runner row whose projection was lost projects crashed, never a fabricated success", async () => {
    const appId = anApp();
    const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
    const runnerJobId = await runnerJobIdOf(jobId);
    // The state a crash between the claim's completion and the wrapper write
    // leaves (the store stores what the real path reaches); the result bytes
    // were lost with the attempt's process, so no success is fabricatable.
    await direct.query(
      `UPDATE ${JOBS_PGBOSS_SCHEMA}.job SET state = 'completed', completed_on = now()
         WHERE id = $1`,
      [runnerJobId],
    );

    await recovery.runPass();
    const row = await recordRow(jobId);
    expect(row.status).toBe("crashed");
    expect(row.error_code).toBe("platform_error");
  });

  test("a missing runner row is corruption: reported, left untouched, bounded later by the deadline", async () => {
    const appId = anApp();
    const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
    const runnerJobId = await runnerJobIdOf(jobId);
    await direct.query(`DELETE FROM ${JOBS_PGBOSS_SCHEMA}.job WHERE id = $1`, [runnerJobId]);

    const before = recovery.snapshot().reconciled;
    await recovery.runPass();
    expect((await recordRow(jobId)).status).toBe("queued");
    expect(recovery.snapshot().reconciled).toBe(before + 1);
  });
});

describe("the sweeper's own supervision", () => {
  test("a pass whose runner reads cannot answer fails honestly and leaves records untouched", async () => {
    const appId = anApp();
    const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
    const broken = new JobsRecovery({
      cancelRunnerJob: neverCancel, // no pending cancellation is arranged in these legs
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      readRunnerJob: async () => ({ verdict: "unavailable", reason: "the runner has not started" }),
      intervalMs: 3_600_000,
      log: LOG,
    });
    broken.start();
    try {
      await broken.runPass();
      expect((await recordRow(jobId)).status).toBe("queued");
      const snap = broken.snapshot();
      expect(snap.passes).toBe(1);
      // No successful pass: the jobs_sweeper check never reads this healthy.
      expect(snap.lastOkPassAt).toBeNull();
      expect(jobsSweeperCheck(snap).status).toBe("error");
    } finally {
      await broken.stop();
    }
  });

  test("runPass is safe after stop, and the component does not restart", async () => {
    const once = new JobsRecovery({
      cancelRunnerJob: neverCancel, // no pending cancellation is arranged in these legs
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      readRunnerJob: async () => ({ verdict: "missing" }),
      intervalMs: 3_600_000,
      log: LOG,
    });
    once.start();
    await once.stop();
    await once.runPass(); // a no-op, never a throw
    once.start(); // refused — the component does not restart after stop
    const snap = once.snapshot();
    expect(snap.started).toBe(false);
  });

  test("a pass driven before start() is a no-op that counts nothing and reports not running", async () => {
    // The unstarted no-op is invisible by design (no log, no throw) — this
    // pins it: no pass is counted, no instant recorded, and the snapshot the
    // jobs_sweeper check grades still reads not-started.
    const dormant = new JobsRecovery({
      cancelRunnerJob: neverCancel, // no pending cancellation is arranged in these legs
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      readRunnerJob: async () => ({ verdict: "missing" }),
      intervalMs: 3_600_000,
      log: LOG,
    });
    await dormant.runPass();
    const snap = dormant.snapshot();
    expect(snap.started).toBe(false);
    expect(snap.passes).toBe(0);
    expect(snap.lastPassAt).toBeNull();
    expect(snap.lastOkPassAt).toBeNull();
    expect(jobsSweeperCheck(snap).status).toBe("error");
    await dormant.stop();
  });

  test("passes that arrive while one is running coalesce — the cadence never overlaps itself", async () => {
    // The overlap guard is what keeps a slow pass from multiplexing its own
    // reconciliation; the writes are conditional anyway, so the pin is that
    // the second call rides the first pass instead of running a second one.
    const before = recovery.snapshot().passes;
    await Promise.all([recovery.runPass(), recovery.runPass(), recovery.runPass()]);
    expect(recovery.snapshot().passes).toBe(before + 1);
  });

  test("the live component's snapshot grades ok once a pass has succeeded", async () => {
    const snap = recovery.snapshot();
    expect(snap.started).toBe(true);
    expect(snap.lastOkPassAt).not.toBeNull();
    const check = jobsSweeperCheck(snap);
    expect(check.name).toBe("jobs_sweeper");
    expect(check.status).toBe("ok");
  });
});

describe("the recovery sweeper's telemetry", () => {
  let recording: RecordingTelemetry;
  beforeAll(() => {
    recording = startRecordingTelemetry();
  });
  afterEach(() => {
    recording.reset();
  });
  afterAll(async () => {
    await recording.restore();
  });

  test("a dispositioned job's span and counter carry the bounded evidence and none of the job's values", async () => {
    const appId = anApp();
    const url = "https://recovery-scan.example/data.json";
    const jobId = await seedJob({ appId, startAfterSeconds: 3_600, data: { url } });
    await backdateAcceptance(jobId, 6);
    await recovery.runPass();

    const spans = recording.spans().filter((s) => s.name === "helix.jobs.recover");
    expect(spans.length).toBeGreaterThanOrEqual(1);
    const scanned = spans.find((s) => s.attributes["helix.jobs.job_id"] === jobId);
    expect(scanned).toBeDefined();
    for (const span of spans) {
      const attrs = span.attributes;
      expect(attrs["helix.outcome"]).toSatisfy((outcome: unknown) =>
        (JOBS_RECOVER_OUTCOMES as readonly string[]).includes(String(outcome)),
      );
      // The red line: no attribute anywhere carries the input URL, the body,
      // the retry key or the owner identity, and no attribute key carries a
      // URL at all.
      for (const [key, value] of Object.entries(attrs)) {
        expect(String(value), `attr ${key} carries the input URL`).not.toContain(url);
        expect(String(value), `attr ${key} carries an owner oid`).not.toContain(
          TEST_IDENTITY.ownerOid,
        );
      }
      expect(Object.keys(attrs).some((k) => k.startsWith("url."))).toBe(false);
      expect(Object.keys(attrs).some((k) => k.startsWith("http.url"))).toBe(false);
    }
    expect(scanned?.attributes["helix.outcome"]).toBe("deadline_exceeded");
    expect(scanned?.attributes["helix.reason"]).toBe("timeout");

    const recoveries = (await recording.metrics()).filter(
      (m) =>
        m.name === "helix.jobs.recoveries" && m.attributes["helix.outcome"] === "deadline_exceeded",
    );
    expect(recoveries.reduce((sum, m) => sum + m.value, 0)).toBeGreaterThanOrEqual(1);
    for (const metric of await recording.metrics()) {
      expect(metric.attributes["helix.jobs.attempt"]).toBeUndefined();
    }
  });

  test("the gate's deadline termination is visible on the execution span's own outcome", async () => {
    const appId = anApp();
    const jobId = await seedJob({ appId });
    await backdateAcceptance(jobId, 6);
    await waitFor("the gate to terminate the past-deadline claim", async () =>
      Boolean((await recordRow(jobId)).status === "failed"),
    );
    const spans = recording.spans().filter((s) => s.name === "helix.jobs.execute");
    const gated = spans.find((s) => s.attributes["helix.jobs.job_id"] === jobId);
    expect(gated?.attributes["helix.outcome"]).toBe("deadline_exceeded");
  });

  test("a fenced loser is dispositioned on the span and counted, outcome `fenced`", async () => {
    const appId = anApp();
    const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
    const runnerJobId = await runnerJobIdOf(jobId);
    const begun = await fenceStore.beginAttempt(runnerJobId, 1);
    if (begun.verdict !== "started") throw new Error(`the first begin refused: ${begun.verdict}`);

    const sweeper = sweeperWithInterleavedRead(runnerJobId, async () => {
      const newer = await fenceStore.beginAttempt(runnerJobId, 2);
      if (newer.verdict !== "started") throw new Error(`the newer begin refused: ${newer.verdict}`);
    });
    sweeper.start();
    try {
      await sweeper.runPass();
    } finally {
      await sweeper.stop();
    }

    // The loser's evidence rides the recover span and the recoveries
    // counter like every disposition's: the outcome is the write's own
    // (`fenced`), the reason is the decision's code, the attempt is the one
    // the pass read. An operator reading the counter by outcome sees the
    // race, not a silent gap.
    const spans = recording.spans().filter((s) => s.name === "helix.jobs.recover");
    const fenced = spans.find((s) => s.attributes["helix.jobs.job_id"] === jobId);
    expect(fenced).toBeDefined();
    expect(fenced?.attributes["helix.outcome"]).toBe("fenced");
    expect(fenced?.attributes["helix.reason"]).toBe("timeout");
    expect(fenced?.attributes["helix.jobs.attempt"]).toBe(1);
    const recoveries = (await recording.metrics()).filter(
      (m) => m.name === "helix.jobs.recoveries" && m.attributes["helix.outcome"] === "fenced",
    );
    expect(recoveries.reduce((sum, m) => sum + m.value, 0)).toBeGreaterThanOrEqual(1);
  });
});

describe("the reconciliation's conditional writes fence a loser", () => {
  /**
   * The pass's writes are conditional (the attempt the row-read saw, or
   * nonterminal) so a competing write fences a loser instead of racing one.
   * The legs interpose the competing write — issued by the real execution
   * store (`fenceStore`, module scope), as the worker would — inside the
   * pass's own read window, through the runner-read seam every read rides.
   * Leftover non-terminal records from earlier legs answer `active`
   * (unaffected): the leg's assertions count only their own job's
   * disposition.
   */

  test("a retry's begin landing between the row-read and the requeue write is not clobbered back to queued", async () => {
    const appId = anApp();
    const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
    const runnerJobId = await runnerJobIdOf(jobId);
    const begun = await fenceStore.beginAttempt(runnerJobId, 1);
    if (begun.verdict !== "started") throw new Error(`the first begin refused: ${begun.verdict}`);

    // The pass reads the record running at attempt 1; its runner read then
    // runs the newer attempt's begin — the real one, as a re-claim would
    // issue it. The requeue must name the attempt it read: a write that
    // checked the status alone would put the record back to `queued` under a
    // live attempt, fencing off that attempt's success behind it.
    const sweeper = sweeperWithInterleavedRead(runnerJobId, async () => {
      const newer = await fenceStore.beginAttempt(runnerJobId, 2);
      if (newer.verdict !== "started") throw new Error(`the newer begin refused: ${newer.verdict}`);
    });
    sweeper.start();
    try {
      await sweeper.runPass();
    } finally {
      await sweeper.stop();
    }

    const row = await recordRow(jobId);
    expect(row.status).toBe("running");
    expect(row.attempt).toBe(2);
    expect(row.error_code).toBeNull();
    // A fenced loser is still a disposition the snapshot counts.
    expect(sweeper.snapshot().reconciled).toBe(1);
  });

  test("a worker's late failure landing between the row-read and the crashed write keeps its reported reason", async () => {
    const appId = anApp();
    const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
    const runnerJobId = await runnerJobIdOf(jobId);
    const begun = await fenceStore.beginAttempt(runnerJobId, 1);
    if (begun.verdict !== "started") throw new Error(`the first begin refused: ${begun.verdict}`);
    // The runner row reads failed — the claim-expiry shape the sweeper
    // reconciles as crashed — while the attempt's handler is still finishing.
    await direct.query(
      `UPDATE ${JOBS_PGBOSS_SCHEMA}.job SET state = 'failed', started_on = now(), output = NULL
         WHERE id = $1`,
      [runnerJobId],
    );

    // The worker's own terminal failure — the real projection, as the
    // settling worker would issue it — lands inside the pass's read window.
    // The crashed write must lose to the worker's reported failure: a
    // terminal row carries no result, so the store's own checks do not
    // refuse the overwrite — the fence is the only protection.
    const sweeper = sweeperWithInterleavedRead(runnerJobId, async () => {
      const failed = await fenceStore.failAttempt(begun.record, 1, "upstream_error", false);
      if (failed !== "projected") throw new Error(`the late failure lost: ${failed}`);
    });
    sweeper.start();
    try {
      await sweeper.runPass();
    } finally {
      await sweeper.stop();
    }

    const row = await recordRow(jobId);
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("upstream_error");
  });

  test("the shared timeout write never rewrites a terminal record, and its refusal repeats", async () => {
    // The one write both deadline enforcers run: a nonterminal record is
    // terminated with the timeout outcome, an already-terminal one is
    // refused — the affected count is how each caller learns it lost a race.
    const terminatedJobId = await seedJob({ appId: anApp(), startAfterSeconds: 3_600 });
    expect(await terminatePastDeadline(direct, "jobs", terminatedJobId)).toBe(1);
    const terminated = await recordRow(terminatedJobId);
    expect(terminated.status).toBe("failed");
    expect(terminated.error_code).toBe("timeout");
    expect(await terminatePastDeadline(direct, "jobs", terminatedJobId)).toBe(0);

    const succeededJobId = await seedJob({ appId: anApp(), startAfterSeconds: 3_600 });
    await direct.query(
      `UPDATE ${JOBS_JOB_RECORD_QUALIFIED} SET status = 'succeeded', result = '"settled"'
        WHERE job_id = $1`,
      [succeededJobId],
    );
    expect(await terminatePastDeadline(direct, "jobs", succeededJobId)).toBe(0);
    const settled = await recordRow(succeededJobId);
    expect(settled.status).toBe("succeeded");
    expect(settled.error_code).toBeNull();
  });
});

describe("the pass bound", () => {
  /** A non-terminal wrapper record with no runner machinery — the candidate read is the leg's subject. */
  async function seedRecordOnly(appId: string, createdAt: Date): Promise<string> {
    const jobId = randomUUID();
    await direct.query(
      `INSERT INTO ${JOBS_JOB_RECORD_QUALIFIED}
         (server, job_id, runner_job_id, app_id, env, owner_kind, owner_oid, type,
          generation, status, retry_key, body_sha256, created_at)
       VALUES ('jobs', $1, $2, $3, 'prod', 'user', $4, 'jobs:fetch', '1', 'queued', NULL, $5, $6)`,
      [
        jobId,
        `batch-leg-${jobId}`,
        appId,
        TEST_IDENTITY.ownerOid,
        sha256BodyDigest(new TextEncoder().encode("{}")),
        createdAt.toISOString(),
      ],
    );
    return jobId;
  }

  test("one pass considers at most its batch cap, oldest first", async () => {
    // The leg's precondition, made explicit rather than clock-dependent:
    // earlier legs leave non-terminal leftovers behind by design (never
    // cleaned mid-file), and whether one out-aged the leg's own seeds would
    // otherwise depend on the file's real runtime. Sweeping them here makes
    // the leg's own records the only candidates the pass can consider, so
    // the cap's selection is exactly the ordering the leg seeds.
    await direct.query(
      `DELETE FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE NOT (status = ANY($1::text[]))`,
      [JOB_TERMINAL_STATUSES],
    );
    const now = Date.now();
    const oldest = await seedRecordOnly(anApp(), new Date(now - 30_000));
    const middle = await seedRecordOnly(anApp(), new Date(now - 20_000));
    const newest = await seedRecordOnly(anApp(), new Date(now - 10_000));

    const bounded = new JobsRecovery({
      cancelRunnerJob: neverCancel, // no pending cancellation is arranged in these legs
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      // The bound, not the runner's answer, is the leg's subject: `cancelled`
      // makes each considered candidate's disposition a visible terminal
      // write, and anything outside the leg's own ids stays unaffected.
      readRunnerJob: async (candidate) =>
        candidate.startsWith("batch-leg-")
          ? { verdict: "found", state: "cancelled", output: null }
          : { verdict: "found", state: "active", output: null },
      batch: 2,
      intervalMs: 3_600_000,
      log: LOG,
    });
    bounded.start();
    try {
      await bounded.runPass();
      expect((await recordRow(oldest)).status).toBe("cancelled");
      expect((await recordRow(middle)).status).toBe("cancelled");
      expect((await recordRow(newest)).status).toBe("queued");
      expect(bounded.snapshot().reconciled).toBe(2);

      await bounded.runPass();
      expect((await recordRow(newest)).status).toBe("cancelled");
      expect(bounded.snapshot().reconciled).toBe(3);
    } finally {
      await bounded.stop();
    }
  });
});

describe("the cadence under failure", () => {
  test("a pass that cannot answer is retried on the cadence — the loop never ends itself", async () => {
    const failing = new JobsRecovery({
      cancelRunnerJob: neverCancel, // no pending cancellation is arranged in these legs
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      readRunnerJob: async () => ({ verdict: "unavailable", reason: "the runner has not started" }),
      intervalMs: 100,
      log: LOG,
    });
    failing.start();
    try {
      await waitFor(
        "the cadence to retry failed passes",
        async () => failing.snapshot().passes >= 3,
      );
    } finally {
      await failing.stop();
    }
  });

  test("a pass whose own failure reporting throws does not end the loop — the next pass still runs", async () => {
    // The pass's catch path reports through the logger; a logger that throws
    // there rejects the pass. The in-flight guard must clear on rejection
    // too — otherwise every later pass coalesces into the settled rejection
    // and the sweeper never reconciles again while the cadence ticks on.
    let failures = 0;
    const throwingOnce = {
      info: () => {},
      warn: () => {},
      error: () => {
        failures += 1;
        if (failures === 1) throw new Error("the reporting sink itself is broken");
      },
    };
    const unreachable = new JobsRecovery({
      cancelRunnerJob: neverCancel, // no pending cancellation is arranged in these legs
      databaseUrl: urlFor(SCRATCH_DB, "helix_jobs_no_such_role"),
      statementTimeoutMs: 2_000,
      readRunnerJob: async () => ({ verdict: "missing" }),
      intervalMs: 3_600_000,
      log: throwingOnce,
    });
    unreachable.start();
    try {
      await expect(unreachable.runPass()).rejects.toThrow("the reporting sink itself is broken");
      // The loop's own contract (a failed pass never ends the cadence): the
      // next pass runs, fails the same way, and is reported and counted.
      await unreachable.runPass();
      expect(failures).toBe(2);
      // Both passes are counted: accounting precedes reporting, so a pass's
      // count survives its own report's throw (the accounting legs in "a
      // failed pass's accounting survives its own reporting").
      expect(unreachable.snapshot().passes).toBe(2);
    } finally {
      await unreachable.stop().catch(() => {});
    }
  });

  test("stop waits for the in-flight pass — no client is pulled out from under itself", async () => {
    // The leg's own job is what keeps the pass busy across the stop: its
    // runner read is held open, so the pass is still mid-flight when stop()
    // is awaited — and stop must not resolve before the pass has settled.
    const jobId = await seedJob({ appId: anApp(), startAfterSeconds: 3_600 });
    const runnerJobId = await runnerJobIdOf(jobId);
    let passSettled = false;
    const settling = new JobsRecovery({
      cancelRunnerJob: neverCancel, // no pending cancellation is arranged in these legs
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      readRunnerJob: async (candidate) => {
        if (candidate !== runnerJobId) {
          return { verdict: "found", state: "active", output: null };
        }
        await new Promise((r) => setTimeout(r, 150));
        return { verdict: "found", state: "active", output: null };
      },
      intervalMs: 3_600_000,
      log: LOG,
    });
    settling.start();
    void settling.runPass().then(() => {
      passSettled = true;
    });
    await settling.stop();
    expect(passSettled).toBe(true);
  });
});

describe("the recovery writes against a live attempt", () => {
  /**
   * The sweeper's writes meeting a worker that is still running: the
   * deadline arm terminating mid-flight work whose success then arrives,
   * the requeue write racing the worker's own delayed projection, and the
   * requeued record's exposure to the lapsed attempt's progress reports.
   * These legs run last in the file on purpose — each leaves its job's
   * runner machinery live for a while (a stalled handler, a 60s retry
   * delay), and the pass-bound legs' oldest-first read assumes the only
   * non-terminal candidates older than its own backdated records are its
   * own.
   */
  let liveStore: JobsExecutionStore;
  beforeAll(() => {
    liveStore = new JobsExecutionStore({
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      log: LOG,
    });
    liveStore.start();
  });
  afterAll(async () => {
    await liveStore.stop();
  });

  /** A sweeper whose runner read answers only this leg's job with its real row. */
  function sweeperForOwnJob(runnerJobId: string): JobsRecovery {
    return new JobsRecovery({
      cancelRunnerJob: neverCancel, // no pending cancellation is arranged in these legs
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      readRunnerJob: async (candidate) =>
        candidate === runnerJobId
          ? readRunnerJobState(boss, candidate)
          : { verdict: "found", state: "active", output: null },
      intervalMs: 3_600_000,
      log: LOG,
    });
  }

  test(
    "the deadline passing mid-flight terminates a live attempt, and the worker's late success is discarded",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      const jobId = await seedJob({ appId });
      const runnerJobId = await runnerJobIdOf(jobId);
      const stall = stalledUntilResolved();
      handlerRuns = 0;
      currentHandler = async () => {
        handlerRuns += 1;
        await stall.promise;
        return "finished after the deadline";
      };
      try {
        // The attempt starts inside the deadline; the deadline passes while
        // the handler is mid-flight and its claim is still held.
        await waitFor("the attempt to begin", async () =>
          Boolean((await recordRow(jobId)).status === "running"),
        );
        await backdateAcceptance(jobId, 6);
        await recovery.runPass();
        expect(await recordRow(jobId)).toMatchObject({ status: "failed", error_code: "timeout" });
      } finally {
        stall.release();
      }
      // The live claim's completion lands after the termination: the runner
      // row completes (the claim was held), but the success is never
      // projected — the timeout outcome is the truth, and with no attempt
      // left the work is never re-driven.
      await waitFor("the claim to complete", async () =>
        Boolean((await runnerRow(jobId)).state === "completed"),
      );
      const row = await recordRow(jobId);
      expect(row.status).toBe("failed");
      expect(row.error_code).toBe("timeout");
      expect(row.result).toBeNull();
      expect(handlerRuns).toBe(1);
      expect(await runnerJobIdOf(jobId)).toBe(runnerJobId);
    },
  );

  test("a worker's delayed retrying-failure landing before the requeue write keeps its own reason", async () => {
    const appId = anApp();
    // The claim expires into a retry the worker's stall outlives: the row
    // reads `retry` while the record still reads `running` at attempt 1 —
    // and the worker's own wrapper projection (the retrying failure) is the
    // slow write that lands inside the pass's read window, before the
    // sweeper's requeue.
    const jobId = await seedJob({ appId, retryLimit: 1, retryDelay: 60, expireInSeconds: 2 });
    const runnerJobId = await runnerJobIdOf(jobId);
    const stall = stalledUntilResolved();
    handlerRuns = 0;
    currentHandler = async () => {
      handlerRuns += 1;
      await stall.promise;
      throw new JobsExecutionError("upstream_error");
    };
    try {
      await waitFor("the attempt to begin", async () =>
        Boolean((await recordRow(jobId)).status === "running"),
      );
      await waitFor("the claim expiry to requeue the runner row", async () =>
        Boolean((await runnerRow(jobId)).state === "retry"),
      );

      const sweeper = new JobsRecovery({
        cancelRunnerJob: neverCancel, // no pending cancellation is arranged in these legs
        databaseUrl: RUNTIME_DSN,
        statementTimeoutMs: 10_000,
        readRunnerJob: async (candidate) => {
          if (candidate !== runnerJobId) {
            return { verdict: "found", state: "active", output: null };
          }
          const failed = await liveStore.failAttempt(
            { server: "jobs", jobId, type: "jobs:fetch", appId, env: "prod" },
            1,
            "upstream_error",
            true,
          );
          if (failed !== "projected") throw new Error(`the late retrying failure lost: ${failed}`);
          return readRunnerJobState(boss, candidate);
        },
        intervalMs: 3_600_000,
        log: LOG,
      });
      sweeper.start();
      try {
        await sweeper.runPass();
      } finally {
        await sweeper.stop();
      }

      // The requeue lost the race to the worker's own projection: the record
      // carries the WORKER's reason, not the sweeper's timeout fallback — a
      // requeue that fenced on the attempt alone would have clobbered it.
      const row = await recordRow(jobId);
      expect(row.status).toBe("queued");
      expect(row.error_code).toBe("upstream_error");
      expect(row.attempt).toBe(1);
      expect(sweeper.snapshot().reconciled).toBe(1);
    } finally {
      stall.release();
    }
    // Settle the leg's leftover (the record is queued, its row waiting out a
    // 60s retry delay the suite never reaches).
    await settleLeftover(jobId);
  });

  test("a lapsed claim's progress report cannot poison a record the sweeper just requeued", async () => {
    const appId = anApp();
    const jobId = await seedJob({ appId, retryLimit: 1, retryDelay: 60, expireInSeconds: 2 });
    const runnerJobId = await runnerJobIdOf(jobId);
    const stall = stalledUntilResolved();
    currentHandler = async (context) => {
      await context.report({ step: 1, of: 2, label: "lost attempt" });
      await stall.promise;
      throw new JobsExecutionError("upstream_error");
    };
    const sweeper = sweeperForOwnJob(runnerJobId);
    sweeper.start();
    try {
      await waitFor("the claim expiry to requeue the runner row", async () =>
        Boolean((await runnerRow(jobId)).state === "retry"),
      );
      const before = sweeper.snapshot().reconciled;
      await sweeper.runPass();
      const requeued = await recordRow(jobId);
      expect(requeued.status).toBe("queued");
      expect(requeued.error_code).toBe("timeout");
      expect(requeued.progress).toEqual({ step: 1, of: 2, label: "lost attempt" });

      // The stalled attempt's worker wakes and reports progress at ITS
      // attempt number: the requeue put the record to queued, so the report
      // must be refused and the lost attempt's attribution stays.
      const verdict = await liveStore.reportProgress(
        { server: "jobs", jobId, type: "jobs:fetch", appId, env: "prod" },
        1,
        { step: 9, of: 9, label: "lapsed report" },
      );
      expect(verdict).toBe("refused");
      expect((await recordRow(jobId)).progress).toEqual({ step: 1, of: 2, label: "lost attempt" });
      expect(sweeper.snapshot().reconciled).toBe(before + 1);
    } finally {
      stall.release();
      await sweeper.stop();
    }
    // Settle the leg's leftover (the record is queued, its row waiting out a
    // 60s retry delay the suite never reaches).
    await settleLeftover(jobId);
  });
});

/**
 * A pass can reject only through its own reporting — a log sink that threw
 * twice (the disposition's report, then the failed pass's own report). The
 * `pass_rejected` contract: the rejection is reported sink-guarded and the
 * release chain survives it — stop() must resolve over a rejected pass, or
 * the shutdown that stops this sweeper never releases what it acquired.
 */
describe("a pass whose reporting threw, at stop", () => {
  test("stop releases through a rejected pass — the release chain survives", async () => {
    const appId = anApp();
    const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
    const runnerJobId = await runnerJobIdOf(jobId);
    const events: Array<Record<string, unknown>> = [];
    const throws = (fields: Record<string, unknown>): void => {
      events.push(fields);
      throw new Error("the reporting sink is down");
    };
    const broken = new JobsRecovery({
      cancelRunnerJob: neverCancel, // no pending cancellation is arranged in these legs
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      // The leg's own record is the pass's candidate: the pass is held open
      // in its read while stop() arrives, then reports `row_missing` through
      // the broken sink — the report's throw rejects the pass during the
      // stop's await.
      readRunnerJob: async (candidate) => {
        if (candidate !== runnerJobId) {
          return { verdict: "found", state: "active", output: null };
        }
        await new Promise((r) => setTimeout(r, 200));
        return { verdict: "missing" };
      },
      intervalMs: 3_600_000,
      log: {
        info: (fields) => throws(fields),
        warn: (fields) => throws(fields),
        error: (fields) => throws(fields),
      },
    });
    broken.start();
    await new Promise((r) => setTimeout(r, 50)); // the pass is mid-read
    try {
      await expect(broken.stop()).resolves.toBeUndefined();
      // The pass finishing during the stop reported its rejection — the
      // release's own `pass_rejected` through the broken sink — and wrote
      // nothing: a stopped sweeper's reconciliation fences itself out.
      expect(events.some((e) => e["event"] === "jobs.recovery.pass_rejected")).toBe(true);
      const mine = await recordRow(jobId);
      expect(mine.status).toBe("queued");
    } finally {
      await broken.stop().catch(() => {});
    }
  });
});

describe("a timer-driven pass whose reporting threw", () => {
  test("is not an unhandled rejection, and the cadence continues", async () => {
    // Every pass's launch handles its own rejection: the timer callback
    // reschedules on either settlement half (the same contract the
    // runPass-level proving test pins), so a pass whose failure report
    // threw (this sink, twice per pass) never becomes an unhandled
    // rejection in the process serving the health body, and the next pass
    // still runs. A launch that dropped the guard turns this red.
    const events: string[] = [];
    const captured: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      captured.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const broken = new JobsRecovery({
      cancelRunnerJob: neverCancel, // no pending cancellation is arranged in these legs
      // No such role: the pass's own store query fails, its catch reports,
      // and the report's sink throw is what rejects the pass.
      databaseUrl: urlFor(SCRATCH_DB, "helix_jobs_no_such_role"),
      statementTimeoutMs: 2_000,
      readRunnerJob: async () => ({ verdict: "missing" }),
      intervalMs: 50,
      log: {
        info: (fields) => {
          events.push(String(fields.event));
          throw new Error("the reporting sink is down");
        },
        warn: (fields) => {
          events.push(String(fields.event));
          throw new Error("the reporting sink is down");
        },
        error: (fields) => {
          events.push(String(fields.event));
          throw new Error("the reporting sink is down");
        },
      },
    });
    try {
      broken.start();
      const passedBy = Date.now() + 3_000;
      while (
        Date.now() < passedBy &&
        events.filter((e) => e === "jobs.recovery.pass_failed").length < 3
      ) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(events.filter((e) => e === "jobs.recovery.pass_failed").length).toBeGreaterThanOrEqual(
        3,
      );
      expect(captured).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      await broken.stop().catch(() => {});
    }
  });
});

/** A sink that records every event name, then throws — the rejection's origin. */
function brokenSink(): { events: string[]; log: JobsRecoveryLogger } {
  const events: string[] = [];
  const throwing = (fields: Record<string, unknown>): void => {
    events.push(String(fields.event));
    throw new Error("the reporting sink is down");
  };
  return {
    events,
    log: { info: throwing, warn: throwing, error: throwing },
  };
}

describe("a failed pass's accounting survives its own reporting", () => {
  /**
   * The module's own contract for a failed pass is three clauses: logged,
   * COUNTED, and never ending the cadence. Both failure arms report before
   * they account, and neither report is sink-guarded — so a reporting sink
   * that throws skips `recordPass` entirely: the pass ran, its rejection is
   * absorbed, the cadence continues, and the snapshot counts nothing. The
   * storage fix's own standard is the comparison: "a probe that cannot run
   * is still a probe that ran" — its counter survives its sink. These legs
   * pin the same standard here.
   */

  test("a pass whose store query fails is still counted when the reporting sink is down", async () => {
    const { events, log } = brokenSink();
    const broken = new JobsRecovery({
      cancelRunnerJob: neverCancel, // no pending cancellation is arranged in these legs
      // No such role: every pass's candidate query fails, the catch arm
      // reports `pass_failed` (the sink throws), and the accounting after it
      // is the part that must survive.
      databaseUrl: urlFor(SCRATCH_DB, "helix_jobs_no_such_role"),
      statementTimeoutMs: 2_000,
      readRunnerJob: async () => ({ verdict: "missing" }),
      intervalMs: 50,
      log,
    });
    broken.start();
    try {
      const passedBy = Date.now() + 5_000;
      while (
        Date.now() < passedBy &&
        events.filter((e) => e === "jobs.recovery.pass_failed").length < 3
      ) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(events.filter((e) => e === "jobs.recovery.pass_failed").length).toBeGreaterThanOrEqual(
        3,
      );
      // Three passes ran and failed: the snapshot must have counted them.
      expect(broken.snapshot().passes).toBeGreaterThanOrEqual(3);
    } finally {
      await broken.stop().catch(() => {});
    }
  });

  test("a pass aborted by an unavailable runner read is still counted when the reporting sink is down", async () => {
    const { events, log } = brokenSink();
    // The leg's own queued record is the pass's candidate, so the abort arm
    // fires on every pass whatever else the shared scratch database holds.
    const appId = anApp();
    const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
    const runnerJobId = await runnerJobIdOf(jobId);
    const broken = new JobsRecovery({
      cancelRunnerJob: neverCancel, // no pending cancellation is arranged in these legs
      // The store answers (the candidate read succeeds); the leg's own
      // candidate's runner read answers unavailable — the abort arm reports
      // `runner_unavailable` (the sink throws) and the accounting after it
      // must survive.
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      readRunnerJob: async (candidate) =>
        candidate === runnerJobId
          ? { verdict: "unavailable", reason: "the runner has not started" }
          : { verdict: "found", state: "active", output: null },
      intervalMs: 50,
      log,
    });
    broken.start();
    try {
      const passedBy = Date.now() + 10_000;
      while (
        Date.now() < passedBy &&
        events.filter((e) => e === "jobs.recovery.runner_unavailable").length < 3
      ) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(
        events.filter((e) => e === "jobs.recovery.runner_unavailable").length,
      ).toBeGreaterThanOrEqual(3);
      expect(broken.snapshot().passes).toBeGreaterThanOrEqual(3);
    } finally {
      await broken.stop().catch(() => {});
      await settleLeftover(jobId);
    }
  });

  test("an aborted pass is accounted exactly once — the report's throw re-entering the catch arm never double-counts", async () => {
    // The once-flag exists for ONE re-entry path: an abort arm's report that
    // throws lands the pass in the catch arm, whose `recordFailure` must see
    // the flag and skip — one pass, one accounting. (The success arm's
    // re-entry is the mirror leg above; the catch arm has no re-entry of its
    // own.) Without the flag, every aborted pass counts twice and the
    // snapshot's pass count runs ahead of the passes that actually ran —
    // the races this loop's writes exist to fence would read as twice the
    // traffic. Each pass below is driven through the seam and awaited to
    // settlement, so the count is exact, not a lower bound.
    const { events, log } = brokenSink();
    const appId = anApp();
    const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
    const runnerJobId = await runnerJobIdOf(jobId);
    const counted = new JobsRecovery({
      cancelRunnerJob: neverCancel, // no pending cancellation is arranged in these legs
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      readRunnerJob: async (candidate) =>
        candidate === runnerJobId
          ? { verdict: "unavailable", reason: "the runner has not started" }
          : { verdict: "found", state: "active", output: null },
      intervalMs: 3_600_000,
      log,
    });
    counted.start();
    try {
      // start()'s own pass aborts and is absorbed by the cadence chain.
      const abortedEvents = (): number =>
        events.filter((e) => e === "jobs.recovery.runner_unavailable").length;
      const by = Date.now() + 5_000;
      while (Date.now() < by && abortedEvents() < 1) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(abortedEvents()).toBeGreaterThanOrEqual(1);
      // Two more aborted passes, each awaited to settlement — the guard
      // cleared on the rejection, so each runs its own pass.
      await counted.runPass().catch(() => {});
      await counted.runPass().catch(() => {});
      // Three passes ran and aborted; the snapshot counted three, not six.
      expect(counted.snapshot().passes).toBe(3);
    } finally {
      await counted.stop().catch(() => {});
      await settleLeftover(jobId);
    }
  });

  test("a succeeded pass whose summary report throws is counted exactly once, and still reads ok", async () => {
    // The mirror arm of the two legs above: the success summary's own report
    // (`jobs.recovery.pass`) throws after the accounting landed — and the
    // throw re-enters the catch arm, which must not account the same pass
    // again. The summary's throw is still the caller-facing rejection (the
    // runPass seam's contract), each pass is counted ONCE, and its evidence
    // reads ok — a succeeded pass is never mislabeled failed in the counts.
    const events: string[] = [];
    const selectiveSink = {
      info: (fields: Record<string, unknown>): void => {
        const event = String(fields.event);
        events.push(event);
        if (event === "jobs.recovery.pass") throw new Error("the summary sink is down");
      },
      warn: () => {},
      error: () => {},
    };
    const counted = new JobsRecovery({
      cancelRunnerJob: neverCancel, // no pending cancellation is arranged in these legs
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      // The leg's own candidates disposition via the deadline arm (backdated
      // below), so every pass completes with a summary to report.
      readRunnerJob: async () => ({ verdict: "found", state: "active", output: null }),
      intervalMs: 3_600_000,
      log: selectiveSink,
    });
    const seedPastDeadline = async (): Promise<string> => {
      const jobId = await seedJob({ appId: anApp(), startAfterSeconds: 3_600 });
      await backdateAcceptance(jobId, 6);
      return jobId;
    };
    const first = await seedPastDeadline();
    const second = await seedPastDeadline();
    counted.start();
    try {
      // start()'s own pass summary threw first and was absorbed by the
      // cadence chain; wait for its evidence.
      const summaryThrown = Date.now() + 5_000;
      while (Date.now() < summaryThrown && !events.includes("jobs.recovery.pass")) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(events.includes("jobs.recovery.pass")).toBe(true);
      // The direct caller's pass: its summary throws too, and the failure
      // arm answers the throw (its own report succeeds on this selective
      // sink — a uniformly broken sink rejects instead; that contract is
      // the runPass seam's leg). The resolution is the succeeded pass's
      // answer; what this leg pins is the accounting:
      await counted.runPass();
      // …both dispositions landed…
      expect((await recordRow(first)).status).toBe("failed");
      expect((await recordRow(second)).status).toBe("failed");
      // …and the accounting is exact: two passes, counted once each, ok —
      // the summary's throw never re-accounted a pass.
      const snap = counted.snapshot();
      expect(snap.passes).toBe(2);
      expect(snap.reconciled).toBe(2);
      expect(snap.lastOkPassAt).not.toBeNull();
    } finally {
      await counted.stop().catch(() => {});
      await settleLeftover(first);
      await settleLeftover(second);
    }
  });
});

describe("a rejected pass at the runPass seam", () => {
  test("a rejected pass rejects to the direct caller, and the next runPass runs its own pass", async () => {
    // The runPass doc's contract for a pass whose own reporting threw has
    // two halves: the rejection is the CALLER's answer (never swallowed at
    // the seam), and the in-flight guard cleared on that rejection — so the
    // next call runs its own pass instead of riding the dead one forever.
    // The no-such-role DSN makes every pass's store query fail fast; the
    // sink throwing in the catch arm is what rejects it.
    const { events, log } = brokenSink();
    const broken = new JobsRecovery({
      cancelRunnerJob: neverCancel, // no pending cancellation is arranged in these legs
      databaseUrl: urlFor(SCRATCH_DB, "helix_jobs_no_such_role"),
      statementTimeoutMs: 2_000,
      readRunnerJob: async () => ({ verdict: "missing" }),
      intervalMs: 3_600_000,
      log,
    });
    broken.start();
    try {
      // start()'s own first pass rejects and is absorbed by the cadence chain.
      const passFailedEvents = (): number =>
        events.filter((e) => e === "jobs.recovery.pass_failed").length;
      const by = Date.now() + 5_000;
      while (Date.now() < by && passFailedEvents() < 1) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(passFailedEvents()).toBeGreaterThanOrEqual(1);

      // The direct caller's rejection…
      await expect(broken.runPass()).rejects.toThrow("the reporting sink is down");
      const afterFirst = passFailedEvents();
      expect(afterFirst).toBeGreaterThanOrEqual(2);
      // …and the guard cleared: the next call runs its OWN pass (another
      // failed pass reported), never the dead one again.
      await expect(broken.runPass()).rejects.toThrow("the reporting sink is down");
      expect(passFailedEvents()).toBeGreaterThan(afterFirst);
    } finally {
      await broken.stop().catch(() => {});
    }
  });
});

describe("the recovery log lines' documented fields", () => {
  test("the row_missing line names the job, and the summary line carries the counts and the duration", async () => {
    // The log inventory's contract for the sweeper's lines: the corrupt
    // store's error line names the occurrence (the operator locates the
    // fault from it), and the pass summary carries the counts by outcome
    // and the pass's duration (the sweep-volume alert reads those fields).
    const lines: Array<Record<string, unknown>> = [];
    const capture = (fields: Record<string, unknown>): void => {
      lines.push(fields);
    };
    const appId = anApp();
    const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
    const runnerJobId = await runnerJobIdOf(jobId);
    await direct.query(`DELETE FROM ${JOBS_PGBOSS_SCHEMA}.job WHERE id = $1`, [runnerJobId]);

    const sweeper = new JobsRecovery({
      cancelRunnerJob: neverCancel, // no pending cancellation is arranged in these legs
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      readRunnerJob: async (candidate) =>
        candidate === runnerJobId
          ? { verdict: "missing" }
          : { verdict: "found", state: "active", output: null },
      intervalMs: 3_600_000,
      log: {
        info: capture,
        warn: capture,
        error: capture,
      },
    });
    sweeper.start();
    try {
      await sweeper.runPass();
    } finally {
      await sweeper.stop();
    }

    const rowMissing = lines.find((l) => l["event"] === "jobs.recovery.row_missing");
    expect(rowMissing).toBeDefined();
    expect(rowMissing?.appId).toBe(appId);
    expect(rowMissing?.jobId).toBe(jobId);
    expect(rowMissing?.outcome).toBe("row_missing");

    const summary = lines.find((l) => l["event"] === "jobs.recovery.pass");
    expect(summary).toBeDefined();
    expect(summary?.counts).toEqual({ row_missing: 1 });
    expect(typeof summary?.durationMs).toBe("number");
    expect(summary?.durationMs).toBeGreaterThanOrEqual(0);
  });
});
