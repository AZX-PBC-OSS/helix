import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { execSync } from "node:child_process";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { startRecordingTelemetry } from "@azx-pbc/telemetry/testing";
import {
  JOBS_INSTRUCTION_BURN_RETENTION_SECONDS,
  JOBS_INSTRUCTION_CLOCK_TOLERANCE_SECONDS,
  JOBS_INSTRUCTION_MAX_LIFETIME_SECONDS,
} from "@azx-pbc/shared/jobsSigning";

import { PgJobsCallbackBurnStore } from "./burns.js";
import { TEST_DATABASE_URL } from "../test/seed.js";

/**
 * The edge's jobs-callback burn store against the REAL platform database —
 * the real migration's table, grants and env-literal RLS policies, through
 * the real runtime roles (`helix_edge` for the prod tier, `helix_dev` for the
 * dev tier). The checklist is the file's structure:
 *
 * - a nonce is consumed once and stays consumed after a restart and across
 *   concurrent replicas (the freshness test IS the insert);
 * - the two tiers are separate nonce spaces, and the DATABASE refuses the
 *   cross-tier burn, read, or delete — a dev role cannot clear a prod nonce
 * to enable a replay, and vice versa (the env-literal RLS the migration
 *   ships);
 * - a mispaired store (a tier its role's policy does not pin) fails closed;
 * - retention is the signed validity floor with no weaker knob, and the sweep
 *   removes what has expired — only that, in bounded batches — without ever
 *   throwing.
 *
 * **Its own database, not the shared `helix_test`** (the
 * `retire.integration.test.ts` pattern): the sweep is a cross-cutting
 * consumer, and the timing tests age and remove rows. Clones the migrated
 * schema into a dedicated database (the globalSetup's migrate-deploy step,
 * pointed at a scratch database) and drops it after. Skips fail-soft — like
 * the other integration suites' role-provisioned skip — only when the cluster
 * or the runtime roles aren't reachable at all; a migration that cannot apply
 * fails the suite red.
 */

const EDGE_DB = `helix_edge_jobs_burns_${randomUUID().replaceAll("-", "")}`;
const SWEEP_DB = `helix_edge_jobs_sweep_${randomUUID().replaceAll("-", "")}`;
const TIERS_DB = `helix_edge_jobs_tiers_${randomUUID().replaceAll("-", "")}`;

function urlFor(database: string, role?: string): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  if (role) {
    url.username = role;
    url.password = role;
  }
  return url.toString();
}

const EDGE_DSN = urlFor(EDGE_DB, "helix_edge");
const DEV_DSN = urlFor(EDGE_DB, "helix_dev");

/** The service's logger surface, as the burn store consumes it. */
const LOG = { warn: () => {} };

function newBurns(options: {
  databaseUrl: string;
  env: "prod" | "dev";
  nowMs?: () => number;
  sweepIntervalMs?: number;
  sweepBatch?: number;
  log?: { warn(obj: Record<string, unknown>, msg: string): void };
}): PgJobsCallbackBurnStore {
  return new PgJobsCallbackBurnStore({
    databaseUrl: options.databaseUrl,
    env: options.env,
    statementTimeoutMs: 10_000,
    nowMs: options.nowMs,
    sweepIntervalMs: options.sweepIntervalMs,
    sweepBatch: options.sweepBatch,
    log: options.log ?? LOG,
  });
}

async function roleRows(dsn: string, jtiFilter: string): Promise<number> {
  const pool = new Pool({ connectionString: dsn, max: 1 });
  try {
    const result = await pool.query<{ n: number }>(
      // count over the table as the ROLE sees it — the RLS scope is part of
      // the answer, which is exactly what the isolation assertions read.
      `SELECT count(*)::int AS n FROM jobs_callback_jti WHERE jti LIKE $1`,
      [jtiFilter],
    );
    return result.rows[0]?.n ?? -1;
  } finally {
    await pool.end();
  }
}

let ok = false;

