import { randomUUID } from "node:crypto";
import { SpanStatusCode } from "@opentelemetry/api";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import {
  JOBS_MAX_RESULT_BYTES,
  JobErrorMessages,
  isJsonValue,
  resolveJobsCapacityLimits,
  type JobsCapacityLimits,
} from "@azx-pbc/shared";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";

import {
  JobsExecution,
  JobsExecutionError,
  JobsExecutionStore,
  JobsHandlerRegistry,
  type JobsExecutionContext,
  type JobsHandler,
} from "./execution.js";
import { migrateJobsStorage } from "./migrate.js";
import { JobsLifecycleStore } from "./lifecycle.js";
import {
  JOBS_JOB_RECORD_QUALIFIED,
  JOBS_PGBOSS_SCHEMA,
  JOBS_RUNTIME_ROLE,
  jobsRuntimeBossOptions,
} from "./policy.js";
import { createPgbossEnqueuer, JobsAcceptanceStore } from "./acceptance.js";
import { seedRunnerJobWithRecord } from "./test/recordSeed.js";
import { applyRolesProvisioning } from "../../portal/src/test/provisionDatabases.js";
import { submitClaims, TEST_BODY, TEST_IDENTITY } from "./test/instructions.js";

/**
 * The execution seam against the real store, the real runner and the real
 * role split: the worker's start gate, the attempt projection (running,
 * bounded progress, terminal outcomes), the claim-fenced late completion, and
 * the two execution-time refusals this seam owns — the version-skew input
 * failure and the unregistered handler.
 *
 * Each test registers its own worker for the leg's window (and takes it off
 * afterwards), so the arrange step runs before any claim can race it: a job
 * that must be refused by the start gate is fully arranged — accepted,
 * archived — before a worker exists to claim it.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

const SCRATCH_DB = `helix_jobs_exec_${randomUUID().replaceAll("-", "")}`;

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

/** Bounded wait for a store state the worker's own cadence produces. */
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
let acceptance: JobsAcceptanceStore;
let lifecycle: JobsLifecycleStore;
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
  acceptance = new JobsAcceptanceStore({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    limits: LIMITS,
    accepting: true,
    // The real borrowed-connection enqueue over this suite's own started
    // pg-boss — the same adapter production composes.
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
  direct = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
}, 60_000);

