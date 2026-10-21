import { randomUUID } from "node:crypto";
import { SpanStatusCode } from "@opentelemetry/api";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { resolveJobsCapacityLimits, type JobsCapacityLimits } from "@azx-pbc/shared";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";

import { JobsCancellationStore, type RunnerJobCanceller } from "./cancellation.js";
import { JobsExecution, JobsHandlerRegistry, type JobsHandler } from "./execution.js";
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
import { cancelClaims, TEST_IDENTITY } from "./test/instructions.js";

/**
 * The owner-cancellation seam against the real store, the real runner and
 * the real role split: the durable intent's write and refusals, the queued
 * job that never dispatches, the running attempt aborted through the
 * worker's own signal, the fenced late completion, and the pending intent
 * the sweeper re-drives. The route's response mapping is pinned against the
 * in-memory double in `operations.test.ts`; these legs prove the durability
 * and the racing semantics the double cannot.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

const SCRATCH_DB = `helix_jobs_cancel_${randomUUID().replaceAll("-", "")}`;

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
  lifecycle = new JobsLifecycleStore({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    log: LOG,
  });
  lifecycle.start();
  cancellation = new JobsCancellationStore({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    // The real runner adapter over this suite's own started instance — the
    // same adapter production composes.
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

/** Seed one queued arrangement on the real store, its generation delivered. */
async function seedJob(options: {
  appId: string;
  data?: object;
  retryLimit?: number;
  startAfterSeconds?: number;
}): Promise<string> {
  await lifecycle.apply(options.appId, { generation: "1", archived: false });
  return seedRunnerJobWithRecord(boss, direct, {
    appId: options.appId,
    data: options.data ?? { url: "https://example.com/data.json" },
    retryLimit: options.retryLimit,
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

/**
 * Write the durable intent directly — the state a crash between the intent
 * write and the runner drive leaves, which no settled request can produce.
 * The pending-since instant rides the write: intent without it is
 * unrepresentable in the store (the check the migration converges), and the
 * instant is what the recovery backlog's age reads.
 */
async function writeIntentDirectly(jobId: string): Promise<void> {
  await direct.query(
    `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
        SET cancellation_requested = true, cancellation_requested_at = COALESCE(cancellation_requested_at, now())
      WHERE job_id = $1`,
    [jobId],
  );
}

/** A deferred the aborted-attempt legs control. */
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

describe("the owner-cancellation seam", () => {
  test(
    "a queued job's cancellation is durable, stops the runner row before dispatch, and the pass projects the terminal outcome",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      // Held off-claim: the arrangement is a queued job the worker cannot
      // reach yet, exactly the state the acknowledgement is about.
      const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
      const runnerJobId = await runnerJobIdOf(jobId);

      const verdict = await cancellation.requestCancel(cancelRequestFor(jobId, appId));
      expect(verdict).toEqual({ outcome: "requested" });

      // The intent is durable, and the runner row stopped before dispatch.
      const row = await recordRow(jobId);
      expect(row.cancellation_requested).toBe(true);
      expect(row.status).toBe("queued");
      expect((await runnerRow(jobId)).state).toBe("cancelled");

      // The cancelled row is never dispatched: long past the hold, the
      // handler has still never run.
      handlerRuns = 0;
      currentHandler = async () => {
        handlerRuns += 1;
        return "must never run";
      };
      await new Promise((r) => setTimeout(r, 2_000));
      expect(handlerRuns).toBe(0);

      // The pass reconciles the cancelled row into the record's terminal
      // outcome — the reference unchanged.
      await recovery.runPass();
      const terminal = await recordRow(jobId);
      expect(terminal.status).toBe("cancelled");
      expect(terminal.error_code).toBe("cancelled");
      expect(terminal.cancellation_requested).toBe(true);
      expect(await runnerJobIdOf(jobId)).toBe(runnerJobId);

      // A second pass changes nothing: the record is terminal.
      await recovery.runPass();
      expect((await recordRow(jobId)).status).toBe("cancelled");
    },
  );

  test(
    "a repeated request while active is harmless and still acknowledges",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
      const first = await cancellation.requestCancel(cancelRequestFor(jobId, appId));
      expect(first).toEqual({ outcome: "requested" });
      // The pending-since instant: the first request's — the age the recovery
      // backlog reads, so a repeat can never reset the wait it measures.
      const firstPendingAt = (await recordRow(jobId)).cancellation_requested_at;
      expect(firstPendingAt).toBeInstanceOf(Date);
      const second = await cancellation.requestCancel(cancelRequestFor(jobId, appId));
      expect(second).toEqual({ outcome: "requested" });
      // The state the first request recorded is exactly what the second
      // left: no second effect, the same acknowledgement, the same instant.
      const row = await recordRow(jobId);
      expect(row.cancellation_requested).toBe(true);
      expect(row.cancellation_requested_at).toEqual(firstPendingAt);
      expect((await runnerRow(jobId)).state).toBe("cancelled");
    },
  );

  test(
    "a terminal job's cancellation preserves its existing outcome",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      const jobId = await seedJob({ appId });
      currentHandler = async () => ({ kept: true });
      await waitFor("the job to succeed", async () => {
        const row = await recordRow(jobId);
        return row.status === "succeeded";
      });

      const verdict = await cancellation.requestCancel(cancelRequestFor(jobId, appId));
      expect(verdict).toEqual({
        outcome: "terminal",
        status: "succeeded",
        error: null,
      });
      const row = await recordRow(jobId);
      expect(row.status).toBe("succeeded");
      expect(row.cancellation_requested).toBe(false);
      expect(JSON.parse(row.result as string)).toEqual({ kept: true });
      expect((await runnerRow(jobId)).state).toBe("completed");

      // A failed job's 409 state carries its stored execution error.
      const failedApp = anApp();
      const failedId = await seedJob({ appId: failedApp });
      currentHandler = async () => {
        throw new (await import("./execution.js")).JobsExecutionError("upstream_error");
      };
      await waitFor("the job to fail", async () => {
        const row = await recordRow(failedId);
        return row.status === "failed";
      });
      const failedVerdict = await cancellation.requestCancel(cancelRequestFor(failedId, failedApp));
      expect(failedVerdict).toEqual({
        outcome: "terminal",
        status: "failed",
        error: { code: "upstream_error", message: "The upstream request failed." },
      });
      expect((await recordRow(failedId)).status).toBe("failed");
    },
  );

  test(
    "a foreign or ungranted caller is refused without recording anything",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });

      // A different owner: the same 404 an unknown job answers with.
      const otherOwner = await cancellation.requestCancel({
        claims: cancelClaims({ jobId, identity: { ...TEST_IDENTITY, ownerOid: "someone-else" } }),
        jobId,
      });
      expect(otherOwner).toEqual({ outcome: "not_found" });
      // A different app: the same 404.
      const otherApp = await cancellation.requestCancel({
        claims: cancelClaims({ jobId, identity: { ...TEST_IDENTITY, appId: randomUUID() } }),
        jobId,
      });
      expect(otherApp).toEqual({ outcome: "not_found" });
      // A different environment and a different principal kind: the same 404.
      expect(
        await cancellation.requestCancel({
          claims: cancelClaims({ jobId, identity: { ...TEST_IDENTITY, env: "dev" } }),
          jobId,
        }),
      ).toEqual({ outcome: "not_found" });
      expect(
        await cancellation.requestCancel({
          claims: cancelClaims({ jobId, identity: { ...TEST_IDENTITY, ownerKind: "dev" } }),
          jobId,
        }),
      ).toEqual({ outcome: "not_found" });
      // A grant that does not cover the record's type: 403.
      expect(
        await cancellation.requestCancel({
          claims: cancelClaims({
            jobId,
            identity: { ...TEST_IDENTITY, appId, allowedTypes: ["jobs:other"] },
          }),
          jobId,
        }),
      ).toEqual({ outcome: "forbidden" });
      // An EMPTY grant set — a caller authorized to use jobs but granted no
      // types — is fail-closed the same way: nothing matches, nothing records.
      expect(
        await cancellation.requestCancel({
          claims: cancelClaims({
            jobId,
            identity: { ...TEST_IDENTITY, appId, allowedTypes: [] },
          }),
          jobId,
        }),
      ).toEqual({ outcome: "forbidden" });

      // Nothing was recorded on the record, and the runner row is untouched.
      const row = await recordRow(jobId);
      expect(row.cancellation_requested).toBe(false);
      expect(row.status).toBe("queued");
      expect((await runnerRow(jobId)).state).toBe("created");
    },
  );

  test(
    "a refusal's ordering holds against a terminal record — identity and grant precede the stateful answer",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      const jobId = await seedJob({ appId });
      currentHandler = async () => ({ finished: true });
      await waitFor("the job to succeed", async () => {
        const row = await recordRow(jobId);
        return row.status === "succeeded";
      });

      // A foreign caller against the terminal record: the same 404 an
      // unknown job answers with — identity is judged before any state is
      // revealed, so another owner's terminal job discloses nothing.
      expect(
        await cancellation.requestCancel({
          claims: cancelClaims({ jobId, identity: { ...TEST_IDENTITY, ownerOid: "someone-else" } }),
          jobId,
        }),
      ).toEqual({ outcome: "not_found" });

      // An ungranted caller against the terminal record: 403 — authorization
      // precedes the stateful 409, whose body would reveal the job's status
      // and stored error. Fail-closed holds on terminal records too.
      expect(
        await cancellation.requestCancel({
          claims: cancelClaims({
            jobId,
            identity: { ...TEST_IDENTITY, appId, allowedTypes: ["jobs:other"] },
          }),
          jobId,
        }),
      ).toEqual({ outcome: "forbidden" });

      // The terminal outcome and its result are exactly as they were, with
      // no intent recorded on the record.
      const row = await recordRow(jobId);
      expect(row.status).toBe("succeeded");
      expect(row.cancellation_requested).toBe(false);
      expect(JSON.parse(row.result as string)).toEqual({ finished: true });
    },
  );

  test(
    "a running attempt's cancellation aborts the handler through the worker's own signal and discards the late result",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      const jobId = await seedJob({ appId });
      let abortObserved: boolean | null = null;
      const abort = deferred();
      currentHandler = async (context) => {
        await context.report({ step: 1, of: 1, label: "started" });
        if (context.signal.aborted) {
          abortObserved = true;
          abort.resolve();
          return "aborted before the wait";
        }
        const aborted = context.signal.addEventListener("abort", () => {
          abortObserved = true;
          abort.resolve();
        });
        void aborted;
        await abort.promise;
        return "stopped on the abort — never settled as a result";
      };

      await waitFor("the attempt to begin", async () => {
        const row = await recordRow(jobId);
        return row.status === "running";
      });
      expect(abortObserved).toBeNull();

      const verdict = await cancellation.requestCancel(cancelRequestFor(jobId, appId));
      expect(verdict).toEqual({ outcome: "requested" });

      // The runner row lost its claim; the worker's signal aborts on the
      // heartbeat's next refresh (well inside the 60-second bound).
      await waitFor("the handler to observe the abort", async () => abortObserved === true);
      await abort.resolve();

      // The attempt's own settle is fenced (the row was already cancelled),
      // so the late result is discarded; the pass projects the intent's
      // terminal outcome.
      await waitFor("the runner row to settle cancelled", async () =>
        Boolean((await runnerRow(jobId)).state === "cancelled"),
      );
      await recovery.runPass();
      const row = await recordRow(jobId);
      expect(row.status).toBe("cancelled");
      expect(row.error_code).toBe("cancelled");
      expect(row.result).toBeNull();
      expect(row.cancellation_requested).toBe(true);
    },
  );

  test(
    "a completion that settles before the cancellation keeps its result; the intent never overwrites it",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      const jobId = await seedJob({ appId });
      currentHandler = async (context) => {
        await context.report({ step: 1, of: 1, label: "fetched" });
        return { won: "the race" };
      };
      await waitFor("the job to succeed", async () => {
        const row = await recordRow(jobId);
        return row.status === "succeeded";
      });
      // The cancellation arrives after the terminal outcome committed: it
      // reads the job's state and changes nothing.
      const verdict = await cancellation.requestCancel(cancelRequestFor(jobId, appId));
      expect(verdict).toEqual({ outcome: "terminal", status: "succeeded", error: null });
      const row = await recordRow(jobId);
      expect(row.status).toBe("succeeded");
      expect(row.cancellation_requested).toBe(false);
      expect(JSON.parse(row.result as string)).toEqual({ won: "the race" });
    },
  );

  test(
    "pending intent survives without a runner drive and the sweeper re-drives it — a restarted service resumes the cancellation",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      // Held off-claim briefly: the intent must be durable before any claim.
      const jobId = await seedJob({ appId, startAfterSeconds: 5 });
      await writeIntentDirectly(jobId);
      // The crash window's exact state: intent durable, runner cancel lost.
      const row = await recordRow(jobId);
      expect(row.cancellation_requested).toBe(true);
      expect((await runnerRow(jobId)).state).toBe("created");

      // The sweeper's pass re-drives the runner cancel and projects the
      // intent's terminal outcome; the handler never runs — the intent can
      // never turn into a run or a retry.
      handlerRuns = 0;
      currentHandler = async () => {
        handlerRuns += 1;
        return "must never run";
      };
      await recovery.runPass();
      expect((await runnerRow(jobId)).state).toBe("cancelled");
      const terminal = await recordRow(jobId);
      expect(terminal.status).toBe("cancelled");
      expect(terminal.error_code).toBe("cancelled");

      // And the row, cancelled, is never dispatched afterwards.
      await new Promise((r) => setTimeout(r, 6_000));
      expect(handlerRuns).toBe(0);
    },
  );

  test(
    "a pending intent on a live claim is re-driven by the pass, the abort lands, and the outcome is the intent's",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      const jobId = await seedJob({ appId });
      const abort = deferred();
      currentHandler = async (context) => {
        await context.signal.addEventListener("abort", () => abort.resolve());
        await abort.promise;
        return "stopped on the abort";
      };
      await waitFor("the attempt to begin", async () => {
        const row = await recordRow(jobId);
        return row.status === "running";
      });
      // The crash window on a live claim: intent durable, the runner cancel
      // lost, the worker still holding the row.
      await writeIntentDirectly(jobId);
      await recovery.runPass();
      expect((await runnerRow(jobId)).state).toBe("cancelled");

      // The abort fires on the heartbeat's next refresh; the attempt's
      // settle is fenced; the pass's projection already committed the
      // intent's terminal outcome.
      await waitFor("the handler to observe the abort", async () => {
        const settled = await Promise.race([
          abort.promise.then(() => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), 20_000)),
        ]);
        return settled;
      });
      const row = await recordRow(jobId);
      expect(row.status).toBe("cancelled");
      expect(row.result).toBeNull();
    },
  );

  test(
    "a pending intent whose re-drive cannot answer is left for the next pass, never projected over an unseen runner state",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
      await writeIntentDirectly(jobId);

      // A sweeper whose runner cancel cannot answer: the pass must neither
      // project the outcome nor lose the intent — the next pass retries.
      // The leg-local sweeper is STARTED — runPass on an unstarted one is a
      // no-op by design, and a vacuous pass would prove nothing here.
      const unavailable: RunnerJobCanceller = async () => ({
        verdict: "unavailable",
        reason: "injected runner unavailability",
      });
      const blocked = new JobsRecovery({
        databaseUrl: RUNTIME_DSN,
        statementTimeoutMs: 10_000,
        readRunnerJob: (runnerJobId) => readRunnerJobState(boss, runnerJobId),
        cancelRunnerJob: unavailable,
        intervalMs: 3_600_000,
        log: LOG,
      });
      blocked.start();
      try {
        await blocked.runPass();
      } finally {
        await blocked.stop();
      }
      let row = await recordRow(jobId);
      expect(row.status).toBe("queued"); // nothing projected
      expect(row.cancellation_requested).toBe(true); // the intent stays pending

      // The same re-drive arriving at a row that went terminal in between:
      // the row's own outcome is what the next pass reads, never a
      // projection over an unseen state.
      const raced: RunnerJobCanceller = async () => ({ verdict: "not_cancellable" });
      const racer = new JobsRecovery({
        databaseUrl: RUNTIME_DSN,
        statementTimeoutMs: 10_000,
        readRunnerJob: (runnerJobId) => readRunnerJobState(boss, runnerJobId),
        cancelRunnerJob: raced,
        intervalMs: 3_600_000,
        log: LOG,
      });
      racer.start();
      try {
        await racer.runPass();
      } finally {
        await racer.stop();
      }
      row = await recordRow(jobId);
      expect(row.status).toBe("queued"); // still nothing projected

      // A healthy pass converges: the re-drive cancels the row, the
      // projection commits the intent's outcome.
      await recovery.runPass();
      row = await recordRow(jobId);
      expect(row.status).toBe("cancelled");
      expect((await runnerRow(jobId)).state).toBe("cancelled");
    },
  );

  test(
    "a pending intent on a runner row that settled failed is reconciled to the row's own outcome, not the intent's",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
      // The failure lands first, then the intent: the runner row is already
      // terminal, the wrapper never projected it (the execution store's
      // outage case) — the row's own failure is the truthful outcome.
      await direct.query(
        `UPDATE ${JOBS_PGBOSS_SCHEMA}.job SET state = 'failed',
            output = '{"code":"upstream_error"}'::jsonb
          WHERE id::text = $1`,
        [await runnerJobIdOf(jobId)],
      );
      await writeIntentDirectly(jobId);
      await recovery.runPass();
      const row = await recordRow(jobId);
      expect(row.status).toBe("failed");
      expect(row.error_code).toBe("upstream_error");
    },
  );

  test(
    "a pending intent on a runner row that settled failed with no worker-reported code reaches the intent's cancelled outcome — and no re-drive is even attempted",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
      // The claim-expiry crash window's own row: the drive was lost and the
      // dependency's expiry machinery settled the claim with its artifact
      // output — no worker-reported code, because no work ever ran. The
      // record is still non-terminal and the intent is pending: this is the
      // state only the recovery arm can carry to the intent's outcome (the
      // gate is not running; no begin is in flight).
      await direct.query(
        `UPDATE ${JOBS_PGBOSS_SCHEMA}.job SET state = 'failed',
            output = '{"value":{"message":"job timed out"}}'::jsonb
          WHERE id::text = $1`,
        [await runnerJobIdOf(jobId)],
      );
      await writeIntentDirectly(jobId);

      // The sweeper whose re-drive would throw if ever reached: the
      // decision's `resumeCancel: false` means the apply skips the drive
      // for a row it read terminal — a re-drive attempt here is the defect,
      // and the throw fails the pass loudly.
      const noRedrive = new JobsRecovery({
        databaseUrl: RUNTIME_DSN,
        statementTimeoutMs: 10_000,
        readRunnerJob: (runnerJobId) => readRunnerJobState(boss, runnerJobId),
        cancelRunnerJob: async () => {
          throw new Error("a terminal row must never be re-driven");
        },
        intervalMs: 3_600_000,
        log: LOG,
      });
      noRedrive.start();
      try {
        await noRedrive.runPass();
      } finally {
        await noRedrive.stop();
      }

      // The intent's outcome was projected through the real store, the
      // pass answering cleanly.
      const row = await recordRow(jobId);
      expect(row.status).toBe("cancelled");
      expect(row.error_code).toBe("cancelled");
      expect(row.cancellation_requested).toBe(true);
      // The row's own state is untouched: the projection never rewrites the
      // runner's truth, only reads it.
      expect((await runnerRow(jobId)).state).toBe("failed");
    },
  );
});

