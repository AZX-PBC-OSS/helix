import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  JOB_TERMINAL_STATUSES,
  JOBS_INTAKE_CHECK,
  JobAcceptedSchema,
  JobRequestErrorSchema,
  resolveJobsCapacityLimits,
} from "@azx-pbc/shared";
import type { JobsCancelClaims, JobsSnapshotClaims } from "@azx-pbc/shared/jobsSigning";
import {
  ATTR_JOBS_INTAKE_CHANGED,
  ATTR_JOBS_SERVER,
  ATTR_OUTCOME,
  SPAN_JOBS_INTAKE,
} from "@azx-pbc/shared/telemetry";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";

import {
  createPgbossEnqueuer,
  JOBS_ADMISSION_LOCK_KEY,
  JobsAcceptanceStore,
  type JobsAdmissionResult,
} from "./acceptance.js";
import { JobsCancellationStore } from "./cancellation.js";
import { JobsCleanup } from "./cleanup.js";
import { jobsIntakeCheck } from "./health.js";
import { JobsIntake, type JobsIntakeSnapshot } from "./intake.js";
import { JobsLifecycleStore } from "./lifecycle.js";
import { migrateJobsStorage } from "./migrate.js";
import { JobsObservationStore } from "./observation.js";
import {
  JOBS_INTAKE_QUALIFIED,
  JOBS_JOB_RECORD_QUALIFIED,
  JOBS_PGBOSS_SCHEMA,
  JOBS_RUNTIME_ROLE,
  jobsRuntimeBossOptions,
} from "./policy.js";
import { cancelRunnerJob, deleteRunnerJobs } from "./runner.js";
import { applyRolesProvisioning } from "../../portal/src/test/provisionDatabases.js";
import {
  appWithLifecycle,
  cancelClaims,
  cancelSpec,
  instructionHeaders,
  makeReceiver,
  mint,
  recordReadClaims,
  runningCleanup,
  submitClaims,
  submitSpec,
  TEST_BODY,
  TEST_IDENTITY,
} from "./test/instructions.js";

/**
 * The durable intake closure against the real store, the real admission
 * transaction and the real role split: the per-server posture applied under
 * the admission lock (so a closure serializes with in-flight enqueue
 * transactions and never retroactively refuses one), the refusals that
 * follow it while retained-key recovery, observation, cancellation and
 * lifecycle delivery keep working, the repointing guard, the supervised
 * retry, and the `jobs_intake` health check graded from real drain evidence.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

const SCRATCH_DB = `helix_jobs_intake_${randomUUID().replaceAll("-", "")}`;

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
/** The store owner's DSN — the identity the repointing legs reset the row through. */
const OWNER_DSN = urlFor(SCRATCH_DB);

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

const BODY = new TextEncoder().encode(TEST_BODY);
const OTHER_BODY = new TextEncoder().encode('{"url":"https://example.com/other.json"}');

let boss: PgBoss;
let admission: JobsAcceptanceStore;
let lifecycle: JobsLifecycleStore;
let observation: JobsObservationStore;
let cancellation: JobsCancellationStore;
let direct: Pool;
let owner: Pool;

beforeAll(async () => {
  await applyRolesProvisioning(SCRATCH_DB);
  await migrateJobsStorage(urlFor(SCRATCH_DB, "helix_jobs_migrate"));
  boss = new PgBoss({ connectionString: RUNTIME_DSN, ...jobsRuntimeBossOptions() });
  await boss.start();
  admission = new JobsAcceptanceStore({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    limits: LIMITS,
    accepting: true,
    enqueuer: createPgbossEnqueuer(boss),
    log: LOG,
  });
  admission.start();
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
  direct = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
  owner = new Pool({ connectionString: OWNER_DSN, max: 1 });
}, 60_000);

