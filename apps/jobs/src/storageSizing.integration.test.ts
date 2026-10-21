import { randomBytes, randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  JOBS_FETCH_QUALIFIED_TYPE,
  JOBS_MAX_INPUT_BYTES,
  JOBS_MAX_RESULT_BYTES,
  resolveJobsCapacityLimits,
} from "@azx-pbc/shared";

import { createPgbossEnqueuer, JobsAcceptanceStore } from "./acceptance.js";
import { JobsCleanup } from "./cleanup.js";
import { JobsExecution, JobsHandlerRegistry, type JobsHandler } from "./execution.js";
import { JobsLifecycleStore } from "./lifecycle.js";
import { migrateJobsStorage } from "./migrate.js";
import {
  JOBS_JOB_RECORD_QUALIFIED,
  JOBS_PGBOSS_SCHEMA,
  JOBS_RUNTIME_ROLE,
  JOBS_SCHEMA,
  jobsRuntimeBossOptions,
} from "./policy.js";
import { JobsRunner, deleteRunnerJobs } from "./runner.js";
import { applyRolesProvisioning } from "../../portal/src/test/provisionDatabases.js";
import { submitClaims, TEST_IDENTITY } from "./test/instructions.js";

/**
 * The jobs store's physical storage per job, measured: the heap, TOAST and
 * index bytes of the wrapper store (`jobs.job_record`), of the runner's own
 * tables, and of everything else in the two schemas, at two payload profiles
 * and across a job's whole lifetime — queued, succeeded, vacuumed, cleaned,
 * refilled — through the real admission, worker and cleanup paths.
 *
 * The signed HTTP hops are not exercised. The only rows they add to this
 * store are the short-lived instruction burns, which are not measured here.
 *
 * Every byte figure is an observation of this run on this machine —
 * hardware, Postgres version and the store's fill history all move it. No
 * figure is a guarantee; the assertions each profile makes are, and they
 * cover only what the storage contract promises: the rows the machinery
 * adds and physically removes, and bodies at the platform bounds stored
 * whole.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

const SCRATCH_DB = `helix_jobs_sizing_${randomUUID().replaceAll("-", "")}`;

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

const LIMITS = resolveJobsCapacityLimits();

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
let acceptance: JobsAcceptanceStore;
let lifecycle: JobsLifecycleStore;
let cleanup: JobsCleanup;
let owner: Pool;

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
  acceptance = new JobsAcceptanceStore({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    limits: LIMITS,
    accepting: true,
    enqueuer: createPgbossEnqueuer(boss),
    log: LOG,
  });
  acceptance.start();
  cleanup = new JobsCleanup({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    deleteRunnerRows: {
      delete: (withinTx, runnerJobIds) => deleteRunnerJobs(boss, withinTx, runnerJobIds),
    },
    // The cadence is test-driven (every pass below is explicit).
    intervalMs: 3_600_000,
    log: LOG,
  });
  cleanup.start();
  // The start's own immediate pass must be settled before the legs, so a
  // leg's passes are its own (a pass coalesces into an in-flight one).
  await waitFor("the first cleanup pass to complete", async () => cleanup.snapshot().passes >= 1);
  // The measurement pool: the superuser from TEST_DATABASE_URL, used only to
  // read catalog sizes and counts, to VACUUM, and to backdate terminal instants.
  owner = new Pool({ connectionString: urlFor(SCRATCH_DB), max: 1 });
}, 60_000);

afterAll(async () => {
  await owner.end();
  await cleanup.stop();
  await acceptance.stop();
  await lifecycle.stop();
  await boss.stop({ graceful: true, timeout: 5_000 }).catch(() => {});
  const pool = new Pool({ connectionString: urlFor("postgres"), max: 1 });
  await pool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
  await pool.end();
}, 30_000);

// ── The footprint measurement ────────────────────────────────────────────────

/** The three relation parts the store is broken into. */
type Part = "wrapper" | "runner" | "other";