describe("the runner adapter's fenced cancel", () => {
  test(
    "a second cancel of an already-cancelled runner row answers not_cancellable — the fence the re-drive reads",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
      const runnerJobId = await runnerJobIdOf(jobId);
      await expect(cancelRunnerJob(boss, runnerJobId)).resolves.toEqual({ verdict: "cancelled" });
      // The runner row's own fence, on the real adapter: an already-stopped
      // row answers zero affected rows, never a fabricated second success —
      // the verdict a pending intent's re-drive reads as "the row's own
      // outcome is the truth, project nothing this pass".
      await expect(cancelRunnerJob(boss, runnerJobId)).resolves.toEqual({
        verdict: "not_cancellable",
      });
      expect((await runnerRow(jobId)).state).toBe("cancelled");
    },
  );
});

describe("the cancellation store's own pool discipline", () => {
  test("a request against a store that is not running throws for the route to refuse; stop is safe twice and the store does not restart", async () => {
    // The pool discipline every store in this service pins: the refusal is
    // the route's retryable 503, never a silent success or a raw pool
    // crash — and stop() is terminal, so a shutdown-window request cannot
    // sneak past a store that is on its way out.
    const store = new JobsCancellationStore({
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      cancelRunnerJob: async () => ({ verdict: "cancelled" }),
      log: LOG,
    });
    await expect(store.requestCancel(cancelRequestFor(randomUUID(), randomUUID()))).rejects.toThrow(
      /not running/,
    );
    await expect(store.stop()).resolves.toBeUndefined(); // safe without a pool
    store.start(); // a stopped store never restarts
    await expect(store.requestCancel(cancelRequestFor(randomUUID(), randomUUID()))).rejects.toThrow(
      /not running/,
    );
    await store.stop();
  });
});