afterAll(async () => {
  await owner.end();
  await direct.end();
  await cancellation.stop();
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

/** An intake applier over this file's store, with the given posture and server id. */
function makeIntake(
  accepting: boolean,
  serverId: string = "jobs",
  log: JobsIntakeLogSink = LOG,
): JobsIntake {
  return new JobsIntake({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    serverId,
    accepting,
    log,
  });
}

type JobsIntakeLogSink = {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
};

/** The intake row's durable state, read directly. */
async function intakeRow(): Promise<{ accepting: boolean; server: string | null }> {
  const result = await direct.query<{ accepting: boolean; server: string | null }>(
    `SELECT accepting, server FROM ${JOBS_INTAKE_QUALIFIED} WHERE singleton`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("the intake row is absent — the migration seeds it");
  return row;
}

/** Put the durable row back to the wanted posture (the runtime role holds UPDATE). */
async function resetIntakeRow(accepting: boolean): Promise<void> {
  await direct.query(`UPDATE ${JOBS_INTAKE_QUALIFIED} SET accepting = $1 WHERE singleton`, [
    accepting,
  ]);
}

/** Start an intake, await its one apply's outcome, release it. */
async function applyAndWait(accepting: boolean, serverId?: string): Promise<JobsIntakeSnapshot> {
  const intake = makeIntake(accepting, serverId);
  intake.start();
  try {
    await expect(intake.applyOnce()).resolves.toMatchObject({ kind: "applied", accepting });
  } finally {
    await intake.stop();
  }
  return intake.snapshot();
}

/** Deliver one lifecycle generation through the real store — the portal's half of the gate. */
async function deliverGeneration(
  appId: string,
  generation: string,
  archived: boolean,
): Promise<void> {
  await lifecycle.apply(appId, { generation, archived });
}

/** One admission of the given body under this app's identity, with overrides. */
async function admit(
  appId: string,
  body: Uint8Array,
  over: Parameters<typeof submitClaims>[0] = {},
): Promise<JobsAdmissionResult> {
  return admission.admit({
    claims: submitClaims({
      generation: "1",
      ...over,
      identity: { ...TEST_IDENTITY, appId, ...(over.identity ?? {}) },
    }),
    body,
  });
}

/** The durable wrapper records of one app, read directly — not through the store. */
async function records(appId: string): Promise<Record<string, unknown>[]> {
  const result = await direct.query(
    `SELECT * FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE app_id = $1 ORDER BY created_at, job_id`,
    [appId],
  );
  return result.rows;
}

/** The runner's own rows joined to the app's records by the stored runner id. */
async function runnerRows(appId: string): Promise<Record<string, unknown>[]> {
  // The runner's id column is a uuid; the wrapper stores it as the bounded
  // opaque text the adapter hands back — the join casts.
  const result = await direct.query(
    `SELECT r.name, r.state FROM ${JOBS_PGBOSS_SCHEMA}.job r
       JOIN ${JOBS_JOB_RECORD_QUALIFIED} w ON w.runner_job_id = r.id::text AND w.server = r.name
      WHERE w.app_id = $1`,
    [appId],
  );
  return result.rows;
}

/** The server-wide occupancy the cleanup pass measures and the health check reports. */
async function serverOccupancy(): Promise<{ retained: number; unfinished: number }> {
  const result = await direct.query<{ retained: number; unfinished: number }>(
    `SELECT count(*)::int AS retained,
            count(*) FILTER (WHERE NOT status = ANY($1::text[]))::int AS unfinished
       FROM ${JOBS_JOB_RECORD_QUALIFIED}`,
    [JOB_TERMINAL_STATUSES],
  );
  const row = result.rows[0]!;
  return { retained: row.retained, unfinished: row.unfinished };
}

describe("closure serializes with in-flight enqueue transactions", () => {
  test("a closing apply waits for an admission lock holder, never retroactively refusing it", async () => {
    await resetIntakeRow(true);
    // An admission mid-enqueue, simulated at the lock itself: the holder's
    // transaction carries the advisory lock and nothing else.
    const holder = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
    const client = await holder.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [JOBS_ADMISSION_LOCK_KEY]);

    const closing = makeIntake(false);
    closing.start();
    const applied = closing.applyOnce();

    // The apply has begun (its attempt stamped) and cannot settle while
    // the holder holds the lock: the serialization is observable, not
    // assumed.
    await waitFor("the closing apply to begin", () => closing.snapshot().lastAttemptAt !== null);
    const settledEarly = await Promise.race([
      applied.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), 300)),
    ]);
    expect(settledEarly).toBe(false);
    expect((await intakeRow()).accepting).toBe(true);

    await client.query("COMMIT");
    client.release();
    await holder.end();

    await expect(applied).resolves.toEqual({ kind: "applied", accepting: false, changed: true });
    expect((await intakeRow()).accepting).toBe(false);
    await closing.stop();
  }, 30_000);

  test("an in-flight enqueue commits before the closing apply lands; later new work is refused", async () => {
    await resetIntakeRow(true);
    const appId = anApp();
    await deliverGeneration(appId, "1", false);

    // A real admission whose enqueuer blocks inside the acceptance
    // transaction — the admission holds the advisory lock exactly the way
    // a mid-enqueue submission does.
    let releaseEnqueue: (() => void) | undefined;
    const releaseGate = new Promise<void>((resolve) => {
      releaseEnqueue = resolve;
    });
    let entered: (() => void) | undefined;
    const enqueueEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gated = new JobsAcceptanceStore({
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      limits: LIMITS,
      accepting: true,
      enqueuer: {
        enqueue: async (withinTx, job) => {
          entered?.();
          await releaseGate;
          return createPgbossEnqueuer(boss).enqueue(withinTx, job);
        },
      },
      log: LOG,
    });
    gated.start();
    let closing: JobsIntake | undefined;
    try {
      let admissionSettled = false;
      const inFlight = gated
        .admit({
          claims: submitClaims({
            identity: { ...TEST_IDENTITY, appId },
            generation: "1",
            idempotencyKey: "in-flight-closure",
          }),
          body: BODY,
        })
        .then((result) => {
          admissionSettled = true;
          return result;
        });
      await enqueueEntered;

      closing = makeIntake(false);
      closing.start();
      const applied = closing.applyOnce();
      await waitFor("the closing apply to begin", () => closing!.snapshot().lastAttemptAt !== null);
      const settledEarly = await Promise.race([
        applied.then(() => true),
        new Promise<false>((r) => setTimeout(() => r(false), 300)),
      ]);
      expect(settledEarly).toBe(false);

      releaseEnqueue?.();
      await expect(inFlight).resolves.toMatchObject({ outcome: "accepted" });
      // The apply settled only after the admission did — the closure never
      // retroactively refuses the work it waited for.
      expect(admissionSettled).toBe(true);
      await expect(applied).resolves.toEqual({
        kind: "applied",
        accepting: false,
        changed: true,
      });
      // The in-flight job IS committed and readable.
      const kept = (await records(appId)).filter((r) => r.retry_key === "in-flight-closure");
      expect(kept).toHaveLength(1);
      expect(await runnerRows(appId)).toHaveLength(1);

      // A new admission on an accepting=true store instance: the durable
      // row is closed — this replica's own config says open, and the store
      // still refuses.
      await expect(admit(appId, BODY, { idempotencyKey: "after-closure" })).resolves.toEqual({
        outcome: "intake_closed",
      });
      expect((await records(appId)).filter((r) => r.retry_key === "after-closure")).toHaveLength(0);
    } finally {
      await gated.stop();
      if (closing) await closing.stop();
    }
  }, 30_000);
});

