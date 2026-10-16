import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { sha256BodyDigest } from "@azx-pbc/shared/jobsSigning";
import {
  createPgbossEnqueuer,
  JobsAcceptanceStore,
  type JobsAcceptanceStoreOptions,
  type JobsAdmissionResult,
} from "./acceptance.js";
import { migrateJobsStorage } from "./migrate.js";
import { JobsLifecycleStore } from "./lifecycle.js";
import {
  JOBS_JOB_RECORD_QUALIFIED,
  JOBS_PGBOSS_SCHEMA,
  JOBS_QUEUE_NAME,
  JOBS_RUNTIME_ROLE,
  jobsAppEnvGroupId,
  jobsRuntimeBossOptions,
} from "./policy.js";
import { applyRolesProvisioning } from "../../portal/src/test/provisionDatabases.js";
import { submitClaims, TEST_BODY, TEST_IDENTITY } from "./test/instructions.js";

/**
 * The acceptance transaction against the real store, the real runner and the
 * real role split (ADR-0003): the durable retry identity, the exact-byte
 * comparison and its precedence over validation and intake, the atomic join
 * of the wrapper record to the runner enqueue, and the concurrency that must
 * resolve simultaneous identical submissions to one job.
 *
 * The borrowed-connection enqueue is exercised by the pinned dependency
 * itself — the store's enqueuer is the real `createPgbossEnqueuer` over a
 * real started pg-boss — because the design requires the adapter's
 * transaction, duplicate and rollback interleavings to be validated with the
 * runner, not asserted from a substitute.
 *
 * Each test admits under its own app id (the identity namespaces are
 * disjoint by construction), so no leg depends on another's rows.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

const SCRATCH_DB = `helix_jobs_accept_${randomUUID().replaceAll("-", "")}`;

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

const LOG = { warn: () => {} };

/** The body every test submission carries, as bytes — and its variants. */
const BODY = new TextEncoder().encode(TEST_BODY);
const OTHER_BODY = new TextEncoder().encode('{"url":"https://example.com/other.json"}');
/** JSON that is not a fetch input — new work must refuse it, replays must still compare. */
const INVALID_BODY = new TextEncoder().encode('{"url":"ftp://example.com/not-http"}');

let boss: PgBoss;
let store: JobsAcceptanceStore;
let lifecycle: JobsLifecycleStore;
let direct: Pool;

