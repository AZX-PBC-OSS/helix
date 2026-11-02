import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { INSTRUCTION_HEADER, JobsGenerationSchema } from "@azx-pbc/shared";
import {
  ATTR_JOBS_LIFECYCLE_STAMPED,
  ATTR_OUTCOME,
  SPAN_JOBS_LIFECYCLE,
} from "@azx-pbc/shared/telemetry";
import { startRecordingTelemetry } from "@azx-pbc/telemetry/testing";

import { migrateJobsStorage } from "./migrate.js";
import {
  JOBS_APP_LIFECYCLE_QUALIFIED,
  JOBS_JOB_RECORD_QUALIFIED,
  JOBS_RUNTIME_ROLE,
} from "./policy.js";
import { applyRolesProvisioning } from "../../portal/src/test/provisionDatabases.js";
import { JobsLifecycleStore, lifecycleEligibilityInTx } from "./lifecycle.js";
import { appWithLifecycle, makeReceiver, mint, TEST_IAT } from "./test/instructions.js";

/**
 * The durable lifecycle authority against the real store, through the real
 * role split: the apply-before-acknowledge transaction, the merge rules that
 * keep older and repeated deliveries from reopening closed generations, the
 * row lock that serializes the admission/start gate against a concurrent
 * apply, and the route wired to all of it.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

const SCRATCH_DB = `helix_jobs_lifecycle_${randomUUID().replaceAll("-", "")}`;

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

/** The service's logger surface, as the store consumes it. */
const LOG = { warn: () => {} };

function newStore(statementTimeoutMs = 10_000): JobsLifecycleStore {
  return new JobsLifecycleStore({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs,
    log: LOG,
  });
}

/** The durable row, read directly — the store's own state, not through the apply. */
async function storedState(
  appId: string,
): Promise<{ generation: string; archived: boolean } | null> {
  const pool = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
  try {
    const result = await pool.query<{ generation: string; archived: boolean }>(
      `SELECT generation, archived FROM ${JOBS_APP_LIFECYCLE_QUALIFIED} WHERE app_id = $1`,
      [appId],
    );
    const row = result.rows[0];
    return row ? { generation: row.generation, archived: row.archived } : null;
  } finally {
    await pool.end();
  }
}

beforeAll(async () => {
  await applyRolesProvisioning(SCRATCH_DB);
  await migrateJobsStorage(urlFor(SCRATCH_DB, "helix_jobs_migrate"));
}, 60_000);

afterAll(async () => {
  const pool = new Pool({ connectionString: urlFor("postgres"), max: 1 });
  await pool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
  await pool.end();
}, 30_000);