describe("a closed intake refuses new work and keeps retained access", () => {
  test("recovery and conflict still answer, new work is refused with nothing created, and the retained job stays fully serviceable", async () => {
    await resetIntakeRow(true);
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const first = await admit(appId, BODY, { idempotencyKey: "kept-key" });
    expect(first.outcome).toBe("accepted");
    if (first.outcome !== "accepted") return;

    // Close durably, through the real applier.
    await applyAndWait(false);
    expect((await intakeRow()).accepting).toBe(false);

    // Same key, same bytes: the original job recovers — the comparison is
    // decided before the intake check.
    await expect(admit(appId, BODY, { idempotencyKey: "kept-key" })).resolves.toEqual({
      outcome: "recovered",
      jobId: first.jobId,
      status: "queued",
    });
    // Same key, different bytes: the conflict still stands.
    await expect(admit(appId, OTHER_BODY, { idempotencyKey: "kept-key" })).resolves.toMatchObject({
      outcome: "conflict",
    });

    // New work: refused, and nothing is created — no wrapper row, no runner
    // row.
    const before = await records(appId);
    const beforeRunners = await runnerRows(appId);
    await expect(admit(appId, BODY, { idempotencyKey: "new-key-closed" })).resolves.toEqual({
      outcome: "intake_closed",
    });
    expect(await records(appId)).toHaveLength(before.length);
    expect(await runnerRows(appId)).toHaveLength(beforeRunners.length);

    // The retained job's observation read works untouched by intake.
    const snapshot = await observation.snapshot({
      claims: recordReadClaims("snapshot", {
        jobId: first.jobId,
        identity: { ...TEST_IDENTITY, appId },
      }) as JobsSnapshotClaims,
      jobId: first.jobId,
    });
    expect(snapshot.outcome).toBe("found");
    if (snapshot.outcome === "found") {
      expect(snapshot.snapshot.status).toBe("queued");
      expect(snapshot.snapshot.jobId).toBe(first.jobId);
    }

    // A lifecycle delivery (the archive's next generation) applies and
    // stamps the retained active job — lifecycle delivery is untouched by
    // intake.
    const delivery = await lifecycle.apply(appId, { generation: "2", archived: true });
    expect(delivery.appliedGeneration).toBe("2");
    expect(delivery.stamped).toBe(1);

    // The owner-cancellation request acknowledges and the record carries the
    // durable intent (a repeat over the delivery's own stamp — the same
    // acknowledgement).
    const verdict = await cancellation.requestCancel({
      claims: cancelClaims({
        jobId: first.jobId,
        identity: { ...TEST_IDENTITY, appId },
      }) as JobsCancelClaims,
      jobId: first.jobId,
    });
    expect(verdict.outcome).toBe("requested");
    const rows = await records(appId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cancellation_requested).toBe(true);
  });
});

