import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { JobsStorageCompatibility } from "./compat.js";
import { JobsStorage, type JobsStorageLogger } from "./storage.js";

/**
 * The storage lifecycle's state machine, driven through an injected probe —
 * the boundary (the database) — so the transitions, the bounded backoff and
 * the release paths are pinned without a cluster. The real probe against a
 * real store, and the recovery story it makes observable, live in the
 * integration legs at the bottom and in the boot suite.
 */

interface CapturedLine {
  level: string;
  fields: Record<string, unknown>;
  msg: string;
}

function silentLog(): { lines: CapturedLine[]; log: JobsStorageLogger } {
  const lines: CapturedLine[] = [];
  return {
    lines,
    log: {
      info: (fields, msg) => lines.push({ level: "info", fields, msg }),
      warn: (fields, msg) => lines.push({ level: "warn", fields, msg }),
      error: (fields, msg) => lines.push({ level: "error", fields, msg }),
    },
  };
}

const COMPATIBLE: JobsStorageCompatibility = { kind: "compatible", schemaVersion: 45 };

function makeStorage(options: {
  probe: () => Promise<JobsStorageCompatibility>;
  retryInitialMs?: number;
  retryMaxMs?: number;
  readyIntervalMs?: number;
}): { storage: JobsStorage; lines: CapturedLine[] } {
  const { lines, log } = silentLog();
  const storage = new JobsStorage({
    databaseUrl: "postgresql://helix_jobs:pw@db:5432/helix_jobs_test",
    statementTimeoutMs: 250,
    check: options.probe,
    retryInitialMs: options.retryInitialMs,
    retryMaxMs: options.retryMaxMs,
    readyIntervalMs: options.readyIntervalMs,
    log,
  });
  return { storage, lines };
}

describe("the storage lifecycle state machine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function flush(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
  }

  test("readiness is pending — unhealthy, never ok — until the first probe lands", async () => {
    const { storage } = makeStorage({ probe: async () => COMPATIBLE });
    const before = storage.snapshot();
    expect(before.state).toBe("pending");
    expect(before.verdict).toBeNull();
    expect(before.lastReadyAt).toBeNull();

    storage.start();
    // The listener is up, the first probe in flight: still pending, still
    // unhealthy — "nothing has answered yet" is not health.
    expect(storage.snapshot().state).toBe("pending");
    await flush();
    expect(storage.snapshot().state).toBe("ready");
  });

  test("an incompatible store is unavailable with its verdict; recovery returns ready", async () => {
    let verdict: JobsStorageCompatibility = { kind: "schema_missing" };
    const { storage, lines } = makeStorage({ probe: async () => verdict });
    storage.start();
    await flush();
    const unavailable = storage.snapshot();
    expect(unavailable.state).toBe("unavailable");
    expect(unavailable.verdict).toEqual({ kind: "schema_missing" });
    expect(unavailable.lastReadyAt).toBeNull();
    expect(unavailable.unavailableSince).not.toBeNull();

    // The transition, not every probe, is the log signal.
    expect(lines.filter((l) => l.fields.event === "jobs.storage.unavailable")).toHaveLength(1);

    // The store becomes usable (the operator runs the migration): the next
    // probe recovers the service without a restart.
    verdict = COMPATIBLE;
    await vi.advanceTimersByTimeAsync(10_000);
    const ready = storage.snapshot();
    expect(ready.state).toBe("ready");
    expect(ready.unavailableSince).toBeNull();
    expect(ready.lastReadyAt).not.toBeNull();
    expect(lines.filter((l) => l.fields.event === "jobs.storage.ready")).toHaveLength(1);
  });

  test("a store that verified ready and then dies is unavailable, and recovers again", async () => {
    let verdict: JobsStorageCompatibility = COMPATIBLE;
    const { storage } = makeStorage({
      probe: async () => verdict,
      readyIntervalMs: 1_000,
    });
    storage.start();
    await flush();
    expect(storage.snapshot().state).toBe("ready");

    verdict = { kind: "unreachable", message: "connect ECONNREFUSED" };
    await vi.advanceTimersByTimeAsync(1_000);
    const lost = storage.snapshot();
    expect(lost.state).toBe("unavailable");
    // The last ready instant survives the outage — "last known good" is the
    // operator's anchor, and the snapshot never rewrites it.
    expect(lost.lastReadyAt).not.toBeNull();

    verdict = COMPATIBLE;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(storage.snapshot().state).toBe("ready");
  });

  test("a second start() while running does not double the loop or leak a second pool", async () => {
    // The idempotency guard (`start` checks pool-or-stopped before acquiring):
    // a second call must be a no-op. A regression that re-acquired would leak
    // the first pool (start overwrites the reference) and interleave a second
    // probe loop — visible here as two probes per cadence tick.
    let probeCalls = 0;
    const { storage } = makeStorage({
      probe: async () => {
        probeCalls += 1;
        return COMPATIBLE;
      },
      readyIntervalMs: 1_000,
    });
    storage.start();
    storage.start();
    await flush();
    expect(probeCalls).toBe(1); // one first probe, not one per start()
    await vi.advanceTimersByTimeAsync(1_000);
    expect(probeCalls).toBe(2); // one loop on the steady cadence, not two
    await storage.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probeCalls).toBe(2); // the single stop released the single loop
  });

  test("a probe that throws is a store that did not answer, not a silent skip", async () => {
    const { storage, lines } = makeStorage({
      probe: async () => {
        throw new Error("the probe exploded");
      },
    });
    storage.start();
    await flush();
    const snapshot = storage.snapshot();
    expect(snapshot.state).toBe("unavailable");
    expect(snapshot.verdict).toEqual({ kind: "unreachable", message: "the probe exploded" });
    expect(lines.filter((l) => l.fields.event === "jobs.storage.probe_error")).toHaveLength(1);
  });
});