beforeAll(async () => {
  // Fail-soft ONLY when the cluster or the roles are not reachable at all
  // (CI without Postgres/db-init — the other integration suites' skip): the
  // scratch build and the migrate below run uncaught, so a migration that
  // cannot apply fails this suite red instead of hiding in a skip.
  try {
    const reachable = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    await reachable.query("SELECT 1");
    await reachable.end();
  } catch {
    return;
  }
  const adminUrl = urlFor("helix");
  for (const db of [EDGE_DB, SWEEP_DB, TIERS_DB]) {
    execSync(`psql "${adminUrl}" -c "DROP DATABASE IF EXISTS ${db} WITH (FORCE)"`, {
      stdio: "pipe",
    });
    execSync(`psql "${adminUrl}" -c "CREATE DATABASE ${db}"`, { stdio: "pipe" });
    execSync("pnpm --filter @azx-pbc/portal exec prisma migrate deploy", {
      stdio: "pipe",
      env: { ...process.env, DATABASE_URL: urlFor(db) },
    });
  }
  // The grants ride the migration's role-conditional blocks: without the
  // provisioned roles (CI without db-init) the runtime identities connect to
  // nothing — the same fail-soft skip the other integration suites take.
  const probe = new Pool({ connectionString: EDGE_DSN, max: 1 });
  try {
    await probe.query("SELECT 1");
    ok = true;
  } catch {
    ok = false;
  } finally {
    await probe.end();
  }
}, 120_000);