describe("the process flag alone closes", () => {
  test("a store whose configured posture is closed refuses new work while the durable row stays open", async () => {
    await resetIntakeRow(true);
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const closedProcess = new JobsAcceptanceStore({
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      limits: LIMITS,
      accepting: false,
      enqueuer: createPgbossEnqueuer(boss),
      log: LOG,
    });
    closedProcess.start();
    try {
      await expect(
        closedProcess.admit({
          claims: submitClaims({
            identity: { ...TEST_IDENTITY, appId },
            generation: "1",
            idempotencyKey: "flag-closed",
          }),
          body: BODY,
        }),
      ).resolves.toEqual({ outcome: "intake_closed" });
      // The refusal was the process's own flag: the durable row was never
      // touched.
      expect((await intakeRow()).accepting).toBe(true);
    } finally {
      await closedProcess.stop();
    }
  });
});

describe("a temporary shutdown resumes on the same store", () => {
  test("a reopening apply flips the row open, the pre-closure key replays its original job, and new work is accepted", async () => {
    await resetIntakeRow(true);
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const before = await admit(appId, BODY, { idempotencyKey: "resume-key" });
    expect(before.outcome).toBe("accepted");
    if (before.outcome !== "accepted") return;

    await applyAndWait(false);

    // A NEW applier, configured open, applies itself to the same store.
    const snapshot = await applyAndWait(true);
    expect(snapshot.phase).toBe("applied");
    expect((await intakeRow()).accepting).toBe(true);

    // The pre-closure key replays the ORIGINAL job — one row for the key.
    await expect(admit(appId, BODY, { idempotencyKey: "resume-key" })).resolves.toEqual({
      outcome: "recovered",
      jobId: before.jobId,
      status: "queued",
    });
    // And a new key is accepted again.
    await expect(admit(appId, BODY, { idempotencyKey: "after-reopen" })).resolves.toMatchObject({
      outcome: "accepted",
    });
  });
});