describe("the start gate's cancellation fence", () => {
  test(
    "a claim arriving after the intent was recorded never runs the handler and commits the terminal outcome in the gate's own transaction",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      // Held off-claim: the intent is durable before any claim can read it.
      const jobId = await seedJob({ appId, startAfterSeconds: 5 });
      await writeIntentDirectly(jobId);
      handlerRuns = 0;
      currentHandler = async () => {
        handlerRuns += 1;
        return "must never run";
      };

      // The claim happens (the worker polls past the hold); the gate
      // refuses it and commits the record's terminal `cancelled` outcome.
      await waitFor("the gate to commit the cancellation", async () => {
        const row = await recordRow(jobId);
        return row.status === "cancelled" && row.error_code === "cancelled";
      });
      expect(handlerRuns).toBe(0);
      // The claim settles through the runner's own retry policy — one
      // attempt, none left — and the record is the intent's terminal.
      expect(await recordRow(jobId)).toMatchObject({ attempt: null });
    },
  );

  test(
    "a claim on a cancelled-and-past-deadline record commits the deadline's timeout, not the intent's outcome — the gate's arms are ordered",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      // Held off-claim only until the worker's next poll, so the claim (and
      // with it the gate's arm order) arrives while the leg watches; the
      // acceptance instant is backdated past the fetch type's five-minute
      // deadline and the intent is durable too — both arms could claim the
      // record, and the deadline's precedence is what pins.
      const jobId = await seedJob({ appId, startAfterSeconds: 2 });
      await direct.query(
        `UPDATE ${JOBS_JOB_RECORD_QUALIFIED} SET created_at = now() - ($1 * interval '1 minute')
          WHERE job_id = $2`,
        [10, jobId],
      );
      await writeIntentDirectly(jobId);
      handlerRuns = 0;
      currentHandler = async () => {
        handlerRuns += 1;
        return "must never run";
      };

      // The claim happens; the deadline arm decides first and commits the
      // timeout — the platform's absolute bound is the first terminal
      // outcome to commit, and the pending intent has lost it.
      await waitFor("the gate to commit the timeout", async () => {
        const row = await recordRow(jobId);
        return row.status === "failed" && row.error_code === "timeout";
      });
      expect(handlerRuns).toBe(0);
      // The record is terminal; a later pass changes nothing.
      await recovery.runPass();
      expect(await recordRow(jobId)).toMatchObject({ status: "failed", error_code: "timeout" });
    },
  );
});