afterAll(async () => {
  if (!ok) return;
  const admin = new Pool({ connectionString: urlFor("helix"), max: 1 });
  try {
    for (const db of [EDGE_DB, SWEEP_DB, TIERS_DB]) {
      await admin.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
}, 30_000);

describe("the jobs-callback burn store (real roles, real migration)", () => {
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

  test("a fresh nonce proceeds; the same nonce is a replay", async () => {
    if (!ok) return;
    const burns = newBurns({ databaseUrl: EDGE_DSN, env: "prod" });
    burns.start();
    try {
      await expect(burns.burn("jti-a")).resolves.toEqual({ verdict: "first-use" });
      await expect(burns.burn("jti-a")).resolves.toEqual({ verdict: "replay" });
    } finally {
      await burns.stop();
    }
  });

  test("a burned nonce survives a receiver restart", async () => {
    if (!ok) return;
    const first = newBurns({ databaseUrl: EDGE_DSN, env: "prod" });
    first.start();
    await expect(first.burn("jti-restart")).resolves.toEqual({ verdict: "first-use" });
    await first.stop();

    // A new instance over the same database — what a restarted replica is.
    const second = newBurns({ databaseUrl: EDGE_DSN, env: "prod" });
    second.start();
    try {
      await expect(second.burn("jti-restart")).resolves.toEqual({ verdict: "replay" });
    } finally {
      await second.stop();
    }
  });

  test("concurrent presentations of one nonce race the constraint and exactly one proceeds", async () => {
    if (!ok) return;
    const burns = newBurns({ databaseUrl: EDGE_DSN, env: "prod" });
    burns.start();
    try {
      const attempts = await Promise.all(Array.from({ length: 5 }, () => burns.burn("jti-race")));
      expect(attempts.filter((a) => a.verdict === "first-use")).toHaveLength(1);
      expect(attempts.filter((a) => a.verdict === "replay")).toHaveLength(4);
    } finally {
      await burns.stop();
    }
  });

  test("the two tiers are separate nonce spaces", async () => {
    if (!ok) return;
    const edge = newBurns({ databaseUrl: EDGE_DSN, env: "prod" });
    const dev = newBurns({ databaseUrl: DEV_DSN, env: "dev" });
    edge.start();
    dev.start();
    try {
      // The same jti value in both tiers is two independent nonces: a jti is
      // a fresh UUID per mint, and the tiers are different receivers — the
      // prod edge and the dev gateway never share a replay verdict.
      await expect(edge.burn("jti-tiers")).resolves.toEqual({ verdict: "first-use" });
      await expect(dev.burn("jti-tiers")).resolves.toEqual({ verdict: "first-use" });
      await expect(edge.burn("jti-tiers")).resolves.toEqual({ verdict: "replay" });
      await expect(dev.burn("jti-tiers")).resolves.toEqual({ verdict: "replay" });
    } finally {
      await edge.stop();
      await dev.stop();
    }
  });

  test("the database refuses a cross-tier burn, read, or delete (the env-literal RLS)", async () => {
    if (!ok) return;
    const jti = `jti-iso-${randomUUID()}`;
    const edgePool = new Pool({ connectionString: EDGE_DSN, max: 1 });
    const devPool = new Pool({ connectionString: DEV_DSN, max: 1 });
    try {
      // Seed one row per tier, each under its own role.
      await expect(
        edgePool.query(
          `INSERT INTO jobs_callback_jti ("env", jti, "burnUntil")
               VALUES ('prod', $1, now() + interval '1 minute')`,
          [jti],
        ),
      ).resolves.toBeDefined();
      await expect(
        devPool.query(
          `INSERT INTO jobs_callback_jti ("env", jti, "burnUntil")
               VALUES ('dev', $1, now() + interval '1 minute')`,
          [jti],
        ),
      ).resolves.toBeDefined();

      // Reads are scoped: each role sees exactly its own tier's row.
      expect(await roleRows(EDGE_DSN, jti)).toBe(1);
      expect(await roleRows(DEV_DSN, jti)).toBe(1);

      // Writes are pinned by WITH CHECK: neither role can plant a nonce in
      // the other's tier.
      await expect(
        edgePool.query(
          `INSERT INTO jobs_callback_jti ("env", jti, "burnUntil")
               VALUES ('dev', $1, now() + interval '1 minute')`,
          [jti],
        ),
      ).rejects.toThrow(/row-level security/i);
      await expect(
        devPool.query(
          `INSERT INTO jobs_callback_jti ("env", jti, "burnUntil")
               VALUES ('prod', $1, now() + interval '1 minute')`,
          [jti],
        ),
      ).rejects.toThrow(/row-level security/i);

      // Deletes are pinned by USING: clearing the OTHER tier's nonce — the
      // replay-enabling move — removes nothing. The role's own row deletes.
      const edgeClear = await edgePool.query(
        `DELETE FROM jobs_callback_jti WHERE jti = $1 AND "env" = 'dev'`,
        [jti],
      );
      expect(edgeClear.rowCount).toBe(0);
      const devClear = await devPool.query(
        `DELETE FROM jobs_callback_jti WHERE jti = $1 AND "env" = 'prod'`,
        [jti],
      );
      expect(devClear.rowCount).toBe(0);

      // And no role can REWRITE a burn — UPDATE is absent from both roles'
      // grant set (a burn is never rewritten; rewriting `burnUntil` is the
      // other replay-enabling move). Pinned for both tiers: the grant-level
      // fact is one migration statement serving two roles.
      await expect(
        edgePool.query(
          `UPDATE jobs_callback_jti SET "burnUntil" = now() WHERE jti = $1 AND "env" = 'prod'`,
          [jti],
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        devPool.query(
          `UPDATE jobs_callback_jti SET "burnUntil" = now() WHERE jti = $1 AND "env" = 'dev'`,
          [jti],
        ),
      ).rejects.toThrow(/permission denied/i);

      // And each role still manages its own tier's row.
      await expect(
        edgePool.query(`DELETE FROM jobs_callback_jti WHERE jti = $1 AND "env" = 'prod'`, [jti]),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        devPool.query(`DELETE FROM jobs_callback_jti WHERE jti = $1 AND "env" = 'dev'`, [jti]),
      ).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await edgePool.end();
      await devPool.end();
    }
  });

  test("even the owner cannot mint an off-tier nonce — the env CHECK", async () => {
    if (!ok) return;
    // The env-literal policies partition the two runtime roles, but RLS does
    // not constrain the table's owner — the CHECK is what keeps an off-value
    // row (which no policy could ever see or sweep) out of the table at all.
    // The sibling partition's CHECK is pinned the same way in
    // role-split.integration.test.ts ("the partition label is a CHECK'd
    // vocabulary"); this is the burn table's own occurrence.
    const owner = new Pool({ connectionString: urlFor(EDGE_DB), max: 1 });
    try {
      await expect(
        owner.query(
          `INSERT INTO jobs_callback_jti ("env", jti, "burnUntil")
             VALUES ('staging', 'jti-off-tier', now() + interval '1 minute')`,
        ),
      ).rejects.toThrow(/violates check constraint/i);
    } finally {
      await owner.end();
    }
  });

  test("a store mispaired with its role denies closed, never proceeds unburned", async () => {
    if (!ok) return;
    // A tier the connecting role's policy does not pin: the WITH CHECK refusal
    // surfaces as store-unavailable — denied without a verdict, the same
    // fail-closed answer as a store that cannot answer at all.
    const mispairedDev = newBurns({ databaseUrl: EDGE_DSN, env: "dev" });
    mispairedDev.start();
    try {
      await expect(mispairedDev.burn("jti-mispaired")).resolves.toMatchObject({
        verdict: "store-unavailable",
        // The refusal carries its cause — the receiver's denial log names the
        // RLS refusal, not a bare verdict.
        error: expect.anything(),
      });
    } finally {
      await mispairedDev.stop();
    }
    const mispairedProd = newBurns({ databaseUrl: DEV_DSN, env: "prod" });
    mispairedProd.start();
    try {
      await expect(mispairedProd.burn("jti-mispaired")).resolves.toMatchObject({
        verdict: "store-unavailable",
        error: expect.anything(),
      });
    } finally {
      await mispairedProd.stop();
    }
  });

  test(
    "a negative ceiling denies closed and bounded — the other side of the connect-wait floor",
    { timeout: 15_000 },
    async () => {
      // The connect-wait floor's branch covers every non-positive ceiling, and
      // a negative one is reachable (`EDGE_STATEMENT_TIMEOUT_MS` reaches the
      // store as a bare Number()). `statement_timeout` rides pg's startup
      // packet verbatim, and Postgres rejects an out-of-range value there — so
      // every acquire fails and every burn answers store-unavailable with the
      // refusal attached: a loud, closed denial. Never a hang (the floor keeps
      // the wait at the default ceiling) and never an unbounded query.
      if (!ok) return;
      const burns = new PgJobsCallbackBurnStore({
        databaseUrl: EDGE_DSN,
        env: "prod",
        statementTimeoutMs: -1,
        log: LOG,
      });
      burns.start();
      try {
        const raced = await Promise.race([
          burns.burn("ceiling-negative"),
          new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 5_000)),
        ]);
        expect(raced, "a negative ceiling parked the callback — the wait is unbounded").not.toBe(
          "hung",
        );
        expect(raced).toMatchObject({
          verdict: "store-unavailable",
          error: expect.anything(),
        });
      } finally {
        await burns.stop();
      }
    },
  );

  test("a stopped store denies without a verdict; stop is safe twice and terminal", async () => {
    if (!ok) return;
    const burns = newBurns({ databaseUrl: EDGE_DSN, env: "prod" });
    burns.start();
    await burns.stop();
    await expect(burns.burn("after-stop")).resolves.toEqual({
      verdict: "store-unavailable",
      error: expect.any(Error),
    });
    await expect(burns.stop()).resolves.toBeUndefined(); // safe twice
    // Terminal, not paused: a start() after stop cannot resurrect the store —
    // the failed-boot exit and the shutdown path both rely on stop being the
    // last word, and a resurrected store would leak a pool past onClose.
    burns.start();
    await expect(burns.burn("after-restart-attempt")).resolves.toEqual({
      verdict: "store-unavailable",
      error: expect.any(Error),
    });
  });

  test(
    "stop() racing in-flight burns: every burn answers a verdict, none throws, stop resolves",
    { timeout: 30_000 },
    async () => {
      // SIGTERM lands while callbacks are burning: the onClose path stops the
      // store with burns checked out and acquires queued behind the ending
      // pool. The contract under that interleaving — burns holding a client
      // complete (first-use), queued acquires deny closed (store-unavailable),
      // no burn throws, none hangs, and stop() releases the pool. burn() never
      // throws by contract, so Promise.all here rejects on exactly that
      // regression, and the test times out on a hang.
      if (!ok) return;
      const burns = new PgJobsCallbackBurnStore({
        databaseUrl: EDGE_DSN,
        env: "prod",
        statementTimeoutMs: 500, // queued acquires deny fast, not at the 10s default
        log: LOG,
      });
      burns.start();
      const inFlight = Array.from({ length: 12 }, (_, i) => burns.burn(`jti-stop-race-${i}`));
      const stopped = burns.stop();
      const outcomes = await Promise.all(inFlight);
      await expect(stopped).resolves.toBeUndefined();
      for (const outcome of outcomes) {
        expect(["first-use", "replay", "store-unavailable"]).toContain(outcome.verdict);
      }
      // Burns that already held a client committed — shutdown did not silently
      // lose them; only the acquires queued behind the ending pool deny.
      expect(outcomes.some((o) => o.verdict === "first-use")).toBe(true);
    },
  );

  test("stop() releases the store's connections — the runtime role's backends are gone", async () => {
    if (!ok) return;
    // The release half of the stop contract: stop() ends the pool, so a
    // shut-down (or failed-boot) edge holds no platform-database connections.
    // The denial half is pinned above; this measures the release on the
    // SERVER side — the pool is the store's private resource, and
    // pg_stat_activity is the one observer that can see it without reaching
    // into it. A dropped pool.end() passes every denial test and still leaks
    // the sockets past onClose.
    const control = new Pool({ connectionString: urlFor("postgres"), max: 1 });
    const backends = async (): Promise<number> => {
      const r = await control.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = $1 AND usename = 'helix_edge' AND pid <> pg_backend_pid()`,
        [EDGE_DB],
      );
      return r.rows[0]?.n ?? -1;
    };
    const burns = newBurns({ databaseUrl: EDGE_DSN, env: "prod" });
    try {
      await expect(burns.burn("stop-release")).resolves.toEqual({ verdict: "first-use" });
      expect(await backends(), "the burn's connection was not acquired").toBeGreaterThanOrEqual(1);
      await burns.stop();
      // The window sits well under pg-pool's 10 s default idleTimeoutMillis —
      // otherwise a dropped pool.end() would pass on the idle timeout's own
      // cleanup. Only the immediate release explains a zero inside it.
      const releasedBy = Date.now() + 3_000;
      while (Date.now() < releasedBy && (await backends()) > 0) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(await backends(), "backends outlived stop() — the pool was not released").toBe(0);
    } finally {
      await burns.stop(); // every exit releases — safe twice
      await control.end();
    }
  });

  test(
    "a pooled burn client dying while idle is reported through the caller's hook, not a process death — and the store still answers",
    { timeout: 60_000 },
    async () => {
      // A transient connection death (a failover, a firewall reap) must not
      // kill the edge: the burn store's pool absorbs an IDLE client's death and
      // reports it through the caller's onClientError — the hook the server
      // composition wires to the `db.pool_client_error` warn — carrying the
      // pool label this store pins. The forwarding has history: edge stores
      // have silently dropped exactly this hook before (createEdgePool's
      // docblock), and the pool-level listener's own tests cannot see a store
      // that stops passing it. Terminate the idle backends behind the pool
      // until the report lands, then prove the store still answers.
      const seen: Array<{ phase: string; label: string }> = [];
      const burns = new PgJobsCallbackBurnStore({
        databaseUrl: EDGE_DSN,
        env: "prod",
        statementTimeoutMs: 10_000,
        onClientError: (_err, ctx) => seen.push(ctx),
        log: LOG,
      });
      try {
        // One burn leaves a pooled, now-idle client to terminate. (No start():
        // the pool exists from construction, so this exercises the pool alone.)
        await expect(burns.burn("pool-error-seed")).resolves.toEqual({ verdict: "first-use" });

        const control = new Pool({ connectionString: urlFor("postgres"), max: 1 });
        try {
          const reportedBy = Date.now() + 20_000;
          while (Date.now() < reportedBy && seen.length === 0) {
            const idle = await control.query<{ pid: number }>(
              `SELECT pid FROM pg_stat_activity
               WHERE datname = $1 AND usename = 'helix_edge'
                 AND state = 'idle' AND pid <> pg_backend_pid()`,
              [EDGE_DB],
            );
            for (const row of idle.rows) {
              await control.query(`SELECT pg_terminate_backend($1)`, [row.pid]);
            }
            await new Promise((r) => setTimeout(r, 300));
          }
        } finally {
          await control.end();
        }
        expect(
          seen,
          "no idle-client error reached the caller's hook — the forwarding is gone or the death went unhandled",
        ).toEqual([{ phase: "idle", label: "jobs-callback-jti" }]);

        // The service survived the death: a fresh burn gets a rebuilt client
        // and answers normally.
        await expect(burns.burn("after-pool-error")).resolves.toEqual({ verdict: "first-use" });
      } finally {
        await burns.stop();
      }
    },
  );

  test(
    "the sweep removes what has expired, and only that, in bounded batches",
    { timeout: 60_000 },
    async () => {
      const dsn = urlFor(SWEEP_DB, "helix_edge");

      let now = 1_800_000_000_000;
      const warnings: Array<Record<string, unknown>> = [];
      const burns = new PgJobsCallbackBurnStore({
        databaseUrl: dsn,
        env: "prod",
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
          await burns.burn(`sweep-stale-${i}`);
        }
        // The survivor is burned later, so its retention outlasts the others'.
        now += 55_000;
        await burns.burn("sweep-keep");
        now += 6_000; // past the stale rows' retention, inside the survivor's

        await new Promise((r) => setTimeout(r, 100));
        // Only the survivor remains: everything expired was swept, across as
        // many passes as it took.
        expect(await roleRows(dsn, "sweep-%")).toBe(1);
        // And no pass removed more than the batch: the backlog warn fires for
        // each pass that hit the cap, which only a capped pass can.
        expect(
          warnings.some((w) => w.event === "edge.jobs_burn.sweep_backlog"),
          "no pass reported hitting the batch cap",
        ).toBe(true);
      } finally {
        await burns.stop();
      }
    },
  );

  test(
    "the two tiers sweep independently — one tier's sweep never removes the other tier's expired nonce",
    { timeout: 30_000 },
    async () => {
      // Both edge processes share the one physical table; each store's sweep
      // must reclaim only its own tier's expired rows — the store docblock's
      // "the two edge processes sweep independently without touching each
      // other's rows". The raw-SQL isolation test above pins the bare verbs
      // under RLS; this drives the STORE's sweep with both tiers populated in
      // one database, which until now had coverage on the prod tier only.
      const dsn = urlFor(TIERS_DB, "helix_edge");
      const devDsn = urlFor(TIERS_DB, "helix_dev");

      let now = 2_000_000_000_000;
      const clock = (): number => now;
      const edge = newBurns({ databaseUrl: dsn, env: "prod", nowMs: clock });
      const dev = newBurns({ databaseUrl: devDsn, env: "dev", nowMs: clock });
      try {
        const jti = `tiers-sweep-${randomUUID()}`;
        await expect(edge.burn(jti)).resolves.toEqual({ verdict: "first-use" });
        await expect(dev.burn(jti)).resolves.toEqual({ verdict: "first-use" });

        // Past BOTH rows' retention by the shared clock — then only the prod
        // store's sweep runs.
        now += 61_000;
        edge.start();
        await new Promise((r) => setTimeout(r, 100));

        // The prod row was reclaimed; the dev row — expired by the same clock —
        // survives the prod process's pass untouched.
        expect(await roleRows(dsn, jti)).toBe(0);
        expect(await roleRows(devDsn, jti)).toBe(1);

        // The dev store's own pass reclaims its tier's row.
        dev.start();
        await new Promise((r) => setTimeout(r, 100));
        expect(await roleRows(devDsn, jti)).toBe(0);
      } finally {
        await edge.stop();
        await dev.stop();
      }
    },
  );

  test(
    "a store that will not answer denies closed, and the sweep counts its failed passes and keeps the cadence",
    { timeout: 30_000 },
    async () => {
      // A dead endpoint is the store-down case the fail-closed rule exists
      // for: a burn the store cannot claim is denied without a verdict (the
      // receiver denies retryably), and the sweep's failure arm — counted,
      // warned, cadence preserved — is what keeps cleanup coming back when
      // the store does.
      const provisional = createServer();
      await new Promise<void>((resolve) => provisional.listen(0, "127.0.0.1", resolve));
      const deadPort = (provisional.address() as { port: number }).port;
      await new Promise<void>((resolve) => provisional.close(() => resolve()));

      const recording = startRecordingTelemetry();
      try {
        const warnings: Array<Record<string, unknown>> = [];
        const burns = new PgJobsCallbackBurnStore({
          databaseUrl: `postgresql://helix:helix@127.0.0.1:${deadPort}/none`,
          env: "prod",
          statementTimeoutMs: 250,
          sweepIntervalMs: 60,
          log: { warn: (obj) => warnings.push(obj) },
        });
        burns.start();
        try {
          await expect(burns.burn("store-down")).resolves.toMatchObject({
            verdict: "store-unavailable",
          });

          await new Promise((r) => setTimeout(r, 1_400));
          const failed = (await recording.metrics()).filter(
            (m) =>
              m.name === "helix.jobs.burn.sweeps" && m.attributes["helix.outcome"] === "failed",
          );
          expect(failed.reduce((sum, m) => sum + m.value, 0)).toBeGreaterThanOrEqual(2);
          const failures = warnings.filter((w) => w.event === "edge.jobs_burn.sweep_failed");
          expect(failures.length).toBeGreaterThanOrEqual(2);
        } finally {
          await burns.stop();
        }
      } finally {
        await recording.restore();
      }
    },
  );

  test("the sweep loop keeps its cadence and counts every pass", { timeout: 30_000 }, async () => {
    const recording = startRecordingTelemetry();
    try {
      const burns = newBurns({ databaseUrl: EDGE_DSN, env: "prod", sweepIntervalMs: 10 });
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

  test(
    "start() during an in-flight pass does not fork the sweep loop",
    { timeout: 30_000 },
    async () => {
      // `start()` is idempotent under every interleaving. The fork window is
      // real: the timer's slot is vacated while a pass runs (`#timer = null`
      // before `sweepPass()` awaits), so an unguarded `start()` landing there
      // schedules a second chain whose handle a later reschedule orphans from
      // `stop()`'s clear — extra concurrent passes until the process ends.
      // The deterministic pin: a stall server holds the first pass's connect
      // open for the store's 250 ms ceiling, a `start()` at 20 ms lands inside
      // that window, and with the default 30 s cadence the only pass that can
      // ever have run by 600 ms is the first one. A forked chain runs its own
      // immediate pass and the count reads 2.
      const sockets = new Set<import("node:net").Socket>();
      const stall = createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      await new Promise<void>((resolve) => stall.listen(0, "127.0.0.1", resolve));
      const stallPort = (stall.address() as { port: number }).port;
      const recording = startRecordingTelemetry();
      try {
        const burns = new PgJobsCallbackBurnStore({
          databaseUrl: `postgresql://helix_edge:unused@127.0.0.1:${stallPort}/none`,
          env: "prod",
          statementTimeoutMs: 250, // the stall answers as store-unavailable at the ceiling
          log: LOG,
        });
        burns.start();
        // Inside the first pass's connect window: the timer slot is vacated.
        await new Promise((r) => setTimeout(r, 20));
        burns.start();
        await new Promise((r) => setTimeout(r, 600));
        await burns.stop();
        const passes = (await recording.metrics()).filter(
          (m) => m.name === "helix.jobs.burn.sweeps",
        );
        expect(passes.reduce((sum, m) => sum + m.value, 0)).toBe(1);
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => stall.close(() => resolve()));
        await recording.restore();
      }
    },
  );

  test(
    "start() twice in the same tick does not fork the sweep loop",
    { timeout: 30_000 },
    async () => {
      // The guard's other arm: two back-to-back start()s before the first timer
      // fires share one chain — the second sees the first's timer slot
      // occupied. A dropped `#timer` check would let the second scheduleSweep
      // overwrite that slot with its own timer and run a second pass; the
      // in-flight arm the pin above tests cannot catch it, because no pass is
      // running yet. With the default 30 s cadence, the only pass that can have
      // run by 600 ms is the first one — a fork reads 2.
      const sockets = new Set<import("node:net").Socket>();
      const stall = createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      await new Promise<void>((resolve) => stall.listen(0, "127.0.0.1", resolve));
      const stallPort = (stall.address() as { port: number }).port;
      const recording = startRecordingTelemetry();
      try {
        const burns = new PgJobsCallbackBurnStore({
          databaseUrl: `postgresql://helix_edge:unused@127.0.0.1:${stallPort}/none`,
          env: "prod",
          statementTimeoutMs: 250, // the stall answers as store-unavailable at the ceiling
          log: LOG,
        });
        burns.start();
        burns.start();
        await new Promise((r) => setTimeout(r, 600));
        await burns.stop();
        const passes = (await recording.metrics()).filter(
          (m) => m.name === "helix.jobs.burn.sweeps",
        );
        expect(passes.reduce((sum, m) => sum + m.value, 0)).toBe(1);
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => stall.close(() => resolve()));
        await recording.restore();
      }
    },
  );
});