describe("the repointing guard", () => {
  test("a store bound to another server's id is refused, and a server-less row with foreign job records is refused too", async () => {
    // The store is bound to "jobs" by this file's earlier applies.
    await resetIntakeRow(true);
    const before = await intakeRow();
    const foreign = makeIntake(true, "other");
    foreign.start();
    try {
      await expect(foreign.applyOnce()).resolves.toEqual({
        kind: "refused",
        boundServer: "jobs",
      });
      // The row is unchanged — a refusal writes nothing.
      expect(await intakeRow()).toEqual(before);
      // And the supervision reports the refusal with the namespace named.
      const snapshot = foreign.snapshot();
      expect(snapshot.phase).toBe("refused");
      expect(snapshot.boundServer).toBe("jobs");
    } finally {
      await foreign.stop();
    }

    // A row with no bound server is still refused when the store's job
    // records carry another server's namespace — the records are the
    // evidence the guard trusts over the row.
    await owner.query(`UPDATE ${JOBS_INTAKE_QUALIFIED} SET server = NULL WHERE singleton`);
    const foreign2 = makeIntake(true, "other");
    foreign2.start();
    try {
      await expect(foreign2.applyOnce()).resolves.toEqual({
        kind: "refused",
        boundServer: "jobs",
      });
      expect((await intakeRow()).server).toBeNull();
    } finally {
      await foreign2.stop();
    }
  });

  test("an admission whose claims name a server the store is not bound to is refused", async () => {
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    // The state a mispointed deployment presents: the row bound to another
    // server (written with the owner DSN — a refusal never writes it, and
    // this file's own appliers are all bound to "jobs").
    await owner.query(
      `UPDATE ${JOBS_INTAKE_QUALIFIED} SET accepting = true, server = 'other' WHERE singleton`,
    );
    await expect(admit(appId, BODY, { idempotencyKey: null })).resolves.toEqual({
      outcome: "intake_closed",
    });
    expect(await records(appId)).toHaveLength(0);
    // Rebind the row to "jobs" — the legs that follow admit as "jobs".
    await owner.query(
      `UPDATE ${JOBS_INTAKE_QUALIFIED} SET accepting = true, server = 'jobs' WHERE singleton`,
    );
  });
});

describe("supervision against a store that does not answer", () => {
  test("start reports pending, retries on its backoff without throwing, and stop resolves", async () => {
    const failures: Array<Record<string, unknown>> = [];
    const unreachable = new JobsIntake({
      databaseUrl: urlFor(SCRATCH_DB, JOBS_RUNTIME_ROLE).replace(":5432", ":1"),
      statementTimeoutMs: 500,
      serverId: "jobs",
      accepting: false,
      retry: { initialMs: 50, maxMs: 200 },
      log: {
        info: () => {},
        warn: (fields) => failures.push(fields),
        error: () => {},
      },
    });
    unreachable.start();
    try {
      await waitFor(
        "the first attempt to be recorded",
        () => unreachable.snapshot().lastAttemptAt !== null,
      );
      // The retries continue on the capped ladder: several failed attempts
      // accumulate, the phase stays pending, and nothing throws.
      await waitFor(
        "the second failed attempt",
        () => failures.filter((f) => f.event === "jobs.intake.apply_failed").length >= 2,
      );
      const snapshot = unreachable.snapshot();
      expect(snapshot.phase).toBe("pending");
      expect(snapshot.appliedAt).toBeNull();
      expect(failures.every((f) => f.event === "jobs.intake.apply_failed")).toBe(true);
    } finally {
      await expect(unreachable.stop()).resolves.toBeUndefined();
    }
    // Safe twice; the snapshot keeps reporting the pending state.
    await expect(unreachable.stop()).resolves.toBeUndefined();
    expect(unreachable.snapshot().phase).toBe("pending");
  });
});

