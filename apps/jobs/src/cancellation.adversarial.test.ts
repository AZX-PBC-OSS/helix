import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  JobErrorMessages,
  resolveJobsCapacityLimits,
  type JobsCapacityLimits,
} from "@azx-pbc/shared";

import { JobsAcceptanceStore, createPgbossEnqueuer } from "./acceptance.js";
import { JobsCancellationStore, type RunnerJobCanceller } from "./cancellation.js";
import {
  JobsExecution,
  JobsExecutionStore,
  JobsHandlerRegistry,
  type JobsHandler,
} from "./execution.js";
import { JobsLifecycleStore } from "./lifecycle.js";
import { migrateJobsStorage } from "./migrate.js";
import {
  JOBS_APP_LIFECYCLE_QUALIFIED,
  JOBS_JOB_RECORD_QUALIFIED,
  JOBS_PGBOSS_SCHEMA,
  JOBS_RUNTIME_ROLE,
  jobsRuntimeBossOptions,
} from "./policy.js";
import { JobsRecovery } from "./recovery.js";
import { cancelRunnerJob, readRunnerJobState } from "./runner.js";
import { seedRunnerJobWithRecord } from "./test/recordSeed.js";
import { applyRolesProvisioning } from "../../portal/src/test/provisionDatabases.js";
import { cancelClaims, submitClaims, TEST_IDENTITY } from "./test/instructions.js";

/**
 * Adversarial legs for the owner-cancellation seam: the race windows and
 * interleavings the ordered legs cannot arrange. Each leg constructs a real
 * mid-flight state through the real machinery — the parked worker-start
 * gate, the lost runner drive, two callers at once — and asserts the
 * invariant the fencing promises, whichever arm of the race wins.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

const SCRATCH_DB = `helix_jobs_cancel_adv_${randomUUID().replaceAll("-", "")}`;

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

/** Bounded wait for a state the machinery's own cadence produces. */
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
let cancellation: JobsCancellationStore;
let acceptance: JobsAcceptanceStore;
let lifecycle: JobsLifecycleStore;
let recovery: JobsRecovery;
let direct: Pool;

beforeAll(async () => {
  await applyRolesProvisioning(SCRATCH_DB);
  await migrateJobsStorage(urlFor(SCRATCH_DB, "helix_jobs_migrate"));
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
  acceptance = new JobsAcceptanceStore({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    limits: LIMITS,
    enqueuer: createPgbossEnqueuer(boss),
    log: LOG,
  });
  acceptance.start();
  lifecycle = new JobsLifecycleStore({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    log: LOG,
  });
  lifecycle.start();
  cancellation = new JobsCancellationStore({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    cancelRunnerJob: (runnerJobId) => cancelRunnerJob(boss, runnerJobId),
    log: LOG,
  });
  cancellation.start();
  // The sweeper's cadence is test-driven (every pass below is explicit).
  recovery = new JobsRecovery({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    readRunnerJob: (runnerJobId) => readRunnerJobState(boss, runnerJobId),
    cancelRunnerJob: (runnerJobId) => cancelRunnerJob(boss, runnerJobId),
    intervalMs: 3_600_000,
    log: LOG,
  });
  recovery.start();
  direct = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
}, 60_000);

