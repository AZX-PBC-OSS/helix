import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { JOB_TERMINAL_STATUSES } from "@azx-pbc/shared";
import { sha256BodyDigest } from "@azx-pbc/shared/jobsSigning";
import { resolveJobsCapacityLimits, type JobsCapacityLimits } from "@azx-pbc/shared";
import {
  createPgbossEnqueuer,
  JobsAcceptanceStore,
  type JobsAcceptanceStoreOptions,
  type JobsAdmission,
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

/** The platform defaults, as the production boot resolves them. */
const LIMITS = resolveJobsCapacityLimits();

/** A resolved limit set for one capacity leg: the shared defaults with this leg's override applied. */
function limitsWith(over: Partial<JobsCapacityLimits>) {
  return resolveJobsCapacityLimits({ ...over });
}

/** A store option set with the given limits — the shared DSN, real enqueuer and silent log. */
function storeOptions(
  limits: JobsCapacityLimits,
  enqueuer: JobsAcceptanceStoreOptions["enqueuer"] = createPgbossEnqueuer(boss),
): JobsAcceptanceStoreOptions {
  return {
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    limits,
    accepting: true,
    enqueuer,
    log: LOG,
  };
}

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
  store = new JobsAcceptanceStore(storeOptions(LIMITS));
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

/** The admission helper bound to a capacity leg's own store, with the same identity discipline. */
function admitThrough(leg: JobsAdmission): typeof admit {
  return (appId, body, over = {}) =>
    leg.admit({
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
      `UPDATE ${JOBS_JOB_RECORD_QUALIFIED} SET status = 'cancelled', terminal_at = now()
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
      limits: LIMITS,
      accepting: true,
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
      limits: LIMITS,
      accepting: true,
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
      limits: LIMITS,
      accepting: true,
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
      limits: LIMITS,
      accepting: true,
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
      limits: LIMITS,
      accepting: true,
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

describe("capacity admission", () => {
  /**
   * The capacity seam (design §4, spec criteria 16/18/20): unfinished and
   * retained occupancy, per app/environment and server-wide, enforced inside
   * the acceptance transaction so concurrent new work across types and
   * replicas cannot step past either cap pair. The counting definitions are
   * the retention contract's: unfinished is every nonterminal status;
   * retained is every physically stored row — active or terminal, whatever
   * transient state the runner's own row is in — until the physical cleanup
   * alone removes it. A refusal never evicts, and the retained-key paths
   * (recovery, conflict) never reach the counts — they use no slot.
   *
   * The per-app/environment legs isolate themselves with a fresh app each
   * (the count is scoped to the app); the server-wide legs read the scratch
   * store's accumulated occupancy and set the limit relative to it, since
   * this file's earlier legs leave their (deliberately retained) records
   * behind.
   */

  /** Seed one bare wrapper record — stored occupancy that no admission created. */
  async function seedRecord(
    appId: string,
    over: { status?: string; env?: string; ownerOid?: string; type?: string } = {},
  ): Promise<void> {
    const status = over.status ?? "queued";
    // A succeeded seed carries the result the execution projection writes —
    // the store's own check refuses a succeeded row without one. A terminal
    // seed carries the terminal instant the store's own check requires (the
    // stamp every production projection writes).
    await direct.query(
      `INSERT INTO ${JOBS_JOB_RECORD_QUALIFIED}
         (server, job_id, runner_job_id, app_id, env, owner_kind, owner_oid, type,
          generation, status, retry_key, body_sha256, created_at, result, terminal_at)
       VALUES ('jobs', $1, $2, $3, $4, 'user', $5, $6, 1, $7, NULL, 'seeded', now(), $8,
               CASE WHEN $7 = ANY($9::text[]) THEN now() END)`,
      [
        randomUUID(),
        randomUUID(),
        appId,
        over.env ?? "prod",
        over.ownerOid ?? TEST_IDENTITY.ownerOid,
        over.type ?? "jobs:fetch",
        status,
        status === "succeeded" ? JSON.stringify({ seeded: true }) : null,
        JOB_TERMINAL_STATUSES,
      ],
    );
  }

  /** The scratch store's occupancy as the acceptance transaction's query sees it. */
  async function serverOccupancy(): Promise<{
    retained_server: number;
    unfinished_server: number;
  }> {
    const result = await direct.query<{
      retained_server: number;
      unfinished_server: number;
    }>(
      `SELECT count(*)::int AS retained_server,
              count(*) FILTER (WHERE NOT status = ANY($1::text[]))::int AS unfinished_server
         FROM ${JOBS_JOB_RECORD_QUALIFIED}`,
      [JOB_TERMINAL_STATUSES],
    );
    return result.rows[0] as { retained_server: number; unfinished_server: number };
  }

  test("the per-app/environment unfinished cap refuses new work at full occupancy, evicting nothing", async () => {
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const warnings: Array<Record<string, unknown>> = [];
    const leg = new JobsAcceptanceStore({
      ...storeOptions(limitsWith({ unfinishedPerAppEnv: 2 })),
      log: { warn: (fields) => warnings.push(fields) },
    });
    leg.start();
    const admit = admitThrough(leg);
    try {
      const first = await admit(appId, BODY, { idempotencyKey: "cap-a" });
      const second = await admit(appId, BODY, { idempotencyKey: "cap-b" });
      expect(first.outcome).toBe("accepted");
      expect(second.outcome).toBe("accepted");

      // Full: the next new work is refused, with the bounded evidence of
      // which cap bound and what the count saw — never a persistent row.
      const refused = await admit(appId, BODY, { idempotencyKey: "cap-c" });
      expect(refused).toEqual({ outcome: "capacity_exceeded" });
      expect(warnings.find((w) => w.event === "jobs.admission.capacity_refused")).toMatchObject({
        cap: "unfinishedPerAppEnv",
        limit: 2,
        occupancy: 2,
        appId,
        env: "prod",
      });

      // Nothing evicted: the two accepted jobs are untouched, on the wrapper
      // and the runner alike.
      expect(await records(appId)).toHaveLength(2);
      expect(await runnerRows(appId)).toHaveLength(2);

      // Recovery still succeeds at full occupancy — a key hit uses no slot.
      if (first.outcome !== "accepted") return;
      await expect(admit(appId, BODY, { idempotencyKey: "cap-a" })).resolves.toMatchObject({
        outcome: "recovered",
        jobId: first.jobId,
      });
      expect(await records(appId)).toHaveLength(2);
    } finally {
      await leg.stop();
    }
  });

  test("the server-wide unfinished cap holds against concurrent new work across apps and replicas", async () => {
    // Eight simultaneous admissions for eight different apps, fired through
    // TWO independent store instances — separate pools, the way two replicas
    // share one database — none of them serialized by the lifecycle lock
    // (every app its own). This is the interleaving the server-wide cap
    // exists for. The enqueuer widens the count→insert window (the race's
    // target) so a missing serialization cannot pass by luck: unsynchronized,
    // every count lands before any wrapper insert and all eight would be
    // accepted. Under the admission lock — per-database state, so it binds
    // across the two pools exactly as across two processes — the decisions
    // serialize, and exactly the limit's remaining headroom is accepted.
    const baseline = (await serverOccupancy()).unfinished_server;
    const apps = Array.from({ length: 8 }, () => anApp());
    for (const appId of apps) {
      await deliverGeneration(appId, "1", false);
    }
    const slowEnqueuer: JobsAcceptanceStoreOptions["enqueuer"] = {
      enqueue: async (withinTx, job) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return createPgbossEnqueuer(boss).enqueue(withinTx, job);
      },
    };
    const limits = limitsWith({ unfinishedPerServer: baseline + 3 });
    const replicaA = new JobsAcceptanceStore(storeOptions(limits, slowEnqueuer));
    const replicaB = new JobsAcceptanceStore(storeOptions(limits, slowEnqueuer));
    replicaA.start();
    replicaB.start();
    const admitA = admitThrough(replicaA);
    const admitB = admitThrough(replicaB);
    try {
      const results = await Promise.all([
        ...apps.slice(0, 4).map((appId) => admitA(appId, BODY, { idempotencyKey: null })),
        ...apps.slice(4).map((appId) => admitB(appId, BODY, { idempotencyKey: null })),
      ]);
      expect(results.filter((r) => r.outcome === "accepted")).toHaveLength(3);
      expect(results.filter((r) => r.outcome === "capacity_exceeded")).toHaveLength(5);

      // The store holds exactly the cap's worth of unfinished work for these
      // eight apps — spread across three of them, never one app's rows alone.
      const admitted = await direct.query<{ app_id: string }>(
        `SELECT app_id FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE app_id = ANY($1::text[])`,
        [apps],
      );
      expect(admitted.rows).toHaveLength(3);
      expect(new Set(admitted.rows.map((r) => r.app_id)).size).toBe(3);
    } finally {
      await replicaA.stop();
      await replicaB.stop();
    }
  });

  test("the server-wide retained cap holds against concurrent new work across apps and replicas", async () => {
    // The retained count is the one definition whose occupancy moves slowly —
    // terminal rows accumulate until the physical cleanup — so a refactor
    // could move its comparison outside the admission lock as an
    // optimization while the unfinished comparison (whose concurrent leg is
    // above) stayed inside. This leg is the witness against that shape: the
    // same eight-way, two-replica race, but with the RETAINED cap binding.
    // The widening enqueuer makes an unsynchronized count→insert window
    // over-admit deterministically — all eight counts land before any
    // wrapper insert — so exactly the cap's remaining headroom accepted is
    // the serialization holding, not luck.
    const baseline = (await serverOccupancy()).retained_server;
    const apps = Array.from({ length: 8 }, () => anApp());
    for (const appId of apps) {
      await deliverGeneration(appId, "1", false);
    }
    const slowEnqueuer: JobsAcceptanceStoreOptions["enqueuer"] = {
      enqueue: async (withinTx, job) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return createPgbossEnqueuer(boss).enqueue(withinTx, job);
      },
    };
    const limits = limitsWith({ retainedPerServer: baseline + 2 });
    const replicaA = new JobsAcceptanceStore(storeOptions(limits, slowEnqueuer));
    const replicaB = new JobsAcceptanceStore(storeOptions(limits, slowEnqueuer));
    replicaA.start();
    replicaB.start();
    const admitA = admitThrough(replicaA);
    const admitB = admitThrough(replicaB);
    try {
      const results = await Promise.all([
        ...apps.slice(0, 4).map((appId) => admitA(appId, BODY, { idempotencyKey: null })),
        ...apps.slice(4).map((appId) => admitB(appId, BODY, { idempotencyKey: null })),
      ]);
      expect(results.filter((r) => r.outcome === "accepted")).toHaveLength(2);
      expect(results.filter((r) => r.outcome === "capacity_exceeded")).toHaveLength(6);

      // Exactly the cap's headroom of stored rows exists for these eight
      // apps — the refusals claimed nothing, so the retained count itself
      // never moved past the limit.
      const admitted = await direct.query<{ app_id: string }>(
        `SELECT app_id FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE app_id = ANY($1::text[])`,
        [apps],
      );
      expect(admitted.rows).toHaveLength(2);
      expect(new Set(admitted.rows.map((r) => r.app_id)).size).toBe(2);
    } finally {
      await replicaA.stop();
      await replicaB.stop();
    }
  });

  test("terminal completion frees unfinished capacity", async () => {
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const leg = new JobsAcceptanceStore(
      storeOptions(limitsWith({ unfinishedPerAppEnv: 2, retainedPerAppEnv: 10 })),
    );
    leg.start();
    const admit = admitThrough(leg);
    try {
      const first = await admit(appId, BODY, { idempotencyKey: null });
      await admit(appId, BODY, { idempotencyKey: null });
      expect(first.outcome).toBe("accepted");

      // One job completes (the execution ticket's outcome persistence will
      // write this transition; the capacity decision must read it):
      // unfinished drops to one and the cap admits again.
      const rows = await records(appId);
      await direct.query(
        `UPDATE ${JOBS_JOB_RECORD_QUALIFIED} SET status = 'succeeded', result = '{}', terminal_at = now() WHERE server = 'jobs' AND job_id = $1`,
        [(rows[0] as { job_id: string }).job_id],
      );
      await expect(admit(appId, BODY, { idempotencyKey: null })).resolves.toMatchObject({
        outcome: "accepted",
      });
      expect(await records(appId)).toHaveLength(3);
    } finally {
      await leg.stop();
    }
  });

  test("terminal completion does not free retained capacity — physical deletion alone does", async () => {
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const leg = new JobsAcceptanceStore(
      storeOptions(limitsWith({ unfinishedPerAppEnv: 10, retainedPerAppEnv: 2 })),
    );
    leg.start();
    const admit = admitThrough(leg);
    try {
      await admit(appId, BODY, { idempotencyKey: null });
      await admit(appId, BODY, { idempotencyKey: null });
      expect(await records(appId)).toHaveLength(2);

      // Terminal, but physically retained: the retained cap is unmoved.
      const rows = await records(appId);
      await direct.query(
        `UPDATE ${JOBS_JOB_RECORD_QUALIFIED} SET status = 'succeeded', result = '{}', terminal_at = now() WHERE server = 'jobs' AND job_id = $1`,
        [(rows[0] as { job_id: string }).job_id],
      );
      await expect(admit(appId, BODY, { idempotencyKey: null })).resolves.toMatchObject({
        outcome: "capacity_exceeded",
      });

      // The cleanup's physical deletion of the record is what releases the
      // retained slot.
      await direct.query(
        `DELETE FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE server = 'jobs' AND job_id = $1`,
        [(rows[0] as { job_id: string }).job_id],
      );
      await expect(admit(appId, BODY, { idempotencyKey: null })).resolves.toMatchObject({
        outcome: "accepted",
      });
    } finally {
      await leg.stop();
    }
  });

  test("the server-wide retained cap counts every app's stored records, not just the submitting app's", async () => {
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const otherA = anApp();
    const otherB = anApp();
    await seedRecord(otherA);
    await seedRecord(otherB);
    const baseline = (await serverOccupancy()).retained_server;
    const leg = new JobsAcceptanceStore(storeOptions(limitsWith({ retainedPerServer: baseline })));
    leg.start();
    const admit = admitThrough(leg);
    try {
      // The submitting app holds nothing; the server's retained storage is
      // full — the server-wide cap refuses regardless.
      await expect(admit(appId, BODY, { idempotencyKey: null })).resolves.toMatchObject({
        outcome: "capacity_exceeded",
      });
      await direct.query(`DELETE FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE app_id = $1`, [otherA]);
      await expect(admit(appId, BODY, { idempotencyKey: null })).resolves.toMatchObject({
        outcome: "accepted",
      });
    } finally {
      await leg.stop();
    }
  });

  test("lowered limits refuse new work without evicting records, and retained recovery still succeeds", async () => {
    // An operator tunes the limits down below the occupancy that already
    // exists (the rollout-restart case): new work waits, nothing accepted is
    // evicted, and a retained key still recovers its job.
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const first = await admit(appId, BODY, { idempotencyKey: "lowered-1" });
    const second = await admit(appId, BODY, { idempotencyKey: "lowered-2" });
    expect(first.outcome).toBe("accepted");
    expect(second.outcome).toBe("accepted");

    const lowered = new JobsAcceptanceStore(storeOptions(limitsWith({ unfinishedPerAppEnv: 1 })));
    lowered.start();
    const admitLowered = admitThrough(lowered);
    try {
      await expect(
        admitLowered(appId, BODY, { idempotencyKey: "lowered-3" }),
      ).resolves.toMatchObject({ outcome: "capacity_exceeded" });
      expect(await records(appId)).toHaveLength(2);
      expect(await runnerRows(appId)).toHaveLength(2);

      // Recovery over the lowered limit — the key hit never occupies a slot.
      await expect(
        admitLowered(appId, BODY, { idempotencyKey: "lowered-1" }),
      ).resolves.toMatchObject({ outcome: "recovered" });
      // A different byte's conflict resolves before the counts too.
      await expect(
        admitLowered(appId, OTHER_BODY, { idempotencyKey: "lowered-1" }),
      ).resolves.toMatchObject({ outcome: "conflict" });
      expect(await records(appId)).toHaveLength(2);
    } finally {
      await lowered.stop();
    }
  });

  test("the intake gate outranks capacity: closed and unseen refuse before the counts", async () => {
    // The design's order — validation, then intake, then capacity — so a
    // generation question is never answered as a capacity question.
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    await seedRecord(appId);
    await seedRecord(appId);
    const leg = new JobsAcceptanceStore(storeOptions(limitsWith({ unfinishedPerAppEnv: 2 })));
    leg.start();
    const admit = admitThrough(leg);
    try {
      // Full capacity, but the newer generation was never delivered: the
      // unseen wait, not the busy refusal.
      await expect(
        admit(appId, BODY, { idempotencyKey: null, generation: "3" }),
      ).resolves.toMatchObject({ outcome: "unseen" });

      // And at full capacity under a closed generation: the final refusal.
      await deliverGeneration(appId, "2", true);
      await expect(
        admit(appId, BODY, { idempotencyKey: null, generation: "2" }),
      ).resolves.toMatchObject({ outcome: "closed" });
      expect(await records(appId)).toHaveLength(2);
    } finally {
      await leg.stop();
    }
  });

  test("the per-app/environment cap counts only its own environment's rows, and a refusal at simultaneous saturation names the app/env unfinished cap first", async () => {
    // The occupancy query's per-app counts carry BOTH the app and the env
    // conjunct: the same app's other environment occupies its own slots and
    // the server-wide counts, never this environment's app/env cap — a
    // dropped env conjunct would fold the two environments' occupancies
    // together and refuse here one admission early. And when several caps
    // saturate at the same instant, the refusal names the stable order's
    // first candidate (unfinished before retained, app/env before server)
    // with the count IT saw — the operator's evidence of which limit bound.
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const baseline = (await serverOccupancy()).unfinished_server;
    const warnings: Array<Record<string, unknown>> = [];
    const leg = new JobsAcceptanceStore({
      ...storeOptions(
        limitsWith({
          unfinishedPerAppEnv: 2,
          unfinishedPerServer: baseline + 3,
          retainedPerAppEnv: 2,
        }),
      ),
      log: { warn: (fields) => warnings.push(fields) },
    });
    leg.start();
    const admit = admitThrough(leg);
    try {
      // The dev job is this app's too — it reaches the server-wide counts
      // (the limit above is set relative to the baseline including it), but
      // prod's app/env counts stay prod's own.
      await expect(
        admit(appId, BODY, {
          idempotencyKey: "env-scope-dev",
          identity: { ...TEST_IDENTITY, appId, env: "dev" },
        }),
      ).resolves.toMatchObject({ outcome: "accepted" });
      await expect(admit(appId, BODY, { idempotencyKey: "env-scope-a" })).resolves.toMatchObject({
        outcome: "accepted",
      });
      await expect(admit(appId, BODY, { idempotencyKey: "env-scope-b" })).resolves.toMatchObject({
        outcome: "accepted",
      });

      // Full: prod's unfinished app/env count (2, the dev row excluded), the
      // server-wide unfinished count (baseline + 3) and prod's retained
      // count (2) saturate at the same instant. The refusal names the
      // app/env unfinished cap with ITS occupancy — not the server cap's
      // count, not the retained pair's.
      await expect(admit(appId, BODY, { idempotencyKey: "env-scope-c" })).resolves.toEqual({
        outcome: "capacity_exceeded",
      });
      expect(warnings.at(-1)).toMatchObject({
        event: "jobs.admission.capacity_refused",
        cap: "unfinishedPerAppEnv",
        limit: 2,
        occupancy: 2,
        appId,
        env: "prod",
      });

      // The order's other precedence: validation outranks capacity. Full
      // capacity answers unreadable new input about the INPUT, never the
      // busy refusal that would send the caller tuning limits.
      await expect(
        admit(appId, INVALID_BODY, { idempotencyKey: "env-scope-invalid" }),
      ).resolves.toMatchObject({ outcome: "invalid_input" });

      // One prod job completes: its unfinished slot frees, its stored record
      // stays — the next refusal is the RETAINED app/env cap, the dev row
      // still excluded from its count.
      const rows = await records(appId);
      const completed = rows.find((r) => r.retry_key === "env-scope-a") as { job_id: string };
      await direct.query(
        `UPDATE ${JOBS_JOB_RECORD_QUALIFIED} SET status = 'succeeded', result = '{}', terminal_at = now() WHERE server = 'jobs' AND job_id = $1`,
        [completed.job_id],
      );
      await expect(admit(appId, BODY, { idempotencyKey: "env-scope-d" })).resolves.toEqual({
        outcome: "capacity_exceeded",
      });
      expect(warnings.at(-1)).toMatchObject({
        cap: "retainedPerAppEnv",
        limit: 2,
        occupancy: 2,
      });

      // The physical deletion of the completed record is what frees the
      // retained slot — the admission after it is accepted again.
      await direct.query(
        `DELETE FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE server = 'jobs' AND job_id = $1`,
        [completed.job_id],
      );
      await expect(admit(appId, BODY, { idempotencyKey: "env-scope-e" })).resolves.toMatchObject({
        outcome: "accepted",
      });
      // The three refusals created nothing: the app's records are the dev
      // job and the two accepted prod jobs.
      expect(await records(appId)).toHaveLength(3);
    } finally {
      await leg.stop();
    }
  });

  test("a capacity refusal claims no retry key — the same key submits as new work once capacity frees", async () => {
    // The refusal exits the transaction before the wrapper insert, and the
    // rollback leaves nothing a later submission could resolve against: the
    // client's retry under the same key once capacity frees is a FRESH
    // acceptance, never a recovery of bytes the key never committed.
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const leg = new JobsAcceptanceStore(storeOptions(limitsWith({ unfinishedPerAppEnv: 1 })));
    leg.start();
    const admit = admitThrough(leg);
    try {
      const first = await admit(appId, BODY, { idempotencyKey: "refusal-key-a" });
      expect(first.outcome).toBe("accepted");
      await expect(admit(appId, BODY, { idempotencyKey: "refusal-key-b" })).resolves.toEqual({
        outcome: "capacity_exceeded",
      });

      // Still full: the same key again is the same refusal — a recovery here
      // would mean the refused attempt left a claim behind.
      await expect(admit(appId, BODY, { idempotencyKey: "refusal-key-b" })).resolves.toEqual({
        outcome: "capacity_exceeded",
      });

      // The first job completes; the key the refusals carried is accepted as
      // new work — its own job, not the completed one's reference.
      const rows = await records(appId);
      await direct.query(
        `UPDATE ${JOBS_JOB_RECORD_QUALIFIED} SET status = 'succeeded', result = '{}', terminal_at = now() WHERE server = 'jobs' AND job_id = $1`,
        [(rows[0] as { job_id: string }).job_id],
      );
      const retried = await admit(appId, BODY, { idempotencyKey: "refusal-key-b" });
      expect(retried).toMatchObject({ outcome: "accepted" });
      if (retried.outcome !== "accepted" || first.outcome !== "accepted") return;
      expect(retried.jobId).not.toBe(first.jobId);
      expect(await records(appId)).toHaveLength(2);
      expect(await runnerRows(appId)).toHaveLength(2);
    } finally {
      await leg.stop();
    }
  });

  test("the server-wide unfinished cap refuses serially off other apps' rows, naming the server cap with the count it saw", async () => {
    // The concurrent leg proves the cap HOLDS under replication; this leg
    // pins the same control's serial path: the submitting app holds nothing,
    // another app's queued row saturates the server count, and the refusal's
    // evidence names `unfinishedPerServer` with the server occupancy —
    // freeing that row admits again.
    const baseline = (await serverOccupancy()).unfinished_server;
    const otherApp = anApp();
    await seedRecord(otherApp);
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const warnings: Array<Record<string, unknown>> = [];
    const leg = new JobsAcceptanceStore({
      ...storeOptions(limitsWith({ unfinishedPerServer: baseline + 1 })),
      log: { warn: (fields) => warnings.push(fields) },
    });
    leg.start();
    const admit = admitThrough(leg);
    try {
      await expect(admit(appId, BODY, { idempotencyKey: null })).resolves.toEqual({
        outcome: "capacity_exceeded",
      });
      expect(warnings.at(-1)).toMatchObject({
        event: "jobs.admission.capacity_refused",
        cap: "unfinishedPerServer",
        limit: baseline + 1,
        occupancy: baseline + 1,
        appId,
        env: "prod",
      });
      expect(await records(appId)).toHaveLength(0);

      await direct.query(`DELETE FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE app_id = $1`, [otherApp]);
      await expect(admit(appId, BODY, { idempotencyKey: null })).resolves.toMatchObject({
        outcome: "accepted",
      });
    } finally {
      await leg.stop();
    }
  });

  test("a saturated server-wide retained cap is refused with the retained server cap's own named evidence", async () => {
    // The counting is the earlier leg's; this one completes the refusal's
    // evidence matrix — the log is matched on the cap's name, so every
    // control's name must be observed carrying its own limit and count. The
    // saturated control is the server's retained cap alone: the seeded row
    // is terminal (retained-only occupancy) and the submitting app's own
    // counts are zero.
    const baseline = (await serverOccupancy()).retained_server;
    const otherApp = anApp();
    await seedRecord(otherApp, { status: "succeeded" });
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const warnings: Array<Record<string, unknown>> = [];
    const leg = new JobsAcceptanceStore({
      ...storeOptions(limitsWith({ retainedPerServer: baseline + 1 })),
      log: { warn: (fields) => warnings.push(fields) },
    });
    leg.start();
    const admit = admitThrough(leg);
    try {
      await expect(admit(appId, BODY, { idempotencyKey: null })).resolves.toEqual({
        outcome: "capacity_exceeded",
      });
      expect(warnings.at(-1)).toMatchObject({
        cap: "retainedPerServer",
        limit: baseline + 1,
        occupancy: baseline + 1,
      });
      await direct.query(`DELETE FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE app_id = $1`, [otherApp]);
      await expect(admit(appId, BODY, { idempotencyKey: null })).resolves.toMatchObject({
        outcome: "accepted",
      });
    } finally {
      await leg.stop();
    }
  });

  test("both retained caps saturating together name the app/environment cap with its own overshoot", async () => {
    // The refusal's evidence contract has two constraints no other leg
    // reaches. First, the retained pair's own order (app/environment before
    // server): both retained caps are saturated at the refusal instant, so a
    // swapped pair would name retainedPerServer instead. Second, the log's
    // limit and occupancy are the named cap's OWN distinct numbers: the
    // lowered cap's occupancy is ABOVE its limit (2 against 1), where a
    // swapped limit/occupancy pairing is visible — every exact-saturation
    // leg sees limit == occupancy, indistinguishable under a swap.
    const baseline = (await serverOccupancy()).retained_server;
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const first = await admit(appId, BODY, { idempotencyKey: null });
    const second = await admit(appId, BODY, { idempotencyKey: null });
    expect(first.outcome).toBe("accepted");
    expect(second.outcome).toBe("accepted");
    const otherApp = anApp();
    await seedRecord(otherApp); // the server's retained count reaches its cap
    const warnings: Array<Record<string, unknown>> = [];
    const leg = new JobsAcceptanceStore({
      ...storeOptions(limitsWith({ retainedPerAppEnv: 1, retainedPerServer: baseline + 3 })),
      log: { warn: (fields) => warnings.push(fields) },
    });
    leg.start();
    const admitLowered = admitThrough(leg);
    try {
      await expect(admitLowered(appId, BODY, { idempotencyKey: null })).resolves.toEqual({
        outcome: "capacity_exceeded",
      });
      expect(warnings.at(-1)).toMatchObject({
        event: "jobs.admission.capacity_refused",
        cap: "retainedPerAppEnv",
        limit: 1,
        occupancy: 2,
      });
      expect(await records(appId)).toHaveLength(2); // nothing evicted
    } finally {
      await leg.stop();
    }
  });

  test("the caps count every stored row of the scope — another type's and another owner's rows occupy the same app/environment slots", async () => {
    // The design's caps bound the app/environment's stored work as a whole:
    // the counts carry no identity conjunct beyond the scope itself, so work
    // spread across job types and owner principals inside one (app, env)
    // consumes the same capacity as the submitting identity's own — a type
    // or owner conjunct in the count's filters would let each identity
    // refill the cap. Each refusal below isolates one dimension: the seeded
    // row differs from the submission ONLY by its type, then ONLY by its
    // owner.
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const warnings: Array<Record<string, unknown>> = [];
    const leg = new JobsAcceptanceStore({
      ...storeOptions(limitsWith({ unfinishedPerAppEnv: 1 })),
      log: { warn: (fields) => warnings.push(fields) },
    });
    leg.start();
    const admit = admitThrough(leg);
    try {
      await seedRecord(appId, { type: "other-server:fetch" });
      await expect(admit(appId, BODY, { idempotencyKey: null })).resolves.toEqual({
        outcome: "capacity_exceeded",
      });
      expect(warnings.at(-1)).toMatchObject({
        event: "jobs.admission.capacity_refused",
        cap: "unfinishedPerAppEnv",
        limit: 1,
        occupancy: 1,
      });

      await direct.query(`DELETE FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE app_id = $1`, [appId]);
      await seedRecord(appId, { ownerOid: "another-owner" });
      await expect(admit(appId, BODY, { idempotencyKey: null })).resolves.toEqual({
        outcome: "capacity_exceeded",
      });
      expect(warnings.at(-1)).toMatchObject({
        cap: "unfinishedPerAppEnv",
        limit: 1,
        occupancy: 1,
      });

      // The scope emptied, the submitting identity's own row fits: the
      // refusals were the count, not a keyed verdict on the identity.
      await direct.query(`DELETE FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE app_id = $1`, [appId]);
      await expect(admit(appId, BODY, { idempotencyKey: null })).resolves.toMatchObject({
        outcome: "accepted",
      });
    } finally {
      await leg.stop();
    }
  });

  test("a wait on the admission lock is bounded by the pool's statement timeout — the retryable failure, never a hang", async () => {
    // One admission holds the server-wide lock while blocked in its enqueuer
    // (the lock is taken before the enqueue); a second, different-app
    // admission then waits on it. The wait is a statement on a pooled
    // client, so the pool's statement timeout bounds it: the contended
    // admission rejects (the store-failure contract), its transaction rolls
    // back claiming nothing, and — the lock released — the same submission
    // is accepted. An admission that stopped taking the lock would sail past
    // this leg accepted; an unbounded wait would hang it.
    const appA = anApp();
    const appB = anApp();
    await deliverGeneration(appA, "1", false);
    await deliverGeneration(appB, "1", false);

    let releaseEnqueue: (() => void) | undefined;
    const releaseGate = new Promise<void>((resolve) => {
      releaseEnqueue = resolve;
    });
    let entered: (() => void) | undefined;
    const enqueueEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holder = new JobsAcceptanceStore({
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
    const contender = new JobsAcceptanceStore({
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 1_500,
      limits: LIMITS,
      accepting: true,
      enqueuer: createPgbossEnqueuer(boss),
      log: LOG,
    });
    holder.start();
    contender.start();
    try {
      const holding = holder.admit({
        claims: submitClaims({
          identity: { ...TEST_IDENTITY, appId: appA },
          generation: "1",
          idempotencyKey: "lock-holder",
        }),
        body: BODY,
      });
      await enqueueEntered; // the holder is inside the transaction, lock taken

      // A different app's admission: the lifecycle row is free, so the wait
      // is the server-wide admission lock's, bounded by the pool's timeout.
      const contended = () =>
        contender.admit({
          claims: submitClaims({
            identity: { ...TEST_IDENTITY, appId: appB },
            generation: "1",
            idempotencyKey: "lock-waiter",
          }),
          body: BODY,
        });
      await expect(contended()).rejects.toThrow(/statement timeout/);

      // The holder's decision finishes and commits once the gate releases.
      releaseEnqueue?.();
      await expect(holding).resolves.toMatchObject({ outcome: "accepted" });

      // The contended attempt claimed nothing (the same key and bytes are
      // new work now) and the pool keeps serving after the cancelled
      // statement.
      await expect(contended()).resolves.toMatchObject({ outcome: "accepted" });
    } finally {
      await holder.stop();
      await contender.stop();
    }
    expect(await records(appA)).toHaveLength(1);
    expect(await records(appB)).toHaveLength(1);
  });

  test("a retained-key recovery never queues behind the admission lock — a replay of another app resolves while new work holds it", async () => {
    // The lock's exclusion set is the contract's other half: it serializes
    // NEW work only, and the retained-key comparison runs before it, so a
    // replay of an already-committed job recovers immediately even while
    // another admission holds the lock — the recovery never waits behind the
    // admission it recovers from, and occupies no slot. No other leg
    // observes what the lock excludes (the bounded-wait leg's contender is
    // new work). A refactor that moved the key lookup after the capacity
    // gate would queue this replay behind the holder and answer the
    // statement timeout instead — red here.
    const appA = anApp();
    const appB = anApp();
    await deliverGeneration(appA, "1", false);
    await deliverGeneration(appB, "1", false);
    const committed = await admit(appB, BODY, { idempotencyKey: "replay-unqueued" });
    expect(committed.outcome).toBe("accepted");
    if (committed.outcome !== "accepted") return;

    let releaseEnqueue: (() => void) | undefined;
    const releaseGate = new Promise<void>((resolve) => {
      releaseEnqueue = resolve;
    });
    let entered: (() => void) | undefined;
    const enqueueEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holder = new JobsAcceptanceStore({
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
    // The replay's own store: a short statement timeout so a regression that
    // queued the replay on the lock fails fast instead of waiting out the
    // holder's gate.
    const replayer = new JobsAcceptanceStore({
      ...storeOptions(LIMITS),
      statementTimeoutMs: 1_500,
    });
    holder.start();
    replayer.start();
    const admitReplay = admitThrough(replayer);
    try {
      const holding = holder.admit({
        claims: submitClaims({
          identity: { ...TEST_IDENTITY, appId: appA },
          generation: "1",
          idempotencyKey: null,
        }),
        body: BODY,
      });
      await enqueueEntered; // the holder is inside the transaction, lock taken

      // A different app's keyed replay: the lifecycle row is free, the key's
      // mapping is committed — the recovery must not wait on the admission
      // lock the holder is holding.
      await expect(
        admitReplay(appB, BODY, { idempotencyKey: "replay-unqueued" }),
      ).resolves.toMatchObject({ outcome: "recovered", jobId: committed.jobId });

      // The holder's decision finishes and commits once the gate releases.
      releaseEnqueue?.();
      await expect(holding).resolves.toMatchObject({ outcome: "accepted" });
    } finally {
      await holder.stop();
      await replayer.stop();
    }
    // The recovery created nothing: one wrapper record per app.
    expect(await records(appA)).toHaveLength(1);
    expect(await records(appB)).toHaveLength(1);
  });
});

describe("the retained-key replay across the read horizons", () => {
  /**
   * The public-read horizons' projection (the observation seam's, which the
   * comparison consumes) bounds what a replay
   * recovers: a matching replay after result expiry returns the original job
   * as `expired` while its record is publicly readable; once public record
   * access expires, the identical replay answers the unknown-job `not_found`
   * without creating work while the row is still physically retained, and
   * the changed-bytes conflict still stands (criterion 14). The horizons'
   * input is the record's `terminal_at` — a leg backdates it directly, the
   * way elapsed time actually reaches the boundary.
   */
  async function completeRecordAsSucceeded(appId: string, jobId: string): Promise<void> {
    await direct.query(
      `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
          SET status = 'succeeded', result = '{"kept":true}', error_code = NULL, terminal_at = now()
        WHERE server = 'jobs' AND job_id = $1 AND app_id = $2`,
      [jobId, appId],
    );
  }

  test("a matching replay after result expiry returns the original job as expired, creating nothing", async () => {
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const first = await admit(appId, BODY, { idempotencyKey: "replay-result-expired" });
    expect(first.outcome).toBe("accepted");
    if (first.outcome !== "accepted") return;
    await completeRecordAsSucceeded(appId, first.jobId);

    // Still readable: the replay recovers the success.
    await expect(admit(appId, BODY, { idempotencyKey: "replay-result-expired" })).resolves.toEqual({
      outcome: "recovered",
      jobId: first.jobId,
      status: "succeeded",
    });

    // Past the seven-day result horizon, within the record's own: the replay
    // returns the original EXPIRED job.
    await direct.query(
      `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
          SET terminal_at = now() - ($2 * interval '1 second')
        WHERE server = 'jobs' AND job_id = $1`,
      [first.jobId, 7 * 24 * 3_600 + 3_600],
    );
    await expect(admit(appId, BODY, { idempotencyKey: "replay-result-expired" })).resolves.toEqual({
      outcome: "recovered",
      jobId: first.jobId,
      status: "expired",
    });

    // No second job, no second slot.
    expect(await records(appId)).toHaveLength(1);
    expect(await runnerRows(appId)).toHaveLength(1);
  });

  test("an identical replay past the public record horizon answers the unknown-job not_found without enqueueing; changed bytes still conflict", async () => {
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const first = await admit(appId, BODY, { idempotencyKey: "replay-record-expired" });
    expect(first.outcome).toBe("accepted");
    if (first.outcome !== "accepted") return;
    await completeRecordAsSucceeded(appId, first.jobId);
    await direct.query(
      `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
          SET terminal_at = now() - ($2 * interval '1 second')
        WHERE server = 'jobs' AND job_id = $1`,
      [first.jobId, 30 * 24 * 3_600 + 3_600],
    );

    // The identical replay: 404's answer, no work created, the retained row
    // still holding the key.
    await expect(admit(appId, BODY, { idempotencyKey: "replay-record-expired" })).resolves.toEqual({
      outcome: "not_found",
    });
    expect(await records(appId)).toHaveLength(1);
    expect(await runnerRows(appId)).toHaveLength(1);

    // Changed bytes: the conflict still stands — the key-holder's own claim
    // is what the 409 answers — with the job's projected state in the body.
    await expect(
      admit(appId, OTHER_BODY, { idempotencyKey: "replay-record-expired" }),
    ).resolves.toEqual({
      outcome: "conflict",
      status: "expired",
      error: null,
    });
    expect(await records(appId)).toHaveLength(1);
    expect(await runnerRows(appId)).toHaveLength(1);
  });

  test("a replay's conflict carries the projected state while the record is readable — a failed job's own error", async () => {
    const appId = anApp();
    await deliverGeneration(appId, "1", false);
    const first = await admit(appId, BODY, { idempotencyKey: "replay-failed-state" });
    expect(first.outcome).toBe("accepted");
    if (first.outcome !== "accepted") return;
    await direct.query(
      `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
          SET status = 'failed', error_code = 'upstream_error', terminal_at = now()
        WHERE server = 'jobs' AND job_id = $1 AND app_id = $2`,
      [first.jobId, appId],
    );

    await expect(
      admit(appId, OTHER_BODY, { idempotencyKey: "replay-failed-state" }),
    ).resolves.toEqual({
      outcome: "conflict",
      status: "failed",
      error: { code: "upstream_error", message: "The upstream request failed." },
    });
  });
});