describe("the health check from real evidence", () => {
  test("a closed intake grades ok with the drain counts a real cleanup pass measured", async () => {
    // Close through the real applier (idempotent when already closed).
    const closing = makeIntake(false);
    closing.start();
    try {
      await expect(closing.applyOnce()).resolves.toMatchObject({ kind: "applied" });

      // A real cleanup pass measures the server-wide occupancy.
      const cleanup = new JobsCleanup({
        databaseUrl: RUNTIME_DSN,
        statementTimeoutMs: 10_000,
        deleteRunnerRows: {
          delete: (withinTx, runnerJobIds) => deleteRunnerJobs(boss, withinTx, runnerJobIds),
        },
        intervalMs: 3_600_000,
        log: LOG,
      });
      cleanup.start();
      try {
        await waitFor("the first cleanup pass to complete", () => cleanup.snapshot().passes >= 1);

        const counted = await serverOccupancy();
        const check = jobsIntakeCheck(closing.snapshot(), cleanup.snapshot());
        expect(check.name).toBe("jobs_intake");
        expect(check.status).toBe("ok");
        expect(check.metrics).toEqual({
          unfinishedServer: counted.unfinished,
          retainedServer: counted.retained,
        });
        expect(check.detail).toMatch(/intake is closed/);
      } finally {
        await cleanup.stop();
      }
    } finally {
      await closing.stop();
    }
  });
});