afterAll(async () => {
  await direct.end();
  await execution.stop();
  await acceptance.stop();
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

/** Deliver one lifecycle generation through the real store — the portal's half of the gate. */
async function deliverGeneration(appId: string, generation: string, archived: boolean) {
  await lifecycle.apply(appId, { generation, archived });
}

/** One admission through the real acceptance store, under this app's identity. */
async function admit(appId: string, body: Uint8Array, idempotencyKey: string | null = null) {
  return acceptance.admit({
    claims: submitClaims({
      generation: "1",
      idempotencyKey,
      identity: { ...TEST_IDENTITY, appId },
    }),
    body,
  });
}

/**
 * Seed one job the way the acceptance transaction would commit it — a runner
 * row with the leg's own retry/claim options, and its wrapper record — so a
 * leg can arrange exact runner-side conditions (a retriable job, a short
 * claim bound, a skewing input) that the platform's own admission never
 * produces. The shared helper carries the shape; this suite pins the
 * conditions its legs need.
 */
function seedJob(options: {
  appId: string;
  data: object;
  retryLimit?: number;
  retryDelay?: number;
  expireInSeconds?: number;
}): Promise<string> {
  return seedRunnerJobWithRecord(boss, direct, options);
}

/** The stored result of a record row, as the wire value — the column carries the bound's canonical text. */
function storedResult(row: Record<string, unknown>): unknown {
  const text = row.result;
  return typeof text === "string" ? (JSON.parse(text) as unknown) : text;
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

/** Register the leg's worker, run the leg's body, take the worker off. */
async function withWorker(run: () => Promise<void>): Promise<void> {
  await execution.registerOn(boss);
  try {
    await run();
  } finally {
    // The component's sanctioned release — the registerOn seam's counterpart,
    // so the next leg's registration on this shared instance is not a second
    // live worker (a doubled per-process allowance).
    await execution.releaseOn(boss);
  }
}

describe("the execution seam", () => {
  test(
    "an accepted job runs under its delivered generation and projects the durable success with its bounded progress",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      await deliverGeneration(appId, "1", false);
      const result = await admit(appId, new TextEncoder().encode(TEST_BODY));
      if (result.outcome !== "accepted")
        throw new Error(`the admission refused: ${result.outcome}`);
      currentHandler = async (context) => {
        expect(context.attempt).toBe(1);
        expect(context.input).toEqual({ url: "https://example.com/data.json" });
        const reported = await context.report({ step: 1, of: 1, label: "fetched" });
        expect(reported).toBe("persisted");
        return { answer: 42 };
      };
      await withWorker(() =>
        waitFor("the job to succeed", async () => {
          const row = await recordRow(result.jobId);
          return row.status === "succeeded";
        }),
      );
      const row = await recordRow(result.jobId);
      expect(row.status).toBe("succeeded");
      expect(row.attempt).toBe(1);
      expect(row.progress).toEqual({ step: 1, of: 1, label: "fetched" });
      expect(storedResult(row)).toEqual({ answer: 42 });
      expect(row.error_code).toBeNull();
      expect((await runnerRow(result.jobId)).state).toBe("completed");
    },
  );

  test(
    "the handler's context carries the record's full immutable attribution, as the store holds it",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      await deliverGeneration(appId, "1", false);
      const result = await admit(appId, new TextEncoder().encode(TEST_BODY));
      if (result.outcome !== "accepted")
        throw new Error(`the admission refused: ${result.outcome}`);
      // The record is the only authority a trusted handler can mint its
      // outbound instructions from — never the input, the one app-supplied
      // part of the context. The seam must hand over the store row's whole
      // attribution, not a subset of the columns it happens to select.
      let seen: JobsExecutionContext["record"] | null = null;
      currentHandler = async (context) => {
        seen = context.record;
        return { answer: 1 };
      };
      await withWorker(() =>
        waitFor("the job to succeed", async () => {
          const row = await recordRow(result.jobId);
          return row.status === "succeeded";
        }),
      );
      expect(seen).toEqual({
        server: "jobs",
        jobId: result.jobId,
        type: "jobs:fetch",
        appId,
        env: "prod",
        ownerKind: "user",
        ownerOid: TEST_IDENTITY.ownerOid,
        generation: "1",
      });
    },
  );

  test(
    "progress off the bounded shape is refused and the job still completes",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      await deliverGeneration(appId, "1", false);
      const result = await admit(appId, new TextEncoder().encode(TEST_BODY));
      if (result.outcome !== "accepted")
        throw new Error(`the admission refused: ${result.outcome}`);
      currentHandler = async (context) => {
        // The step beyond the total is off the bounded shape: nothing persisted.
        expect(await context.report({ step: 5, of: 1, label: "impossible" })).toBe("refused");
        return "ok";
      };
      await withWorker(() =>
        waitFor("the job to succeed", async () => {
          const row = await recordRow(result.jobId);
          return row.status === "succeeded";
        }),
      );
      const row = await recordRow(result.jobId);
      expect(row.progress).toBeNull();
      expect(storedResult(row)).toBe("ok");
    },
  );

  test(
    "a retrying failure retains the attempt's attribution while waiting, and the next attempt resets the progress",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      await deliverGeneration(appId, "1", false);
      const jobId = await seedJob({
        appId,
        data: { url: "https://example.com/data.json" },
        retryLimit: 1,
      });
      const seenAttempts: number[] = [];
      currentHandler = async (context) => {
        seenAttempts.push(context.attempt);
        await context.report({ step: context.attempt, of: 2, label: `attempt ${context.attempt}` });
        if (context.attempt === 1) throw new JobsExecutionError("upstream_error");
        return "recovered";
      };
      await withWorker(async () => {
        await waitFor("the first attempt to fail back to queued", async () => {
          const row = await recordRow(jobId);
          return row.status === "queued" && row.attempt === 1;
        });
        const waiting = await recordRow(jobId);
        // While waiting to retry: the failed attempt's error and its progress
        // stay clearly identified.
        expect(waiting.error_code).toBe("upstream_error");
        expect(waiting.progress).toEqual({ step: 1, of: 2, label: "attempt 1" });

        await waitFor("the retry to succeed", async () => {
          const row = await recordRow(jobId);
          return row.status === "succeeded";
        });
      });
      const done = await recordRow(jobId);
      expect(done.status).toBe("succeeded");
      expect(done.attempt).toBe(2);
      // The next attempt's begin reset the progress; the attempt's own report
      // is what the record now carries.
      expect(done.progress).toEqual({ step: 2, of: 2, label: "attempt 2" });
      expect(done.error_code).toBeNull();
      expect(storedResult(done)).toBe("recovered");
      expect(seenAttempts).toEqual([1, 2]);
    },
  );

  test(
    "a retrying failure stamps nothing — the waiting record has no terminal instant",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      await deliverGeneration(appId, "1", false);
      const jobId = await seedJob({
        appId,
        data: { url: "https://example.com/data.json" },
        retryLimit: 1,
        retryDelay: 60,
      });
      currentHandler = async (context) => {
        if (context.attempt === 1) throw new JobsExecutionError("upstream_error");
        return "recovered";
      };
      await withWorker(async () => {
        await waitFor("the first attempt to fail back to queued", async () => {
          const row = await recordRow(jobId);
          return row.status === "queued" && row.attempt === 1;
        });
        // The retry arm's write stamps nothing: an unfinished record carries
        // no terminal instant, so the read horizons can never apply to it —
        // work that is merely waiting can never read expired or unknown by
        // age. The store's own check requires the instant only of terminal
        // rows, so a retry arm that stamped would corrupt the horizons
        // silently; this assertion is what holds the arm's restraint.
        const waiting = await recordRow(jobId);
        expect(waiting.terminal_at).toBeNull();
      });
    },
  );

  test(
    "a terminal write stamps the store clock, not another column's instant",
    { timeout: 120_000 },
    async () => {
      // `created_at` is backdated under the type's absolute deadline (300s):
      // if a terminal write ever stamped the acceptance instant instead of
      // its own, both public-read horizons would begin early and no check in
      // the store would refuse it — the freshness bound below is what makes
      // that regression red.
      const appId = anApp();
      await deliverGeneration(appId, "1", false);
      const succeededId = await seedJob({ appId, data: { url: "https://example.com/data.json" } });
      await direct.query(
        `UPDATE ${JOBS_JOB_RECORD_QUALIFIED} SET created_at = now() - interval '120 seconds'
          WHERE job_id = $1`,
        [succeededId],
      );
      currentHandler = async () => "done";
      await withWorker(() =>
        waitFor(
          "the job to succeed",
          async () => (await recordRow(succeededId)).status === "succeeded",
        ),
      );
      const succeeded = await recordRow(succeededId);
      expect(Math.abs(Date.now() - (succeeded.terminal_at as Date).getTime())).toBeLessThan(60_000);

      // The failure projection's terminal arm stamps the same way — the
      // original terminal outcome's instant, whichever outcome it was.
      const failedApp = anApp();
      await deliverGeneration(failedApp, "1", false);
      const failedId = await seedJob({
        appId: failedApp,
        data: { url: "https://example.com/data.json" },
      });
      await direct.query(
        `UPDATE ${JOBS_JOB_RECORD_QUALIFIED} SET created_at = now() - interval '120 seconds'
          WHERE job_id = $1`,
        [failedId],
      );
      currentHandler = async () => {
        throw new JobsExecutionError("upstream_error");
      };
      await withWorker(() =>
        waitFor("the job to fail", async () => (await recordRow(failedId)).status === "failed"),
      );
      const failed = await recordRow(failedId);
      expect(Math.abs(Date.now() - (failed.terminal_at as Date).getTime())).toBeLessThan(60_000);
    },
  );

  test(
    "a stale attempt's late progress report is refused — the record answers only the attempt that owns it",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      await deliverGeneration(appId, "1", false);
      // A two-second claim bound with a retry behind it: attempt 1's handler
      // outlives its claim, the runner's expiry moves the record to attempt 2,
      // and the abandoned handler's late report must lose its attempt's
      // currency — the fence's attempt half, which no ordering the test can
      // force through the completion path exercises. Attempt 2 parks its own
      // completion until the stale report has been answered, so the stale
      // write lands while attempt 2 is the record's present: a report
      // condition that checked the status alone would wrongly persist it, and
      // attempt 1's label would ride the record as attempt 2's attribution.
      const jobId = await seedJob({
        appId,
        data: { url: "https://example.com/data.json" },
        retryLimit: 1,
        expireInSeconds: 2,
      });
      let staleEnteredResolve: () => void = () => {};
      const staleEntered = new Promise<void>((resolve) => {
        staleEnteredResolve = resolve;
      });
      let releaseStaleReport: () => void = () => {};
      const staleReportGate = new Promise<void>((resolve) => {
        releaseStaleReport = resolve;
      });
      let staleAnsweredResolve: () => void = () => {};
      const staleAnswered = new Promise<void>((resolve) => {
        staleAnsweredResolve = resolve;
      });
      let releaseCurrent: () => void = () => {};
      const currentGate = new Promise<void>((resolve) => {
        releaseCurrent = resolve;
      });
      let currentReportedResolve: () => void = () => {};
      const currentReported = new Promise<void>((resolve) => {
        currentReportedResolve = resolve;
      });
      let staleReport: "persisted" | "refused" | undefined;
      let currentReport: "persisted" | "refused" | undefined;
      currentHandler = async (context) => {
        if (context.attempt === 1) {
          // Abandoned mid-flight: the claim expires while this handler is
          // parked, attempt 2 takes the record, and the test releases the
          // stale report only after it has seen attempt 2 own it.
          staleEnteredResolve();
          await staleReportGate;
          staleReport = await context.report({ step: 1, of: 2, label: "late attempt 1" });
          staleAnsweredResolve();
          return "too late";
        }
        currentReport = await context.report({ step: 2, of: 2, label: "attempt 2" });
        currentReportedResolve();
        await currentGate;
        return "recovered";
      };
      await withWorker(async () => {
        await staleEntered;
        await waitFor("attempt 2 to own the record", async () => {
          const row = await recordRow(jobId);
          return row.status === "running" && row.attempt === 2;
        });
        releaseStaleReport();
        await staleAnswered;
        expect(staleReport).toBe("refused");
        // The report's answer is observed through its own happens-before
        // edge: the begin write landing does not order attempt 2's handler
        // report before this assertion, and a scheduling pause between them
        // (a loaded CI runner's ordinary event) must not fail a correct
        // system.
        await currentReported;
        expect(currentReport).toBe("persisted");
        releaseCurrent();
        await waitFor("the job to succeed", async () => {
          const row = await recordRow(jobId);
          return row.status === "succeeded";
        });
      });
      const done = await recordRow(jobId);
      expect(done.status).toBe("succeeded");
      expect(done.attempt).toBe(2);
      // The record carries the current attempt's attribution — the stale
      // attempt's label never touched it.
      expect(done.progress).toEqual({ step: 2, of: 2, label: "attempt 2" });
      expect(done.error_code).toBeNull();
    },
  );

  test(
    "a failure with no attempt left is the terminal failure with its distinct reason",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      await deliverGeneration(appId, "1", false);
      const result = await admit(appId, new TextEncoder().encode(TEST_BODY));
      if (result.outcome !== "accepted")
        throw new Error(`the admission refused: ${result.outcome}`);
      currentHandler = async () => {
        throw new JobsExecutionError("upstream_error");
      };
      await withWorker(() =>
        waitFor("the job to fail terminally", async () => {
          const row = await recordRow(result.jobId);
          return row.status === "failed";
        }),
      );
      const row = await recordRow(result.jobId);
      expect(row.status).toBe("failed");
      expect(row.error_code).toBe("upstream_error");
      expect(row.result).toBeNull();
      expect(row.attempt).toBe(1);
      expect((await runnerRow(result.jobId)).state).toBe("failed");
    },
  );

  test(
    "input that no longer parses at execution time terminates the accepted job with the version-skew reason, and the handler never runs",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      await deliverGeneration(appId, "1", false);
      // The runner row carries bytes the CURRENT input contract refuses — the
      // state of a job accepted under older rules.
      const jobId = await seedJob({ appId, data: { url: "ftp://example.com/not-http" } });
      let handlerRan = false;
      currentHandler = async () => {
        handlerRan = true;
        return "must not run";
      };
      await withWorker(() =>
        waitFor("the skewed job to terminate", async () => {
          const row = await recordRow(jobId);
          return row.status === "failed";
        }),
      );
      const row = await recordRow(jobId);
      expect(row.status).toBe("failed");
      expect(row.error_code).toBe("execution_input_invalid");
      expect(handlerRan).toBe(false);
    },
  );

  test(
    "a record whose type has no registered handler terminates with the platform error — an unsupported handler name cannot execute",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      await deliverGeneration(appId, "1", false);
      const jobId = await seedJob({ appId, data: { url: "https://example.com/data.json" } });
      // A bare execution component with an empty registry: its worker claims
      // the job and the dispatch refuses it. Taken off before the leg ends.
      const bare = new JobsExecution({
        databaseUrl: RUNTIME_DSN,
        statementTimeoutMs: 10_000,
        handlers: new JobsHandlerRegistry(),
        limits: LIMITS,
        log: LOG,
      });
      bare.start();
      await bare.registerOn(boss);
      try {
        await waitFor("the unhandled job to terminate", async () => {
          const row = await recordRow(jobId);
          return row.status === "failed";
        });
        const row = await recordRow(jobId);
        expect(row.status).toBe("failed");
        expect(row.error_code).toBe("platform_error");
      } finally {
        await bare.releaseOn(boss);
        await bare.stop();
      }
    },
  );

  test(
    "a job whose lifecycle generation closed before it could claim never starts",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      await deliverGeneration(appId, "1", false);
      const result = await admit(appId, new TextEncoder().encode(TEST_BODY));
      if (result.outcome !== "accepted")
        throw new Error(`the admission refused: ${result.outcome}`);
      // The archive lands while the job is queued — arranged BEFORE any worker
      // exists to claim it.
      await deliverGeneration(appId, "2", true);
      let handlerRan = false;
      currentHandler = async () => {
        handlerRan = true;
        return "must not run";
      };
      await withWorker(async () => {
        // The claim happens (the runner row settles through the refusal), but
        // the handler never runs and the record stays exactly as it was.
        await waitFor("the refused claim to settle on the runner row", async () => {
          try {
            return (await runnerRow(result.jobId)).state === "failed";
          } catch {
            return false;
          }
        });
        await new Promise((r) => setTimeout(r, 500));
        expect(handlerRan).toBe(false);
        const row = await recordRow(result.jobId);
        expect(row.status).toBe("queued");
        expect(row.attempt).toBeNull();
      });
    },
  );

  test(
    "a completion whose claim lapsed is discarded — the late result is never stored",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      await deliverGeneration(appId, "1", false);
      // A one-second claim bound: the runner's own settlement fails the batch
      // while the handler is still sleeping.
      const jobId = await seedJob({
        appId,
        data: { url: "https://example.com/data.json" },
        expireInSeconds: 1,
      });
      currentHandler = async () => {
        await new Promise((r) => setTimeout(r, 3_000));
        return "too late";
      };
      await withWorker(async () => {
        await waitFor("the claim to lapse on the runner row", async () => {
          try {
            return (await runnerRow(jobId)).state === "failed";
          } catch {
            return false;
          }
        });
        // The abandoned handler settles ~3s in; its fenced complete must find
        // the claim gone and store nothing.
        await new Promise((r) => setTimeout(r, 4_000));
        const row = await recordRow(jobId);
        expect(row.status).toBe("running"); // untouched — the recovery path's reconciliation
        expect(row.result).toBeNull();
        expect(row.attempt).toBe(1);
      });
    },
  );

  test(
    "a conflict against a failed job carries the job's stored execution error",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      await deliverGeneration(appId, "1", false);
      const first = await admit(appId, new TextEncoder().encode(TEST_BODY), "conflict-error-1");
      if (first.outcome !== "accepted") throw new Error(`the admission refused: ${first.outcome}`);
      currentHandler = async () => {
        throw new JobsExecutionError("upstream_error");
      };
      await withWorker(() =>
        waitFor("the job to fail terminally", async () => {
          const row = await recordRow(first.jobId);
          return row.status === "failed";
        }),
      );
      // The same retry key, different bytes: the conflict names the job's state,
      // and the error is the stored execution failure — code and fixed message.
      const conflict = await admit(
        appId,
        new TextEncoder().encode('{"url":"https://example.com/other.json"}'),
        "conflict-error-1",
      );
      expect(conflict).toEqual({
        outcome: "conflict",
        status: "failed",
        error: { code: "upstream_error", message: JobErrorMessages.upstream_error },
      });
    },
  );

  test(
    "a wire-legal result at the byte cap's maximum legal depth stores and reads back — the judge, the bound and the store agree on one domain",
    { timeout: 120_000 },
    async () => {
      // The depth the shared result contract judges legal at exactly the byte
      // cap (32,766 levels, 65,536 bytes) is deeper than the engine's
      // recursive JSON.stringify reaches (~5,000 — a RangeError) and deeper
      // than Postgres's own jsonb parser accepts at its default
      // max_stack_depth (~8,000 — a query error). The bound's serialization
      // is the shared iterative one and the result column holds its canonical
      // TEXT, so the whole chain — judge, bound, store, read-back — answers
      // for the value the contract declares legal, refusing nothing and
      // truncating nothing.
      const appId = anApp();
      await deliverGeneration(appId, "1", false);
      const result = await admit(appId, new TextEncoder().encode(TEST_BODY));
      if (result.outcome !== "accepted")
        throw new Error(`the admission refused: ${result.outcome}`);
      const depth = (JOBS_MAX_RESULT_BYTES - 4) / 2;
      const wire = "[".repeat(depth) + "null" + "]".repeat(depth);
      const deep: unknown = JSON.parse(wire);
      expect(isJsonValue(deep)).toBe(true);
      currentHandler = async () => deep;
      await withWorker(() =>
        waitFor("the deep result to store", async () => {
          const row = await recordRow(result.jobId);
          return row.status === "succeeded";
        }),
      );
      const row = await recordRow(result.jobId);
      expect(row.status).toBe("succeeded");
      // The stored text IS the wire form the bound measured — byte-identical.
      expect(row.result).toBe(wire);
      // And the read-back round-trips, verified iteratively: the nesting and
      // its terminal value survive the store.
      const stored: unknown = JSON.parse(row.result as string);
      expect(stored).not.toBeNull();
      let node: unknown = stored;
      let remaining = depth;
      while (remaining > 0) {
        expect(Array.isArray(node)).toBe(true);
        node = (node as unknown[])[0];
        remaining -= 1;
      }
      expect(node).toBeNull();
    },
  );

  test(
    "a store that is not running refuses its attempts honestly",
    { timeout: 120_000 },
    async () => {
      const stopped = new JobsExecutionStore({
        databaseUrl: RUNTIME_DSN,
        statementTimeoutMs: 10_000,
        log: LOG,
      });
      await expect(stopped.beginAttempt(randomUUID(), 1)).rejects.toThrow(/not running/);
      await stopped.stop();
      await expect(stopped.stop()).resolves.toBeUndefined(); // safe twice
    },
  );

  test(
    "a store that stopped does not restart — start() after stop() never resurrects the released pool",
    { timeout: 30_000 },
    async () => {
      const once = new JobsExecutionStore({
        databaseUrl: RUNTIME_DSN,
        statementTimeoutMs: 10_000,
        log: LOG,
      });
      once.start();
      await once.stop();
      once.start();
      await expect(once.beginAttempt(randomUUID(), 1)).rejects.toThrow(/not running/);
      await expect(once.stop()).resolves.toBeUndefined();
    },
  );
});