interface PartFootprint {
  heap: number;
  toast: number;
  indexes: number;
  total: number;
}

interface Footprint {
  wrapper: PartFootprint;
  runner: PartFootprint;
  other: PartFootprint;
  wrapperRows: number;
  runnerRows: number;
}

/**
 * The store's physical size, from the catalog's own file-size functions:
 * `heap` is the main fork, `toast` the relation's TOAST heap and its index,
 * `indexes` every index. Ordinary tables only (`relkind = 'r'`), because the
 * runner's `job` parent holds nothing itself — its partitions are the
 * physical rows. The wrapper part is the job-record store alone; the runner
 * part is every pgboss table that holds queue jobs; the rest (the lifecycle,
 * intake and burn stores, pgboss bookkeeping) is "other".
 */
async function footprint(): Promise<Footprint> {
  const { rows } = await owner.query<{
    relname: string;
    heap: string;
    toast: string;
    indexes: string;
  }>(
    `SELECT n.nspname || '.' || c.relname AS relname,
            pg_relation_size(c.oid) AS heap,
            COALESCE(pg_total_relation_size(NULLIF(c.reltoastrelid, 0)), 0) AS toast,
            pg_indexes_size(c.oid) AS indexes
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname = ANY($1::text[])`,
    [[JOBS_SCHEMA, JOBS_PGBOSS_SCHEMA]],
  );
  const parts: Record<Part, PartFootprint> = {
    wrapper: { heap: 0, toast: 0, indexes: 0, total: 0 },
    runner: { heap: 0, toast: 0, indexes: 0, total: 0 },
    other: { heap: 0, toast: 0, indexes: 0, total: 0 },
  };
  for (const row of rows) {
    const part: Part =
      row.relname === `${JOBS_SCHEMA}.job_record`
        ? "wrapper"
        : row.relname.startsWith(`${JOBS_PGBOSS_SCHEMA}.job`)
          ? "runner"
          : "other";
    const target = parts[part];
    const heap = Number(row.heap);
    const toast = Number(row.toast);
    const indexes = Number(row.indexes);
    target.heap += heap;
    target.toast += toast;
    target.indexes += indexes;
    target.total += heap + toast + indexes;
  }
  const wrapperRows = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${JOBS_JOB_RECORD_QUALIFIED}`,
  );
  const runnerRows = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${JOBS_PGBOSS_SCHEMA}.job`,
  );
  return {
    wrapper: parts.wrapper,
    runner: parts.runner,
    other: parts.other,
    wrapperRows: wrapperRows.rows[0]?.n ?? 0,
    runnerRows: runnerRows.rows[0]?.n ?? 0,
  };
}

// ── The payload profiles ─────────────────────────────────────────────────────

/** One job's fixtures: the exact input bytes admitted and the handler's result value. */
interface JobSpec {
  url: string;
  body: Uint8Array;
  result: unknown;
}

interface Profile {
  name: "small" | "bound";
  jobs: number;
  /** Fresh app ids to spread the jobs over, so no per-app cap is hit. */
  apps: number;
  specs: JobSpec[];
}

/** Random URL-safe characters — incompressible filler for the bound profile. */
function randomUrlSafeChars(count: number): string {
  return randomBytes(Math.ceil((count * 3) / 4))
    .toString("base64url")
    .slice(0, count);
}

function smallProfile(): Profile {
  const specs: JobSpec[] = [];
  for (let n = 1; n <= 100; n += 1) {
    const url = `https://fixtures.invalid/sizing/${n}`;
    specs.push({
      url,
      body: new TextEncoder().encode(JSON.stringify({ url })),
      result: { status: 200, body: { ok: true, n } },
    });
  }
  return { name: "small", jobs: specs.length, apps: 5, specs };
}

