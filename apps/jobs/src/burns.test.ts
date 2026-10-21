import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { startRecordingTelemetry } from "@azx-pbc/telemetry/testing";
import {
  JOBS_INSTRUCTION_BURN_RETENTION_SECONDS,
  JOBS_INSTRUCTION_CLOCK_TOLERANCE_SECONDS,
  JOBS_INSTRUCTION_MAX_LIFETIME_SECONDS,
} from "@azx-pbc/shared/jobsSigning";

import { JobsInstructionBurns } from "./burns.js";
import { migrateJobsStorage } from "./migrate.js";
import { JOBS_INSTRUCTION_BURNS_QUALIFIED, JOBS_RUNTIME_ROLE } from "./policy.js";
import { applyRolesProvisioning } from "../../portal/src/test/provisionDatabases.js";

/**
 * The durable burn store against the real store, through the real role split:
 * the freshness test is the insert (concurrent presentations race a unique
 * constraint and exactly one proceeds), the refusal survives a receiver
 * restart, retention is the signed validity floor with no weaker knob, and
 * the sweep removes what has expired in bounded batches without ever throwing.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

const SCRATCH_DB = `helix_jobs_burns_${randomUUID().replaceAll("-", "")}`;

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

/** The service's logger surface, as the burn store consumes it. */
const LOG = { warn: () => {} };

/** A fresh store instance on the shared scratch database — a "restart" when called again. */
function newBurns(nowMs: () => number = Date.now, sweepIntervalMs = 30_000): JobsInstructionBurns {
  return new JobsInstructionBurns({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    nowMs,
    sweepIntervalMs,
    log: LOG,
  });
}