describe("the intake apply's span", () => {
  // One recording for the describe block: a module-scope tracer keeps its
  // first delegate after a restore, so the recording wraps exactly these
  // legs and nothing else in this file emits spans.
  let recording: RecordingTelemetry;

  beforeAll(() => {
    recording = startRecordingTelemetry();
  });
  afterAll(async () => {
    await recording.restore();
  });

  test("one span per apply, the bounded outcome, the server id and the changed flag — and nothing unbounded", async () => {
    await resetIntakeRow(true);

    // An opened apply: the row was open, so the re-apply changed nothing.
    const opener = makeIntake(true);
    opener.start();
    await expect(opener.applyOnce()).resolves.toMatchObject({ kind: "applied", accepting: true });
    await opener.stop();

    // A closing apply: the row moves, and the span carries the change.
    const closer = makeIntake(false);
    closer.start();
    await expect(closer.applyOnce()).resolves.toEqual({
      kind: "applied",
      accepting: false,
      changed: true,
    });
    await closer.stop();

    // A refused apply: the foreign server's namespace.
    const foreign = makeIntake(true, "other");
    foreign.start();
    await expect(foreign.applyOnce()).resolves.toMatchObject({ kind: "refused" });
    await foreign.stop();

    await resetIntakeRow(true);

    const spans = recording.spans().filter((s) => s.name === SPAN_JOBS_INTAKE);
    expect(spans).toHaveLength(3);
    const [opened, closed, refused] = spans;
    expect(opened?.attributes[ATTR_OUTCOME]).toBe("opened");
    expect(opened?.attributes[ATTR_JOBS_SERVER]).toBe("jobs");
    expect(opened?.attributes[ATTR_JOBS_INTAKE_CHANGED]).toBe(false);
    expect(opened?.status.code).toBe(0); // UNSET — the designed answer

    expect(closed?.attributes[ATTR_OUTCOME]).toBe("closed");
    expect(closed?.attributes[ATTR_JOBS_SERVER]).toBe("jobs");
    expect(closed?.attributes[ATTR_JOBS_INTAKE_CHANGED]).toBe(true);

    expect(refused?.attributes[ATTR_OUTCOME]).toBe("refused");
    expect(refused?.attributes[ATTR_JOBS_SERVER]).toBe("other");
    expect(refused?.attributes[ATTR_JOBS_INTAKE_CHANGED]).toBeUndefined();
    expect(refused?.status.code).toBe(2); // ERROR — a refusal is the failure exit

    // The red line: no attribute's value carries the DSN, a password, a
    // retry key or the store owner's credentials — the span is about the
    // apply, never the connection.
    const retryKeys = [
      "kept-key",
      "new-key-closed",
      "resume-key",
      "after-reopen",
      "in-flight-closure",
    ];
    for (const span of spans) {
      for (const [key, value] of Object.entries(span.attributes)) {
        const text = String(value);
        expect(text, `attr ${key} carries a connection string`).not.toMatch(/postgres(ql)?:\/\//);
        expect(text, `attr ${key} carries the store name`).not.toContain(SCRATCH_DB);
        expect(text, `attr ${key} carries a retry key`).not.toContain("kept-key");
        for (const retryKey of retryKeys) {
          expect(text, `attr ${key} carries a retry key`).not.toContain(retryKey);
        }
      }
    }
  });
});

describe("a retired server's references keep routing through the signed routes", () => {
  test("snapshot, keyed recovery and cancel answer the original {server, jobId}; new work is 503 jobs_disabled", async () => {
    await resetIntakeRow(true);
    const appId = anApp();
    const identity = { ...TEST_IDENTITY, appId };
    await deliverGeneration(appId, "7", false);
    const before = await admit(appId, BODY, { generation: "7", idempotencyKey: "route-key" });
    expect(before.outcome).toBe("accepted");
    if (before.outcome !== "accepted") return;

    // Retire: the durable row closes, and this replica is configured closed.
    await applyAndWait(false);
    const retired = new JobsAcceptanceStore({
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      limits: LIMITS,
      accepting: false,
      enqueuer: createPgbossEnqueuer(boss),
      log: LOG,
    });
    retired.start();
    const receiver = makeReceiver();
    const { app } = await appWithLifecycle(
      receiver,
      lifecycle,
      retired,
      cancellation,
      observation,
      runningCleanup,
    );
    try {
      const snapshotToken = await mint(
        cancelSpec({ operation: "snapshot", identity, jobId: before.jobId }),
      );
      const snapshot = await app.inject({
        method: "GET",
        url: `/internal/jobs/v1/jobs/${before.jobId}`,
        headers: instructionHeaders(snapshotToken),
      });
      expect(snapshot.statusCode).toBe(200);
      expect(snapshot.json()).toMatchObject({ server: "jobs", jobId: before.jobId });

      const replay = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: {
          "content-type": "application/json",
          ...instructionHeaders(
            await mint(submitSpec({ identity, idempotencyKey: "route-key" })),
            "route-key",
          ),
        },
        payload: TEST_BODY,
      });
      expect(replay.statusCode).toBe(202);
      expect(JobAcceptedSchema.parse(replay.json())).toEqual({
        server: "jobs",
        jobId: before.jobId,
        status: "queued",
      });

      const fresh = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: {
          "content-type": "application/json",
          ...instructionHeaders(
            await mint(submitSpec({ identity, idempotencyKey: "route-new" })),
            "route-new",
          ),
        },
        payload: TEST_BODY,
      });
      expect(fresh.statusCode).toBe(503);
      expect(JobRequestErrorSchema.parse(fresh.json()).code).toBe("jobs_disabled");
      expect((await records(appId)).map((r) => r.retry_key)).toEqual(["route-key"]);

      const cancel = await app.inject({
        method: "DELETE",
        url: `/internal/jobs/v1/jobs/${before.jobId}`,
        headers: instructionHeaders(await mint(cancelSpec({ identity, jobId: before.jobId }))),
      });
      expect(cancel.statusCode).toBe(202);
      expect(cancel.json()).toEqual({
        server: "jobs",
        jobId: before.jobId,
        cancellationRequested: true,
      });
    } finally {
      await app.close();
      await retired.stop();
    }

    // The health route over a really closed intake: the applier's own
    // snapshot, graded against fresh drain evidence of what remains.
    const closedIntake = makeIntake(false);
    closedIntake.start();
    await expect(closedIntake.applyOnce()).resolves.toMatchObject({ kind: "applied" });
    const evidence = runningCleanup();
    evidence.evidence = { ...evidence.evidence!, unfinishedServer: 1, retainedServer: 1 };
    const { app: healthApp } = await appWithLifecycle(
      makeReceiver(),
      lifecycle,
      admission,
      cancellation,
      observation,
      () => evidence,
      () => closedIntake.snapshot(),
    );
    try {
      const health = await healthApp.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      const checks = (health.json() as { checks: Array<Record<string, unknown>> }).checks;
      expect(checks.find((c) => c.name === JOBS_INTAKE_CHECK)).toMatchObject({
        status: "ok",
        metrics: { unfinishedServer: 1, retainedServer: 1 },
        detail:
          "intake is closed; 1 unfinished and 1 retained jobs remain — retirement is complete only when both reach zero",
      });
    } finally {
      await healthApp.close();
      await closedIntake.stop();
    }
  }, 30_000);
});