afterAll(async () => {
  await direct.end();
  await recovery.stop();
  await cancellation.stop();
  await acceptance.stop();
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
let handlerInvocations = 0;
handlers.register("jobs:fetch", (context) => {
  handlerInvocations += 1;
  return currentHandler(context);
});

/** Each test's own app — the uuid the identity schemas accept, disjoint per leg. */
function anApp(): string {
  return randomUUID();
}

/** Seed one queued arrangement on the real store, its generation delivered. */
async function seedJob(options: {
  appId: string;
  data?: object;
  retryLimit?: number;
  retryDelay?: number;
  startAfterSeconds?: number;
}): Promise<string> {
  await lifecycle.apply(options.appId, { generation: "1", archived: false });
  return seedRunnerJobWithRecord(boss, direct, {
    appId: options.appId,
    data: options.data ?? { url: "https://example.com/data.json" },
    retryLimit: options.retryLimit,
    retryDelay: options.retryDelay,
    startAfterSeconds: options.startAfterSeconds,
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

/** The stored runner id a seeded job was enqueued as. */
async function runnerJobIdOf(jobId: string): Promise<string> {
  const row = await recordRow(jobId);
  if (typeof row.runner_job_id !== "string") throw new Error(`no runner id for job ${jobId}`);
  return row.runner_job_id;
}

/** A deferred the racing legs control. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A one-owner-cancellation request under the leg's own identity, for one job id. */
function cancelRequestFor(jobId: string, appId: string) {
  return {
    claims: cancelClaims({ jobId, identity: { ...TEST_IDENTITY, appId } }),
    jobId,
  };
}

describe("the cancellation seam under race", () => {
  test(
    "two simultaneous cancellation requests are both acknowledged and leave exactly one recorded intent",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
      const request = cancelRequestFor(jobId, appId);

      const [first, second] = await Promise.all([
        cancellation.requestCancel(request),
        cancellation.requestCancel(request),
      ]);
      expect(first).toEqual({ outcome: "requested" });
      expect(second).toEqual({ outcome: "requested" });

      // The concurrent form of the harmless repeat: the record carries the
      // intent once written, still non-terminal, and the runner row stopped.
      const row = await recordRow(jobId);
      expect(row.cancellation_requested).toBe(true);
      expect(row.status).toBe("queued");
      expect((await runnerRow(jobId)).state).toBe("cancelled");
    },
  );

  test(
    "a cancellation racing the attempt's settlement preserves exactly one outcome — the result iff the completion won",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      const jobId = await seedJob({ appId });
      const release = deferred();
      currentHandler = async (context) => {
        await context.report({ step: 1, of: 1, label: "started" });
        await release.promise;
        return { raced: true };
      };
      await waitFor("the attempt to begin", async () => {
        return (await recordRow(jobId)).status === "running";
      });

      // The intent's write and the attempt's own settle, released together:
      // whichever terminal outcome commits first is the record's.
      const cancelPromise = cancellation.requestCancel(cancelRequestFor(jobId, appId));
      release.resolve();
      const verdict = await cancelPromise;
      expect(verdict).toEqual({ outcome: "requested" });

      // The completed arm converges on its own (the attempt's settle and
      // wrapper write); the cancelled arm's projection is the pass's. The
      // row settles first either way, and the completed arm's wrapper write
      // follows within its own statement — the pass runs only after the
      // record has stopped moving on its own, so the pass never projects
      // over a live attempt.
      await waitFor("the runner row to settle", async () => {
        const state = (await runnerRow(jobId)).state;
        return state === "completed" || state === "cancelled";
      });
      await waitFor("the record to stop moving on its own", async () => {
        const row = await recordRow(jobId);
        const state = (await runnerRow(jobId)).state;
        return state === "cancelled" || row.status !== "running";
      });
      await recovery.runPass();

      const row = await recordRow(jobId);
      if (row.status === "succeeded") {
        // The completion won: its result is preserved.
        expect(JSON.parse(row.result as string)).toEqual({ raced: true });
      } else {
        // The intent won: the late result is discarded, never stored.
        expect(row.status).toBe("cancelled");
        expect(row.error_code).toBe("cancelled");
        expect(row.result).toBeNull();
      }
    },
  );

  test(
    "an acknowledged cancellation whose claim was starting when the intent committed reaches cancelled, not the crashed disposition",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      // Held off-claim so the claim arrives while the leg watches.
      const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
      handlerInvocations = 0;
      currentHandler = async () => "must never run";

      // Park the worker-start gate mid-transaction: the gate reads the
      // record first, then takes the app_lifecycle row lock for the
      // eligibility check. Holding that lock here holds the gate in the gap
      // between its read and its write — the gap the begin's intent-fenced
      // projection exists for.
      const locker = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
      const client = await locker.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `SELECT generation FROM ${JOBS_APP_LIFECYCLE_QUALIFIED}
            WHERE app_id = $1 FOR UPDATE`,
          [appId],
        );

        // Release the row to the claim path while the gate is parked: the
        // worker claims for real and blocks inside the gate's transaction.
        await direct.query(
          `UPDATE ${JOBS_PGBOSS_SCHEMA}.job SET start_after = now() WHERE id::text = $1`,
          [await runnerJobIdOf(jobId)],
        );
        await waitFor("the claim while the gate is parked", async () => {
          return (await runnerRow(jobId)).state === "active";
        });
        expect(await recordRow(jobId)).toMatchObject({ status: "queued" });

        // The intent commits inside the gap, and its runner drive cannot
        // answer — the seam's own unavailability verdict, exactly the
        // crash-window state on a claim that is starting.
        let drives = 0;
        const unavailableDrive: RunnerJobCanceller = async () => {
          drives += 1;
          return { verdict: "unavailable", reason: "injected drive unavailability" };
        };
        const legStore = new JobsCancellationStore({
          databaseUrl: RUNTIME_DSN,
          statementTimeoutMs: 10_000,
          cancelRunnerJob: unavailableDrive,
          log: LOG,
        });
        legStore.start();
        try {
          const verdict = await legStore.requestCancel(cancelRequestFor(jobId, appId));
          expect(verdict).toEqual({ outcome: "requested" });
          expect(drives).toBe(1);
        } finally {
          await legStore.stop();
        }

        // The gate resumes: its stale read says no intent, its fenced write
        // refuses, the handler never runs, and the claim settles through
        // the runner's own retry policy.
        await client.query("COMMIT");
      } finally {
        client.release();
        await locker.end();
      }

      await waitFor("the fence-refused claim to settle", async () => {
        return (await runnerRow(jobId)).state === "failed";
      });
      expect(handlerInvocations).toBe(0);

      // The pending intent's pass. The work never ran and the owner's
      // cancellation was acknowledged: the only truthful terminal outcome
      // is the intent's `cancelled` — never the crashed disposition a
      // start-refused claim's settle would otherwise reconcile to.
      await recovery.runPass();
      const row = await recordRow(jobId);
      expect(row.status).toBe("cancelled");
      expect(row.error_code).toBe("cancelled");
      expect(row.cancellation_requested).toBe(true);
    },
  );

  test(
    "the gate's own transaction commits the cancellation when the intent lands inside its begin — the record is already terminal when the claim settles, before any pass",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      // The same parked-gate arrangement as the leg above: the gate reads
      // the record, then blocks on the app_lifecycle lock, and the intent
      // commits inside that gap.
      const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
      handlerInvocations = 0;
      currentHandler = async () => "must never run";

      const locker = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
      const client = await locker.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `SELECT generation FROM ${JOBS_APP_LIFECYCLE_QUALIFIED}
            WHERE app_id = $1 FOR UPDATE`,
          [appId],
        );
        await direct.query(
          `UPDATE ${JOBS_PGBOSS_SCHEMA}.job SET start_after = now() WHERE id::text = $1`,
          [await runnerJobIdOf(jobId)],
        );
        await waitFor("the claim while the gate is parked", async () => {
          return (await runnerRow(jobId)).state === "active";
        });
        expect(await recordRow(jobId)).toMatchObject({ status: "queued" });

        // The intent commits inside the gap; the drive cannot answer while
        // the claim is live.
        const legStore = new JobsCancellationStore({
          databaseUrl: RUNTIME_DSN,
          statementTimeoutMs: 10_000,
          cancelRunnerJob: async () => ({
            verdict: "unavailable",
            reason: "injected drive unavailability",
          }),
          log: LOG,
        });
        legStore.start();
        try {
          expect(await legStore.requestCancel(cancelRequestFor(jobId, appId))).toEqual({
            outcome: "requested",
          });
        } finally {
          await legStore.stop();
        }

        // The gate resumes. Its fenced write distinguishes the intent's
        // race and commits the outcome in the gate's own transaction.
        await client.query("COMMIT");
      } finally {
        client.release();
        await locker.end();
      }

      // When the fence-refused claim settles, the record must ALREADY be
      // terminal — no sweeper pass has run. This is the gate's own
      // cancellation arm, pinned apart from the recovery path's backstop:
      // the settle leaves no code-less failed row for the recovery decision
      // to reconcile at all.
      await waitFor("the fence-refused claim to settle", async () => {
        return (await runnerRow(jobId)).state === "failed";
      });
      expect(handlerInvocations).toBe(0);
      const row = await recordRow(jobId);
      expect(row.status).toBe("cancelled");
      expect(row.error_code).toBe("cancelled");
      expect(row.cancellation_requested).toBe(true);
      // The begin's projection never landed — the denied attempt left no
      // attribution, because no attempt ever was.
      expect(row.attempt).toBeNull();

      // The terminal record is not a candidate: a pass changes nothing —
      // the gate's outcome stood over the row's failed settle without help.
      await recovery.runPass();
      expect(await recordRow(jobId)).toMatchObject({
        status: "cancelled",
        error_code: "cancelled",
        attempt: null,
      });
    },
  );

  test(
    "a cancellation of a retrying job stops its scheduled re-dispatch and the record reaches cancelled, not another attempt",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      // A retriable job whose first attempt fails with a worker-reported
      // reason: the runner row schedules the re-dispatch — the one runner
      // state whose future dispatch the cancellation must stop.
      const jobId = await seedJob({ appId, retryLimit: 1, retryDelay: 2 });
      handlerInvocations = 0;
      currentHandler = async () => {
        throw new (await import("./execution.js")).JobsExecutionError("upstream_error");
      };
      await waitFor("the first attempt to fail into the retry state", async () => {
        const row = await recordRow(jobId);
        return row.status === "queued" && (await runnerRow(jobId)).state === "retry";
      });
      const runsBeforeCancel = handlerInvocations;
      expect(runsBeforeCancel).toBeGreaterThanOrEqual(1);

      const verdict = await cancellation.requestCancel(cancelRequestFor(jobId, appId));
      expect(verdict).toEqual({ outcome: "requested" });
      expect((await runnerRow(jobId)).state).toBe("cancelled");

      // Past the retry delay the row would have re-dispatched on: the
      // cancelled row never does.
      currentHandler = async () => "must never run after the cancellation";
      await new Promise((r) => setTimeout(r, 4_000));
      expect(handlerInvocations).toBe(runsBeforeCancel);

      // The pending intent's pass projects the record's terminal outcome.
      await recovery.runPass();
      const row = await recordRow(jobId);
      expect(row.status).toBe("cancelled");
      expect(row.error_code).toBe("cancelled");
    },
  );

  test(
    "an intent that lands while the attempt's completion is settling leaves the won outcome intact — the residue never misleads a later refusal",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      const jobId = await seedJob({ appId });
      const release = deferred();
      currentHandler = async (context) => {
        await context.report({ step: 1, of: 1, label: "started" });
        await release.promise;
        return { raced: true };
      };
      await waitFor("the attempt to begin", async () => {
        return (await recordRow(jobId)).status === "running";
      });

      // The intent commits against the running record, and the drive finds
      // the runner row already settled — the state a completion winning the
      // row in front of the drive leaves. The intent is recorded; the row's
      // outcome is not the intent's.
      let drives = 0;
      const legStore = new JobsCancellationStore({
        databaseUrl: RUNTIME_DSN,
        statementTimeoutMs: 10_000,
        cancelRunnerJob: async () => {
          drives += 1;
          return { verdict: "not_cancellable" };
        },
        log: LOG,
      });
      legStore.start();
      try {
        const verdict = await legStore.requestCancel(cancelRequestFor(jobId, appId));
        expect(verdict).toEqual({ outcome: "requested" });
        expect(drives).toBe(1);
      } finally {
        await legStore.stop();
      }
      release.resolve();

      // The attempt's own settlement and projection land: the completion
      // held its claim, so the result is preserved even though the intent
      // matched the record's pre-write snapshot.
      await waitFor("the completion to project", async () => {
        return (await recordRow(jobId)).status === "succeeded";
      });
      await recovery.runPass(); // a terminal record is not a candidate — nothing changes

      const row = await recordRow(jobId);
      expect(row.status).toBe("succeeded");
      expect(JSON.parse(row.result as string)).toEqual({ raced: true });
      expect(row.cancellation_requested).toBe(true);

      // And a later cancellation reads the record's own outcome — the
      // residue on the succeeded record never turns a refusal into a
      // re-drive or a fabricated state.
      const later = await cancellation.requestCancel(cancelRequestFor(jobId, appId));
      expect(later).toEqual({ outcome: "terminal", status: "succeeded", error: null });
      expect((await recordRow(jobId)).status).toBe("succeeded");
    },
  );

  test(
    "a fenced begin that lost to a newer attempt stays fenced — the re-read never cancels a live attempt the intent never touched",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      // Held off-claim: the worker never reaches this arrangement — the
      // leg drives the execution store directly, the way a delayed stale
      // claim's begin would arrive.
      const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
      // A newer attempt's begin has committed: the record is running at
      // attempt 2, no cancellation intent anywhere.
      await direct.query(
        `UPDATE ${JOBS_JOB_RECORD_QUALIFIED} SET status = 'running', attempt = 2
          WHERE job_id = $1`,
        [jobId],
      );
      const legStore = new JobsExecutionStore({
        databaseUrl: RUNTIME_DSN,
        statementTimeoutMs: 10_000,
        log: LOG,
      });
      legStore.start();
      try {
        // The stale claim's begin: its attempt number is not newer than the
        // stored one, so its projection is fenced — and the re-read must
        // answer "still open, but no intent" with a rollback, never a
        // cancellation of the live attempt.
        const stale = await legStore.beginAttempt(await runnerJobIdOf(jobId), 1);
        expect(stale).toEqual({ verdict: "terminal_fenced" });
        const row = await recordRow(jobId);
        expect(row.status).toBe("running");
        expect(row.attempt).toBe(2);
        expect(row.cancellation_requested).toBe(false);
        expect(row.error_code).toBeNull();
        expect(row.result).toBeNull();

        // And the fence was the staleness, not a stuck state: a genuinely
        // newer attempt number begins and projects.
        const newer = await legStore.beginAttempt(await runnerJobIdOf(jobId), 3);
        expect(newer.verdict).toBe("started");
        expect(await recordRow(jobId)).toMatchObject({ status: "running", attempt: 3 });
      } finally {
        await legStore.stop();
      }
    },
  );

  test(
    "a fenced begin that lost to a completed record leaves the won outcome intact — the re-read rolls back, never projects over a terminal write",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
      handlerInvocations = 0;
      currentHandler = async () => "must never run";

      // Park the worker-start gate mid-transaction, exactly as the
      // parked-gate legs do, and let the claim arrive while held.
      const locker = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
      const client = await locker.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `SELECT generation FROM ${JOBS_APP_LIFECYCLE_QUALIFIED}
            WHERE app_id = $1 FOR UPDATE`,
          [appId],
        );
        await direct.query(
          `UPDATE ${JOBS_PGBOSS_SCHEMA}.job SET start_after = now() WHERE id::text = $1`,
          [await runnerJobIdOf(jobId)],
        );
        await waitFor("the claim while the gate is parked", async () => {
          return (await runnerRow(jobId)).state === "active";
        });

        // The completion's own projection wins the gap: the record goes
        // terminal with its result while the gate holds its stale read.
        await direct.query(
          `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
              SET status = 'succeeded', result = '{"won":true}', error_code = NULL
            WHERE job_id = $1`,
          [jobId],
        );

        // The gate resumes: its fenced write loses to the terminal record,
        // and the re-read's still-open half must answer no — the outcome
        // that committed first keeps the record, with no cancellation
        // projected over it.
        await client.query("COMMIT");
      } finally {
        client.release();
        await locker.end();
      }

      await waitFor("the fence-refused claim to settle", async () => {
        return (await runnerRow(jobId)).state === "failed";
      });
      expect(handlerInvocations).toBe(0);
      const row = await recordRow(jobId);
      expect(row.status).toBe("succeeded");
      expect(JSON.parse(row.result as string)).toEqual({ won: true });
      expect(row.cancellation_requested).toBe(false);

      // The terminal record is not a candidate: the row's own failed settle
      // — the fence-refused claim's retry policy — never reconciles over the
      // record's won outcome.
      await recovery.runPass();
      const after = await recordRow(jobId);
      expect(after.status).toBe("succeeded");
      expect(JSON.parse(after.result as string)).toEqual({ won: true });
    },
  );
});