async function rowCount(dsn: string, jtiFilter: string): Promise<number> {
  const pool = new Pool({ connectionString: dsn, max: 1 });
  try {
    const result = await pool.query(
      `SELECT count(*)::int AS n FROM ${JOBS_INSTRUCTION_BURNS_QUALIFIED} WHERE jti LIKE $1`,
      [jtiFilter],
    );
    return result.rows[0]?.n ?? -1;
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

describe("the durable burn store", () => {
  test("the burn retention floor covers the signed validity/tolerance interval", () => {
    // A token burned at its first presentation can still verify — against a
    // replica that has not seen the burn, or after a restart — for at most
    // tolerance + max lifetime + tolerance after that burn. Retention below
    // that accepts replays, so the floor the store runs at must always cover
    // the interval the signing constants define; tuning the lifetime without
    // retuning retention must go red here, not silently accept replays.
    const signedIntervalSeconds =
      JOBS_INSTRUCTION_CLOCK_TOLERANCE_SECONDS +
      JOBS_INSTRUCTION_MAX_LIFETIME_SECONDS +
      JOBS_INSTRUCTION_CLOCK_TOLERANCE_SECONDS;
    expect(JOBS_INSTRUCTION_BURN_RETENTION_SECONDS).toBeGreaterThanOrEqual(signedIntervalSeconds);
  });

  test("a fresh nonce proceeds; the same nonce is a replay; another scope's same jti is independent", async () => {
    const burns = newBurns();
    burns.start();
    try {
      await expect(burns.burn("edgeToJobs", "jti-a")).resolves.toEqual({ verdict: "first-use" });
      await expect(burns.burn("edgeToJobs", "jti-a")).resolves.toEqual({ verdict: "replay" });
      // The two receiving directions are separate nonce spaces: the edge's
      // minter and the portal's can never collide on a jti.
      await expect(burns.burn("portalToJobs", "jti-a")).resolves.toEqual({ verdict: "first-use" });
    } finally {
      await burns.stop();
    }
  });

  test("concurrent presentations of one nonce race the constraint and exactly one proceeds", async () => {
    const burns = newBurns();
    burns.start();
    try {
      const attempts = await Promise.all(
        Array.from({ length: 5 }, () => burns.burn("edgeToJobs", "jti-race")),
      );
      expect(attempts.filter((a) => a.verdict === "first-use")).toHaveLength(1);
      expect(attempts.filter((a) => a.verdict === "replay")).toHaveLength(4);
    } finally {
      await burns.stop();
    }
  });

  test("a burned nonce survives a receiver restart", async () => {
    const first = newBurns();
    first.start();
    await expect(first.burn("edgeToJobs", "jti-restart")).resolves.toEqual({
      verdict: "first-use",
    });
    await first.stop();

    // A new instance over the same database — what a restarted replica is.
    const second = newBurns();
    second.start();
    try {
      await expect(second.burn("edgeToJobs", "jti-restart")).resolves.toEqual({
        verdict: "replay",
      });
    } finally {
      await second.stop();
    }
  });

  test(
    "the sweep removes what has expired, and only that, in bounded batches",
    { timeout: 60_000 },
    async () => {
      // Its own scratch store, so the batch arithmetic below is exact.
      const sweepDb = `helix_jobs_burns_sweep_${randomUUID().replaceAll("-", "")}`;
      await applyRolesProvisioning(sweepDb);
      await migrateJobsStorage(urlFor(sweepDb, "helix_jobs_migrate"));
      const dsn = urlFor(sweepDb, JOBS_RUNTIME_ROLE);

      let now = 1_800_000_000_000;
      const warnings: Array<Record<string, unknown>> = [];
      const burns = new JobsInstructionBurns({
        databaseUrl: dsn,
        statementTimeoutMs: 10_000,
        nowMs: () => now,
        sweepIntervalMs: 10,
        sweepBatch: 10,
        log: { warn: (obj) => warnings.push(obj) },
      });
      burns.start();
      try {
        // Fifteen burns at the base instant; their retention ends 60 s later.
        for (let i = 0; i < 15; i++) {
          await burns.burn("edgeToJobs", `sweep-stale-${i}`);
        }
        // The survivor is burned later, so its retention outlasts the others'.
        now += 55_000;
        await burns.burn("edgeToJobs", "sweep-keep");
        now += 6_000; // past the stale rows' retention, inside the survivor's

        await new Promise((r) => setTimeout(r, 100));
        // Only the survivor remains: everything expired was swept, across as
        // many passes as it took.
        expect(await rowCount(dsn, "sweep-%")).toBe(1);
        // And no pass removed more than the batch: the backlog warn fires for
        // each pass that hit the cap, which only a capped pass can.
        expect(
          warnings.some((w) => w.event === "jobs.burn.sweep_backlog"),
          "no pass reported hitting the batch cap",
        ).toBe(true);
      } finally {
        await burns.stop();
        const pool = new Pool({ connectionString: urlFor("postgres"), max: 1 });
        await pool.query(`DROP DATABASE IF EXISTS "${sweepDb}" WITH (FORCE)`);
        await pool.end();
      }
    },
  );

  test("a stopped store denies without a verdict; stop is safe twice and terminal", async () => {
    const burns = newBurns();
    burns.start();
    await burns.stop();
    await expect(burns.burn("edgeToJobs", "after-stop")).resolves.toEqual({
      verdict: "store-unavailable",
      error: expect.any(Error),
    });
    await expect(burns.stop()).resolves.toBeUndefined(); // safe twice
  });

  test(
    "a store that will not answer denies closed, and the sweep counts its failed passes and keeps the cadence",
    { timeout: 30_000 },
    async () => {
      // A dead endpoint is the store-down case the fail-closed rule exists
      // for: a burn the store cannot claim is denied without a verdict (the
      // caller sees the retryable 503), and the sweep's failure arm — counted,
      // warned, cadence preserved — is what keeps cleanup coming back when
      // the store does.
      const provisional = createServer();
      await new Promise<void>((resolve) => provisional.listen(0, "127.0.0.1", resolve));
      const deadPort = (provisional.address() as { port: number }).port;
      await new Promise<void>((resolve) => provisional.close(() => resolve()));

      const recording = startRecordingTelemetry();
      try {
        const warnings: Array<Record<string, unknown>> = [];
        const burns = new JobsInstructionBurns({
          databaseUrl: `postgresql://helix:helix@127.0.0.1:${deadPort}/none`,
          statementTimeoutMs: 250,
          sweepIntervalMs: 60,
          log: { warn: (obj) => warnings.push(obj) },
        });
        burns.start();
        try {
          await expect(burns.burn("edgeToJobs", "store-down")).resolves.toMatchObject({
            verdict: "store-unavailable",
          });

          await new Promise((r) => setTimeout(r, 1_400));
          const failed = (await recording.metrics()).filter(
            (m) =>
              m.name === "helix.jobs.burn.sweeps" && m.attributes["helix.outcome"] === "failed",
          );
          expect(failed.reduce((sum, m) => sum + m.value, 0)).toBeGreaterThanOrEqual(2);
          const failures = warnings.filter((w) => w.event === "jobs.burn.sweep_failed");
          expect(failures.length).toBeGreaterThanOrEqual(2);
        } finally {
          await burns.stop();
        }
      } finally {
        await recording.restore();
      }
    },
  );

  test(
    "a pooled burn client dying while idle is a logged warning, not a process death — and the store still answers",
    { timeout: 60_000 },
    async () => {
      // A transient connection death (a failover, a firewall reap) must not
      // kill the service: pg-pool strips a checked-out client's own error
      // listener, so an IDLE client's death is an unhandled pool event unless
      // the store's listener absorbs it — the same scenario the storage
      // supervisor's pool carries. Terminate idle backends behind the pool's
      // back until the warning lands, then prove the store still answers.
      const warnings: Array<{ fields: Record<string, unknown>; msg: string }> = [];
      const burns = new JobsInstructionBurns({
        databaseUrl: RUNTIME_DSN,
        statementTimeoutMs: 10_000,
        log: { warn: (fields, msg) => warnings.push({ fields, msg }) },
      });
      burns.start();
      try {
        // One burn leaves a pooled, now-idle client to terminate.
        await expect(burns.burn("edgeToJobs", "pool-error-seed")).resolves.toEqual({
          verdict: "first-use",
        });

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
            if (warnings.some((w) => w.fields.event === "jobs.burn.pool_error")) break;
          }
        } finally {
          await control.end();
        }
        expect(
          warnings.some((w) => w.fields.event === "jobs.burn.pool_error"),
          "no pool_error warning landed — the listener is gone or the death went unhandled",
        ).toBe(true);

        // The service survived the death: a fresh burn gets a rebuilt client
        // and answers normally.
        await expect(burns.burn("edgeToJobs", "after-pool-error")).resolves.toEqual({
          verdict: "first-use",
        });
      } finally {
        await burns.stop();
      }
    },
  );

  test("the sweep loop keeps its cadence and counts every pass", { timeout: 30_000 }, async () => {
    const recording = startRecordingTelemetry();
    try {
      const burns = newBurns(Date.now, 10);
      burns.start();
      await new Promise((r) => setTimeout(r, 60));
      await burns.stop();
      const sweeps = (await recording.metrics()).filter(
        (m) => m.name === "helix.jobs.burn.sweeps" && m.attributes["helix.outcome"] === "ok",
      );
      // The immediate pass plus the interval's: the loop kept running.
      expect(sweeps.reduce((sum, m) => sum + m.value, 0)).toBeGreaterThanOrEqual(2);
    } finally {
      await recording.restore();
    }
  });
});