describe("the durable lifecycle store", () => {
  test("an apply against a store that is not running throws for the route to refuse; stop is safe twice and the store does not restart", async () => {
    // The pool discipline the service's other stores pin: the refusal is the
    // route's retryable 503, never a silent success or a raw pool crash — and
    // stop() is terminal, so a shutdown-window delivery cannot sneak an apply
    // past a store that is on its way out.
    const store = newStore();
    await expect(store.apply("app-stopped", { generation: "1", archived: false })).rejects.toThrow(
      /not running/,
    );
    await expect(store.stop()).resolves.toBeUndefined(); // safe without a pool
    store.start(); // no-op after stop
    await expect(store.apply("app-stopped", { generation: "1", archived: false })).rejects.toThrow(
      /not running/,
    );
    await store.stop();
  });

  test("a first delivery applies as delivered and acknowledges its generation", async () => {
    const store = newStore();
    store.start();
    try {
      await expect(store.apply("app-first", { generation: "1", archived: false })).resolves.toEqual(
        { appliedGeneration: "1", changed: true, stamped: 0 },
      );
      await expect(storedState("app-first")).resolves.toEqual({
        generation: "1",
        archived: false,
      });
    } finally {
      await store.stop();
    }
  });

  test("a repeated delivery acknowledges the applied generation without changing it", async () => {
    const store = newStore();
    store.start();
    try {
      await store.apply("app-repeat", { generation: "3", archived: true });
      await expect(store.apply("app-repeat", { generation: "3", archived: true })).resolves.toEqual(
        { appliedGeneration: "3", changed: false, stamped: 0 },
      );
      await expect(storedState("app-repeat")).resolves.toEqual({
        generation: "3",
        archived: true,
      });
    } finally {
      await store.stop();
    }
  });

  test("a newer delivery applies; an older delivery after it is a no-op that still acknowledges the highest", async () => {
    const store = newStore();
    store.start();
    try {
      await expect(store.apply("app-newer", { generation: "2", archived: true })).resolves.toEqual({
        appliedGeneration: "2",
        changed: true,
        stamped: 0,
      });
      await expect(store.apply("app-newer", { generation: "5", archived: false })).resolves.toEqual(
        {
          appliedGeneration: "5",
          changed: true,
          stamped: 0,
        },
      );
      // The out-of-order archive (generation 2) arriving after the newer
      // unarchive (generation 5): acknowledged with the highest applied
      // generation, state unmoved — nothing reopened, nothing lost.
      await expect(store.apply("app-newer", { generation: "2", archived: true })).resolves.toEqual({
        appliedGeneration: "5",
        changed: false,
        stamped: 0,
      });
      await expect(storedState("app-newer")).resolves.toEqual({
        generation: "5",
        archived: false,
      });
    } finally {
      await store.stop();
    }
  });

  test("an immediate archive then unarchive delivered out of order keeps every prior generation ineligible", async () => {
    // The unarchive (generation 6, open) delivered before its preceding
    // archive (generation 5, closed): the open generation 6 stands, the
    // stale archive closes nothing new, and every generation at or below 6's
    // predecessors — including the brief archive's own — is ineligible at
    // the gate.
    const store = newStore();
    store.start();
    try {
      await expect(store.apply("app-brief", { generation: "6", archived: false })).resolves.toEqual(
        { appliedGeneration: "6", changed: true, stamped: 0 },
      );
      await expect(store.apply("app-brief", { generation: "5", archived: true })).resolves.toEqual({
        appliedGeneration: "6",
        changed: false,
        stamped: 0,
      });

      const pool = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
      try {
        const client = await pool.connect();
        try {
          // The claimed generations a caller could still present: the
          // pre-archive generations are closed; only 6 admits.
          await expect(lifecycleEligibilityInTx(client, "app-brief", "5")).resolves.toMatchObject({
            verdict: "closed",
          });
          await expect(lifecycleEligibilityInTx(client, "app-brief", "4")).resolves.toMatchObject({
            verdict: "closed",
          });
          await expect(lifecycleEligibilityInTx(client, "app-brief", "6")).resolves.toEqual({
            verdict: "admit",
          });
          await expect(lifecycleEligibilityInTx(client, "app-brief", "7")).resolves.toMatchObject({
            verdict: "unseen",
          });
        } finally {
          client.release();
        }
      } finally {
        await pool.end();
      }
    } finally {
      await store.stop();
    }
  });

  test("the applied generation outlives a store restart", async () => {
    const first = newStore();
    first.start();
    await first.apply("app-restart", { generation: "8", archived: true });
    await first.stop();

    const restarted = newStore();
    restarted.start();
    try {
      // A fresh store instance on the same durable store — the restarted
      // receiver. The stale delivery is still a no-op acknowledging the
      // highest applied generation; the closed generation stays closed.
      await expect(
        restarted.apply("app-restart", { generation: "7", archived: false }),
      ).resolves.toEqual({ appliedGeneration: "8", changed: false, stamped: 0 });
      await expect(storedState("app-restart")).resolves.toEqual({
        generation: "8",
        archived: true,
      });
    } finally {
      await restarted.stop();
    }
  });

  test("concurrent first deliveries of one app serialize; the highest generation stands", async () => {
    const store = newStore();
    store.start();
    try {
      const results = await Promise.all([
        store.apply("app-race", { generation: "1", archived: false }),
        store.apply("app-race", { generation: "2", archived: false }),
      ]);
      expect(results).toHaveLength(2);
      // Order-insensitive: whichever apply lands second merges against the
      // first's committed state, so the applied generation is the maximum.
      await expect(storedState("app-race")).resolves.toEqual({
        generation: "2",
        archived: false,
      });
    } finally {
      await store.stop();
    }
  });

  test("a delivery the store cannot durably represent is refused with nothing applied, and the store still answers after it", async () => {
    // The wire generation schema has no upper bound; the store's bigint
    // column does. A delivery past that bound is a real mid-transaction
    // failure: the apply must throw with nothing applied and nothing
    // acknowledged — and the rolled-back unit must leave a usable store
    // behind, not an aborted transaction the next delivery inherits.
    const store = newStore();
    store.start();
    try {
      await expect(
        store.apply("app-overflow", { generation: "9223372036854775808", archived: false }),
      ).rejects.toThrow(/out of range/);
      await expect(storedState("app-overflow")).resolves.toBeNull();

      await expect(
        store.apply("app-overflow", { generation: "1", archived: true }),
      ).resolves.toEqual({ appliedGeneration: "1", changed: true, stamped: 0 });
      await expect(storedState("app-overflow")).resolves.toEqual({
        generation: "1",
        archived: true,
      });
    } finally {
      await store.stop();
    }
  });

  test("a first delivery the wire schema refuses never lands as a different generation — the apply's answer is the wire form of what it stored", async () => {
    // The store's first-delivery path inserts the delivered generation
    // verbatim and bypasses the merge, and the update type is the schema's
    // unbranded infer — so a non-canonical string is in-type here. Postgres
    // 18's bigint input silently coerces the whole wider grammar ('0x10' is
    // 16, '007' is 7), which launders the delivery: the row would hold one
    // generation while the apply reports the delivered string — an
    // acknowledgement the wire ack schema then refuses, 500 after the
    // commit. Refused outright or canonicalized, either way what the apply
    // reports must parse as a generation and be exactly what the row holds.
    const store = newStore();
    store.start();
    try {
      const result = await store
        .apply("app-noncanonical", { generation: "0x10", archived: false })
        .catch(() => null);
      if (result === null) {
        // The refusal shape: nothing durably stored from a delivery the
        // boundary refuses.
        await expect(storedState("app-noncanonical")).resolves.toBeNull();
      } else {
        expect(
          JobsGenerationSchema.safeParse(result.appliedGeneration).success,
          `the apply reported ${JSON.stringify(result.appliedGeneration)} for a refused wire form`,
        ).toBe(true);
        await expect(storedState("app-noncanonical")).resolves.toEqual({
          generation: result.appliedGeneration,
          archived: false,
        });
      }

      // Canonicalization repairs the spelling, not the value: a negative
      // generation is BigInt-canonical as "-1" and the bigint column stores
      // it, but the wire form forbids the sign. Such a delivery would land a
      // row no acknowledgement can name (the ack schema refuses "-1" — 500
      // after the commit, every retry) and no canonical claim can ever admit
      // under (every claim sits above it — unseen forever): a poisoned app.
      // The same property as the hex leg must hold — the answer parses as a
      // generation and is what the row holds, or the delivery is refused.
      const negative = await store
        .apply("app-negative", { generation: "-1", archived: false })
        .catch(() => null);
      if (negative === null) {
        await expect(storedState("app-negative")).resolves.toBeNull();
      } else {
        expect(
          JobsGenerationSchema.safeParse(negative.appliedGeneration).success,
          `the apply reported ${JSON.stringify(negative.appliedGeneration)} for a value the wire form forbids`,
        ).toBe(true);
        await expect(storedState("app-negative")).resolves.toEqual({
          generation: negative.appliedGeneration,
          archived: false,
        });
      }
    } finally {
      await store.stop();
    }
  });

  test("a non-canonical newer delivery against an existing row acks and stores the canonical form", async () => {
    // The route's schema refuses a non-canonical spelling before the apply,
    // so this arm is the direct caller's defence in depth: the apply
    // canonicalizes before the merge, so what is acked and what the row
    // holds stay one wire form — the laundering shape the bigint column's
    // silent coercion allows cannot diverge them, on the merge arm either.
    const store = newStore();
    store.start();
    try {
      await expect(
        store.apply("app-canonical", { generation: "7", archived: false }),
      ).resolves.toEqual({ appliedGeneration: "7", changed: true, stamped: 0 });
      // Equal under canonicalization: a redelivery in a non-canonical
      // spelling is the no-op it would have been in the canonical one.
      await expect(
        store.apply("app-canonical", { generation: "007", archived: false }),
      ).resolves.toEqual({ appliedGeneration: "7", changed: false, stamped: 0 });
      // Newer under canonicalization: applies as the value it denotes.
      await expect(
        store.apply("app-canonical", { generation: "0x10", archived: true }),
      ).resolves.toEqual({ appliedGeneration: "16", changed: true, stamped: 0 });
      await expect(storedState("app-canonical")).resolves.toEqual({
        generation: "16",
        archived: true,
      });
    } finally {
      await store.stop();
    }
  });

  test("a delivery that is not a generation at all is refused with nothing stored, and the store still answers", async () => {
    // The route's schema refuses unparseable input; the apply's
    // canonicalization is the direct caller's boundary. The observable
    // contract holds whichever side refuses: rejection, no row, and a store
    // that still answers — never a stored guess.
    const store = newStore();
    store.start();
    try {
      await expect(
        store.apply("app-unparseable", { generation: "not-a-generation", archived: false }),
      ).rejects.toThrow();
      await expect(storedState("app-unparseable")).resolves.toBeNull();
      await expect(
        store.apply("app-unparseable", { generation: "1", archived: false }),
      ).resolves.toEqual({ appliedGeneration: "1", changed: true, stamped: 0 });
    } finally {
      await store.stop();
    }
  });

  test("the gate's lock serializes against a concurrent apply — held to the caller's commit", async () => {
    const store = newStore(1_500); // short bound: a blocked apply must time out, not hang
    store.start();
    const pool = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
    try {
      await store.apply("app-lock", { generation: "2", archived: false });

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // The gate's read takes the row lock inside the caller's transaction.
        await expect(lifecycleEligibilityInTx(client, "app-lock", "2")).resolves.toEqual({
          verdict: "admit",
        });

        // While the lock is held, a lifecycle apply for the same app cannot
        // land — the admission/start decision that read the state cannot be
        // overtaken by a generation change before its own commit.
        await expect(
          store.apply("app-lock", { generation: "3", archived: true }),
        ).rejects.toThrow();

        // The gate's caller commits; the waiting apply then succeeds.
        await client.query("COMMIT");
        await expect(store.apply("app-lock", { generation: "3", archived: true })).resolves.toEqual(
          { appliedGeneration: "3", changed: true, stamped: 0 },
        );
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
      await store.stop();
    }
  });

  test("an app the portal never delivered is unseen through the gate's own read", async () => {
    // The SQL row-miss maps to the pure gate's absence answer: unseen with
    // no applied generation to report — temporary, never closed, never
    // admit. The appliedGeneration null is load-bearing.
    const pool = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
    try {
      const client = await pool.connect();
      try {
        await expect(lifecycleEligibilityInTx(client, "app-never-delivered", "1")).resolves.toEqual(
          { verdict: "unseen", appliedGeneration: null },
        );
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  test(
    "a pooled lifecycle client dying while idle is a logged warning, not a process death — and the store still answers",
    { timeout: 60_000 },
    async () => {
      // Same scenario the burn store's pool pins: pg-pool strips a
      // checked-out client's own error listener, so an idle client's death is
      // an unhandled pool event unless the lifecycle store's listener absorbs
      // it — and an idle window here is ordinary, since the pool only serves
      // lifecycle deliveries. Terminate idle backends behind the pool's back
      // until the warning lands, then prove the store still answers.
      const warnings: Array<{ fields: Record<string, unknown>; msg: string }> = [];
      const store = new JobsLifecycleStore({
        databaseUrl: RUNTIME_DSN,
        statementTimeoutMs: 10_000,
        log: { warn: (fields, msg) => warnings.push({ fields, msg }) },
      });
      store.start();
      try {
        // One apply leaves a pooled, now-idle client to terminate.
        await expect(
          store.apply("app-pool-error", { generation: "1", archived: false }),
        ).resolves.toEqual({ appliedGeneration: "1", changed: true, stamped: 0 });

        const control = new Pool({ connectionString: urlFor("postgres"), max: 1 });
        try {
          const warnedBy = Date.now() + 20_000;
          while (Date.now() < warnedBy) {
            const idle = await control.query<{ pid: number }>(
              `SELECT pid FROM pg_stat_activity
               WHERE datname = $1 AND usename = $2 AND state = 'idle' AND pid <> pg_backend_pid()`,
              [SCRATCH_DB, JOBS_RUNTIME_ROLE],
            );
            for (const row of idle.rows) {
              await control.query(`SELECT pg_terminate_backend($1)`, [row.pid]);
            }
            await new Promise((r) => setTimeout(r, 300));
            if (warnings.some((w) => w.fields.event === "jobs.lifecycle.pool_error")) break;
          }
        } finally {
          await control.end();
        }
        expect(
          warnings.some((w) => w.fields.event === "jobs.lifecycle.pool_error"),
          "no pool_error warning landed — the listener is gone or the death went unhandled",
        ).toBe(true);

        // The store survived the death: a fresh apply gets a rebuilt client
        // and answers normally.
        await expect(
          store.apply("app-pool-error", { generation: "2", archived: true }),
        ).resolves.toEqual({ appliedGeneration: "2", changed: true, stamped: 0 });
      } finally {
        await store.stop();
      }
    },
  );

  test(
    "every apply exit returns its client — successes, no-ops and failures alike never shrink the pool",
    { timeout: 15_000 },
    async () => {
      // The resource-lifetime loop: each apply checks a client out of the
      // two-client pool and must return it on every exit — the failure exit's
      // release-with-destroy included. A dropped release on any one path
      // silently shrinks the pool until an apply hangs on the connect bound;
      // repeating the three exits past the pool's capacity is what makes a
      // one-call-per-exit test's blind spot red.
      const store = newStore(2_000); // short connect bound: a stranded client surfaces fast
      store.start();
      try {
        for (let i = 0; i < 4; i += 1) {
          const generation = String(i + 1);
          await expect(
            store.apply("app-release", { generation, archived: false }),
          ).resolves.toEqual({ appliedGeneration: generation, changed: true, stamped: 0 });
          await expect(
            store.apply("app-release", { generation, archived: false }),
          ).resolves.toEqual({ appliedGeneration: generation, changed: false, stamped: 0 });
          await expect(
            store.apply("app-release", { generation: "9223372036854775808", archived: false }),
          ).rejects.toThrow(/out of range/);
        }
        // The pool still answers after the loop: no client was stranded.
        await expect(
          store.apply("app-release", { generation: "99", archived: true }),
        ).resolves.toEqual({ appliedGeneration: "99", changed: true, stamped: 0 });
      } finally {
        await store.stop();
      }
    },
  );

  test("the runtime role holds no DELETE on the lifecycle store — tombstone state", async () => {
    // The rows are the cancellation-intent record a future app deletion must
    // still deliver against; no runtime path removes them.
    const pool = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
    try {
      await expect(
        pool.query(`DELETE FROM ${JOBS_APP_LIFECYCLE_QUALIFIED} WHERE app_id = 'app-first'`),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await pool.end();
    }
  });

  test("the runtime role holds no TRUNCATE on the lifecycle store either — the tombstone invariant has no removal path", async () => {
    // DELETE is the pinned removal path; TRUNCATE is a separate privilege
    // that empties the same rows without it. The tombstone promise holds only
    // if neither is granted — the migration grants SELECT/INSERT/UPDATE and
    // no default privileges exist to sneak a wider grant in behind it.
    const pool = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
    try {
      await expect(pool.query(`TRUNCATE ${JOBS_APP_LIFECYCLE_QUALIFIED}`)).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await pool.end();
    }
  });
});

/** Ad-hoc pool for the record-store arrangements the legs read back directly. */
async function withRecordPool<T>(body: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
  try {
    return await body(pool);
  } finally {
    await pool.end();
  }
}

let recordSeq = 0;
function aRunnerId(): string {
  recordSeq += 1;
  return `stamp-fixture-${recordSeq}`;
}

/** Seed one wrapper record the way acceptance would commit it (no runner row — nothing here executes). */
async function seedRecord(options: {
  appId: string;
  env?: string;
  generation?: string;
  status?: string;
}): Promise<string> {
  const jobId = randomUUID();
  const status = options.status ?? "queued";
  await withRecordPool(async (pool) =>
    pool.query(
      `INSERT INTO ${JOBS_JOB_RECORD_QUALIFIED}
         (server, job_id, runner_job_id, app_id, env, owner_kind, owner_oid, type,
          generation, status, retry_key, body_sha256, created_at, terminal_at, error_code)
       VALUES ('jobs', $1, $2, $3, $4, 'user', 'oid', 'jobs:fetch', $5, $6, NULL, $7, now(),
               CASE WHEN $6 = ANY(ARRAY['succeeded','failed','crashed','cancelled','expired']) THEN now() END,
               CASE WHEN $6 = ANY(ARRAY['failed','crashed','cancelled','expired']) THEN 'cancelled' END)`,
      [
        jobId,
        aRunnerId(),
        options.appId,
        options.env ?? "prod",
        options.generation ?? "1",
        status,
        "0".repeat(64),
      ],
    ),
  );
  return jobId;
}

async function recordOf(jobId: string): Promise<{
  status: string;
  cancellation_requested: boolean;
  cancellation_requested_at: Date | null;
}> {
  return withRecordPool(async (pool) => {
    const result = await pool.query<{
      status: string;
      cancellation_requested: boolean;
      cancellation_requested_at: Date | null;
    }>(
      `SELECT status, cancellation_requested, cancellation_requested_at
         FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE job_id = $1`,
      [jobId],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`no record row for job ${jobId}`);
    return row;
  });
}

describe("the apply's cancellation stamping", () => {
  test("a delivered archive stamps still-active work in both environments; terminal records and other apps are untouched", async () => {
    const store = newStore();
    store.start();
    try {
      await store.apply("app-stamp", { generation: "1", archived: false });
      await store.apply("app-other", { generation: "1", archived: false });
      const prod = await seedRecord({ appId: "app-stamp" });
      const dev = await seedRecord({ appId: "app-stamp", env: "dev" });
      const foreign = await seedRecord({ appId: "app-other" });
      const done = await seedRecord({ appId: "app-stamp", status: "cancelled" });

      await expect(store.apply("app-stamp", { generation: "2", archived: true })).resolves.toEqual({
        appliedGeneration: "2",
        changed: true,
        stamped: 2,
      });

      for (const jobId of [prod, dev]) {
        const row = await recordOf(jobId);
        expect(row.cancellation_requested).toBe(true);
        expect(row.cancellation_requested_at).toBeInstanceOf(Date);
        expect(row.status).toBe("queued");
      }
      // Another app's work is not the archive's to cancel; a record already
      // terminal keeps the outcome it won.
      expect((await recordOf(foreign)).cancellation_requested).toBe(false);
      expect((await recordOf(done)).cancellation_requested).toBe(false);
    } finally {
      await store.stop();
    }
  });

  test("an unarchive stamps pre-archive work but never the eligible new generation's", async () => {
    const store = newStore();
    store.start();
    try {
      await store.apply("app-unarchive", { generation: "1", archived: false });
      const preArchive = await seedRecord({ appId: "app-unarchive", generation: "1" });

      // The unarchive OPENS generation 2 — and closes everything below it
      // forever: the pre-archive record is stamped by the very delivery that
      // opens the new work.
      await expect(
        store.apply("app-unarchive", { generation: "2", archived: false }),
      ).resolves.toEqual({ appliedGeneration: "2", changed: true, stamped: 1 });
      expect((await recordOf(preArchive)).cancellation_requested).toBe(true);

      // The eligible new generation is not cancellation-eligible work.
      const newGeneration = await seedRecord({ appId: "app-unarchive", generation: "2" });
      await expect(
        store.apply("app-unarchive", { generation: "2", archived: false }),
      ).resolves.toEqual({ appliedGeneration: "2", changed: false, stamped: 0 });
      expect((await recordOf(newGeneration)).cancellation_requested).toBe(false);
    } finally {
      await store.stop();
    }
  });

  test("an archive delivered at the applied generation stamps its same-generation work", async () => {
    // The predicate's third disjunct: a record admitted at the applied
    // generation is cancellation-eligible the moment that generation is
    // archived — the merge arm that closes a generation without moving the
    // watermark (an archive is never undone at the generation it claims)
    // stamps the work it closes, exactly as a watermark-moving archive does.
    const store = newStore();
    store.start();
    try {
      await store.apply("app-same-gen", { generation: "4", archived: false });
      const jobId = await seedRecord({ appId: "app-same-gen", generation: "4" });

      await expect(
        store.apply("app-same-gen", { generation: "4", archived: true }),
      ).resolves.toEqual({ appliedGeneration: "4", changed: true, stamped: 1 });
      const row = await recordOf(jobId);
      expect(row.cancellation_requested).toBe(true);
      expect(row.cancellation_requested_at).toBeInstanceOf(Date);
      expect(row.status).toBe("queued");
    } finally {
      await store.stop();
    }
  });

  test("a submission committing under the archive's lock is stamped by the apply that closes its generation", async () => {
    // The serialization boundary's cancellation half: an admission holds the
    // lifecycle row while it commits its record; the archive apply waits for
    // that commit — and then stamps the record it sees, so no acceptance can
    // land between the closed generation and the intent that cancels it.
    const store = newStore();
    store.start();
    await store.apply("app-race-stamp", { generation: "1", archived: false });
    const pool = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await expect(lifecycleEligibilityInTx(client, "app-race-stamp", "1")).resolves.toEqual({
          verdict: "admit",
        });
        const racingJobId = randomUUID();
        await client.query(
          `INSERT INTO ${JOBS_JOB_RECORD_QUALIFIED}
             (server, job_id, runner_job_id, app_id, env, owner_kind, owner_oid, type,
              generation, status, retry_key, body_sha256, created_at)
           VALUES ('jobs', $1, $2, 'app-race-stamp', 'prod', 'user', 'oid', 'jobs:fetch',
                   '1', 'queued', NULL, $3, now())`,
          [racingJobId, aRunnerId(), "0".repeat(64)],
        );

        // The archive apply blocks on the admission's lock; the admission
        // commits first, and the unblocked apply stamps the record it then
        // sees.
        const archiveApply = store.apply("app-race-stamp", { generation: "2", archived: true });
        await client.query("COMMIT");
        await expect(archiveApply).resolves.toEqual({
          appliedGeneration: "2",
          changed: true,
          stamped: 1,
        });
        expect((await recordOf(racingJobId)).cancellation_requested).toBe(true);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
      await store.stop();
    }
  });

  test("a repeated delivery does not rewrite the pending-cancellation instant", async () => {
    const store = newStore();
    store.start();
    try {
      await store.apply("app-repeat-stamp", { generation: "1", archived: false });
      const jobId = await seedRecord({ appId: "app-repeat-stamp" });
      await store.apply("app-repeat-stamp", { generation: "2", archived: true });
      const first = (await recordOf(jobId)).cancellation_requested_at;
      expect(first).toBeInstanceOf(Date);

      // The redelivery is a no-op merge and stamps nothing — the first
      // intent's instant is the one the recovery backlog's age reads.
      await expect(
        store.apply("app-repeat-stamp", { generation: "2", archived: true }),
      ).resolves.toEqual({ appliedGeneration: "2", changed: false, stamped: 0 });
      expect((await recordOf(jobId)).cancellation_requested_at).toEqual(first);
    } finally {
      await store.stop();
    }
  });

  test("a no-op delivery still stamps the standing closed set's residue", async () => {
    // The stamp reads the CURRENT closed set of the delivery's own app, not
    // the delivered change: a stale delivery that merges nothing still
    // commits intent on active work its app's standing state already closes
    // (criterion 65's synchronized state — the closed-set predicate, not
    // "newly closed"). The residue here is the shape a store from before the
    // stamping holds; the recovery sweeper's healing arm is the backstop for
    // stores — and other apps' residue — that never receive a delivery.
    const store = newStore();
    store.start();
    try {
      await store.apply("app-stale-stamp", { generation: "3", archived: false });
      const jobId = await seedRecord({ appId: "app-stale-stamp", generation: "1" });
      // The residue: active work under the standing watermark, carrying no
      // intent (the healing-arm leg's shape).
      await withRecordPool(async (pool) =>
        pool.query(
          `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
              SET cancellation_requested = false, cancellation_requested_at = NULL
            WHERE job_id = $1`,
          [jobId],
        ),
      );

      // The stale archive closes nothing new — and still stamps what the
      // standing state already closes.
      await expect(
        store.apply("app-stale-stamp", { generation: "2", archived: true }),
      ).resolves.toEqual({ appliedGeneration: "3", changed: false, stamped: 1 });
      const row = await recordOf(jobId);
      expect(row.cancellation_requested).toBe(true);
      expect(row.cancellation_requested_at).toBeInstanceOf(Date);
      expect(row.status).toBe("queued");
    } finally {
      await store.stop();
    }
  });
});

describe("the lifecycle route against the real store", () => {
  const APP_ID = "0b9e8c3e-6f2a-4c9b-9e1f-2a4b6c8d0e2f";

  /** Mint and deliver one lifecycle update through the real composition. */
  async function deliver(
    app: FastifyInstance,
    body: string,
    appId: string = APP_ID,
  ): Promise<{ statusCode: number; body: unknown; headers: Record<string, unknown> }> {
    const token = await mint({
      operation: "lifecycle",
      server: "jobs",
      appId,
      body: new TextEncoder().encode(body),
      iatS: TEST_IAT,
    });
    const res = await app.inject({
      method: "POST",
      url: `/internal/jobs/v1/lifecycle/${appId}`,
      headers: {
        "content-type": "application/json",
        [INSTRUCTION_HEADER]: token,
      },
      payload: body,
    });
    return { statusCode: res.statusCode, body: res.json(), headers: res.headers };
  }

  test("a delivery is applied before it is acknowledged, and its redelivery acknowledges the same generation", async () => {
    const receiver = makeReceiver();
    const store = newStore();
    store.start();
    const { app, storage } = await appWithLifecycle(receiver, store);
    try {
      const first = await deliver(app, '{"generation":"1","archived":false}');
      expect(first.statusCode).toBe(200);
      expect(first.headers["cache-control"]).toBe("no-store");
      expect(first.body).toEqual({ appliedGeneration: "1" });
      // Applied before acknowledged: the state is durable once the ack exists.
      await expect(storedState(APP_ID)).resolves.toEqual({ generation: "1", archived: false });

      // The sender's redelivery (a fresh instruction, the same change) is
      // acknowledged with the same applied generation and changes nothing.
      const repeat = await deliver(app, '{"generation":"1","archived":false}');
      expect(repeat.statusCode).toBe(200);
      expect(repeat.body).toEqual({ appliedGeneration: "1" });
      await expect(storedState(APP_ID)).resolves.toEqual({ generation: "1", archived: false });
    } finally {
      await app.close();
      await storage.stop();
      await store.stop();
    }
  });

  test("an out-of-order archive after a newer unarchive acknowledges the highest generation", async () => {
    const receiver = makeReceiver();
    const store = newStore();
    store.start();
    const { app, storage } = await appWithLifecycle(receiver, store);
    try {
      await expect(deliver(app, '{"generation":"4","archived":false}')).resolves.toMatchObject({
        statusCode: 200,
        body: { appliedGeneration: "4" },
      });
      await expect(deliver(app, '{"generation":"3","archived":true}')).resolves.toMatchObject({
        statusCode: 200,
        body: { appliedGeneration: "4" },
      });
      await expect(storedState(APP_ID)).resolves.toEqual({ generation: "4", archived: false });
    } finally {
      await app.close();
      await storage.stop();
      await store.stop();
    }
  });

  test("the route span carries the delivery's stamped reach through the real store", async () => {
    // The in-memory double's span always reads stamped: 0 — the attribute's
    // real reach is the durable apply's, so this leg drives it: two queued
    // records, one archive through the signed route, and the count the
    // delivery's cancellation evidence names.
    const recording = startRecordingTelemetry();
    const receiver = makeReceiver();
    const store = newStore();
    store.start();
    const { app, storage } = await appWithLifecycle(receiver, store);
    // This leg's own app — the describe's shared APP_ID already holds a
    // newer generation from an earlier leg, and a stale archive here would
    // ack that instead of stamping.
    const appId = randomUUID();
    try {
      await deliver(app, '{"generation":"1","archived":false}', appId);
      const prod = await seedRecord({ appId });
      const dev = await seedRecord({ appId, env: "dev" });
      recording.reset(); // the open generation's delivery is not this leg's subject

      const archive = await deliver(app, '{"generation":"2","archived":true}', appId);
      expect(archive.statusCode).toBe(200);
      expect(archive.body).toEqual({ appliedGeneration: "2" });

      const spans = recording.spans().filter((s) => s.name === SPAN_JOBS_LIFECYCLE);
      expect(spans).toHaveLength(1);
      const span = spans[0];
      expect(span?.attributes[ATTR_OUTCOME]).toBe("applied");
      expect(span?.attributes[ATTR_JOBS_LIFECYCLE_STAMPED]).toBe(2);

      // The span's count is the store's own answer: both records carry the
      // durable intent the delivery reached.
      for (const jobId of [prod, dev]) {
        expect((await recordOf(jobId)).cancellation_requested).toBe(true);
      }
    } finally {
      await app.close();
      await storage.stop();
      await store.stop();
      await recording.restore();
    }
  });
});