function boundProfile(): Profile {
  // The JSON body `{"url":"https://fixtures.invalid/<pad>"}` padded to exactly
  // the platform's input bound, and a random base64url string whose JSON
  // serialization is exactly the result bound — both incompressible, so the
  // TOAST sizes below are the payloads' own bytes, not compression artifacts.
  const emptyPad = JSON.stringify({ url: "https://fixtures.invalid/" });
  const specs: JobSpec[] = [];
  for (let n = 0; n < 40; n += 1) {
    const pad = randomUrlSafeChars(JOBS_MAX_INPUT_BYTES - Buffer.byteLength(emptyPad));
    const url = `https://fixtures.invalid/${pad}`;
    const body = new TextEncoder().encode(JSON.stringify({ url }));
    const result = randomUrlSafeChars(JOBS_MAX_RESULT_BYTES - 2); // the two quotes of the JSON string form
    specs.push({ url, body, result });
  }
  return { name: "bound", jobs: specs.length, apps: 2, specs };
}

// ── The real worker ──────────────────────────────────────────────────────────

/** The result each fixture job returns, looked up by the url its input carries. */
const resultsByUrl = new Map<string, unknown>();

const sizingHandler: JobsHandler = async (context) => {
  const input = context.input as { url?: unknown };
  if (typeof input.url !== "string") {
    throw new Error("the sizing fixture's input carries no url");
  }
  await context.report({ step: 1, of: 1, label: "Fetched" });
  const result = resultsByUrl.get(input.url);
  if (result === undefined) {
    throw new Error("no result fixture was registered for the sizing input's url");
  }
  return result;
};

/** One worker process, exactly as the platform composes a per-leg runner. */
async function startWorkerProcess(): Promise<{ stop(): Promise<void> }> {
  const registry = new JobsHandlerRegistry();
  registry.register(JOBS_FETCH_QUALIFIED_TYPE, sizingHandler);
  const component = new JobsExecution({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    handlers: registry,
    limits: LIMITS,
    log: LOG,
  });
  component.start();
  const runner = new JobsRunner({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    registerWorker: async (bossInstance) => {
      await component.registerOn(bossInstance);
    },
    log: LOG,
  });
  runner.start();
  await waitFor("the runner to register its worker", async () => runner.snapshot.workerRegistered);
  return {
    stop: async () => {
      await runner.stop();
      await component.stop();
    },
  };
}

// ── The lifetime's phase helpers ─────────────────────────────────────────────

/** One admission through the real acceptance store — a refusal fails the leg. */
async function admitOne(appId: string, spec: JobSpec): Promise<string> {
  const result = await acceptance.admit({
    claims: submitClaims({
      generation: "1",
      idempotencyKey: `sz-${randomUUID()}`,
      identity: { ...TEST_IDENTITY, appId, env: "prod" },
    }),
    body: spec.body,
  });
  if (result.outcome !== "accepted") {
    throw new Error(`the admission refused (${result.outcome})`);
  }
  return result.jobId;
}