/**
 * A sweep can reject only through its own reporting — a log sink that threw
 * (its store failure is a verdict, never a throw). The `sweep_rejected`
 * contract: the rejection is reported sink-guarded and the release chain
 * survives it — stop() must resolve over a rejected in-flight sweep, or the
 * shutdown that stops this store never releases what it acquired.
 */
describe("a sweep whose own reporting threw", () => {
  test("stop releases through a rejected in-flight sweep — the release chain survives", async () => {
    const events: string[] = [];
    const throws = (fields: Record<string, unknown>): void => {
      events.push(String(fields.event));
      throw new Error("the reporting sink is down");
    };
    // A store that does not exist: the sweep's own failure path runs (the
    // catch reports `sweep_failed`), and the report's sink throw is what
    // rejects the pass.
    const burns = new JobsInstructionBurns({
      databaseUrl: urlFor(`${SCRATCH_DB}_no_such`, JOBS_RUNTIME_ROLE),
      statementTimeoutMs: 2_000,
      sweepIntervalMs: 30_000,
      log: { warn: (fields) => throws(fields) },
    });
    burns.start();
    try {
      const failedBy = Date.now() + 10_000;
      while (Date.now() < failedBy && !events.includes("jobs.burn.sweep_failed")) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(events.some((e) => e === "jobs.burn.sweep_failed")).toBe(true);

      await expect(burns.stop()).resolves.toBeUndefined();
      // The release's own report of the rejected sweep rode the same broken
      // sink — the event names the occurrence; the release continued.
      expect(events.some((e) => e === "jobs.burn.sweep_rejected")).toBe(true);
    } finally {
      await burns.stop().catch(() => {});
    }
  });
});