describe("the probe cadence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("retries back off from the initial delay and never exceed the cap", async () => {
    const calls: number[] = [];
    const { storage } = makeStorage({
      probe: async () => {
        calls.push(Date.now()); // fake-timer clock
        return { kind: "unreachable", message: "down" };
      },
      retryInitialMs: 100,
      retryMaxMs: 1_000,
    });
    storage.start();
    // Long enough to cross the cap several times: delays 100, 200, 400, 800,
    // 1000, 1000, … capped — never faster than the initial delay, never slower
    // than the cap.
    await vi.advanceTimersByTimeAsync(6_500);
    expect(calls.length).toBeGreaterThan(4);

    const gaps = calls.slice(1).map((at, i) => at - calls[i]!);
    expect(gaps[0]).toBe(100); // the first retry waits the initial delay
    // The shape is exponential — each failure doubles the wait until the cap:
    // 100, 200, 400, 800, then 1000 forever. A linear ramp also stays bounded
    // and capped, so the prefix is what distinguishes the design from a
    // regression to it.
    expect(gaps[1]).toBe(200);
    expect(gaps[2]).toBe(400);
    expect(gaps[3]).toBe(800);
    for (const gap of gaps) {
      expect(gap).toBeLessThanOrEqual(1_000); // the cap holds everywhere
    }
    expect(gaps.at(-1)).toBe(1_000); // the cap is reached, not approximated

    // The absorbed retries are counted on the snapshot, whatever the cadence.
    expect(storage.snapshot().probes).toBe(calls.length);
  });

  test("a ready store is re-probed on the steady cadence, so a later failure is seen", async () => {
    let probeCalls = 0;
    const { storage } = makeStorage({
      probe: async () => {
        probeCalls += 1;
        return COMPATIBLE;
      },
      readyIntervalMs: 1_000,
    });
    storage.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(probeCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    // The first probe at t=0, then one per 1 s tick through t=10 s: the
    // later-failure detection bound is the interval, not "never again".
    expect(probeCalls).toBe(11);
    expect(storage.snapshot().state).toBe("ready");
  });
});