beforeAll(async () => {
  await applyRolesProvisioning(SCRATCH_DB);
  await migrateJobsStorage(urlFor(SCRATCH_DB, "helix_jobs_migrate"));
  boss = new PgBoss({ connectionString: RUNTIME_DSN, ...jobsRuntimeBossOptions() });
  await boss.start();
  store = new JobsAcceptanceStore({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    enqueuer: createPgbossEnqueuer(boss),
    log: LOG,
  });
  store.start();
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
  await store.stop();
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
  return store.admit({
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
    `SELECT r.name, r.state, r.retry_limit, r.expire_seconds, r.group_id, r.data
       FROM ${JOBS_PGBOSS_SCHEMA}.job r
       JOIN ${JOBS_JOB_RECORD_QUALIFIED} w ON w.runner_job_id = r.id::text AND w.server = r.name
      WHERE w.app_id = $1`,
    [appId],
  );
  return result.rows;
}

describe("the acceptance transaction", () => {
  test("an unkeyed submission is accepted as new work, enqueued with its wrapper record", async () => {
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const result = await admit(appId, BODY, { idempotencyKey: null });
    expect(result).toMatchObject({ outcome: "accepted", status: "queued" });
    if (result.outcome !== "accepted") return;
    expect(result.jobId).toMatch(/^[A-Za-z0-9_-]+$/);

    const rows = await records(appId);
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row.job_id).toBe(result.jobId);
    expect(row.status).toBe("queued");
    expect(row.retry_key).toBeNull();
    expect(row.body_sha256).toHaveLength(64);
    expect(row.type).toBe("jobs:fetch");
    expect(row.env).toBe("prod");
    expect(row.owner_kind).toBe("user");
    expect(row.generation).toBe("1");
    // The runner row exists and is joined by the stored runner id.
    const runner = await runnerRows(appId);
    expect(runner).toHaveLength(1);
    expect(runner[0]?.data).toEqual({ url: "https://example.com/data.json" });
  });

  test("each unkeyed POST is new, independent work", async () => {
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const first = await admit(appId, BODY, { idempotencyKey: null });
    const second = await admit(appId, BODY, { idempotencyKey: null });
    expect(first.outcome).toBe("accepted");
    expect(second.outcome).toBe("accepted");
    if (first.outcome !== "accepted" || second.outcome !== "accepted") return;
    expect(second.jobId).not.toBe(first.jobId);
    expect(await records(appId)).toHaveLength(2);
    expect(await runnerRows(appId)).toHaveLength(2);
  });

  test("a keyed resubmission with identical bytes recovers the original job and creates nothing", async () => {
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const first = await admit(appId, BODY, { idempotencyKey: "recover-1" });
    expect(first.outcome).toBe("accepted");
    if (first.outcome !== "accepted") return;

    // The lost-reply recovery: the same keyed POST, a fresh decision.
    const replay = await admit(appId, BODY, { idempotencyKey: "recover-1" });
    expect(replay).toEqual({ outcome: "recovered", jobId: first.jobId, status: "queued" });

    // One wrapper record, one runner row: no second job, no second slot.
    expect(await records(appId)).toHaveLength(1);
    expect(await runnerRows(appId)).toHaveLength(1);
  });

  test("a keyed resubmission with different bytes conflicts without creating work", async () => {
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    await admit(appId, BODY, { idempotencyKey: "conflict-1" });
    const runnerBefore = await runnerRows(appId);

    // Equivalent JSON serialized differently is still different bytes.
    const reserialized = new TextEncoder().encode('{ "url" : "https://example.com/data.json" }');
    const conflict = await admit(appId, reserialized, { idempotencyKey: "conflict-1" });
    expect(conflict).toMatchObject({ outcome: "conflict", status: "queued", error: null });
    expect(await admit(appId, OTHER_BODY, { idempotencyKey: "conflict-1" })).toMatchObject({
      outcome: "conflict",
    });

    expect(await records(appId)).toHaveLength(1);
    expect(await runnerRows(appId)).toHaveLength(runnerBefore.length);
  });

  test("the comparison precedes new-input validation: different-but-invalid bytes still conflict, identical bytes recover what validation would now refuse", async () => {
    const appId = anApp();
    // The key's original bytes were accepted under an older validation era;
    // the mapping is seeded directly — the only way to time-travel the
    // rules — carrying the digest of bytes the CURRENT input contract
    // refuses.
    const digest = sha256BodyDigest(INVALID_BODY);
    await direct.query(
      `INSERT INTO ${JOBS_JOB_RECORD_QUALIFIED}
         (server, job_id, runner_job_id, app_id, env, owner_kind, owner_oid, type,
          generation, status, retry_key, body_sha256, created_at)
       VALUES ('jobs', 'old-era-job', '11111111-1111-4111-8111-111111111111', $1, 'prod',
               'user', $2, 'jobs:fetch', 1, 'queued', 'old-era', $3, now())`,
      [appId, TEST_IDENTITY.ownerOid, digest],
    );

    // Different bytes that are ALSO unreadable as new work: the comparison
    // precedes validation, so the answer is the conflict, not a 400.
    const otherInvalid = new TextEncoder().encode('{"url":"https://not-even-json"');
    const conflict = await admit(appId, otherInvalid, { idempotencyKey: "old-era" });
    expect(conflict).toMatchObject({ outcome: "conflict", status: "queued", error: null });

    // Identical bytes — invalid for new work under the CURRENT rules —
    // recover the original job: the recovery never validates.
    const recovered = await admit(appId, INVALID_BODY, { idempotencyKey: "old-era" });
    expect(recovered).toEqual({ outcome: "recovered", jobId: "old-era-job", status: "queued" });

    // The recovery projects the job's CURRENT stored status, whatever it is
    // — not a hard-coded admission state.
    await direct.query(
      `UPDATE ${JOBS_JOB_RECORD_QUALIFIED} SET status = 'cancelled'
        WHERE server = 'jobs' AND job_id = 'old-era-job'`,
    );
    await expect(admit(appId, INVALID_BODY, { idempotencyKey: "old-era" })).resolves.toEqual({
      outcome: "recovered",
      jobId: "old-era-job",
      status: "cancelled",
    });

    // A different owner's same key is a different namespace: no mapping
    // exists, so the identical bytes are NEW work — refused by today's
    // validation, proving the namespaces never share recovery.
    const otherOwner = await admit(appId, INVALID_BODY, {
      idempotencyKey: "old-era",
      identity: { ...TEST_IDENTITY, appId, ownerOid: "another-owner" },
    });
    expect(otherOwner.outcome).toBe("invalid_input");
  });

  test("the input contract is judged before the intake gate: invalid new input answers the validation refusal under a shut intake too", async () => {
    // The adopted order is key, then validation, then intake: a payload the
    // contract refuses is answered about the payload, even while intake is
    // shut — never as the intake refusals (403 closed, 503 unseen) that
    // would send the caller fixing the wrong thing.
    const appId = anApp();

    // The app is not known here at all: still the validation answer.
    await expect(admit(appId, INVALID_BODY, { idempotencyKey: null })).resolves.toMatchObject({
      outcome: "invalid_input",
    });

    await deliverGeneration(appId, "1", false);
    await deliverGeneration(appId, "2", true); // the archive closes the generation
    await expect(
      admit(appId, INVALID_BODY, { idempotencyKey: null, generation: "2" }),
    ).resolves.toMatchObject({ outcome: "invalid_input" });

    expect(await records(appId)).toHaveLength(0);
    expect(await runnerRows(appId)).toHaveLength(0);
  });

  test("the retry namespaces stay separate across owner, environment, principal kind and app", async () => {
    // The same key in every other namespace is a different key: each
    // submission below is new work, none conflicts with another.
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const variants: Parameters<typeof submitClaims>[0][] = [
      { idempotencyKey: "shared-key", identity: { ...TEST_IDENTITY, appId, ownerOid: "owner-b" } },
      { idempotencyKey: "shared-key", identity: { ...TEST_IDENTITY, appId, env: "dev" } },
      { idempotencyKey: "shared-key", identity: { ...TEST_IDENTITY, appId, ownerKind: "dev" } },
    ];
    const jobIds: string[] = [];
    for (const over of variants) {
      const result = await admit(appId, BODY, over);
      expect(result.outcome, JSON.stringify(over)).toBe("accepted");
      if (result.outcome === "accepted") jobIds.push(result.jobId);
    }
    expect(new Set(jobIds).size).toBe(3);
    expect(await records(appId)).toHaveLength(3);
  });

  test("a retained key recovers across a generation change — the scoped key does not include the claimed generation", async () => {
    // The edge signs every retry with the generation current at minting
    // time, so a portal delivery landing between the original acceptance and
    // the lost reply must not turn that retry into duplicate work. The
    // scope's columns are the unique constraint's arbiter exactly — no
    // generation column — so the same key and bytes recover the original job
    // even though a fresh unkeyed submission under the new generation would
    // be new work.
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const first = await admit(appId, BODY, { idempotencyKey: "across-generations" });
    expect(first.outcome).toBe("accepted");
    if (first.outcome !== "accepted") return;

    await deliverGeneration(appId, "2", false); // a newer delivery, still open
    await expect(
      admit(appId, BODY, { idempotencyKey: "across-generations", generation: "2" }),
    ).resolves.toEqual({ outcome: "recovered", jobId: first.jobId, status: "queued" });
    expect(await records(appId)).toHaveLength(1);
    expect(await runnerRows(appId)).toHaveLength(1);
  });

  test("malformed new input creates no job and no key claim", async () => {
    const appId = anApp();
    await deliverGeneration(appId, "1", false);

    const invalid = await admit(appId, INVALID_BODY, { idempotencyKey: "never-claimed" });
    expect(invalid).toMatchObject({ outcome: "invalid_input" });

    // The body is unreadable as JSON at all: same refusal.
    const unreadable = await store.admit({
      claims: submitClaims({
        identity: { ...TEST_IDENTITY, appId },
        idempotencyKey: "never-claimed-2",
      }),
      body: new TextEncoder().encode("{not json"),
    });
    expect(unreadable).toMatchObject({ outcome: "invalid_input" });

    // A body that is JSON but not an object: same refusal.
    const scalar = await admit(appId, new TextEncoder().encode("5"), {
      idempotencyKey: "never-claimed-3",
    });
    expect(scalar).toMatchObject({ outcome: "invalid_input" });

    expect(await records(appId)).toHaveLength(0);
    expect(await runnerRows(appId)).toHaveLength(0);
  });

  test("a zero-byte body the transport verified is invalid new work — and a keyed one leaves no claim behind", async () => {
    // A signed instruction minted over zero bytes verifies, burns and reaches
    // this admission carrying the empty bytes (the route suite's
    // unbindable-body legs pin the transport half of that presentation): the
    // input contract refuses them, and the keyed refusal claims nothing —
    // the client's corrected resubmission under the same key is not poisoned
    // by the empty attempt.
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const empty = new Uint8Array(0);

    await expect(admit(appId, empty, { idempotencyKey: "empty-key" })).resolves.toMatchObject({
      outcome: "invalid_input",
    });
    await expect(admit(appId, empty, { idempotencyKey: null })).resolves.toMatchObject({
      outcome: "invalid_input",
    });

    expect(await records(appId)).toHaveLength(0);
    expect(await runnerRows(appId)).toHaveLength(0);

    // The key was never claimed: real work under it is accepted afterward.
    await expect(admit(appId, BODY, { idempotencyKey: "empty-key" })).resolves.toMatchObject({
      outcome: "accepted",
    });
    expect(await records(appId)).toHaveLength(1);
  });

  test("a submission for a type this server has no installed policy for is refused without creating work", async () => {
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const result = await admit(appId, BODY, {
      idempotencyKey: "ghost-key",
      type: "jobs:ghost",
      identity: { ...TEST_IDENTITY, appId, allowedTypes: ["jobs:ghost"] },
    });
    expect(result).toMatchObject({ outcome: "type_unknown" });
    expect(await records(appId)).toHaveLength(0);
    expect(await runnerRows(appId)).toHaveLength(0);
  });

  test("a generation the portal has not delivered is retryably unavailable, a closed one refuses new work finally, and neither releases the key's recovery", async () => {
    const appId = anApp();

    // Unseen: no lifecycle row for the app at all yet.
    await expect(admit(appId, BODY, { idempotencyKey: null })).resolves.toMatchObject({
      outcome: "unseen",
    });
    expect(await records(appId)).toHaveLength(0);

    // The portal's delivery opens the generation; the same submission is
    // then accepted.
    await deliverGeneration(appId, "1", false);
    await expect(admit(appId, BODY, { idempotencyKey: null })).resolves.toMatchObject({
      outcome: "accepted",
    });

    // The keyed job is accepted while the generation is open...
    const keyed = await admit(appId, BODY, { idempotencyKey: "pre-archive" });
    expect(keyed.outcome).toBe("accepted");

    // ...then an archive closes the generation: new work is refused —
    // finally.
    await deliverGeneration(appId, "2", true);
    await expect(
      admit(appId, BODY, { idempotencyKey: null, generation: "2" }),
    ).resolves.toMatchObject({ outcome: "closed" });
    // And a newer-than-applied claim waits for the portal (never auto-opens).
    await expect(
      admit(appId, BODY, { idempotencyKey: null, generation: "3" }),
    ).resolves.toMatchObject({ outcome: "unseen" });

    // The recovery contract outranks the gate: the retained key recovers
    // under the closed generation, and different bytes still conflict.
    await expect(admit(appId, BODY, { idempotencyKey: "pre-archive" })).resolves.toMatchObject({
      outcome: "recovered",
    });
    await expect(
      admit(appId, OTHER_BODY, { idempotencyKey: "pre-archive" }),
    ).resolves.toMatchObject({
      outcome: "conflict",
    });
  });

  test("simultaneous identical keyed submissions resolve to one durable job", async () => {
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const results = await Promise.all([
      admit(appId, BODY, { idempotencyKey: "race-1" }),
      admit(appId, BODY, { idempotencyKey: "race-1" }),
      admit(appId, BODY, { idempotencyKey: "race-1" }),
    ]);
    const outcomes = results.map((r) => r.outcome).sort();
    expect(outcomes).toEqual(["accepted", "recovered", "recovered"]);
    const jobIds = new Set(
      results.map((r) => (r.outcome === "accepted" || r.outcome === "recovered" ? r.jobId : "")),
    );
    expect(jobIds.size).toBe(1);
    // Exactly one wrapper record and one runner row for the raced key.
    const rows = (await records(appId)).filter((r) => r.retry_key === "race-1");
    expect(rows).toHaveLength(1);
    expect(await runnerRows(appId)).toHaveLength(1);
  });

  test("a scoped-key claim lost to a concurrent writer rolls its own enqueue back and resolves the retry identity against the winner", async () => {
    // The lifecycle lock serializes same-app admissions, so the constraint
    // backstop has no natural contender; the enqueuer seam is where one is
    // injected: while the losing transaction sits between its lookup and its
    // wrapper insert, a winner commits the same scoped key from another
    // connection. The loser must roll back — the runner row it had already
    // enqueued included — and resolve the identity against the winner.
    const appId = anApp();
    await deliverGeneration(appId, "1", false);

    const losing = new JobsAcceptanceStore({
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      enqueuer: {
        enqueue: async (withinTx, job) => {
          // The loser's own runner row first — the one that must roll back.
          const runnerJobId = await createPgbossEnqueuer(boss).enqueue(withinTx, job);
          // The winner commits the same scoped key from another connection,
          // with the identity's digest for the identical-bytes arm.
          const digest = sha256BodyDigest(BODY);
          await direct.query(
            `INSERT INTO ${JOBS_JOB_RECORD_QUALIFIED}
               (server, job_id, runner_job_id, app_id, env, owner_kind, owner_oid, type,
                generation, status, retry_key, body_sha256, created_at)
             VALUES ('jobs', 'race-winner', '22222222-2222-4222-8222-222222222222', $1, 'prod',
                     'user', $2, 'jobs:fetch', 1, 'queued', 'backstop-race', $3, now())`,
            [appId, TEST_IDENTITY.ownerOid, digest],
          );
          return runnerJobId;
        },
      },
      log: LOG,
    });
    losing.start();
    try {
      await expect(
        losing.admit({
          claims: submitClaims({
            identity: { ...TEST_IDENTITY, appId },
            generation: "1",
            idempotencyKey: "backstop-race",
          }),
          body: BODY,
        }),
      ).resolves.toEqual({ outcome: "recovered", jobId: "race-winner", status: "queued" });
    } finally {
      await losing.stop();
    }

    // The loser's runner row rolled back with its transaction: the only
    // runner row joined to this app's records is the winner's own (none —
    // the winner is a bare mapping).
    const rows = (await records(appId)).filter((r) => r.retry_key === "backstop-race");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.job_id).toBe("race-winner");
    expect(await runnerRows(appId)).toHaveLength(0);
  });

  test("a claim lost to the concurrent writer resolves by the winner's digest too — different bytes conflict, never a fabricated recovery", async () => {
    // The backstop's loser compares digests like any replay: the injected
    // winner commits a DIFFERENT body's digest under the same scoped key, so
    // the claim the constraint takes from the loser must resolve to the
    // conflict — a resolution that returned the winner's job unconditionally
    // would recover bytes the key never accepted.
    const appId = anApp();
    await deliverGeneration(appId, "1", false);

    const losing = new JobsAcceptanceStore({
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      enqueuer: {
        enqueue: async (withinTx, job) => {
          const runnerJobId = await createPgbossEnqueuer(boss).enqueue(withinTx, job);
          // The winner commits the same scoped key from another connection,
          // carrying the OTHER body's digest for the conflict arm.
          const digest = sha256BodyDigest(OTHER_BODY);
          await direct.query(
            `INSERT INTO ${JOBS_JOB_RECORD_QUALIFIED}
               (server, job_id, runner_job_id, app_id, env, owner_kind, owner_oid, type,
                generation, status, retry_key, body_sha256, created_at)
             VALUES ('jobs', 'race-winner-other', '33333333-3333-4333-8333-333333333333', $1,
                     'prod', 'user', $2, 'jobs:fetch', 1, 'queued', 'backstop-conflict', $3, now())`,
            [appId, TEST_IDENTITY.ownerOid, digest],
          );
          return runnerJobId;
        },
      },
      log: LOG,
    });
    losing.start();
    try {
      await expect(
        losing.admit({
          claims: submitClaims({
            identity: { ...TEST_IDENTITY, appId },
            generation: "1",
            idempotencyKey: "backstop-conflict",
          }),
          body: BODY,
        }),
      ).resolves.toEqual({ outcome: "conflict", status: "queued", error: null });
    } finally {
      await losing.stop();
    }

    // The loser's runner row rolled back with its transaction; the winner's
    // bare mapping is the only record for the raced key.
    const rows = (await records(appId)).filter((r) => r.retry_key === "backstop-conflict");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.job_id).toBe("race-winner-other");
    expect(await runnerRows(appId)).toHaveLength(0);
  });

  test("a failure after the runner enqueue rolls back to neither work nor a lasting key claim", async () => {
    // The wrapper insert is forced to fail after the enqueue — the crash
    // window the transaction exists to close. The runner row the enqueue
    // wrote must roll back with it.
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const failing: JobsAcceptanceStore = new JobsAcceptanceStore({
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      enqueuer: {
        enqueue: async (withinTx, job) => {
          await createPgbossEnqueuer(boss).enqueue(withinTx, job);
          throw new Error("crash between the enqueue and the wrapper insert");
        },
      },
      log: LOG,
    });
    failing.start();
    try {
      await expect(
        failing.admit({
          claims: submitClaims({
            identity: { ...TEST_IDENTITY, appId },
            generation: "1",
            idempotencyKey: "rollback-1",
          }),
          body: BODY,
        }),
      ).rejects.toThrow(/crash between the enqueue/);
    } finally {
      await failing.stop();
    }

    // Neither the key claim nor a runner row survived — the enqueued runner
    // job went back with the transaction.
    expect((await records(appId)).filter((r) => r.retry_key === "rollback-1")).toHaveLength(0);
    const orphans = await direct.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${JOBS_PGBOSS_SCHEMA}.job
        WHERE (data->>'url') = 'https://example.com/data.json'
          AND id::text NOT IN (SELECT runner_job_id FROM ${JOBS_JOB_RECORD_QUALIFIED})`,
    );
    expect(orphans.rows[0]?.n).toBe(0);

    // The retry after the failure is a fresh acceptance: the failed attempt
    // left no key claim to conflict with.
    const retried = await admit(appId, BODY, { idempotencyKey: "rollback-1" });
    expect(retried.outcome).toBe("accepted");
  });

  test("a connection that dies mid-decision is released destroyed, and the pool keeps serving", async () => {
    // Terminating the decision's own backend kills the connection under the
    // transaction: the client-level listener (withJobsClient's checkout
    // bracket) records the death, the awaited query rejects, the catch's
    // ROLLBACK rejects through the same dead socket — and the release
    // destroys the client instead of parking it. The decision must reject,
    // commit nothing, and leave the pool able to open fresh clients for what
    // follows: the admission after the death still decides. No harness mask
    // covers the emit — the process-level unhandled-'error' crash this
    // scenario once produced is the defect the bracket exists to prevent.
    const appId = anApp();
    await deliverGeneration(appId, "1", false);

    let killed = false;
    const warnings: Array<Record<string, unknown>> = [];
    const dying = new JobsAcceptanceStore({
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      enqueuer: {
        enqueue: async (withinTx, job) => {
          if (!killed) {
            killed = true;
            const self = await withinTx.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
            await direct.query(`SELECT pg_terminate_backend($1)`, [self.rows[0]?.pid]);
            return "44444444-4444-4444-8444-444444444444";
          }
          return createPgbossEnqueuer(boss).enqueue(withinTx, job);
        },
      },
      log: {
        warn: (fields) => {
          warnings.push(fields);
        },
      },
    });
    dying.start();
    try {
      await expect(
        dying.admit({
          claims: submitClaims({
            identity: { ...TEST_IDENTITY, appId },
            generation: "1",
            idempotencyKey: "dead-client",
          }),
          body: BODY,
        }),
      ).rejects.toThrow();
      expect(await records(appId)).toHaveLength(0);

      // The death was reported through the store's own sink, with the
      // checkout-window phase — the operator's evidence the bracket exists
      // to keep honest, not only silent.
      expect(
        warnings.some((w) => w.event === "jobs.admission.pool_error" && w.phase === "checked-out"),
      ).toBe(true);

      // The dead client is out of the pool — an aborted transaction handed
      // back as idle would fail this admission's first statement instead.
      await expect(
        dying.admit({
          claims: submitClaims({
            identity: { ...TEST_IDENTITY, appId },
            generation: "1",
            idempotencyKey: "after-the-death",
          }),
          body: BODY,
        }),
      ).resolves.toMatchObject({ outcome: "accepted" });
    } finally {
      await dying.stop();
    }
    expect(await records(appId)).toHaveLength(1);
  });

  test("the retry key's server namespace stays separate: another server's same key never recovers this server's mapping", async () => {
    // The scoped-key predicate carries `server = $1` — two jobs servers
    // sharing one store must not resolve each other's retry identities. The
    // seed's type deliberately names the other server, so the server column
    // is the ONLY difference between the seed and the lookup: a dropped
    // server conjunct answers `recovered` (the comparison precedes the type
    // check), while the held namespace misses and answers the refusal for a
    // type no policy is installed for.
    const appId = anApp();
    const otherServer = "other-server";
    await direct.query(
      `INSERT INTO ${JOBS_JOB_RECORD_QUALIFIED}
         (server, job_id, runner_job_id, app_id, env, owner_kind, owner_oid, type,
          generation, status, retry_key, body_sha256, created_at)
       VALUES ('jobs', 'other-servers-job', '55555555-5555-4555-8555-555555555555', $1, 'prod',
               'user', $2, $3, 1, 'queued', 'cross-server', $4, now())`,
      [appId, TEST_IDENTITY.ownerOid, `${otherServer}:fetch`, sha256BodyDigest(BODY)],
    );
    await expect(
      admit(appId, BODY, {
        idempotencyKey: "cross-server",
        server: otherServer,
        type: `${otherServer}:fetch`,
        identity: { ...TEST_IDENTITY, appId, allowedTypes: [`${otherServer}:fetch`] },
      }),
    ).resolves.toMatchObject({ outcome: "type_unknown" });
    // The refusal created nothing: the seed is still the app's only record.
    expect(await records(appId)).toHaveLength(1);
  });

  test("the retry key's type namespace stays separate: the same key under another type is new work, never the foreign type's mapping", async () => {
    // The scoped-key predicate carries `type = $6`. The seed's type
    // deliberately names a foreign server, so the type column is the ONLY
    // difference between the seed and the lookup: a dropped type conjunct
    // answers `recovered` for a type the submission never named, while the
    // held namespace admits the identical bytes as NEW work under the named
    // type — a fresh job id, never the seed's.
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    await direct.query(
      `INSERT INTO ${JOBS_JOB_RECORD_QUALIFIED}
         (server, job_id, runner_job_id, app_id, env, owner_kind, owner_oid, type,
          generation, status, retry_key, body_sha256, created_at)
       VALUES ('jobs', 'other-types-job', '66666666-6666-4666-8666-666666666666', $1, 'prod',
               'user', $2, 'other-server:fetch', 1, 'queued', 'cross-type', $3, now())`,
      [appId, TEST_IDENTITY.ownerOid, sha256BodyDigest(BODY)],
    );
    const result = await admit(appId, BODY, { idempotencyKey: "cross-type" });
    expect(result.outcome).toBe("accepted");
    if (result.outcome !== "accepted") return;
    expect(result.jobId).not.toBe("other-types-job");
    const rows = await records(appId);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.type === "jobs:fetch")).toHaveLength(1);
    expect(rows.filter((r) => r.type === "other-server:fetch")).toHaveLength(1);
  });

  test("simultaneous keyed submissions with different bytes resolve first-writer-wins: one accepted, the other conflicts", async () => {
    // The identical-bytes race resolves by recovery; this is its other arm:
    // two simultaneous keyed submissions that disagree on the bytes. The
    // lifecycle lock serializes same-app admissions, so the outcome is
    // deterministic whichever submission wins the lock — one accepted, the
    // loser resolving against the winner's committed mapping to the
    // conflict — and exactly one job exists for the raced key.
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const results = await Promise.all([
      admit(appId, BODY, { idempotencyKey: "race-different" }),
      admit(appId, OTHER_BODY, { idempotencyKey: "race-different" }),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["accepted", "conflict"]);
    const conflict = results.find((r) => r.outcome === "conflict");
    if (conflict?.outcome === "conflict") {
      expect(conflict.status).toBe("queued");
      expect(conflict.error).toBeNull();
    }
    // The winner's reference is the raced key's one record, and the only
    // runner row: no duplicate work survived the race.
    const accepted = results.find((r) => r.outcome === "accepted");
    if (accepted?.outcome !== "accepted") return;
    const rows = (await records(appId)).filter((r) => r.retry_key === "race-different");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.job_id).toBe(accepted.jobId);
    expect(await runnerRows(appId)).toHaveLength(1);
  });

  test("the enqueued runner row carries the platform's send-time policy for its type", async () => {
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    await admit(appId, BODY, { idempotencyKey: "policy-1" });
    const rows = (await records(appId)).filter((r) => r.retry_key === "policy-1");
    expect(rows).toHaveLength(1);
    const runner = await runnerRows(appId);
    expect(runner).toHaveLength(1);
    const policyRow = runner[0] as Record<string, unknown> | undefined;
    expect(policyRow?.name).toBe(JOBS_QUEUE_NAME);
    // The fetch type's one-attempt, five-minute-claim policy — the send-time
    // options, never the queue's defaults.
    expect(policyRow?.retry_limit).toBe(0);
    expect(policyRow?.expire_seconds).toBe(300);
    // The trusted (appId, env) fairness group.
    expect(policyRow?.group_id).toBe(jobsAppEnvGroupId(appId, "prod"));
  });

  test("the acceptance store refuses to decide while it is not running, and stop is safe twice", async () => {
    const appId = anApp();
    const storeOptions: JobsAcceptanceStoreOptions = {
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      enqueuer: createPgbossEnqueuer(boss),
      log: LOG,
    };
    const stopped = new JobsAcceptanceStore(storeOptions);
    await expect(
      stopped.admit({
        claims: submitClaims({ identity: { ...TEST_IDENTITY, appId } }),
        body: BODY,
      }),
    ).rejects.toThrow(/not running/);
    await expect(stopped.stop()).resolves.toBeUndefined(); // safe without a pool
    stopped.start(); // no-op after stop
    await expect(
      stopped.admit({
        claims: submitClaims({ identity: { ...TEST_IDENTITY, appId } }),
        body: BODY,
      }),
    ).rejects.toThrow(/not running/);
    await stopped.stop();
  });

  test("stop() waits for a decision in flight — the in-flight admission commits atomically, and admissions after the stop refuse", async () => {
    // The shutdown path stops the admission store while the process is
    // draining (server.ts's onClose and failed-listen exits both call it).
    // The contract that makes that safe: stop() cannot orphan a
    // checked-out client — pg-pool's end() resolves only when the last
    // client is released, and a release while ending destroys it — so a
    // decision already running finishes and COMMITS rather than being
    // truncated into a phantom 503. A stop that force-ended the pool (or
    // resolved before the drain) would reject the in-flight decision or
    // resolve while its transaction is still writing: either fails here.
    const appId = anApp();
    await deliverGeneration(appId, "1", false);

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
    try {
      const inFlight = gated.admit({
        claims: submitClaims({
          identity: { ...TEST_IDENTITY, appId },
          generation: "1",
          idempotencyKey: "stop-in-flight",
        }),
        body: BODY,
      });

      // The decision is inside the transaction, holding its checked-out
      // client, blocked in the enqueuer.
      await enqueueEntered;

      const stopped = gated.stop();

      // The stop cannot resolve while the decision is in flight: the pool's
      // end waits for the checked-out client. Bounded in the safe direction —
      // a stop that releases early resolves within this window and fails the
      // assertion; the real end() cannot resolve here at all.
      const stoppedEarly = await Promise.race([
        stopped.then(() => true),
        new Promise<false>((r) => setTimeout(() => r(false), 250)),
      ]);
      expect(stoppedEarly).toBe(false);

      // The decision finishes, commits, and answers its real outcome — the
      // stop racing it never truncates it into a retryable refusal.
      releaseEnqueue?.();
      await expect(inFlight).resolves.toMatchObject({ outcome: "accepted" });

      // The stop waited for the released client, then released the pool;
      // admissions after it refuse, and the committed work is durable.
      await expect(stopped).resolves.toBeUndefined();
      await expect(
        gated.admit({
          claims: submitClaims({
            identity: { ...TEST_IDENTITY, appId },
            generation: "1",
            idempotencyKey: "after-stop",
          }),
          body: BODY,
        }),
      ).rejects.toThrow(/not running/);
      expect((await records(appId)).filter((r) => r.retry_key === "stop-in-flight")).toHaveLength(
        1,
      );
      expect(await runnerRows(appId)).toHaveLength(1);
    } finally {
      await gated.stop();
    }
  });
});