describe("a timer-driven sweep whose reporting threw", () => {
  test("is not an unhandled rejection, and the cadence continues", async () => {
    // Every sweep's launch handles its own rejection: the timer callback
    // reschedules on either settlement half, so a sweep whose failure
    // report threw (this sink) never becomes an unhandled rejection in the
    // process the burn store serves, and the next sweep still runs. A
    // launch that dropped the guard turns this red.
    const events: string[] = [];
    const captured: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      captured.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const burns = new JobsInstructionBurns({
      databaseUrl: urlFor(`${SCRATCH_DB}_no_such`, JOBS_RUNTIME_ROLE),
      statementTimeoutMs: 2_000,
      sweepIntervalMs: 50,
      log: {
        warn: (fields) => {
          events.push(String(fields.event));
          throw new Error("the reporting sink is down");
        },
      },
    });
    try {
      burns.start();
      const sweptBy = Date.now() + 3_000;
      while (
        Date.now() < sweptBy &&
        events.filter((e) => e === "jobs.burn.sweep_failed").length < 3
      ) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(events.filter((e) => e === "jobs.burn.sweep_failed").length).toBeGreaterThanOrEqual(3);
      expect(captured).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      await burns.stop().catch(() => {});
    }
  });
});

describe("a failed sweep's accounting survives its own reporting", () => {
  test("the counter counts the failed sweep when the sink that reports it is down", async () => {
    // The sweep's failure accounting (`helix.jobs.burn.sweeps` by outcome)
    // is the operator's rate signal for a store that stopped answering —
    // the same standard the recovery sweeper's accounting legs pin: account
    // BEFORE reporting, so a reporting sink that threw cannot skip the
    // count. A sweep that fails (this store does not exist) with a sink
    // that throws on every report must still be counted failed, and the
    // cadence must continue. A reordering that reports before accounting
    // turns this red: the counter skips every sweep whose report threw.
    const recording = startRecordingTelemetry();
    try {
      const burns = new JobsInstructionBurns({
        databaseUrl: urlFor(`${SCRATCH_DB}_no_such`, JOBS_RUNTIME_ROLE),
        statementTimeoutMs: 2_000,
        sweepIntervalMs: 50,
        log: {
          warn: () => {
            throw new Error("the reporting sink is down");
          },
        },
      });
      burns.start();
      const sweptBy = Date.now() + 3_000;
      while (Date.now() < sweptBy) {
        const sweeps = (await recording.metrics()).filter(
          (m) => m.name === "helix.jobs.burn.sweeps" && m.attributes["helix.outcome"] === "failed",
        );
        if (sweeps.reduce((sum, m) => sum + m.value, 0) >= 3) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      await burns.stop().catch(() => {});

      const sweeps = (await recording.metrics()).filter(
        (m) => m.name === "helix.jobs.burn.sweeps" && m.attributes["helix.outcome"] === "failed",
      );
      // The accounting survived every report's throw: three failed sweeps,
      // counted.
      expect(sweeps.reduce((sum, m) => sum + m.value, 0)).toBeGreaterThanOrEqual(3);
      // Bounded, non-personal dimensions: the outcome, nothing else.
      for (const point of sweeps) {
        expect(Object.keys(point.attributes)).toEqual(["helix.outcome"]);
      }
    } finally {
      await recording.restore();
    }
  });

  test(
    "a successful sweep's accounting is exactly once — a full batch whose backlog report throws is not also counted failed",
    { timeout: 30_000 },
    async () => {
      // The sweep's success accounting (`helix.jobs.burn.sweeps`, outcome `ok`)
      // is exactly once per sweep: the backlog report that follows the count is
      // cosmetic evidence, so a reporting sink that throws on it must not fail
      // the already-counted sweep into the catch arm's `failed` count — one
      // sweep counted twice, ok and failed, would put a failure that never
      // happened into the store-down rate signal during exactly the sink-broken
      // period that signal exists for.
      const sweepDb = `helix_jobs_burns_once_${randomUUID().replaceAll("-", "")}`;
      await applyRolesProvisioning(sweepDb);
      await migrateJobsStorage(urlFor(sweepDb, "helix_jobs_migrate"));
      const dsn = urlFor(sweepDb, JOBS_RUNTIME_ROLE);

      let now = 1_800_000_000_000;
      const burns = new JobsInstructionBurns({
        databaseUrl: dsn,
        statementTimeoutMs: 10_000,
        nowMs: () => now,
        sweepIntervalMs: 50,
        sweepBatch: 2,
        log: {
          warn: () => {
            throw new Error("the reporting sink is down");
          },
        },
      });
      const recording = startRecordingTelemetry();
      try {
        burns.start();
        // Two burns at the base instant — exactly one full batch once their
        // retention ends, so the removal pass hits the cap and reports the
        // backlog through the throwing sink.
        for (let i = 0; i < 2; i++) {
          await burns.burn("edgeToJobs", `exactly-once-${i}`);
        }
        now += JOBS_INSTRUCTION_BURN_RETENTION_SECONDS * 1_000 + 1_000;

        // The removal pass ran: the expired rows are gone from the store.
        const removedBy = Date.now() + 10_000;
        while (Date.now() < removedBy && (await rowCount(dsn, "exactly-once-%")) > 0) {
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(await rowCount(dsn, "exactly-once-%")).toBe(0);
        // The cadence continued past the throwing report: further clean passes.
        await new Promise((r) => setTimeout(r, 200));
        await burns.stop().catch(() => {});

        const metrics = await recording.metrics();
        const okSweeps = metrics.filter(
          (m) => m.name === "helix.jobs.burn.sweeps" && m.attributes["helix.outcome"] === "ok",
        );
        // The removal pass was accounted, and the cadence kept accounting after
        // its report threw: at least the removal pass and one later clean pass.
        expect(okSweeps.reduce((sum, m) => sum + m.value, 0)).toBeGreaterThanOrEqual(2);
        // No sweep failed — the store answered every query; the only failure was
        // the reporting sink on a cosmetic line, which must not reach the counter.
        const failedSweeps = metrics.filter(
          (m) => m.name === "helix.jobs.burn.sweeps" && m.attributes["helix.outcome"] === "failed",
        );
        expect(failedSweeps.reduce((sum, m) => sum + m.value, 0)).toBe(0);
      } finally {
        await recording.restore();
        const pool = new Pool({ connectionString: urlFor("postgres"), max: 1 });
        await pool.query(`DROP DATABASE IF EXISTS "${sweepDb}" WITH (FORCE)`);
        await pool.end();
      }
    },
  );
});
