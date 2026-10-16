import { randomUUID } from "node:crypto";
import type { PgBoss } from "pg-boss";
import { Pool } from "pg";
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
      log: { info: () => {}, warn: () => {} },
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
      log: { info: () => {}, warn: () => {} },
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
      log: { info: () => {}, warn: () => {} },
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
});
