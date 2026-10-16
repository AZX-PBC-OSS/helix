import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

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