describe("the execution seam's telemetry", () => {
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

  test("an attempt's span and counter carry the bounded evidence and none of the job's values", async () => {
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const url = "https://telemetry-scan.example/data.json";
    const result = await admit(
      appId,
      new TextEncoder().encode(JSON.stringify({ url })),
      "telemetry-scan-key",
    );
    if (result.outcome !== "accepted") throw new Error(`the admission refused: ${result.outcome}`);
    currentHandler = async (context) => {
      await context.report({ step: 1, of: 1, label: "scanned" });
      return { scanned: true };
    };
    await withWorker(() =>
      waitFor("the job to succeed", async () => {
        const row = await recordRow(result.jobId);
        return row.status === "succeeded";
      }),
    );

    const spans = recording.spans().filter((s) => s.name === "helix.jobs.execute");
    expect(spans.length).toBeGreaterThanOrEqual(1);
    for (const span of spans) {
      const attrs = span.attributes;
      // The bounded evidence the seam declares — the app, the qualified
      // type, the job's public id and the attempt number.
      expect(attrs["helix.app_id"]).toBe(appId);
      expect(attrs["helix.jobs.type"]).toBe("jobs:fetch");
      expect(attrs["helix.jobs.job_id"]).toBe(result.jobId);
      expect(attrs["helix.jobs.attempt"]).toBe(1);
      expect(attrs["helix.outcome"]).toBe("succeeded");
      // The red line: no attribute anywhere carries the input URL, the body,
      // the retry key or the owner identity, and no attribute key carries a
      // URL at all.
      for (const [key, value] of Object.entries(attrs)) {
        expect(String(value), `attr ${key} carries the input URL`).not.toContain(url);
        expect(String(value), `attr ${key} carries a retry key`).not.toContain(
          "telemetry-scan-key",
        );
        expect(String(value), `attr ${key} carries an owner oid`).not.toContain(
          TEST_IDENTITY.ownerOid,
        );
      }
      expect(Object.keys(attrs).some((k) => k.startsWith("url."))).toBe(false);
      expect(Object.keys(attrs).some((k) => k.startsWith("http.url"))).toBe(false);
    }

    const executions = (await recording.metrics()).filter(
      (m) => m.name === "helix.jobs.executions" && m.attributes["helix.outcome"] === "succeeded",
    );
    expect(executions.reduce((sum, m) => sum + m.value, 0)).toBeGreaterThanOrEqual(1);
    // The attempt number is a span attribute, never a counter dimension.
    for (const metric of await recording.metrics()) {
      expect(metric.attributes["helix.jobs.attempt"]).toBeUndefined();
    }
  });

  test("an execution store that cannot answer fails the attempt through the runner's own policy — the span says unavailable and the process survives", async () => {
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const result = await admit(appId, new TextEncoder().encode(TEST_BODY));
    if (result.outcome !== "accepted") throw new Error(`the admission refused: ${result.outcome}`);
    currentHandler = async () => "must never run";
    // The component's store goes down after its worker registered: the
    // claim's begin cannot answer, and the attempt's disposition is the
    // store's unavailability — the runner's own retry policy settles the row.
    const broken = new JobsExecution({
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      handlers,
      limits: LIMITS,
      log: LOG,
    });
    broken.start();
    await broken.registerOn(boss);
    try {
      await broken.stop();
      const unavailableBefore = (await recording.metrics())
        .filter(
          (m) =>
            m.name === "helix.jobs.executions" && m.attributes["helix.outcome"] === "unavailable",
        )
        .reduce((sum, m) => sum + m.value, 0);
      await waitFor("the failed begin to settle the runner row", async () => {
        try {
          return (await runnerRow(result.jobId)).state === "failed";
        } catch {
          return false;
        }
      });
      // The wrapper record is untouched — nothing was projected, and the
      // recovery path's reconciliation (not a fabricated outcome) is what
      // can later answer it.
      const row = await recordRow(result.jobId);
      expect(row.status).toBe("queued");
      expect(row.attempt).toBeNull();

      const unavailableAfter = (await recording.metrics())
        .filter(
          (m) =>
            m.name === "helix.jobs.executions" && m.attributes["helix.outcome"] === "unavailable",
        )
        .reduce((sum, m) => sum + m.value, 0);
      expect(unavailableAfter - unavailableBefore).toBeGreaterThanOrEqual(1);
      const unavailableSpans = recording
        .spans()
        .filter(
          (s) => s.name === "helix.jobs.execute" && s.attributes["helix.outcome"] === "unavailable",
        );
      expect(unavailableSpans.length).toBeGreaterThanOrEqual(1);
      // The deliberate grading rule: the execution store not answering is an
      // infrastructure fault — ERROR at every unavailable site, including the
      // begin-side one, so a trace backend's error views tell the same story
      // the counter's dimension does.
      for (const span of unavailableSpans) {
        expect(span.status.code).toBe(SpanStatusCode.ERROR);
      }
      // The cause is recorded exactly once, at the site that decided the
      // disposition: the controlled rethrow is a disposition the wrapper's
      // escape hatch must not grade or record again — a second exception
      // event would mean the filter lost the controlled class.
      const beginSpan = unavailableSpans[0];
      const exceptionEvents = beginSpan?.events.filter((e) => e.name === "exception") ?? [];
      expect(exceptionEvents.length).toBe(1);
      expect(String(exceptionEvents[0]?.attributes?.["exception.message"])).toMatch(/not running/);
    } finally {
      await broken.releaseOn(boss);
    }
  });

  test("a success the store cannot settle leaves the record mid-flight and the claim fails through the retry policy — no completed row without its result", async () => {
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const jobId = await seedJob({
      appId,
      data: { url: "https://example.com/data.json" },
    });
    // A distinct component whose store stops while its own handler runs:
    // the claim is already begun, so the outage lands on the projection —
    // a different unavailable site from the leg above, whose store was
    // already stopped when the claim arrived.
    const midflight = new JobsExecution({
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      handlers,
      limits: LIMITS,
      log: LOG,
    });
    midflight.start();
    currentHandler = async () => {
      await midflight.stop();
      return "unprojectable";
    };
    const unavailableBefore = (await recording.metrics())
      .filter(
        (m) =>
          m.name === "helix.jobs.executions" && m.attributes["helix.outcome"] === "unavailable",
      )
      .reduce((sum, m) => sum + m.value, 0);
    await midflight.registerOn(boss);
    try {
      // The span ends only after the whole attempt settles — its existence
      // means the fenced settlement and the failed projection have both run.
      await waitFor("the attempt's unavailable span", async () =>
        recording
          .spans()
          .some(
            (s) => s.name === "helix.jobs.execute" && s.attributes["helix.jobs.job_id"] === jobId,
          ),
      );
      // The record write and the runner settle share one transaction, so
      // neither landed. The worker loop then fails the claim (retryLimit 0:
      // terminally, with no worker-reported code), which recovery projects
      // as `crashed`. The runner row is never `completed` beside a record
      // that lost the result.
      await waitFor("the runner row to settle failed", async () => {
        try {
          return (await runnerRow(jobId)).state === "failed";
        } catch {
          return false;
        }
      });
      const row = await recordRow(jobId);
      expect(row.status).toBe("running");
      expect(row.attempt).toBe(1);
      expect(row.result).toBeNull();
      expect(row.error_code).toBeNull();

      const unavailableAfter = (await recording.metrics())
        .filter(
          (m) =>
            m.name === "helix.jobs.executions" && m.attributes["helix.outcome"] === "unavailable",
        )
        .reduce((sum, m) => sum + m.value, 0);
      expect(unavailableAfter - unavailableBefore).toBeGreaterThanOrEqual(1);
      const span = recording
        .spans()
        .find(
          (s) => s.name === "helix.jobs.execute" && s.attributes["helix.jobs.job_id"] === jobId,
        );
      expect(span?.attributes["helix.outcome"]).toBe("unavailable");
      // The deliberate grading rule: the execution store not answering is an
      // infrastructure fault — ERROR at every unavailable site, so a trace
      // backend's error views tell the same story the counter's dimension does.
      expect(span?.status.code).toBe(SpanStatusCode.ERROR);
      // The identity attributes were set at begin — they ride the span even
      // on this exit, so the operator's join survives the outage.
      expect(span?.attributes["helix.jobs.attempt"]).toBe(1);
      expect(span?.attributes["helix.app_id"]).toBe(appId);
    } finally {
      await midflight.releaseOn(boss);
      await midflight.stop().catch(() => {});
    }
  });

  test("a completion whose settle answer is lost is never stored — nothing projects from an uncertain claim", async () => {
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const result = await admit(appId, new TextEncoder().encode(TEST_BODY));
    if (result.outcome !== "accepted") throw new Error(`the admission refused: ${result.outcome}`);
    currentHandler = async () => "resolved but never settled";
    const unavailableBefore = (await recording.metrics())
      .filter(
        (m) =>
          m.name === "helix.jobs.executions" && m.attributes["helix.outcome"] === "unavailable",
      )
      .reduce((sum, m) => sum + m.value, 0);
    // The runner-side settlement is a real network boundary; losing its
    // answer mid-call is the failure no honest arrangement produces
    // deterministically, so the boundary itself is forced to reject once.
    const settle = vi
      .spyOn(boss, "complete")
      .mockRejectedValueOnce(new Error("connection dropped mid-settle"));
    try {
      await withWorker(() =>
        waitFor("the attempt's unavailable span", async () =>
          recording
            .spans()
            .some(
              (s) =>
                s.name === "helix.jobs.execute" &&
                s.attributes["helix.jobs.job_id"] === result.jobId,
            ),
        ),
      );
      const row = await recordRow(result.jobId);
      // The handler resolved, but the claim's fate is unknown — the result
      // is discarded, never stored on top of an uncertain settlement.
      expect(row.status).toBe("running");
      expect(row.attempt).toBe(1);
      expect(row.result).toBeNull();
      expect(row.error_code).toBeNull();

      const unavailableAfter = (await recording.metrics())
        .filter(
          (m) =>
            m.name === "helix.jobs.executions" && m.attributes["helix.outcome"] === "unavailable",
        )
        .reduce((sum, m) => sum + m.value, 0);
      expect(unavailableAfter - unavailableBefore).toBeGreaterThanOrEqual(1);
      const span = recording
        .spans()
        .find(
          (s) =>
            s.name === "helix.jobs.execute" && s.attributes["helix.jobs.job_id"] === result.jobId,
        );
      expect(span?.attributes["helix.outcome"]).toBe("unavailable");
      // The deliberate grading rule: the execution store not answering is an
      // infrastructure fault — ERROR at every unavailable site, so a trace
      // backend's error views tell the same story the counter's dimension does.
      expect(span?.status.code).toBe(SpanStatusCode.ERROR);
      expect(span?.attributes["helix.jobs.attempt"]).toBe(1);
    } finally {
      settle.mockRestore();
    }
  });

  test("a failing attempt whose settlement answer is lost is never projected — the span grades the outage ERROR at the fail side too", async () => {
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const result = await admit(appId, new TextEncoder().encode(TEST_BODY));
    if (result.outcome !== "accepted") throw new Error(`the admission refused: ${result.outcome}`);
    currentHandler = async () => {
      throw new JobsExecutionError("upstream_error");
    };
    const unavailableBefore = (await recording.metrics())
      .filter(
        (m) =>
          m.name === "helix.jobs.executions" && m.attributes["helix.outcome"] === "unavailable",
      )
      .reduce((sum, m) => sum + m.value, 0);
    // The fail-side settlement boundary rejects once — the answer lost. The
    // execution seam's own fenced fail runs first (the spy's first call); the
    // worker wrapper's settlement of the rethrown failure consumes the real
    // method afterwards.
    const failSettle = vi
      .spyOn(boss, "fail")
      .mockRejectedValueOnce(new Error("connection dropped mid-fail"));
    try {
      await withWorker(() =>
        waitFor("the attempt's unavailable span", async () =>
          recording
            .spans()
            .some(
              (s) =>
                s.name === "helix.jobs.execute" &&
                s.attributes["helix.jobs.job_id"] === result.jobId,
            ),
        ),
      );
      await waitFor("the runner row to settle failed", async () => {
        try {
          return (await runnerRow(result.jobId)).state === "failed";
        } catch {
          return false;
        }
      });
      const row = await recordRow(result.jobId);
      // The claim's fate was unknown — the failure is discarded, never stored
      // on top of an uncertain settlement, and the recovery path reconciles.
      expect(row.status).toBe("running");
      expect(row.attempt).toBe(1);
      expect(row.error_code).toBeNull();
      expect(row.result).toBeNull();

      const unavailableAfter = (await recording.metrics())
        .filter(
          (m) =>
            m.name === "helix.jobs.executions" && m.attributes["helix.outcome"] === "unavailable",
        )
        .reduce((sum, m) => sum + m.value, 0);
      expect(unavailableAfter - unavailableBefore).toBeGreaterThanOrEqual(1);
      const span = recording
        .spans()
        .find(
          (s) =>
            s.name === "helix.jobs.execute" && s.attributes["helix.jobs.job_id"] === result.jobId,
        );
      expect(span?.attributes["helix.outcome"]).toBe("unavailable");
      // The uniform grading contract: the fail side's outage is an
      // infrastructure fault, graded ERROR like every other unavailable exit —
      // and the failure was never projected, so no reason rides the span.
      expect(span?.status.code).toBe(SpanStatusCode.ERROR);
      expect(span?.attributes["helix.reason"]).toBeUndefined();
    } finally {
      failSettle.mockRestore();
    }
  });

  test("a failure the store cannot project leaves the record mid-flight with the runner row settled failed", async () => {
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const jobId = await seedJob({
      appId,
      data: { url: "https://example.com/data.json" },
    });
    // The fail-side projection cannot answer: the record write and the
    // runner settle share one transaction, so neither lands, and the worker
    // loop's own fail settles the runner row.
    const fails = new JobsExecution({
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      handlers,
      limits: LIMITS,
      log: LOG,
    });
    fails.start();
    currentHandler = async () => {
      await fails.stop();
      throw new JobsExecutionError("upstream_error");
    };
    const unavailableBefore = (await recording.metrics())
      .filter(
        (m) =>
          m.name === "helix.jobs.executions" && m.attributes["helix.outcome"] === "unavailable",
      )
      .reduce((sum, m) => sum + m.value, 0);
    await fails.registerOn(boss);
    try {
      await waitFor("the attempt's unavailable span", async () =>
        recording
          .spans()
          .some(
            (s) => s.name === "helix.jobs.execute" && s.attributes["helix.jobs.job_id"] === jobId,
          ),
      );
      await waitFor("the runner row to settle failed", async () => {
        try {
          return (await runnerRow(jobId)).state === "failed";
        } catch {
          return false;
        }
      });
      const row = await recordRow(jobId);
      // The runner row says failed (the loop's fail carries the attempt's
      // own code); the wrapper record never learned it — the state the
      // recovery path reconciles, never a fabricated failure.
      expect(row.status).toBe("running");
      expect(row.attempt).toBe(1);
      expect(row.error_code).toBeNull();
      expect(row.result).toBeNull();

      const unavailableAfter = (await recording.metrics())
        .filter(
          (m) =>
            m.name === "helix.jobs.executions" && m.attributes["helix.outcome"] === "unavailable",
        )
        .reduce((sum, m) => sum + m.value, 0);
      expect(unavailableAfter - unavailableBefore).toBeGreaterThanOrEqual(1);
      const span = recording
        .spans()
        .find(
          (s) => s.name === "helix.jobs.execute" && s.attributes["helix.jobs.job_id"] === jobId,
        );
      expect(span?.attributes["helix.outcome"]).toBe("unavailable");
      // The deliberate grading rule: the execution store not answering is an
      // infrastructure fault — ERROR at every unavailable site, so a trace
      // backend's error views tell the same story the counter's dimension does.
      expect(span?.status.code).toBe(SpanStatusCode.ERROR);
      expect(span?.attributes["helix.jobs.attempt"]).toBe(1);
      expect(span?.attributes["helix.app_id"]).toBe(appId);
      // The projected-failure reason is absent: the failure was not projected.
      expect(span?.attributes["helix.reason"]).toBeUndefined();
    } finally {
      await fails.releaseOn(boss);
      await fails.stop().catch(() => {});
    }
  });

  test("a refused claim's span stays UNSET — the gate refusal is the platform working as designed", async () => {
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const result = await admit(appId, new TextEncoder().encode(TEST_BODY));
    if (result.outcome !== "accepted") throw new Error(`the admission refused: ${result.outcome}`);
    // The archive lands while the job is queued — arranged before a worker
    // exists to claim it, so the refusal is the gate's own decision.
    await deliverGeneration(appId, "2", true);
    currentHandler = async () => "must not run";
    await withWorker(async () => {
      await waitFor("the refused claim to settle on the runner row", async () => {
        try {
          return (await runnerRow(result.jobId)).state === "failed";
        } catch {
          return false;
        }
      });
    });
    // The grading rule's UNSET half: a closed generation refusing to start
    // work is the platform working as designed — an app archived while a job
    // sat queued is a normal operator action, and grading it ERROR would
    // page operators for it.
    const refusedSpans = recording
      .spans()
      .filter(
        (s) => s.name === "helix.jobs.execute" && s.attributes["helix.outcome"] === "gate_refused",
      );
    expect(refusedSpans.length).toBeGreaterThanOrEqual(1);
    for (const span of refusedSpans) {
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
      // The refusal carries no exception record: nothing failed.
      expect(span.events.some((e) => e.name === "exception")).toBe(false);
    }
  });

  test(
    "a claim-lapsed attempt's span stays UNSET — the discard is the fence working, not a fault",
    { timeout: 120_000 },
    async () => {
      const appId = anApp();
      await deliverGeneration(appId, "1", false);
      const jobId = await seedJob({
        appId,
        data: { url: "https://example.com/data.json" },
        expireInSeconds: 1,
      });
      currentHandler = async () => {
        await new Promise((r) => setTimeout(r, 3_000));
        return "too late";
      };
      await withWorker(async () => {
        await waitFor("the claim to lapse on the runner row", async () => {
          try {
            return (await runnerRow(jobId)).state === "failed";
          } catch {
            return false;
          }
        });
        // The abandoned handler settles ~3s in; its fenced complete must find
        // the claim gone and be discarded as the fence's answer.
        await new Promise((r) => setTimeout(r, 4_000));
      });
      const lapsedSpans = recording
        .spans()
        .filter(
          (s) =>
            s.name === "helix.jobs.execute" &&
            s.attributes["helix.jobs.job_id"] === jobId &&
            s.attributes["helix.outcome"] === "terminal_fenced",
        );
      expect(lapsedSpans.length).toBeGreaterThanOrEqual(1);
      for (const span of lapsedSpans) {
        expect(span.status.code).toBe(SpanStatusCode.UNSET);
        expect(span.events.some((e) => e.name === "exception")).toBe(false);
      }
    },
  );

  test("a designed failure is the job's answer on the span, not a span fault", async () => {
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const result = await admit(appId, new TextEncoder().encode(TEST_BODY));
    if (result.outcome !== "accepted") throw new Error(`the admission refused: ${result.outcome}`);
    currentHandler = async () => {
      throw new JobsExecutionError("upstream_error");
    };
    await withWorker(() =>
      waitFor("the job to fail terminally", async () => {
        const row = await recordRow(result.jobId);
        return row.status === "failed";
      }),
    );
    const span = recording
      .spans()
      .find(
        (s) =>
          s.name === "helix.jobs.execute" && s.attributes["helix.jobs.job_id"] === result.jobId,
      );
    expect(span?.attributes["helix.outcome"]).toBe("failed");
    // The reason rides the span attribute, and the span itself stays UNSET:
    // a job's own failure is the platform working as designed, and grading
    // it ERROR would page operators for every user job that fails.
    expect(span?.attributes["helix.reason"]).toBe("upstream_error");
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
  });

  test("a platform fault is graded ERROR — the span distinguishes it from the job's own answer", async () => {
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const result = await admit(appId, new TextEncoder().encode(TEST_BODY));
    if (result.outcome !== "accepted") throw new Error(`the admission refused: ${result.outcome}`);
    currentHandler = async () => {
      throw new Error("the handler exploded");
    };
    await withWorker(() =>
      waitFor("the job to fail terminally", async () => {
        const row = await recordRow(result.jobId);
        return row.status === "failed";
      }),
    );
    const row = await recordRow(result.jobId);
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("platform_error");
    const span = recording
      .spans()
      .find(
        (s) =>
          s.name === "helix.jobs.execute" && s.attributes["helix.jobs.job_id"] === result.jobId,
      );
    expect(span?.attributes["helix.outcome"]).toBe("failed");
    expect(span?.attributes["helix.reason"]).toBe("platform_error");
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe("the begin's attempt fence", () => {
  /** The begin store of its own, so the leg drives begins directly, without a worker. */
  let store: JobsExecutionStore;
  beforeAll(() => {
    store = new JobsExecutionStore({
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      log: LOG,
    });
    store.start();
  });
  afterAll(async () => {
    await store.stop();
  });

  test("a delayed stale begin is fenced — the newer attempt's begin is never rewritten or wiped", async () => {
    // Two claims' begins landing out of order: the newer attempt's begin has
    // taken the record (and reported its progress) when a claim delayed past
    // its own expiry arrives at the older attempt number. The begin's write
    // must refuse the older number — rewriting the record at attempt 1 would
    // wipe attempt 2's attribution and fence off its success behind it.
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const jobId = await seedRunnerJobWithRecord(boss, direct, {
      appId,
      data: { url: "https://example.com/data.json" },
      startAfterSeconds: 3_600,
    });
    const runnerJobId = String((await runnerRow(jobId)).id);

    const newer = await store.beginAttempt(runnerJobId, 2);
    if (newer.verdict !== "started") throw new Error(`the newer begin refused: ${newer.verdict}`);
    expect(
      await store.reportProgress(newer.record, 2, { step: 1, of: 1, label: "live attempt" }),
    ).toBe("persisted");

    const stale = await store.beginAttempt(runnerJobId, 1);
    expect(stale.verdict).toBe("terminal_fenced");

    const row = await recordRow(jobId);
    expect(row.status).toBe("running");
    expect(row.attempt).toBe(2);
    expect(row.progress).toEqual({ step: 1, of: 1, label: "live attempt" });
    expect(row.error_code).toBeNull();
  });

  test("a stored enum the wire contract does not carry is refused — never a malformed attribution handed out", async () => {
    // The attempt record is parsed against the wire enums at the one
    // projection every verdict shares: storage drift in an enum column must
    // throw, never reach a handler as a plausible-looking attribution (the
    // trusted handler mints its outbound authority from these fields).
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const jobId = await seedRunnerJobWithRecord(boss, direct, {
      appId,
      data: { url: "https://example.com/data.json" },
    });
    const runnerJobId = String((await runnerRow(jobId)).id);

    await direct.query(
      `UPDATE ${JOBS_JOB_RECORD_QUALIFIED} SET owner_kind = 'service' WHERE runner_job_id = $1`,
      [runnerJobId],
    );
    await expect(store.beginAttempt(runnerJobId, 1)).rejects.toThrow();

    await direct.query(
      `UPDATE ${JOBS_JOB_RECORD_QUALIFIED} SET env = 'staging' WHERE runner_job_id = $1`,
      [runnerJobId],
    );
    await expect(store.beginAttempt(runnerJobId, 2)).rejects.toThrow();
  });
});
