import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { sha256BodyDigest } from "@azx-pbc/shared/jobsSigning";

import { jobsLifecycleRecoveryCheck } from "./health.js";
import { JobsLifecycleStore } from "./lifecycle.js";
import { migrateJobsStorage } from "./migrate.js";
import {
  JOBS_APP_LIFECYCLE_QUALIFIED,
  JOBS_JOB_RECORD_QUALIFIED,
  JOBS_RUNTIME_ROLE,
} from "./policy.js";
import { JobsRecovery, JOBS_LIFECYCLE_RECOVERY_OVERDUE_MS } from "./recovery.js";
import { applyRolesProvisioning } from "../../portal/src/test/provisionDatabases.js";

/**
 * The lifecycle stamp's scope, against the real store: the apply's documented
 * contract is per-app — the stamped count and the route span's
 * `helix.jobs.lifecycle.stamped` are one delivery's cancellation reach for the
 * app it names — and the backlog evidence the recovery pass grades must move
 * the `jobs_lifecycle_recovery` check past the 60-second bound and back
 * through the real measurement chain, not only through hand-built snapshots.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

const SCRATCH_DB = `helix_jobs_lss_${randomUUID().replaceAll("-", "")}`;

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
  recovery = new JobsRecovery({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    readRunnerJob: async () => ({ verdict: "found", state: "created", output: null }),
    cancelRunnerJob: async () => ({ verdict: "cancelled" }),
    intervalMs: 3_600_000,
    log: LOG,
  });
  recovery.start();
  // The initial pass runs in the background the moment start() returns; the
  // legs below arrange closed-generation residue by direct SQL and assert
  // exactly which writer stamped it, so the pass must be over (its store
  // view settled) before the first seed — the same arrangement discipline
  // the sibling sweeper suites keep.
  await waitFor("the first recovery pass to complete", async () => recovery.snapshot().passes >= 1);
  direct = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
}, 60_000);

afterAll(async () => {
  await direct.end();
  await recovery.stop();
  await lifecycle.stop();
  const pool = new Pool({ connectionString: urlFor("postgres"), max: 1 });
  await pool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
  await pool.end();
}, 30_000);

/** Each test's own app — the uuid the identity schemas accept, disjoint per leg. */
function anApp(): string {
  return randomUUID();
}

/**
 * Seed one app's lifecycle row directly — the pre-delivery state a store
 * holds without any apply having run for it (the upgrade-residue shape the
 * healing arm exists for).
 */
async function seedLifecycleRow(
  appId: string,
  generation: string,
  archived: boolean,
): Promise<void> {
  await direct.query(
    `INSERT INTO ${JOBS_APP_LIFECYCLE_QUALIFIED} (app_id, generation, archived)
       VALUES ($1, $2, $3)`,
    [appId, generation, archived],
  );
}

/**
 * Seed one queued wrapper record directly — the way a record the acceptance
 * transaction committed looks, without its runner row (nothing here reads the
 * runner's own store).
 */
async function seedQueuedRecord(options: { appId: string; generation: string }): Promise<string> {
  const jobId = randomUUID();
  await direct.query(
    `INSERT INTO ${JOBS_JOB_RECORD_QUALIFIED}
       (server, job_id, runner_job_id, app_id, env, owner_kind, owner_oid, type,
        generation, status, retry_key, body_sha256, created_at)
     VALUES ('jobs', $1, $2, $3, 'prod', 'user', '00000000-0000-0000-0000-000000000001',
             'jobs:fetch', $4, 'queued', NULL, $5, now())`,
    [
      jobId,
      randomUUID(),
      options.appId,
      options.generation,
      sha256BodyDigest(new TextEncoder().encode(JSON.stringify({ seeded: true }))),
    ],
  );
  return jobId;
}