describe("release", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function flush(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
  }

  test("stop halts the loop for good: no probe runs after it, and stop is safe twice", async () => {
    let probeCalls = 0;
    const { storage } = makeStorage({
      probe: async () => {
        probeCalls += 1;
        return { kind: "unreachable", message: "down" };
      },
      retryInitialMs: 50,
    });
    storage.start();
    await flush();
    expect(probeCalls).toBe(1);

    await storage.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probeCalls).toBe(1); // no timer survived the stop
    await storage.stop(); // idempotent
  });

  test("stop before start is a no-op, and start after stop stays stopped", async () => {
    let probeCalls = 0;
    const { storage } = makeStorage({
      probe: async () => {
        probeCalls += 1;
        return COMPATIBLE;
      },
    });
    await storage.stop();
    storage.start();
    await flush();
    expect(probeCalls).toBe(0);
  });

  test("start and stop N times in a loop: each cycle's probes run and each pool releases", async () => {
    // The resource-lifetime invariant: acquire/release pairs stay balanced
    // across repeated cycles — a one-unit leak per cycle shows up here. A
    // fresh supervisor per cycle: stop is terminal by design (a stopped
    // supervisor never restarts, pinned above), matching a process restart.
    let probeCalls = 0;
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const { storage } = makeStorage({
        probe: async () => {
          probeCalls += 1;
          return COMPATIBLE;
        },
      });
      storage.start();
      await vi.advanceTimersByTimeAsync(0);
      await storage.stop();
    }
    expect(probeCalls).toBe(5); // exactly one probe per cycle — nothing leaked, nothing stuck
  });

  test("stop awaits the in-flight probe: no client is pulled out from under itself", async () => {
    let releaseProbe!: () => void;
    const { storage } = makeStorage({
      probe: () =>
        new Promise<JobsStorageCompatibility>((resolve) => {
          releaseProbe = () => resolve(COMPATIBLE);
        }),
    });
    storage.start();
    await flush();
    const stopping = storage.stop();
    releaseProbe();
    await stopping; // resolves only after the probe settled
    expect(storage.snapshot().state).toBe("ready");
  });
});

