import { randomUUID } from "node:crypto";
import type { PgBoss } from "pg-boss";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { migrateJobsStorage } from "./migrate.js";
import { JobsRunner } from "./runner.js";
import { JOBS_PGBOSS_SCHEMA, JOBS_QUEUE_NAME } from "./policy.js";
import { applyRolesProvisioning } from "../../portal/src/test/provisionDatabases.js";

/**
 * The supervised runner's convergence: the retry loop's whole job is the
 * transition from a store that is not usable yet to one that is. The failure
 * side is pinned in `runner.test.ts` (a store that refuses connections keeps
 * retrying) and the success-from-a-migrated-store side in the boot suite's
 * instruction legs; the transition between them — a migration landing
 * mid-flight under a loop that keeps retrying — is exercised here against the
 * real pg-boss and the real migration command: the loop must keep attempting
 * until the store verifies, flip to started, and its enqueue must then serve
 * through the borrowed-connection adapter (the runner row lands on the
 * caller's transaction and shares its fate).
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

const SCRATCH_DB = `helix_jobs_runc_${randomUUID().replaceAll("-", "")}`;

function urlFor(database: string, role?: string): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  if (role) {
    url.username = role;
    url.password = role;
  }
  return url.toString();
}

const RUNTIME_DSN = urlFor(SCRATCH_DB, "helix_jobs");

/** Bounded wait for an event the runner's loop produces at its own cadence. */
async function waitFor(what: string, deadlineMs: number, probe: () => boolean): Promise<void> {
  const by = Date.now() + deadlineMs;
  while (Date.now() < by) {
    if (probe()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("the supervised runner's convergence", () => {
  let runner: JobsRunner;
  let pool: Pool;
  let started = false;
  let failedStarts = 0;

  beforeAll(async () => {
    await applyRolesProvisioning(SCRATCH_DB);
    // No migration yet: the loop must refuse-and-retry against this store.
    runner = new JobsRunner({
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      retryInitialMs: 25,
      retryMaxMs: 100,
      log: {
        info: (fields) => {
          if ((fields as { event?: string }).event === "jobs.runner.started") started = true;
        },
        warn: (fields) => {
          if ((fields as { event?: string }).event === "jobs.runner.start_failed")
            failedStarts += 1;
        },
        error: () => {},
      },
      registerWorker: async () => {},
    });
    runner.start();
  }, 60_000);

  afterAll(async () => {
    await runner?.stop();
    await pool?.end();
    const drop = new Pool({ connectionString: urlFor("postgres"), max: 1 });
    await drop.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
    await drop.end();
  }, 30_000);

  test("a start that failed against the unmigrated store converges once the migration lands, and the enqueue then serves on the caller's transaction", async () => {
    // The loop refused the unmigrated store at least once before the
    // migration: the convergence below is the failure→success transition,
    // not a first-attempt success.
    await waitFor("the first failed start attempt", 30_000, () => failedStarts > 0);

    // Until it converges, the enqueue refuses honestly.
    await expect(
      runner.enqueuer.enqueue({ query: async () => ({ rows: [] }) } as never, {
        type: "jobs:fetch",
        appId: randomUUID(),
        env: "prod",
        input: { url: "https://example.com/data.json" },
        retryLimit: 0,
        expireInSeconds: 300,
      }),
    ).rejects.toThrow(/not started/);

    // The migration lands under the running loop; the next attempt verifies.
    await migrateJobsStorage(urlFor(SCRATCH_DB, "helix_jobs_migrate"));
    await waitFor("the runner to start against the migrated store", 30_000, () => started);

    // The runner's own enqueuer — the getter the server composes — now
    // serves, and its runner row lands on the CALLER's transaction: visible
    // inside it, gone with its rollback.
    pool = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
    const client = await pool.connect();
    let runnerJobId: string | undefined;
    try {
      await client.query("BEGIN");
      runnerJobId = await runner.enqueuer.enqueue(client, {
        type: "jobs:fetch",
        appId: randomUUID(),
        env: "prod",
        input: { url: "https://example.com/data.json" },
        retryLimit: 0,
        expireInSeconds: 300,
      });
      expect(runnerJobId).toBeTruthy();
      const inside = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${JOBS_PGBOSS_SCHEMA}.job WHERE id::text = $1`,
        [runnerJobId],
      );
      expect(inside.rows[0]?.n).toBe(1);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const after = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${JOBS_PGBOSS_SCHEMA}.job
        WHERE id::text = $1 AND name = $2`,
      [runnerJobId, JOBS_QUEUE_NAME],
    );
    expect(after.rows[0]?.n).toBe(0);
  }, 90_000);

  test("the runner's deleter — the getter the cleanup composes — deletes the named row on the caller's transaction, and the deletion shares the transaction's fate", async () => {
    // The cleanup loop's record arm retires runner rows through THIS getter
    // (`server.ts` wires `deleteRunnerRows: runner.deleter`) inside its own
    // transaction, so the deletion must land on the CALLER's client — the
    // same borrowed-connection property the enqueue half proves above. The
    // row is gone inside the borrowing transaction, back after its rollback,
    // and gone for good after a commit: one rollback discards the retirement
    // of the wrapper record and the runner row together.
    await migrateJobsStorage(urlFor(SCRATCH_DB, "helix_jobs_migrate"));
    await waitFor("the runner to be started", 30_000, () => runner.snapshot.started);

    // Two connections: the borrowing transaction holds one while the
    // outside reads answer on the other.
    const legPool = new Pool({ connectionString: RUNTIME_DSN, max: 2 });
    try {
      // A committed runner row, enqueued through the runner's own getter.
      const writer = await legPool.connect();
      let runnerJobId: string | undefined;
      try {
        await writer.query("BEGIN");
        runnerJobId = await runner.enqueuer.enqueue(writer, {
          type: "jobs:fetch",
          appId: randomUUID(),
          env: "prod",
          input: { url: "https://example.com/data.json" },
          retryLimit: 0,
          expireInSeconds: 300,
        });
        await writer.query("COMMIT");
      } finally {
        writer.release();
      }
      expect(runnerJobId).toBeTruthy();

      const countRow = async (withinTx: Pool | PoolClient): Promise<number> => {
        const result = await withinTx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${JOBS_PGBOSS_SCHEMA}.job WHERE id::text = $1`,
          [runnerJobId],
        );
        return result.rows[0]?.n ?? -1;
      };
      expect(await countRow(legPool)).toBe(1);

      const client = await legPool.connect();
      try {
        await client.query("BEGIN");
        await runner.deleter.delete(client, [runnerJobId!]);
        expect(await countRow(client)).toBe(0); // gone inside the transaction
        await client.query("ROLLBACK");
        expect(await countRow(legPool)).toBe(1); // the rollback brought it back

        await client.query("BEGIN");
        await runner.deleter.delete(client, [runnerJobId!]);
        await client.query("COMMIT");
        expect(await countRow(legPool)).toBe(0); // gone for good
      } finally {
        client.release();
      }
    } finally {
      await legPool.end();
    }
  }, 90_000);
});

describe("the runner's worker registration", () => {
  test("a registration that fails is a failed start — the instance is discarded and a later attempt succeeds", async () => {
    await applyRolesProvisioning(SCRATCH_DB);
    await migrateJobsStorage(urlFor(SCRATCH_DB, "helix_jobs_migrate"));
    let registrations = 0;
    const seenInstances = new Set<object>();
    const failing = new JobsRunner({
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      retryInitialMs: 25,
      retryMaxMs: 100,
      registerWorker: async (boss) => {
        registrations += 1;
        seenInstances.add(boss);
        if (registrations < 3) throw new Error("the worker registration failed");
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    failing.start();
    try {
      // The first two attempts fail as starts (their half-started
      // instances are discarded); the third registers and the runner
      // reports its worker.
      const by = Date.now() + 30_000;
      while (Date.now() < by && !failing.snapshot.workerRegistered) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(failing.snapshot).toEqual({ started: true, workerRegistered: true });
      expect(registrations).toBe(3);
      // Every retried attempt registered on a FRESH instance — a
      // half-started one is never re-registered onto.
      expect(seenInstances.size).toBe(registrations);
    } finally {
      await failing.stop();
    }
    expect(failing.snapshot).toEqual({ started: false, workerRegistered: false });
  }, 60_000);

  test("a runner that converged on a retried instance still contains the instance's 'error' events — the containment rides every attempt's instance, not only the first", async () => {
    await applyRolesProvisioning(SCRATCH_DB);
    await migrateJobsStorage(urlFor(SCRATCH_DB, "helix_jobs_migrate"));
    let registrations = 0;
    let serving: PgBoss | undefined;
    const retried = new JobsRunner({
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      retryInitialMs: 25,
      retryMaxMs: 100,
      registerWorker: async (boss) => {
        registrations += 1;
        // The first attempt fails as a start; the loop converges on a fresh
        // instance — the one this test then probes.
        if (registrations === 1) throw new Error("the worker registration failed");
        serving = boss;
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    retried.start();
    try {
      const by = Date.now() + 30_000;
      while (Date.now() < by && !retried.snapshot.workerRegistered) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(retried.snapshot.workerRegistered).toBe(true);
      expect(registrations).toBeGreaterThanOrEqual(2);
      // pg-boss emits the errors its own supervision absorbs (a failed
      // maintenance pass, a dropped pool client) on the instance's event
      // emitter; an "error" event with no listener throws out of the
      // emitter and kills the process — the crash the runner's own
      // containment exists to prevent. The serving instance must absorb it:
      // contained means logged, never thrown.
      expect(() =>
        serving?.emit("error", new Error("a supervision error the runner must absorb")),
      ).not.toThrow();
    } finally {
      await retried.stop();
    }
  }, 60_000);

  test("the containment reports what it absorbs — an instance's 'error' event is logged with its cause, at warn", async () => {
    await applyRolesProvisioning(SCRATCH_DB);
    await migrateJobsStorage(urlFor(SCRATCH_DB, "helix_jobs_migrate"));
    const warns: Array<{ fields: Record<string, unknown>; msg: string }> = [];
    let serving: PgBoss | undefined;
    const reporting = new JobsRunner({
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      registerWorker: async (boss) => {
        serving = boss;
      },
      log: {
        info: () => {},
        warn: (fields, msg) => warns.push({ fields, msg }),
        error: () => {},
      },
    });
    reporting.start();
    try {
      const by = Date.now() + 30_000;
      while (Date.now() < by && !reporting.snapshot.workerRegistered) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(reporting.snapshot.workerRegistered).toBe(true);
      // The absorbed emission is not silent: the operator's evidence for the
      // supervision failures nothing else reports is this event, with the
      // error itself attached — a containment that swallowed without
      // reporting would pass the leg above while hiding every instance
      // error it absorbed. Warn, not error: the runner survived the
      // emission, and the probes and operations carry the fatal cases.
      const cause = new Error("a supervision error worth an operator's attention");
      serving?.emit("error", cause);
      const instanceError = warns.find((w) => w.fields["event"] === "jobs.runner.instance_error");
      expect(instanceError).toBeDefined();
      expect(instanceError?.fields["err"]).toBe(cause);
      expect(instanceError?.msg).toMatch(/the runner emitted an error/);
    } finally {
      await reporting.stop();
    }
  }, 60_000);

  test("a stop landing during a registration wait is waited out — the snapshot never reads healthy for a stopped runner", async () => {
    await applyRolesProvisioning(SCRATCH_DB);
    await migrateJobsStorage(urlFor(SCRATCH_DB, "helix_jobs_migrate"));
    let hookEnteredResolve: () => void = () => {};
    const hookEntered = new Promise<void>((resolve) => {
      hookEnteredResolve = resolve;
    });
    let releaseRegistration: () => void = () => {};
    const registrationReleased = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    const stopping = new JobsRunner({
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      registerWorker: async () => {
        // The attempt is inside the hook: the store verified, the instance is
        // live, and the start's outcome is still pending on this gate.
        hookEnteredResolve();
        await registrationReleased;
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    stopping.start();
    await hookEntered;
    // The stop lands while the registration is still pending. The in-flight
    // attempt is awaited before the stop's own teardown: the registration's
    // success below must never outlive the stop and leave the snapshot
    // claiming a healthy worker on a stopped runner — a state no later
    // attempt would correct, since the loop is over.
    const stopped = stopping.stop();
    releaseRegistration();
    await stopped;
    expect(stopping.snapshot).toEqual({ started: false, workerRegistered: false });
  }, 60_000);

  test("a discarded instance whose own stop fails is survived and reported — the teardown never takes the loop down", async () => {
    await applyRolesProvisioning(SCRATCH_DB);
    await migrateJobsStorage(urlFor(SCRATCH_DB, "helix_jobs_migrate"));
    const warns: Array<{ fields: Record<string, unknown>; msg: string }> = [];
    let registrations = 0;
    const surviving = new JobsRunner({
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      retryInitialMs: 25,
      retryMaxMs: 100,
      registerWorker: async (boss) => {
        registrations += 1;
        if (registrations === 1) {
          // The first attempt's registration fails as a start, and the
          // discard's own stop then rejects — forced at the boundary (the
          // instance's stop method), the same technique the execution suite
          // uses for a lost settle answer. A discard-stop failure the loop
          // did not absorb would escape as an unhandled rejection and take
          // the process down.
          vi.spyOn(boss, "stop").mockRejectedValueOnce(new Error("the stop itself failed"));
          throw new Error("the worker registration failed");
        }
      },
      log: {
        info: () => {},
        warn: (fields, msg) => warns.push({ fields, msg }),
        error: () => {},
      },
    });
    surviving.start();
    try {
      const by = Date.now() + 30_000;
      while (Date.now() < by && !surviving.snapshot.workerRegistered) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // The loop survived the failed discard and converged on a fresh
      // instance: the runner's contract is that start() never throws and
      // the loop owns every failure, including the teardown's.
      expect(surviving.snapshot).toEqual({ started: true, workerRegistered: true });
      expect(registrations).toBe(2);
      const discardWarn = warns.find(
        (w) => w.fields["event"] === "jobs.runner.discard_stop_failed",
      );
      expect(discardWarn).toBeDefined();
      expect(discardWarn?.msg).toMatch(/discarded instance's stop failed/);
    } finally {
      await surviving.stop();
    }
  }, 60_000);

  test("the runner's own pool carries the statement ceiling — a drive against a locked row answers at the injected bound, never hangs", async () => {
    // The runtime instance's `options` string (`-c statement_timeout=…`,
    // runner.ts's buildBoss) is what bounds every statement its pool runs —
    // the cancellation drives, the worker's settles and the sweeper's reads.
    // The platform-pool pin (`pool.test.ts`) covers `createJobsPool`'s
    // pools; THIS pool is pg-boss's, and the leg makes its ceiling
    // observable through the real drive: a runner row locked by a stalled
    // leg-side transaction (the production state a parked transaction
    // holds), the injected bound, the honest `unavailable` answer carrying
    // the timeout's reason at the bound, and the drive succeeding once the
    // lock releases. A regression that drops the options string leaves the
    // drive hanging past the leg's own timeout — this leg goes red there.
    await applyRolesProvisioning(SCRATCH_DB);
    await migrateJobsStorage(urlFor(SCRATCH_DB, "helix_jobs_migrate"));
    const BOUND = 1_500;
    const bounded = new JobsRunner({
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: BOUND,
      registerWorker: async () => {},
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    bounded.start();
    let pool: Pool | null = null;
    let holder: Pool | null = null;
    try {
      await waitFor("the bounded runner to start", 30_000, () => bounded.snapshot.started);

      // One runner row, enqueued through the borrowed-connection adapter —
      // the row the drive below targets.
      pool = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
      const client = await pool.connect();
      let runnerJobId: string;
      try {
        await client.query("BEGIN");
        runnerJobId = await bounded.enqueuer.enqueue(client, {
          type: "jobs:fetch",
          appId: randomUUID(),
          env: "prod",
          input: { url: "https://example.com/data.json" },
          retryLimit: 0,
          expireInSeconds: 300,
        });
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      expect(runnerJobId).toBeTruthy();

      holder = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
      const lock = await holder.connect();
      try {
        await lock.query("BEGIN");
        await lock.query(
          `SELECT id FROM ${JOBS_PGBOSS_SCHEMA}.job WHERE id::text = $1 FOR UPDATE`,
          [runnerJobId],
        );

        const startedAt = Date.now();
        const verdict = await bounded.cancelJob(runnerJobId);
        const elapsed = Date.now() - startedAt;
        // The honest verdict, at the ceiling — never a hang: past the
        // bound (plus scheduling margin) the leg's own timeout is the
        // failure the pin exists to catch.
        if (verdict.verdict !== "unavailable") {
          throw new Error(`expected unavailable, got: ${verdict.verdict}`);
        }
        expect(verdict.reason).toMatch(/statement timeout/i);
        expect(elapsed).toBeLessThan(15_000);

        await lock.query("ROLLBACK");
      } finally {
        lock.release();
      }

      // The pool kept serving: released from the lock, the drive succeeds.
      await expect(bounded.cancelJob(runnerJobId)).resolves.toEqual({
        verdict: "cancelled",
      });
    } finally {
      await bounded.stop();
      await pool?.end();
      await holder?.end();
    }
  }, 60_000);
});

describe("a start whose own reporting threw", () => {
  test("a start that succeeded is not failed by its own log line — the runner keeps serving", async () => {
    await applyRolesProvisioning(SCRATCH_DB);
    await migrateJobsStorage(urlFor(SCRATCH_DB, "helix_jobs_migrate"));
    let startedLines = 0;
    const serving = new JobsRunner({
      databaseUrl: RUNTIME_DSN,
      statementTimeoutMs: 10_000,
      retryInitialMs: 25,
      retryMaxMs: 100,
      registerWorker: async () => {},
      log: {
        info: (fields) => {
          if ((fields as { event?: string }).event === "jobs.runner.started") {
            startedLines += 1;
            throw new Error("the reporting sink is down");
          }
        },
        warn: () => {},
        error: () => {},
      },
    });
    serving.start();
    try {
      // The start attempt reached its own success report (the started line)
      // and that report threw. The store verified and the worker registered —
      // a log line must not fail a start that succeeded, and the attempt's
      // rejection contract ("the loop's scheduling and the release continue")
      // must leave the runner serving, not bricked with `started` reading
      // true over no instance and no retry.
      await waitFor("the started line to report", 30_000, () => startedLines > 0);
      const by = Date.now() + 3_000;
      while (Date.now() < by && !(serving.snapshot.started && serving.snapshot.workerRegistered)) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(serving.snapshot).toEqual({ started: true, workerRegistered: true });
    } finally {
      await serving.stop();
    }
  }, 60_000);
});