describe("the cancellation seam's telemetry", () => {
  let recording: RecordingTelemetry;
  beforeAll(() => {
    recording = startRecordingTelemetry();
  });

  test(
    "the gate's cancellation refusal is the bounded outcome on the execute span — UNSET, no exception, no owner identity",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      const url = "https://telemetry-cancel.example/data.json";
      const jobId = await seedJob({ appId, data: { url }, startAfterSeconds: 5 });
      await writeIntentDirectly(jobId);
      currentHandler = async () => "must never run";
      await waitFor("the gate to commit the cancellation", async () => {
        const row = await recordRow(jobId);
        return row.status === "cancelled";
      });

      const spans = recording
        .spans()
        .filter(
          (s) => s.name === "helix.jobs.execute" && s.attributes["helix.jobs.job_id"] === jobId,
        );
      expect(spans.length).toBeGreaterThanOrEqual(1);
      for (const span of spans) {
        const attrs = span.attributes;
        expect(attrs["helix.outcome"]).toBe("cancelled");
        expect(attrs["helix.app_id"]).toBe(appId);
        expect(attrs["helix.jobs.type"]).toBe("jobs:fetch");
        // The red line: no attribute carries the input URL or the owner oid.
        for (const [key, value] of Object.entries(attrs)) {
          expect(String(value), `attr ${key} carries the input URL`).not.toContain(url);
          expect(String(value), `attr ${key} carries an owner oid`).not.toContain(
            TEST_IDENTITY.ownerOid,
          );
        }
        // The fence working as designed is not a fault.
        expect(span.status.code).toBe(SpanStatusCode.UNSET);
        expect(span.events.some((e) => e.name === "exception")).toBe(false);
      }
      const cancelled = (await recording.metrics())
        .filter(
          (m) =>
            m.name === "helix.jobs.executions" && m.attributes["helix.outcome"] === "cancelled",
        )
        .reduce((sum, m) => sum + m.value, 0);
      expect(cancelled).toBeGreaterThanOrEqual(1);
    },
  );
});