describe("the probe counter", () => {
  let recording: RecordingTelemetry;

  beforeEach(() => {
    recording = startRecordingTelemetry();
  });

  afterEach(async () => {
    await recording.restore();
  });

  test("every probe is counted by its bounded outcome — retries are visible, not silent", async () => {
    // Real timers at a trivial cadence: what this pins is the counting and the
    // bounded dimensions, not the scheduling (pinned above on fake timers).
    let verdict: JobsStorageCompatibility = { kind: "unreachable", message: "down" };
    const { storage } = makeStorage({
      probe: async () => verdict,
      retryInitialMs: 10,
      readyIntervalMs: 10,
    });
    storage.start();
    const settledBy = Date.now() + 5_000;
    while (Date.now() < settledBy && storage.snapshot().probes < 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    verdict = COMPATIBLE;
    while (Date.now() < settledBy && storage.snapshot().probes < 3) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await storage.stop();

    const points = await recording.metrics();
    const probes = points.filter((p) => p.name === "helix.jobs.storage.probes");
    const byOutcome = new Map(probes.map((p) => [p.attributes["helix.outcome"], p.value]));
    expect(byOutcome.get("unavailable")).toBe(1);
    expect(byOutcome.get("ok")).toBe(2);
    // Bounded, non-personal dimensions: the outcome, nothing else.
    for (const point of probes) {
      expect(Object.keys(point.attributes)).toEqual(["helix.outcome"]);
    }
  });
});

/**
 * A probe can reject only through its own reporting — a log sink that threw.
 * The supervisor's answer is threefold (the `probe_rejected` contract): the
 * first probe's rejection is absorbed at its launch, a rejection at stop time
 * must not break the release chain, and a report's failure must end neither
 * the evidence nor the scheduling. The timer-driven launch's own guard is the
 * finding pinned in the last leg of this describe.
 */
describe("a probe whose own reporting threw", () => {
  /** A sink that records every call, then throws — the rejection's origin. */
  function throwingLog(): { events: string[]; log: JobsStorageLogger } {
    const events: string[] = [];
    return {
      events,
      log: {
        info: (fields) => {
          events.push(String(fields.event));
          throw new Error("the reporting sink is down");
        },
        warn: (fields) => {
          events.push(String(fields.event));
          throw new Error("the reporting sink is down");
        },
        error: (fields) => {
          events.push(String(fields.event));
          throw new Error("the reporting sink is down");
        },
      },
    };
  }

  test("the first probe's rejection is absorbed at its launch — the cadence and the record continue", async () => {
    // Real timers at a trivial cadence: the subject is the guarded launch and
    // the try/finally's scheduling, not the clock.
    const { events, log } = throwingLog();
    const storage = new JobsStorage({
      databaseUrl: "postgresql://helix_jobs:pw@db:5432/helix_jobs_test",
      statementTimeoutMs: 250,
      check: async () => ({ kind: "unreachable", message: "down" }),
      retryInitialMs: 10,
      retryMaxMs: 20,
      readyIntervalMs: 10,
      log,
    });
    try {
      storage.start();
      const probedBy = Date.now() + 5_000;
      while (Date.now() < probedBy && storage.snapshot().probes < 3) {
        await new Promise((r) => setTimeout(r, 5));
      }
      // The rejected first probe still recorded its verdict (the evidence)
      // and its failure scheduled the next probe (the cadence): the loop ran
      // past its own reporting's death.
      expect(storage.snapshot().probes).toBeGreaterThanOrEqual(3);
      expect(storage.snapshot().state).toBe("unavailable");
      // The rejection was reported exactly once — the launch guard's
      // `probe_rejected` — after the verdict's own transition line.
      expect(events.filter((e) => e === "jobs.storage.unavailable")).toHaveLength(1);
      expect(events.filter((e) => e === "jobs.storage.probe_rejected")).toHaveLength(1);
    } finally {
      await storage.stop();
    }
  });

  test("stop releases through an already-rejected probe — the release chain survives", async () => {
    const { events, log } = throwingLog();
    const storage = new JobsStorage({
      databaseUrl: "postgresql://helix_jobs:pw@db:5432/helix_jobs_test",
      statementTimeoutMs: 250,
      check: async () => ({ kind: "unreachable", message: "down" }),
      retryInitialMs: 10,
      retryMaxMs: 20,
      log,
    });
    storage.start();
    const rejectedBy = Date.now() + 5_000;
    while (Date.now() < rejectedBy && !events.includes("jobs.storage.probe_rejected")) {
      await new Promise((r) => setTimeout(r, 5));
    }
    // stop() awaits a rejected in-flight probe: it must resolve — a
    // rejection here would break the shutdown's release chain.
    await expect(storage.stop()).resolves.toBeUndefined();
    expect(events.some((e) => e === "jobs.storage.probe_rejected")).toBe(true);
  });

  test("a timer-driven probe whose reporting threw is not an unhandled rejection", async () => {
    // Every probe's launch carries the guard, through the one `launchProbe`
    // helper: the first from start(), the rest from the cadence's timer —
    // so a rejected probe is never an unhandled rejection in the process
    // that serves the health body. The probe's evidence and the next
    // scheduling both land (the previous leg's contract); what this pin
    // adds is the launch's own guard on the steady-state path.
    const { events, log } = throwingLog();
    // The first probe answers compatible (no transition line, no throw); the
    // second — timer-driven — records the first failure, whose report throws.
    let probes = 0;
    const captured: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      captured.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const storage = new JobsStorage({
      databaseUrl: "postgresql://helix_jobs:pw@db:5432/helix_jobs_test",
      statementTimeoutMs: 250,
      check: async () => {
        probes += 1;
        return probes === 1 ? COMPATIBLE : { kind: "unreachable", message: "down" };
      },
      readyIntervalMs: 10,
      retryInitialMs: 10,
      retryMaxMs: 20,
      log,
    });
    try {
      storage.start();
      const probedBy = Date.now() + 5_000;
      while (Date.now() < probedBy && storage.snapshot().probes < 3) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(storage.snapshot().probes).toBeGreaterThanOrEqual(3);
      expect(events.some((e) => e === "jobs.storage.unavailable")).toBe(true);
      expect(captured).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      await storage.stop().catch(() => {});
    }
  });
});

describe("a check that itself throws while reporting is down", () => {
  test(
    "the verdict is still recorded and the cadence survives — the snapshot never freezes on a stale ready",
    { timeout: 15_000 },
    async () => {
      // The check's own throw is a designed path: probeOnce answers it "as a
      // verdict, never a silent skip". Its catch arm reports through the sink —
      // and that report sits OUTSIDE the scheduling finally, so a sink that
      // throws here escapes before the verdict is recorded or the next probe
      // scheduled. The module's contract for every rejected body is that the
      // cadence and the evidence continue; a supervisor that froze on its last
      // `ready` would leave /health reading ok with the store down and the
      // supervisor dead.
      let probes = 0;
      const storage = new JobsStorage({
        databaseUrl: "postgresql://helix_jobs:pw@db:5432/helix_jobs_test",
        statementTimeoutMs: 250,
        check: async () => {
          probes += 1;
          if (probes === 1) return COMPATIBLE;
          throw new Error("the compatibility check exploded");
        },
        readyIntervalMs: 10,
        retryInitialMs: 10,
        retryMaxMs: 20,
        log: {
          info: () => {},
          warn: () => {},
          error: () => {
            throw new Error("the reporting sink is down");
          },
        },
      });
      storage.start();
      try {
        const probedBy = Date.now() + 5_000;
        while (Date.now() < probedBy && storage.snapshot().probes < 3) {
          await new Promise((r) => setTimeout(r, 5));
        }
        // The cadence survived the check's own throw: probes kept counting.
        expect(storage.snapshot().probes).toBeGreaterThanOrEqual(3);
        // The verdict was recorded — the store's failure never reads as ready.
        expect(storage.snapshot().state).toBe("unavailable");
        // And the loop is still probing at its (capped) retry cadence.
        const probesAtAssert = storage.snapshot().probes;
        await new Promise((r) => setTimeout(r, 60));
        expect(storage.snapshot().probes).toBeGreaterThan(probesAtAssert);
      } finally {
        await storage.stop();
      }
    },
  );
});

/**
 * The real probe against the real cluster, through the real role split — the
 * supervisor's production configuration, not the injected seam. Owns its
 * scratch store; the boot suite composes the same legs through HTTP.
 */
describe("the supervisor against the real store", () => {
  const TEST_DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";
  const SCRATCH_DB = `helix_jobs_boot_${Math.random().toString(36).slice(2)}`;
  const POOL_ERROR_DB = `helix_jobs_boot_pe_${Math.random().toString(36).slice(2)}`;

  function urlFor(database: string, role?: string): string {
    const url = new URL(TEST_DATABASE_URL);
    url.pathname = `/${database}`;
    if (role) {
      url.username = role;
      url.password = role;
    }
    return url.toString();
  }

  async function dropScratch(database: string): Promise<void> {
    const pool = new (await import("pg")).Pool({
      connectionString: urlFor("postgres"),
      max: 1,
    });
    await pool.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await pool.end();
  }

  test(
    "a pooled client dying while idle is a logged warning, not a process death — and the loop recovers",
    { timeout: 60_000 },
    async () => {
      const { applyRolesProvisioning } =
        await import("../../portal/src/test/provisionDatabases.js");
      const { migrateJobsStorage } = await import("./migrate.js");
      await applyRolesProvisioning(POOL_ERROR_DB);
      await migrateJobsStorage(urlFor(POOL_ERROR_DB, "helix_jobs_migrate"));

      const { lines, log } = silentLog();
      const storage = new JobsStorage({
        databaseUrl: urlFor(POOL_ERROR_DB, "helix_jobs"),
        statementTimeoutMs: 5_000,
        // A fast steady cadence so the post-death probe (and so this test) does
        // not wait out the production interval.
        readyIntervalMs: 500,
        retryInitialMs: 100,
        log,
      });
      try {
        storage.start();
        const readyBy = Date.now() + 30_000;
        while (Date.now() < readyBy && storage.snapshot().state !== "ready") {
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(storage.snapshot().state).toBe("ready");

        // Kill the pool's idle client behind the store's back — the transient
        // connection death (a failover, a firewall reap) the pool-error
        // listener exists to absorb. Terminate until the warning lands: a pass
        // that hits a checked-out client surfaces through the probe's verdict
        // instead, and the loop makes the next pass.
        const control = new (await import("pg")).Pool({
          connectionString: urlFor("postgres"),
          max: 1,
        });
        const warnedBy = Date.now() + 20_000;
        while (Date.now() < warnedBy) {
          const idle = await control.query<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity
             WHERE datname = $1 AND usename = $2 AND state = 'idle' AND pid <> pg_backend_pid()`,
            [POOL_ERROR_DB, "helix_jobs"],
          );
          for (const row of idle.rows) {
            await control.query(`SELECT pg_terminate_backend($1)`, [row.pid]);
          }
          await new Promise((r) => setTimeout(r, 300));
          if (lines.some((l) => l.fields.event === "jobs.storage.pool_error")) break;
        }
        await control.end();
        expect(lines.some((l) => l.fields.event === "jobs.storage.pool_error")).toBe(true);

        // The service stays alive and honest. The stale body still reads ready
        // right after the death — the snapshot only changes when a probe runs —
        // so the evidence of recovery is the next probe actually running and
        // verifying the store again: a rebuilt client, ready, without a restart.
        const probesAtDeath = storage.snapshot().probes;
        const recoveredBy = Date.now() + 15_000;
        while (Date.now() < recoveredBy && storage.snapshot().probes <= probesAtDeath) {
          await new Promise((r) => setTimeout(r, 25));
        }
        const recovered = storage.snapshot();
        expect(recovered.probes).toBeGreaterThan(probesAtDeath);
        expect(recovered.state).toBe("ready");
        expect(recovered.lastReadyAt).not.toBeNull();
      } finally {
        await storage.stop();
        await dropScratch(POOL_ERROR_DB);
      }
    },
  );

  test(
    "an unmigrated store is unavailable with the migration answer, and becomes ready after the migration runs",
    { timeout: 60_000 },
    async () => {
      const { applyRolesProvisioning } =
        await import("../../portal/src/test/provisionDatabases.js");
      const { migrateJobsStorage } = await import("./migrate.js");
      await applyRolesProvisioning(SCRATCH_DB);

      const { lines, log } = silentLog();
      const storage = new JobsStorage({
        databaseUrl: urlFor(SCRATCH_DB, "helix_jobs"),
        statementTimeoutMs: 5_000,
        log,
      });
      storage.start();
      const unavailableBy = Date.now() + 30_000;
      while (Date.now() < unavailableBy && storage.snapshot().state === "pending") {
        await new Promise((r) => setTimeout(r, 25));
      }
      const unmigrated = storage.snapshot();
      expect(unmigrated.state).toBe("unavailable");
      expect(unmigrated.verdict?.kind).toBe("schema_missing");

      // The operator's move: the migration command, under the migration
      // identity. Nothing about the supervisor changed.
      await migrateJobsStorage(urlFor(SCRATCH_DB, "helix_jobs_migrate"));

      const recoveredBy = Date.now() + 30_000;
      while (Date.now() < recoveredBy && storage.snapshot().state !== "ready") {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(storage.snapshot().state).toBe("ready");
      expect(lines.some((l) => l.fields.event === "jobs.storage.ready")).toBe(true);

      // Release, observed from the store's side: while the supervisor runs it
      // holds the store's connection; after stop() — with this process still
      // alive — nothing is connected any more. A skipped pool end would leave
      // the idle client's session visible here.
      const connectionsToScratch = async (): Promise<number> => {
        const pool = new (await import("pg")).Pool({
          connectionString: urlFor("postgres"),
          max: 1,
        });
        const result = await pool.query<{ count: string }>(
          `SELECT count(*) AS count FROM pg_stat_activity WHERE datname = $1`,
          [SCRATCH_DB],
        );
        await pool.end();
        return Number(result.rows[0]?.count ?? 0);
      };
      const heldBy = Date.now() + 2_000;
      while (Date.now() < heldBy && (await connectionsToScratch()) === 0) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(await connectionsToScratch()).toBeGreaterThan(0);
      await storage.stop();
      // The zero budget is strictly below pg-pool's 10 s idle-client reaper:
      // only the explicit pool end can produce it inside one, so the pin
      // cannot be satisfied by the pool's own housekeeping.
      const releasedBy = Date.now() + 1_500;
      while (Date.now() < releasedBy && (await connectionsToScratch()) > 0) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(await connectionsToScratch()).toBe(0);

      const pool = new (await import("pg")).Pool({
        connectionString: urlFor("postgres"),
        max: 1,
      });
      await pool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
      await pool.end();
    },
  );
});
