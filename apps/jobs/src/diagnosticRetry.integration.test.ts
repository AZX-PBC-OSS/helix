import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  JOBS_DIAGNOSTIC_QUALIFIED_TYPE,
  resolveJobsCapacityLimits,
  type JobsCapacityLimits,
} from "@azx-pbc/shared";

import { JobsExecution, JobsHandlerRegistry } from "./execution.js";
import { jobsInstalledTypePolicies, makeDiagnosticJobHandler } from "./diagnostics.js";
import { JobsLifecycleStore } from "./lifecycle.js";
import { migrateJobsStorage } from "./migrate.js";
import { JOBS_PGBOSS_SCHEMA, JOBS_JOB_RECORD_QUALIFIED, JOBS_RUNTIME_ROLE } from "./policy.js";
import { seedRunnerJobWithRecord } from "./test/recordSeed.js";
import { applyRolesProvisioning } from "../../portal/src/test/provisionDatabases.js";

/**
 * The diagnostic type through the real store and the real runner — the
 * projection side of retry exhaustion: a retriable job that fails on every
 * attempt runs its policy's attempts and ends `failed` carrying the
 * exhausted-retries reason (never the attempt's own code), and while a retry
 * waits, the record keeps the failed attempt's attribution.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

const SCRATCH_DB = `helix_jobs_diag_${randomUUID().replaceAll("-", "")}`;

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

const LIMITS: JobsCapacityLimits = resolveJobsCapacityLimits();

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
let lifecycle: JobsLifecycleStore;
let direct: Pool;

beforeAll(async () => {
  await applyRolesProvisioning(SCRATCH_DB);
  await migrateJobsStorage(urlFor(SCRATCH_DB, "helix_jobs_migrate"));
  boss = new PgBoss({ connectionString: RUNTIME_DSN, ...{ migrate: false, schedule: false } });
  await boss.start();
  // The diagnostic composition: the installed policy set with the diagnostic
  // type, its handler registered, and the same set threaded to the store.
  const handlers = new JobsHandlerRegistry(jobsInstalledTypePolicies({ diagnostics: true }));
  handlers.register(JOBS_DIAGNOSTIC_QUALIFIED_TYPE, makeDiagnosticJobHandler());
  execution = new JobsExecution({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    handlers,
    limits: LIMITS,
    log: LOG,
  });
  execution.start();
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
  await lifecycle.stop();
  await boss.stop({ graceful: true, timeout: 5_000 }).catch(() => {});
  const pool = new Pool({ connectionString: urlFor("postgres"), max: 1 });
  await pool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
  await pool.end();
}, 30_000);

async function recordRow(jobId: string): Promise<Record<string, unknown>> {
  const result = await direct.query<Record<string, unknown>>(
    `SELECT * FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE job_id = $1`,
    [jobId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no record row for job ${jobId}`);
  return row;
}

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

async function withWorker(run: () => Promise<void>): Promise<void> {
  await execution.registerOn(boss);
  try {
    await run();
  } finally {
    await execution.releaseOn(boss);
  }
}

async function seedDiagnostic(options: {
  data: object;
  retryLimit: number;
  retryDelay?: number;
}): Promise<string> {
  const appId = randomUUID();
  await lifecycle.apply(appId, { generation: "1", archived: false });
  return seedRunnerJobWithRecord(boss, direct, {
    appId,
    type: JOBS_DIAGNOSTIC_QUALIFIED_TYPE,
    expireInSeconds: 60,
    ...options,
  });
}

describe("the diagnostic type's retry exhaustion", () => {
  test(
    "a failure on every attempt runs the policy's attempts and ends failed with attempts_exhausted",
    { timeout: 120_000 },
    async () => {
      const jobId = await seedDiagnostic({
        data: { steps: 1, failAtStep: 1 },
        retryLimit: 2, // the diagnostic policy's own attempt count
      });
      await withWorker(() =>
        waitFor("the job to fail terminally", async () => {
          const row = await recordRow(jobId);
          return row.status === "failed";
        }),
      );
      const row = await recordRow(jobId);
      expect(row.status).toBe("failed");
      // The exhausted-retries reason — not the attempt's own upstream_error.
      expect(row.error_code).toBe("attempts_exhausted");
      expect(row.attempt).toBe(3);
      expect(row.result).toBeNull();
      expect(row.terminal_at).not.toBeNull();
      expect((await runnerRow(jobId)).state).toBe("failed");
    },
  );

  test(
    "while a retry waits, the record is queued carrying the previous attempt's number, progress and error",
    { timeout: 120_000 },
    async () => {
      const jobId = await seedDiagnostic({
        data: { steps: 2, failAtStep: 2 },
        retryLimit: 2,
        retryDelay: 60, // holds the between-attempts state for the assertions
      });
      await withWorker(() =>
        waitFor("the failed attempt to wait for its retry", async () => {
          const row = await recordRow(jobId);
          return row.status === "queued" && row.attempt === 1;
        }),
      );
      const waiting = await recordRow(jobId);
      expect(waiting.status).toBe("queued");
      expect(waiting.attempt).toBe(1);
      expect(waiting.error_code).toBe("upstream_error");
      expect(waiting.progress).toEqual({ step: 1, of: 2, label: "Diagnostic step" });
      expect(waiting.terminal_at).toBeNull();
    },
  );
});
