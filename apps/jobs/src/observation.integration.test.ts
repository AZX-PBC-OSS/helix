import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { resolveJobsCapacityLimits, type JobsCapacityLimits } from "@azx-pbc/shared";

import { JobsCancellationStore } from "./cancellation.js";
import {
  JobsExecution,
  JobsExecutionError,
  JobsHandlerRegistry,
  type JobsHandler,
} from "./execution.js";
import { JobsLifecycleStore } from "./lifecycle.js";
import { migrateJobsStorage } from "./migrate.js";
import { JobsObservationStore } from "./observation.js";
import {
  JOBS_JOB_RECORD_QUALIFIED,
  JOBS_RECORD_TTL_SECONDS,
  JOBS_RESULT_TTL_SECONDS,
  JOBS_RUNTIME_ROLE,
  jobsRuntimeBossOptions,
} from "./policy.js";
import { cancelRunnerJob, readRunnerJobState } from "./runner.js";
import { JobsRecovery } from "./recovery.js";
import { seedRunnerJobWithRecord } from "./test/recordSeed.js";
import { cancelClaims, recordReadClaims, TEST_IDENTITY } from "./test/instructions.js";
import { applyRolesProvisioning } from "../../portal/src/test/provisionDatabases.js";

/**
 * The observation seam against the real store, the real runner and the real
 * role split: the complete snapshot's explicit nulls and expiry instants,
 * the raw-bytes result (JSON `null` included, distinguishable from expiry),
 * the stateful 409s, the 410 and 404 the logical horizons answer irrespective
 * of physical cleanup, the owner/grant classification, and the reads that
 * mutate nothing. The routes' response mapping is pinned against the
 * in-memory double in `operations.test.ts`; the retained-key replay's
 * unreadable answer is pinned against the real admission store in
 * `acceptance.integration.test.ts`. These legs prove the projection and the
 * horizons neither of those can.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

const SCRATCH_DB = `helix_jobs_obsrv_${randomUUID().replaceAll("-", "")}`;

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

/** Bounded wait for a state the machinery's own cadence produces. */
async function waitFor(what: string, probe: () => Promise<boolean>): Promise<void> {
  const by = Date.now() + 45_000;
  while (Date.now() < by) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A deferred the held-attempt legs control; resolve is idempotent. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Park one attempt mid-run: the handler reports (optionally), signals
 * `started`, and holds until `release` — the arrangement a mid-run read
 * needs. Returns the two controls; the caller releases in its finally and
 * waits for the success the release produces.
 */
function parkHandler(options: { report?: { step: number; of: number; label: string } } = {}) {
  const started = deferred();
  const release = deferred();
  currentHandler = async (context) => {
    if (options.report) await context.report(options.report);
    started.resolve();
    await release.promise;
    return { kept: true };
  };
  return { started: started.promise, release };
}

let boss: PgBoss;
let execution: JobsExecution;
let observation: JobsObservationStore;
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
  observation = new JobsObservationStore({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    log: LOG,
  });
  observation.start();
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
  await observation.stop();
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

/** Seed one queued arrangement on the real store, its generation delivered. */
async function seedJob(options: {
  appId: string;
  data?: object;
  startAfterSeconds?: number;
}): Promise<string> {
  await lifecycle.apply(options.appId, { generation: "1", archived: false });
  return seedRunnerJobWithRecord(boss, direct, {
    appId: options.appId,
    data: options.data ?? { url: "https://example.com/data.json" },
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

/** Backdate a terminal record's `terminal_at` — the way elapsed time reaches the horizons' input. */
async function backdateTerminalAt(jobId: string, secondsAgo: number): Promise<void> {
  await direct.query(
    `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
        SET terminal_at = now() - ($2 * interval '1 second')
      WHERE job_id = $1`,
    [jobId, secondsAgo],
  );
}

/** The owner-scoped snapshot and result reads for one job under the leg's own identity. */
function readsFor(jobId: string, appId: string) {
  const snapshotClaims = (over: Partial<Parameters<typeof recordReadClaims>[1]> = {}) =>
    recordReadClaims("snapshot", {
      jobId,
      identity: { ...TEST_IDENTITY, appId, ...(over.identity ?? {}) },
    });
  const resultClaims = (over: Partial<Parameters<typeof recordReadClaims>[1]> = {}) =>
    recordReadClaims("result", {
      jobId,
      identity: { ...TEST_IDENTITY, appId, ...(over.identity ?? {}) },
    });
  return {
    snapshot: (over: Partial<Parameters<typeof recordReadClaims>[1]> = {}) =>
      observation.snapshot({ claims: snapshotClaims(over), jobId }),
    result: (over: Partial<Parameters<typeof recordReadClaims>[1]> = {}) =>
      observation.result({ claims: resultClaims(over), jobId }),
    snapshotClaims,
    resultClaims,
  };
}

/** The snapshot's shared queued-before-execution shape — every unavailable value an explicit null. */
const QUEUED_NULLS = {
  attempt: null,
  progress: null,
  cancellationRequested: false,
  resultExpiresAt: null,
  recordExpiresAt: null,
  error: null,
};

describe("the owner-scoped snapshot", () => {
  test("a queued job's snapshot is complete — explicit nulls, no execution state invented", async () => {
    const appId = anApp();
    const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
    const reads = readsFor(jobId, appId);

    const verdict = await reads.snapshot();
    expect(verdict.outcome).toBe("found");
    if (verdict.outcome !== "found") return;
    expect(verdict.snapshot).toEqual({
      server: "jobs",
      jobId,
      type: "jobs:fetch",
      status: "queued",
      ...QUEUED_NULLS,
    });
  });

  test("a running attempt's snapshot exposes the attempt and its progress", async () => {
    const appId = anApp();
    const hold = parkHandler({ report: { step: 0, of: 1, label: "Fetching" } });
    const jobId = await seedJob({ appId });
    await hold.started;
    const reads = readsFor(jobId, appId);
    try {
      const verdict = await reads.snapshot();
      expect(verdict.outcome).toBe("found");
      if (verdict.outcome !== "found") return;
      expect(verdict.snapshot.status).toBe("running");
      expect(verdict.snapshot.attempt).toBe(1);
      expect(verdict.snapshot.progress).toEqual({ step: 0, of: 1, label: "Fetching" });
      expect(verdict.snapshot.resultExpiresAt).toBeNull();
      expect(verdict.snapshot.recordExpiresAt).toBeNull();
      expect(verdict.snapshot.error).toBeNull();
    } finally {
      // Release the held attempt to its success so no later leg sees it running.
      currentHandler = async () => null;
      hold.release.resolve();
      await waitFor(
        "the job to succeed",
        async () => (await recordRow(jobId)).status === "succeeded",
      );
    }
  });

  test("a succeeded job's snapshot carries both horizons, derived from the original terminal outcome", async () => {
    const appId = anApp();
    const jobId = await seedJob({ appId });
    currentHandler = async () => ({ kept: true });
    await waitFor(
      "the job to succeed",
      async () => (await recordRow(jobId)).status === "succeeded",
    );
    const reads = readsFor(jobId, appId);

    const verdict = await reads.snapshot();
    expect(verdict.outcome).toBe("found");
    if (verdict.outcome !== "found") return;
    expect(verdict.snapshot.status).toBe("succeeded");
    expect(verdict.snapshot.error).toBeNull();
    expect(verdict.snapshot.attempt).toBe(1);
    // Both horizons run from the success instant (the row's own terminal_at),
    // within a bounded skew of the leg's own clock.
    const row = await recordRow(jobId);
    const terminalAtMs = (row.terminal_at as Date).getTime();
    const resultExpiry = Date.parse(verdict.snapshot.resultExpiresAt as string);
    const recordExpiry = Date.parse(verdict.snapshot.recordExpiresAt as string);
    expect(Math.abs(resultExpiry - (terminalAtMs + JOBS_RESULT_TTL_SECONDS * 1_000))).toBeLessThan(
      5_000,
    );
    expect(Math.abs(recordExpiry - (terminalAtMs + JOBS_RECORD_TTL_SECONDS * 1_000))).toBeLessThan(
      5_000,
    );
  });

  test("a failed job's snapshot carries its bounded execution error", async () => {
    const appId = anApp();
    const jobId = await seedJob({ appId });
    currentHandler = async () => {
      throw new JobsExecutionError("upstream_error");
    };
    await waitFor("the job to fail", async () => (await recordRow(jobId)).status === "failed");
    const reads = readsFor(jobId, appId);

    const verdict = await reads.snapshot();
    expect(verdict.outcome).toBe("found");
    if (verdict.outcome !== "found") return;
    expect(verdict.snapshot.status).toBe("failed");
    expect(verdict.snapshot.error).toEqual({
      code: "upstream_error",
      message: "The upstream request failed.",
    });
    expect(verdict.snapshot.resultExpiresAt).toBeNull();
    expect(verdict.snapshot.recordExpiresAt).toEqual(expect.any(String));
  });

  test("a result past its seven days reads expired with its result expiry still named", async () => {
    const appId = anApp();
    const jobId = await seedJob({ appId });
    currentHandler = async () => ({ kept: true });
    await waitFor(
      "the job to succeed",
      async () => (await recordRow(jobId)).status === "succeeded",
    );
    await backdateTerminalAt(jobId, JOBS_RESULT_TTL_SECONDS + 3_600);
    const reads = readsFor(jobId, appId);

    const verdict = await reads.snapshot();
    expect(verdict.outcome).toBe("found");
    if (verdict.outcome !== "found") return;
    expect(verdict.snapshot.status).toBe("expired");
    expect(verdict.snapshot.error).toBeNull();
    expect(verdict.snapshot.resultExpiresAt).toEqual(expect.any(String));
    expect(verdict.snapshot.recordExpiresAt).toEqual(expect.any(String));
  });

  test("a record waiting to retry snapshots as queued with the previous attempt's progress and failure", async () => {
    // While waiting to retry, the previous attempt's progress remains the
    // snapshot's (criterion 39) — the retry arm stamps nothing and clears no
    // attribution, so a queued record that has already executed reads
    // attempt 1 with its progress and error, and carries NO record horizon
    // (the non-terminal row is undated; expiry never touches active work).
    const appId = anApp();
    const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
    await direct.query(
      `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
          SET status = 'queued', attempt = 1, error_code = 'upstream_error',
              progress = $2::jsonb
        WHERE job_id = $1`,
      [jobId, JSON.stringify({ step: 1, of: 1, label: "Fetching" })],
    );
    const reads = readsFor(jobId, appId);

    const verdict = await reads.snapshot();
    expect(verdict.outcome).toBe("found");
    if (verdict.outcome !== "found") return;
    expect(verdict.snapshot).toEqual({
      server: "jobs",
      jobId,
      type: "jobs:fetch",
      status: "queued",
      attempt: 1,
      progress: { step: 1, of: 1, label: "Fetching" },
      cancellationRequested: false,
      resultExpiresAt: null,
      recordExpiresAt: null,
      error: { code: "upstream_error", message: "The upstream request failed." },
    });
  });

  test("a stored progress off the bounded shape is a defect the snapshot read throws — never a malformed body", async () => {
    // The progress column carries no store CHECK — the report path's own
    // bound (a refused report persists nothing) is the only writer guard, so
    // a store a defective writer produced is representable only by hand. The
    // snapshot is wire-validated in the store: a value off the bounded shape
    // surfaces as the caller's failure contract (the route's retryable 503),
    // never as a found verdict whose progress is not the wire's.
    const appId = anApp();
    const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
    await direct.query(
      `UPDATE ${JOBS_JOB_RECORD_QUALIFIED} SET progress = $2::jsonb WHERE job_id = $1`,
      [jobId, JSON.stringify({ step: "three", of: 1, label: "Fetching" })],
    );
    const reads = readsFor(jobId, appId);

    await expect(reads.snapshot()).rejects.toThrow();
  });

  test("a cancelled job's snapshot keeps the intent flag and the outcome", async () => {
    const appId = anApp();
    const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
    const cancel = await cancellation.requestCancel({
      claims: cancelClaims({ jobId, identity: { ...TEST_IDENTITY, appId } }),
      jobId,
    });
    expect(cancel.outcome).toBe("requested");
    await recovery.runPass();
    await waitFor("the record to go terminal", async () => {
      const row = await recordRow(jobId);
      return row.status === "cancelled";
    });
    const reads = readsFor(jobId, appId);

    const verdict = await reads.snapshot();
    expect(verdict.outcome).toBe("found");
    if (verdict.outcome !== "found") return;
    expect(verdict.snapshot.status).toBe("cancelled");
    expect(verdict.snapshot.cancellationRequested).toBe(true);
    expect(verdict.snapshot.error).toEqual({
      code: "cancelled",
      message: "The job was cancelled.",
    });
  });

  test("a foreign identity reads the same 404 as an unknown job; a lapsed grant is forbidden", async () => {
    const appId = anApp();
    const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
    const reads = readsFor(jobId, appId);

    // A different owner, app, environment, or principal kind: the same 404.
    for (const identity of [
      { ...TEST_IDENTITY, appId, ownerOid: "someone-else" },
      { ...TEST_IDENTITY, appId: randomUUID() },
      { ...TEST_IDENTITY, appId, env: "dev" as const },
      { ...TEST_IDENTITY, appId, ownerKind: "dev" as const },
    ]) {
      const snapshot = await observation.snapshot({
        claims: recordReadClaims("snapshot", { jobId, identity }),
        jobId,
      });
      expect(snapshot.outcome, JSON.stringify(identity)).toBe("not_found");
    }
    // A grant that does not cover the record's type — and an empty one: 403,
    // fail-closed, ahead of any state revelation.
    for (const allowedTypes of [["jobs:other"], []]) {
      const snapshot = await observation.snapshot({
        claims: recordReadClaims("snapshot", {
          jobId,
          identity: { ...TEST_IDENTITY, appId, allowedTypes },
        }),
        jobId,
      });
      expect(snapshot.outcome, JSON.stringify(allowedTypes)).toBe("forbidden");
    }
    // An unknown job id: the same 404.
    const unknown = await observation.snapshot({
      claims: reads.snapshotClaims({ jobId: "does-not-exist" }),
      jobId: "does-not-exist",
    });
    expect(unknown.outcome).toBe("not_found");
  });

  test("a read of a record past its public horizon answers the unknown-job 404 to any caller", async () => {
    const appId = anApp();
    const jobId = await seedJob({ appId });
    currentHandler = async () => ({ kept: true });
    await waitFor(
      "the job to succeed",
      async () => (await recordRow(jobId)).status === "succeeded",
    );
    await backdateTerminalAt(jobId, JOBS_RECORD_TTL_SECONDS + 3_600);
    const reads = readsFor(jobId, appId);

    expect(await reads.snapshot()).toEqual({ outcome: "not_found" });
    expect(await reads.result()).toEqual({ outcome: "not_found" });

    // The record is still physically retained — the read removed nothing and
    // changed nothing (the cleanup is the only remover, and no read is one).
    const row = await recordRow(jobId);
    expect(row.status).toBe("succeeded");
    expect(row.result).toEqual(expect.anything());
  });

  test("a record past its public horizon reads as unknown even to a caller whose grant is lapsed", async () => {
    // The horizon outranks the grant in the classification: an expired
    // record is indistinguishable from an unknown one to ANY caller — a 403
    // here would disclose that an answerable record exists to someone the
    // grant does not even cover.
    const appId = anApp();
    const jobId = await seedJob({ appId });
    currentHandler = async () => ({ kept: true });
    await waitFor(
      "the job to succeed",
      async () => (await recordRow(jobId)).status === "succeeded",
    );
    await backdateTerminalAt(jobId, JOBS_RECORD_TTL_SECONDS + 3_600);
    const reads = readsFor(jobId, appId);

    const lapsed = { ...TEST_IDENTITY, appId, allowedTypes: ["jobs:other"] };
    expect(await reads.snapshot({ identity: lapsed })).toEqual({ outcome: "not_found" });
    expect(await reads.result({ identity: lapsed })).toEqual({ outcome: "not_found" });
  });
});

describe("the owner-scoped result read", () => {
  test("a successful object result is the stored canonical bytes, exactly", async () => {
    const appId = anApp();
    const jobId = await seedJob({ appId });
    currentHandler = async () => ({ kept: true, nested: [1, "two", null] });
    await waitFor(
      "the job to succeed",
      async () => (await recordRow(jobId)).status === "succeeded",
    );
    const reads = readsFor(jobId, appId);

    const verdict = await reads.result();
    expect(verdict.outcome).toBe("found");
    if (verdict.outcome !== "found") return;
    // The stored text is the value the job produced — the route sends it as
    // exact bytes, so the caller reads the same JSON.
    expect(JSON.parse(verdict.resultText)).toEqual({ kept: true, nested: [1, "two", null] });
  });

  test("a successful JSON null is a result — found while fresh, expiry past its horizon", async () => {
    const appId = anApp();
    const jobId = await seedJob({ appId });
    currentHandler = async () => null;
    await waitFor(
      "the job to succeed",
      async () => (await recordRow(jobId)).status === "succeeded",
    );
    const reads = readsFor(jobId, appId);

    const verdict = await reads.result();
    expect(verdict.outcome).toBe("found");
    if (verdict.outcome !== "found") return;
    expect(JSON.parse(verdict.resultText)).toBeNull();

    // And the same null past its horizon is expiry, not a result — the
    // distinction the contract keeps for exactly this shape.
    await backdateTerminalAt(jobId, JOBS_RESULT_TTL_SECONDS + 3_600);
    expect(await reads.result()).toEqual({ outcome: "expired" });
  });

  test("a scalar result travels without an envelope", async () => {
    const appId = anApp();
    const jobId = await seedJob({ appId });
    currentHandler = async () => "fetched";
    await waitFor(
      "the job to succeed",
      async () => (await recordRow(jobId)).status === "succeeded",
    );
    const reads = readsFor(jobId, appId);

    const verdict = await reads.result();
    expect(verdict.outcome).toBe("found");
    if (verdict.outcome !== "found") return;
    expect(JSON.parse(verdict.resultText)).toBe("fetched");
  });

  test("a stored result deeper than the engine's own serializer is returned as the exact stored bytes", async () => {
    // The store never parses or re-serializes the result text — the stored
    // canonical form is what the verdict carries, so a result nested past
    // the engine's recursive serializer (~5,000 levels) reads back whole.
    // Any parse or re-serialization on the read path throws here, turning a
    // legal result into a 5xx.
    const appId = anApp();
    const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
    const depth = 20_000;
    const deepText = `${"[".repeat(depth)}null${"]".repeat(depth)}`;
    await direct.query(
      `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
          SET status = 'succeeded', result = $2, error_code = NULL, terminal_at = now()
        WHERE job_id = $1`,
      [jobId, deepText],
    );
    const reads = readsFor(jobId, appId);

    const verdict = await reads.result();
    expect(verdict.outcome).toBe("found");
    if (verdict.outcome !== "found") return;
    expect(verdict.resultText).toBe(deepText);
  });

  test("an unfinished job's result read is the stateful 409 — queued, running, and waiting to retry", async () => {
    const appId = anApp();
    // Queued (held off-claim).
    const queuedId = await seedJob({ appId, startAfterSeconds: 3_600 });
    const queuedReads = readsFor(queuedId, appId);
    expect(await queuedReads.result()).toEqual({
      outcome: "not_ready",
      status: "queued",
      error: null,
    });

    // Running (held mid-attempt).
    const runningId = await seedJob({ appId });
    const hold = parkHandler();
    await hold.started;
    const runningReads = readsFor(runningId, appId);
    try {
      expect(await runningReads.result()).toEqual({
        outcome: "not_ready",
        status: "running",
        error: null,
      });
    } finally {
      // Release the held attempt to its success.
      currentHandler = async () => null;
      hold.release.resolve();
      await waitFor(
        "the job to succeed",
        async () => (await recordRow(runningId)).status === "succeeded",
      );
    }

    // Waiting to retry: the previous attempt's failure is the applicable
    // bounded error the 409 carries. Held off-claim — a queued record the
    // runner cannot reach, so the written state is the state the read sees.
    const retryApp = anApp();
    const retryId = await seedJob({ appId: retryApp, startAfterSeconds: 3_600 });
    await direct.query(
      `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
          SET status = 'queued', attempt = 1, error_code = 'upstream_error'
        WHERE job_id = $1`,
      [retryId],
    );
    const retryReads = readsFor(retryId, retryApp);
    expect(await retryReads.result()).toEqual({
      outcome: "not_ready",
      status: "queued",
      error: { code: "upstream_error", message: "The upstream request failed." },
    });
  });

  test("a terminal job without a successful result is the stateful 409 with its own outcome", async () => {
    const appId = anApp();
    const failedId = await seedJob({ appId });
    currentHandler = async () => {
      throw new JobsExecutionError("upstream_error");
    };
    await waitFor("the job to fail", async () => (await recordRow(failedId)).status === "failed");
    const reads = readsFor(failedId, appId);
    expect(await reads.result()).toEqual({
      outcome: "terminal",
      status: "failed",
      error: { code: "upstream_error", message: "The upstream request failed." },
    });

    // A cancelled job's 409 carries the cancellation's own outcome.
    const cancelledApp = anApp();
    const cancelledId = await seedJob({ appId: cancelledApp, startAfterSeconds: 3_600 });
    await cancellation.requestCancel({
      claims: cancelClaims({
        jobId: cancelledId,
        identity: { ...TEST_IDENTITY, appId: cancelledApp },
      }),
      jobId: cancelledId,
    });
    await recovery.runPass();
    await waitFor("the record to go terminal", async () => {
      const row = await recordRow(cancelledId);
      return row.status === "cancelled";
    });
    const cancelledReads = readsFor(cancelledId, cancelledApp);
    expect(await cancelledReads.result()).toEqual({
      outcome: "terminal",
      status: "cancelled",
      error: { code: "cancelled", message: "The job was cancelled." },
    });
  });

  test("a crashed job's snapshot and result read carry the crashed outcome the recovery projection wrote", async () => {
    // `crashed` is the terminal vocabulary only the recovery sweeper writes,
    // and the one no other leg reads through this seam: the projection's
    // terminal fall-through must carry it exactly like a reported failure —
    // its own bounded error, no result horizon, the record horizon present —
    // and the result read answers the stateful 409 with it.
    const appId = anApp();
    const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
    await direct.query(
      `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
          SET status = 'crashed', error_code = 'platform_error', attempt = 1, terminal_at = now()
        WHERE job_id = $1`,
      [jobId],
    );
    const reads = readsFor(jobId, appId);

    const snapshot = await reads.snapshot();
    expect(snapshot.outcome).toBe("found");
    if (snapshot.outcome !== "found") return;
    expect(snapshot.snapshot.status).toBe("crashed");
    expect(snapshot.snapshot.error).toEqual({
      code: "platform_error",
      message: "The job failed because of a platform error.",
    });
    expect(snapshot.snapshot.resultExpiresAt).toBeNull();
    expect(snapshot.snapshot.recordExpiresAt).toEqual(expect.any(String));

    expect(await reads.result()).toEqual({
      outcome: "terminal",
      status: "crashed",
      error: { code: "platform_error", message: "The job failed because of a platform error." },
    });
  });

  test("a result past its seven days is expiry, however delayed the physical cleanup", async () => {
    const appId = anApp();
    const jobId = await seedJob({ appId });
    currentHandler = async () => ({ kept: true });
    await waitFor(
      "the job to succeed",
      async () => (await recordRow(jobId)).status === "succeeded",
    );
    await backdateTerminalAt(jobId, JOBS_RESULT_TTL_SECONDS + 3_600);
    const reads = readsFor(jobId, appId);

    expect(await reads.result()).toEqual({ outcome: "expired" });
    // The stored bytes are untouched — the read removed nothing; the physical
    // cleanup (within its own 48-hour bound) is the only remover.
    const row = await recordRow(jobId);
    expect(row.result).toEqual(expect.anything());
    expect(row.status).toBe("succeeded");
  });

  test("authorization is the snapshot's: foreign 404, lapsed grant 403, unknown job 404", async () => {
    const appId = anApp();
    const jobId = await seedJob({ appId });
    currentHandler = async () => ({ kept: true });
    await waitFor(
      "the job to succeed",
      async () => (await recordRow(jobId)).status === "succeeded",
    );
    const reads = readsFor(jobId, appId);

    expect(
      await reads.result({ identity: { ...TEST_IDENTITY, appId, ownerOid: "someone-else" } }),
    ).toMatchObject({ outcome: "not_found" });
    expect(
      await reads.result({
        identity: { ...TEST_IDENTITY, appId, allowedTypes: ["jobs:other"] },
      }),
    ).toMatchObject({ outcome: "forbidden" });
    const unknown = await observation.result({
      claims: reads.resultClaims({ jobId: "does-not-exist" }),
      jobId: "does-not-exist",
    });
    expect(unknown).toMatchObject({ outcome: "not_found" });
  });
});

describe("cancelling unreadable records", () => {
  test("cancelling a result-expired job is the 409 with the expired status — the intent is never recorded", async () => {
    const appId = anApp();
    currentHandler = async () => ({ kept: true });
    const jobId = await seedJob({ appId });
    await waitFor(
      "the job to succeed",
      async () => (await recordRow(jobId)).status === "succeeded",
    );
    await backdateTerminalAt(jobId, JOBS_RESULT_TTL_SECONDS + 3_600);

    const verdict = await cancellation.requestCancel({
      claims: cancelClaims({ jobId, identity: { ...TEST_IDENTITY, appId } }),
      jobId,
    });
    expect(verdict).toEqual({ outcome: "terminal", status: "expired", error: null });
    const row = await recordRow(jobId);
    expect(row.cancellation_requested).toBe(false);
  });

  test("cancelling a record past its public horizon is the unknown-job 404 — nothing disclosed, nothing recorded", async () => {
    const appId = anApp();
    currentHandler = async () => ({ kept: true });
    const jobId = await seedJob({ appId });
    await waitFor(
      "the job to succeed",
      async () => (await recordRow(jobId)).status === "succeeded",
    );
    await backdateTerminalAt(jobId, JOBS_RECORD_TTL_SECONDS + 3_600);

    const verdict = await cancellation.requestCancel({
      claims: cancelClaims({ jobId, identity: { ...TEST_IDENTITY, appId } }),
      jobId,
    });
    expect(verdict).toEqual({ outcome: "not_found" });
    const row = await recordRow(jobId);
    expect(row.cancellation_requested).toBe(false);
    expect(row.status).toBe("succeeded");
  });

  test("cancelling past the horizon reads as unknown even to a lapsed grant — nothing disclosed, nothing recorded", async () => {
    // The refusal classification's order: the record's public readability
    // answers before the type grant, so the expired record's 404 is the
    // answer to any caller — a 403 here would reveal an answerable record
    // to an identity the grant does not cover.
    const appId = anApp();
    currentHandler = async () => ({ kept: true });
    const jobId = await seedJob({ appId });
    await waitFor(
      "the job to succeed",
      async () => (await recordRow(jobId)).status === "succeeded",
    );
    await backdateTerminalAt(jobId, JOBS_RECORD_TTL_SECONDS + 3_600);

    const verdict = await cancellation.requestCancel({
      claims: cancelClaims({
        jobId,
        identity: { ...TEST_IDENTITY, appId, allowedTypes: ["jobs:other"] },
      }),
      jobId,
    });
    expect(verdict).toEqual({ outcome: "not_found" });
    const row = await recordRow(jobId);
    expect(row.cancellation_requested).toBe(false);
  });

  test("a cancellation's terminal write stamps the store clock — the original terminal outcome's instant", async () => {
    // `created_at` is backdated (within the type's absolute deadline): if
    // the cancellation projection ever stamped the acceptance instant
    // instead of its own, the record horizon would begin early and no store
    // check would refuse it — the freshness bound is what makes that red.
    const appId = anApp();
    const jobId = await seedJob({ appId, startAfterSeconds: 3_600 });
    await direct.query(
      `UPDATE ${JOBS_JOB_RECORD_QUALIFIED} SET created_at = now() - interval '120 seconds'
        WHERE job_id = $1`,
      [jobId],
    );
    await cancellation.requestCancel({
      claims: cancelClaims({ jobId, identity: { ...TEST_IDENTITY, appId } }),
      jobId,
    });
    await recovery.runPass();
    await waitFor("the record to go terminal", async () => {
      const row = await recordRow(jobId);
      return row.status === "cancelled";
    });

    const row = await recordRow(jobId);
    expect(Math.abs(Date.now() - (row.terminal_at as Date).getTime())).toBeLessThan(60_000);
  });
});

describe("the observation store's own pool discipline", () => {
  test("a read against a store that is not running throws for the route's failure contract; stop is safe twice", async () => {
    const store = new JobsObservationStore({
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      log: LOG,
    });
    const request = {
      claims: recordReadClaims("snapshot", { jobId: "any-job-id" }),
      jobId: "any-job-id",
    };
    await expect(store.snapshot(request)).rejects.toThrow(/not running/);
    await expect(store.result(request)).rejects.toThrow(/not running/);
    store.start();
    await store.stop();
    await store.stop();
    await expect(store.snapshot(request)).rejects.toThrow(/not running/);
  });
});