async function recordRow(jobId: string): Promise<Record<string, unknown>> {
  const result = await direct.query<Record<string, unknown>>(
    `SELECT * FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE job_id = $1`,
    [jobId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no record row for job ${jobId}`);
  return row;
}

/** Settle one record terminal cancelled, so a later pass's store-wide measurement excludes it. */
async function settleCancelled(jobId: string): Promise<void> {
  await direct.query(
    `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
        SET status = 'cancelled', error_code = 'cancelled', terminal_at = now()
      WHERE job_id = $1`,
    [jobId],
  );
}

describe("the lifecycle stamp's scope", () => {
  test("an apply stamps and counts only its own app's closed-generation work", async () => {
    // The pre-upgrade world: two apps' states and records exist, neither
    // apply has run for them, and the quiet app's closed generation left its
    // record unstamped — the residue the healing arm exists for.
    const quietApp = anApp();
    await seedLifecycleRow(quietApp, "2", true);
    const quietJob = await seedQueuedRecord({ appId: quietApp, generation: "1" });

    const appliedApp = anApp();
    await seedLifecycleRow(appliedApp, "1", false);
    const appliedJob = await seedQueuedRecord({ appId: appliedApp, generation: "1" });

    // The delivery under test: the archive for the applied app only.
    try {
      const applied = await lifecycle.apply(appliedApp, { generation: "2", archived: true });

      // The stamped count is the delivery's own cancellation reach — the
      // quiet app's residue is the healing arm's news, never this delivery's.
      expect(applied.stamped).toBe(1);
      // The apply's own record carries the intent...
      expect((await recordRow(appliedJob)).cancellation_requested).toBe(true);
      // ...and the quiet app's record is untouched by a delivery that is not
      // its app's: an apply that stamped across apps would misattribute the
      // quiet app's work to this delivery's span and ack evidence.
      expect((await recordRow(quietJob)).cancellation_requested).toBe(false);
    } finally {
      // Leave the store converged for the file's other legs, red or green.
      await settleCancelled(appliedJob);
      await settleCancelled(quietJob);
    }
  });

  test("the real measurement chain degrades the check past the 60-second bound and recovers it", async () => {
    const app = anApp();
    await lifecycle.apply(app, { generation: "1", archived: false });
    const jobId = await seedQueuedRecord({ appId: app, generation: "1" });

    // A first pass over the empty store: the freshness skeleton's baseline.
    await recovery.runPass();
    expect(recovery.snapshot().lifecycle).toEqual({ outstanding: 0, oldestPendingAt: null });

    // The archive stamps the queued record; the intent is backdated past the
    // bound so the opening measurement's age is what the check grades.
    const applied = await lifecycle.apply(app, { generation: "2", archived: true });
    expect(applied.stamped).toBe(1);
    await direct.query(
      `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
          SET cancellation_requested_at = now() - make_interval(secs => $2)
        WHERE job_id = $1`,
      [jobId, JOBS_LIFECYCLE_RECOVERY_OVERDUE_MS / 1000 + 1],
    );

    // The pass measures the backlog at its start, THEN reconciles the record
    // to its terminal outcome — the snapshot still carries the opening
    // evidence, and the check degrades on it.
    await recovery.runPass();
    const degraded = jobsLifecycleRecoveryCheck(recovery.snapshot());
    expect(degraded.status).toBe("degraded");
    expect(degraded.metrics).toMatchObject({ outstanding: 1 });
    expect(degraded.metrics?.oldestSeconds).toBeGreaterThanOrEqual(60);
    expect(degraded.detail).toMatch(/overdue/);
    await waitFor("the record to converge cancelled", async () => {
      const row = await recordRow(jobId);
      return row.status === "cancelled" && row.error_code === "cancelled";
    });

    // The next pass measures the empty backlog and the check recovers.
    await recovery.runPass();
    expect(recovery.snapshot().lifecycle).toEqual({ outstanding: 0, oldestPendingAt: null });
    const recovered = jobsLifecycleRecoveryCheck(recovery.snapshot());
    expect(recovered.status).toBe("ok");
    expect(recovered.metrics).toMatchObject({ outstanding: 0 });
  });

  test("the healing arm's reach is store-wide — residue no delivery named is stamped and converged", async () => {
    // The scope division's other half: no apply runs for either app here —
    // the residue exists only as closed generations with unstamped records,
    // in both disjunct shapes (below the watermark, and equal to it while
    // archived). One pass must stamp and converge both: the healing arm is
    // the store-wide reach, the news of every app whose deliveries stopped.
    const appBelow = anApp();
    await seedLifecycleRow(appBelow, "2", true);
    const belowJob = await seedQueuedRecord({ appId: appBelow, generation: "1" });
    const appEqual = anApp();
    await seedLifecycleRow(appEqual, "1", true);
    const equalJob = await seedQueuedRecord({ appId: appEqual, generation: "1" });

    // One pass, residue from two apps: the documented event fires ONCE for
    // the pass, carrying the store-wide count it stamped — not once per app,
    // not a per-app count. A healing arm restructured into per-app calls
    // (the stamp's optional appId invites it) would fire per app and break
    // the contract.
    const stampedEventsBefore = lifecycleStampedEvents().length;
    await recovery.runPass();
    const stampedEvents = lifecycleStampedEvents().slice(stampedEventsBefore);
    expect(stampedEvents).toHaveLength(1);
    expect(stampedEvents[0]?.stamped).toBe(2);

    for (const jobId of [belowJob, equalJob]) {
      const row = await recordRow(jobId);
      expect(row.cancellation_requested).toBe(true);
      expect(row.cancellation_requested_at).toBeInstanceOf(Date);
    }
    // The opening measurement counted both (taken after the healing stamp,
    // before the pass's own reconciliation converged them)...
    expect(recovery.snapshot().lifecycle?.outstanding).toBe(2);
    await waitFor("both healed records to converge cancelled", async () => {
      const rows = await Promise.all([recordRow(belowJob), recordRow(equalJob)]);
      return rows.every((row) => row.status === "cancelled" && row.error_code === "cancelled");
    });
    // ...and the next pass measures the empty store-wide backlog.
    await recovery.runPass();
    expect(recovery.snapshot().lifecycle).toEqual({ outstanding: 0, oldestPendingAt: null });
  });

  test("a pass that cannot reach the runner still reports the backlog it measured", async () => {
    // The evidence is recorded before the reconciliation, so a runner outage
    // suppresses the CONVERGENCE, never the visibility: the check keeps
    // grading the measured backlog (degraded past the bound) instead of
    // losing the evidence to the outage. A measurement moved behind the
    // runner read would make every outage hide unfinished work — the exact
    // state an operator most needs to see.
    let runnerUp = true;
    const outage = new JobsRecovery({
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      readRunnerJob: async () =>
        runnerUp
          ? { verdict: "found", state: "created", output: null }
          : { verdict: "unavailable", reason: "the runner is not answering" },
      cancelRunnerJob: async () => ({ verdict: "cancelled" }),
      intervalMs: 3_600_000,
      log: LOG,
    });
    try {
      outage.start();
      await waitFor(
        "the outage sweeper's first pass to complete",
        async () => outage.snapshot().passes >= 1,
      );
      expect(outage.snapshot().lastOkPassAt).not.toBeNull();

      const app = anApp();
      await lifecycle.apply(app, { generation: "1", archived: false });
      const jobId = await seedQueuedRecord({ appId: app, generation: "1" });
      const applied = await lifecycle.apply(app, { generation: "2", archived: true });
      expect(applied.stamped).toBe(1);
      await direct.query(
        `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
            SET cancellation_requested_at = now() - make_interval(secs => $2)
          WHERE job_id = $1`,
        [jobId, JOBS_LIFECYCLE_RECOVERY_OVERDUE_MS / 1000 + 1],
      );

      // The pass measures the backlog, then aborts at the runner read.
      runnerUp = false;
      await outage.runPass();
      const evidence = outage.snapshot().lifecycle;
      expect(evidence).toEqual({
        outstanding: 1,
        oldestPendingAt: expect.any(String),
      });
      const degraded = jobsLifecycleRecoveryCheck(outage.snapshot());
      expect(degraded.status).toBe("degraded");
      expect(degraded.metrics).toMatchObject({ outstanding: 1 });
      expect(degraded.detail).toMatch(/overdue/);

      // The outage over, the next pass converges the record and the check
      // recovers — the evidence was a report, never a dead state.
      runnerUp = true;
      await outage.runPass();
      await waitFor("the outage leg's record to converge cancelled", async () => {
        const row = await recordRow(jobId);
        return row.status === "cancelled" && row.error_code === "cancelled";
      });
      await outage.runPass();
      expect(outage.snapshot().lifecycle).toEqual({ outstanding: 0, oldestPendingAt: null });
      expect(jobsLifecycleRecoveryCheck(outage.snapshot()).status).toBe("ok");
    } finally {
      await outage.stop();
    }
  });
});

/** Bounded wait for a store state the machinery's own cadence produces. */
async function waitFor(what: string, probe: () => Promise<boolean>): Promise<void> {
  const by = Date.now() + 45_000;
  while (Date.now() < by) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}