/** Every one of the profile's jobs reached its durable success, or the leg fails naming the stragglers. */
async function waitAllSucceeded(jobIds: string[]): Promise<void> {
  const by = Date.now() + 120_000;
  while (Date.now() < by) {
    const { rows } = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${JOBS_JOB_RECORD_QUALIFIED}
        WHERE status <> 'succeeded' AND job_id = ANY($1::text[])`,
      [jobIds],
    );
    if ((rows[0]?.n ?? 1) === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  const { rows } = await owner.query<{ status: string; error_code: string | null; n: number }>(
    `SELECT status, error_code, count(*)::int AS n
       FROM ${JOBS_JOB_RECORD_QUALIFIED}
      WHERE job_id = ANY($1::text[])
      GROUP BY status, error_code`,
    [jobIds],
  );
  const counts = rows
    .map((r) => `${r.status}${r.error_code === null ? "" : `/${r.error_code}`}: ${r.n}`)
    .join(", ");
  throw new Error(`the profile's jobs never all reached succeeded: ${counts}`);
}

/** Plain VACUUM over the whole scratch database — what autovacuum would eventually do. */
async function vacuumDatabase(): Promise<void> {
  await owner.query("VACUUM (ANALYZE)");
}

/** The retention horizons' input is the ORIGINAL terminal instant — backdate it past the record horizon. */
async function backdateTerminal(jobIds: string[]): Promise<void> {
  await owner.query(
    `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
        SET terminal_at = now() - interval '31 days'
      WHERE job_id = ANY($1::text[])`,
    [jobIds],
  );
}

/** Explicit passes until one retires nothing more — the batch cap is 500, so one or two. */
async function driveCleanupPasses(): Promise<void> {
  let retired = cleanup.snapshot().recordsRetired;
  for (let pass = 0; pass < 10; pass += 1) {
    await cleanup.runPass();
    const after = cleanup.snapshot().recordsRetired;
    if (after === retired) return;
    retired = after;
  }
  throw new Error("the cleanup passes never converged");
}

// ── The published record ─────────────────────────────────────────────────────

interface ProfilePhases {
  baseline: Footprint;
  accepted: Footprint;
  succeeded: Footprint;
  vacuumed: Footprint;
  cleaned: Footprint;
  cleanedVacuumed: Footprint;
  refilled: Footprint;
}

/** Per-job byte deltas against the baseline, per part and overall, rounded to whole bytes. */
function perJobFigures(
  phases: ProfilePhases,
  jobs: number,
): Record<string, Record<string, number>> {
  const figs: Record<string, Record<string, number>> = {};
  for (const phase of ["accepted", "succeeded", "vacuumed"] as const) {
    const at = phases[phase];
    const baseline = phases.baseline;
    figs[phase] = {
      wrapper: Math.round((at.wrapper.total - baseline.wrapper.total) / jobs),
      runner: Math.round((at.runner.total - baseline.runner.total) / jobs),
      other: Math.round((at.other.total - baseline.other.total) / jobs),
      overall: Math.round(
        (at.wrapper.total +
          at.runner.total +
          at.other.total -
          (baseline.wrapper.total + baseline.runner.total + baseline.other.total)) /
          jobs,
      ),
    };
  }
  return figs;
}

/**
 * One profile's whole lifetime, measured. The published record is the run's
 * structured evidence; the caller asserts against it and passes its text as
 * the message of every assertion, so a failing run reprints the measurement
 * that explains it.
 */
async function runProfile(profile: Profile): Promise<{ phases: ProfilePhases; record: string }> {
  const first = profile.specs[0];
  if (!first) throw new Error("the profile built no jobs");

  const apps: string[] = [];
  for (let n = 0; n < profile.apps; n += 1) apps.push(randomUUID());
  for (const appId of apps) {
    await lifecycle.apply(appId, { generation: "1", archived: false });
  }
  resultsByUrl.clear();
  for (const spec of profile.specs) {
    resultsByUrl.set(spec.url, spec.result);
  }

  const baseline = await footprint();

  // Every job admitted before any worker exists, so the accepted footprint is
  // one clean queued-state measurement. The apps are spread so no admission
  // passes the per-app unfinished cap (20) — the whole profile queues at once.
  const jobIds: string[] = [];
  for (const [index, spec] of profile.specs.entries()) {
    const appId = apps[index % apps.length];
    if (!appId) throw new Error("the profile built no apps");
    jobIds.push(await admitOne(appId, spec));
  }

  const accepted = await footprint();

  const worker = await startWorkerProcess();
  try {
    await waitAllSucceeded(jobIds);
  } finally {
    await worker.stop();
  }
  const succeeded = await footprint();

  await vacuumDatabase();
  const vacuumed = await footprint();

  await backdateTerminal(jobIds);
  await driveCleanupPasses();
  const cleaned = await footprint();

  await vacuumDatabase();
  const cleanedVacuumed = await footprint();

  // The refill: the same profile's jobs again, into whatever the cleanup and
  // the vacuum freed — the observation of whether that space is reused.
  const refilledJobIds: string[] = [];
  for (const [index, spec] of profile.specs.entries()) {
    const appId = apps[index % apps.length];
    if (!appId) throw new Error("the profile built no apps");
    refilledJobIds.push(await admitOne(appId, spec));
  }
  const refilled = await footprint();

  // Every measurement is taken. Complete the refilled work through the same
  // path so the next profile starts with nothing unfinished.
  const drain = await startWorkerProcess();
  try {
    await waitAllSucceeded(refilledJobIds);
  } finally {
    await drain.stop();
  }

  const phases: ProfilePhases = {
    baseline,
    accepted,
    succeeded,
    vacuumed,
    cleaned,
    cleanedVacuumed,
    refilled,
  };
  const postgresVersion = await owner.query<{ server_version: string }>("SHOW server_version");
  const record = JSON.stringify({
    profile: profile.name,
    jobs: profile.jobs,
    inputBodyBytes: Buffer.byteLength(first.body),
    resultBytes: Buffer.byteLength(JSON.stringify(first.result)),
    phases,
    perJob: perJobFigures(phases, profile.jobs),
    postgres: postgresVersion.rows[0]?.server_version ?? "unknown",
  });
  console.info(`[jobs sizing] ${record}`);
  return { phases, record };
}

// ── The profiles' legs ───────────────────────────────────────────────────────

describe("the jobs store's physical footprint, measured", () => {
  test(
    "small payloads — 100 jobs from admission to cleanup, then a refill into the freed space",
    { timeout: 240_000 },
    async () => {
      const profile = smallProfile();
      const { phases, record } = await runProfile(profile);
      // The rows admission adds are exactly the jobs', wrapper and runner both.
      expect(phases.accepted.wrapperRows - phases.baseline.wrapperRows, record).toBe(profile.jobs);
      expect(phases.accepted.runnerRows - phases.baseline.runnerRows, record).toBe(profile.jobs);
      // Completion removes no row — the result is a projection on the same one.
      expect(phases.succeeded.wrapperRows, record).toBe(phases.accepted.wrapperRows);
      expect(phases.succeeded.runnerRows, record).toBe(phases.accepted.runnerRows);
      // The physical cleanup removes both rows of every job, back to the baseline.
      expect(phases.cleaned.wrapperRows, record).toBe(phases.baseline.wrapperRows);
      expect(phases.cleaned.runnerRows, record).toBe(phases.baseline.runnerRows);
    },
  );

  test(
    "bound payloads — the largest accepted input and result, stored whole through the same lifetime",
    { timeout: 240_000 },
    async () => {
      const profile = boundProfile();
      for (const spec of profile.specs) {
        expect(Buffer.byteLength(spec.body)).toBe(JOBS_MAX_INPUT_BYTES);
        expect(Buffer.byteLength(JSON.stringify(spec.result))).toBe(JOBS_MAX_RESULT_BYTES);
      }
      const { phases, record } = await runProfile(profile);
      expect(phases.accepted.wrapperRows - phases.baseline.wrapperRows, record).toBe(profile.jobs);
      expect(phases.accepted.runnerRows - phases.baseline.runnerRows, record).toBe(profile.jobs);
      expect(phases.succeeded.wrapperRows, record).toBe(phases.accepted.wrapperRows);
      expect(phases.succeeded.runnerRows, record).toBe(phases.accepted.runnerRows);
      expect(phases.cleaned.wrapperRows, record).toBe(phases.baseline.wrapperRows);
      expect(phases.cleaned.runnerRows, record).toBe(phases.baseline.runnerRows);
      // Both incompressible bodies are stored once each, so the store cannot
      // hold less than their sum for every job.
      const grown =
        phases.succeeded.wrapper.total +
        phases.succeeded.runner.total +
        phases.succeeded.other.total -
        (phases.baseline.wrapper.total +
          phases.baseline.runner.total +
          phases.baseline.other.total);
      expect(grown, record).toBeGreaterThanOrEqual(
        profile.jobs * (JOBS_MAX_INPUT_BYTES + JOBS_MAX_RESULT_BYTES),
      );
    },
  );
});