describe("the cancellation seam's retry-key interaction", () => {
  test(
    "a keyed re-submission of a cancelled job recovers the record with its cancelled status; different bytes conflict with that state",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      await lifecycle.apply(appId, { generation: "1", archived: false });
      const claims = submitClaims({
        identity: { ...TEST_IDENTITY, appId },
        generation: "1",
        idempotencyKey: "cancel-replay-key",
      });
      const body = new TextEncoder().encode('{"url":"https://example.com/data.json"}');

      // Accepted through the real acceptance transaction, then cancelled to
      // its terminal outcome through the seam under attack.
      const accepted = await acceptance.admit({ claims, body });
      expect(accepted).toMatchObject({ outcome: "accepted", status: "queued" });
      const jobId = (accepted as { jobId: string }).jobId;
      const verdict = await cancellation.requestCancel(cancelRequestFor(jobId, appId));
      expect(verdict).toEqual({ outcome: "requested" });
      // The sweeper's cadence is test-driven here: one pass carries the
      // pending intent to the record's terminal outcome.
      await recovery.runPass();
      await waitFor("the record to converge cancelled", async () => {
        return (await recordRow(jobId)).status === "cancelled";
      });

      // The edge's lost-acknowledgement retry presents the same key and the
      // same bytes: the keyed recovery must answer the record's own state —
      // never new work, never a fabricated status.
      const replay = await acceptance.admit({ claims, body });
      expect(replay).toEqual({ outcome: "recovered", jobId, status: "cancelled" });

      // And different bytes under the same key conflict with the cancelled
      // state — the conflict's error is the cancellation's own wire error.
      const conflict = await acceptance.admit({
        claims,
        body: new TextEncoder().encode('{"url":"https://example.com/other.json"}'),
      });
      expect(conflict).toEqual({
        outcome: "conflict",
        status: "cancelled",
        error: { code: "cancelled", message: JobErrorMessages.cancelled },
      });
      // The record is exactly as the cancellation left it, whatever the
      // replays answered.
      expect(await recordRow(jobId)).toMatchObject({
        status: "cancelled",
        error_code: "cancelled",
        cancellation_requested: true,
      });
    },
  );
});
