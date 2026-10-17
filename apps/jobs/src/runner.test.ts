import { describe, expect, test } from "vitest";
import { PgBoss } from "pg-boss";

import { JobsRunner, cancelRunnerJob, readRunnerJobState } from "./runner.js";

/**
 * The runtime runner's supervised start, against real failure modes: a store
 * that refuses connections keeps the loop retrying (logged, bounded, never
 * throwing out of start()), the enqueue refuses honestly until the runner
 * comes up, a failing worker registration is a failed start (the instance is
 * discarded and the loop retries until the registration succeeds), and stop()
 * releases the timer and the instance on every exit path — safe twice, safe
 * before start, and never restarting after stop. The start-against-a-
 * migrated-store success path is the boot suite's instruction legs, which
 * submit for real through the running process.
 */

const DEAD_DSN = "postgresql://helix_jobs:pw@127.0.0.1:59999/none";

function runnerWith(log: { warn: (fields: { event: unknown }) => void }) {
  return new JobsRunner({
    databaseUrl: DEAD_DSN,
    statementTimeoutMs: 2_000,
    retryInitialMs: 20,
    retryMaxMs: 50,
    // The registration hook's own contract is exercised against the real
    // store in `runner.integration.test.ts`; here a no-op stands in — these
    // legs' subject is the store-driven loop.
    registerWorker: async () => {},
    // The structural logger's real shape, narrowed at the call site.
    log: log as unknown as ConstructorParameters<typeof JobsRunner>[0]["log"],
  });
}

describe("the supervised runner", () => {
  test("a store that refuses connections is retried with capped backoff, and the enqueue refuses until the runner comes up", async () => {
    let failedStarts = 0;
    const runner = runnerWith({
      warn: (fields) => {
        if ((fields as { event?: string }).event === "jobs.runner.start_failed") failedStarts += 1;
      },
    });
    runner.start();
    try {
      // The refusal is immediate and honest — never a hang, never a plausible
      // enqueue into a store that does not exist.
      await expect(
        runner.enqueuer.enqueue({ query: async () => ({ rows: [] }) } as never, {
          type: "jobs:fetch",
          appId: "app",
          env: "prod",
          input: {},
        }),
      ).rejects.toThrow(/not started/);
      // Let the loop's own cadence run at least two attempts before the stop.
      await new Promise((r) => setTimeout(r, 120));
    } finally {
      await runner.stop();
    }
    // The loop retried at least twice before the stop, and the failures
    // never escaped start().
    expect(failedStarts).toBeGreaterThanOrEqual(2);
    expect(runner.snapshot).toEqual({ started: false, workerRegistered: false });
  });

  test("the backoff is capped — the loop keeps retrying at the cap instead of spacing out toward giving up", async () => {
    // The cap is the contract (`retryMaxMs`, 30s in production): an unbounded
    // exponential would space attempts toward hours after a long store
    // outage and the runner would never recover without a restart. With
    // initial 10ms and cap 20ms, capped attempts run roughly every 20ms
    // after the second failure, while uncapped doubling would run fewer than
    // half as many in the same window — the count separates the two with
    // room for scheduling jitter in either direction.
    let failedStarts = 0;
    const runner = runnerWith({
      warn: (fields) => {
        if ((fields as { event?: string }).event === "jobs.runner.start_failed") failedStarts += 1;
      },
    });
    runner.start();
    try {
      await new Promise((r) => setTimeout(r, 1_500));
    } finally {
      await runner.stop();
    }
    expect(failedStarts).toBeGreaterThanOrEqual(15);
  });

  test("stop is safe twice and before start, and the loop is over for good after it", async () => {
    let failedStarts = 0;
    const runner = runnerWith({
      warn: (fields) => {
        if ((fields as { event?: string }).event === "jobs.runner.start_failed") failedStarts += 1;
      },
    });
    await expect(runner.stop()).resolves.toBeUndefined(); // safe before start
    runner.start();
    await runner.stop();
    const atStop = failedStarts;
    await expect(runner.stop()).resolves.toBeUndefined(); // safe twice

    // No attempt is scheduled after the stop: a loop that survived it would
    // warn again within its own backoff window.
    await new Promise((r) => setTimeout(r, 400));
    expect(failedStarts).toBe(atStop);
    await expect(
      runner.enqueuer.enqueue(undefined as never, {
        type: "jobs:fetch",
        appId: "app",
        env: "prod",
        input: {},
      }),
    ).rejects.toThrow(/not started/);
  });

  test("a start attempt's failure never rejects — the loop owns it", async () => {
    // start() itself is fire-and-forget; an unhandled rejection from the
    // first attempt would crash the process the runner serves.
    const runner = runnerWith({ warn: () => {} });
    runner.start();
    // The in-flight attempt (if any) settles without escaping; stop() awaits
    // it before ending the instance.
    await expect(runner.stop()).resolves.toBeUndefined();
  });

  test("the recovery sweeper's runner-row read answers unavailable until the runner is up, and after it stops", async () => {
    // The sweeper's reconciliation reads the runner's state through THIS
    // seam; before the instance exists (or after the runner stops) there is
    // nothing to read through, and the honest answer is unavailable — the
    // pass retries on its own cadence, never a fabricated state.
    const runner = runnerWith({ warn: () => {} });
    await expect(runner.jobState("not-a-uuid")).resolves.toEqual({
      verdict: "unavailable",
      reason: "the runner has not started",
    });
    runner.start();
    try {
      // A failed start's instance is discarded — the answer is still
      // unavailable, with the loop retrying underneath.
      await expect(runner.jobState("not-a-uuid")).resolves.toMatchObject({
        verdict: "unavailable",
      });
    } finally {
      await runner.stop();
    }
    await expect(runner.jobState("not-a-uuid")).resolves.toEqual({
      verdict: "unavailable",
      reason: "the runner has not started",
    });
  });
});

/**
 * A start attempt can reject only through its own reporting — a log sink
 * that threw. The `attempt_rejected` contract: the rejection is reported
 * sink-guarded, the release chain survives it, and the timer-driven launch
 * carries the same guard the first attempt's launch has.
 */
describe("a start attempt whose own reporting threw", () => {
  /** A full-shape sink that records every call, then throws — the rejection's origin. */
  function throwingLog(): {
    events: string[];
    log: ConstructorParameters<typeof JobsRunner>[0]["log"];
  } {
    const events: string[] = [];
    const throwing = (fields: Record<string, unknown>): void => {
      events.push(String(fields.event));
      throw new Error("the reporting sink is down");
    };
    return {
      events,
      log: { info: throwing, warn: throwing, error: throwing },
    };
  }

  test("stop releases through a rejected start attempt — the release chain survives", async () => {
    const { events, log } = throwingLog();
    const runner = new JobsRunner({
      databaseUrl: DEAD_DSN,
      statementTimeoutMs: 2_000,
      retryInitialMs: 20,
      retryMaxMs: 50,
      registerWorker: async () => {},
      log,
    });
    runner.start();
    const rejectedBy = Date.now() + 5_000;
    while (Date.now() < rejectedBy && !events.includes("jobs.runner.attempt_rejected")) {
      await new Promise((r) => setTimeout(r, 5));
    }
    // stop() awaits a rejected in-flight attempt: it must resolve — a
    // rejection here would break the shutdown's release chain.
    await expect(runner.stop()).resolves.toBeUndefined();
    expect(events.some((e) => e === "jobs.runner.attempt_rejected")).toBe(true);
  });

  test("a timer-driven start attempt whose reporting threw is not an unhandled rejection", async () => {
    // Every start attempt's launch carries the guard, through the one
    // `launchAttempt` helper: the first from start(), the rest from the
    // backoff timer — so a rejected attempt is never an unhandled rejection
    // in the process the runner serves. The attempt's own
    // discard-and-reschedule still land
    // (the loop keeps retrying); what this pin adds is the launch's guard on
    // the steady-state path.
    const { log } = throwingLog();
    const captured: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      captured.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const runner = new JobsRunner({
      databaseUrl: DEAD_DSN,
      statementTimeoutMs: 2_000,
      retryInitialMs: 20,
      retryMaxMs: 50,
      registerWorker: async () => {},
      log,
    });
    try {
      runner.start();
      // Two backoff windows: the first attempt (guarded launch) and at least
      // one timer-driven attempt after it.
      await new Promise((r) => setTimeout(r, 200));
      expect(captured).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      await runner.stop().catch(() => {});
    }
  });
});

describe("readRunnerJobState", () => {
  test("a read the runner's store cannot answer is unavailable with the failure's reason — never a fabricated state", async () => {
    // The sweeper's reconciliation reads through THIS mapping; when the
    // runner's store does not answer, the honest verdict is `unavailable`
    // (the pass aborts and retries on its cadence) — never a guessed state.
    // A real instance against a store that refuses connections: the read
    // fails, the mapping answers, nothing throws out of the call.
    const dead = new PgBoss({ connectionString: DEAD_DSN });
    const lookup = await readRunnerJobState(dead, "not-a-uuid");
    if (lookup.verdict !== "unavailable") {
      throw new Error(`expected unavailable, got: ${lookup.verdict}`);
    }
    expect(typeof lookup.reason).toBe("string");
    expect(lookup.reason.length).toBeGreaterThan(0);
  });
});

describe("cancelRunnerJob", () => {
  test("a cancel the runner's store cannot answer is unavailable with the failure's reason — never a fabricated verdict", async () => {
    // Both cancellation drives (the store's post-intent drive and the
    // sweeper's re-drive) run through THIS mapping; when the runner's store
    // does not answer, the honest verdict is `unavailable` — the caller's
    // durable intent stays pending and the next cadence retries, never a
    // guessed "cancelled" that could stop the re-drive.
    const dead = new PgBoss({ connectionString: DEAD_DSN });
    const verdict = await cancelRunnerJob(dead, "not-a-uuid");
    if (verdict.verdict !== "unavailable") {
      throw new Error(`expected unavailable, got: ${verdict.verdict}`);
    }
    expect(typeof verdict.reason).toBe("string");
    expect(verdict.reason.length).toBeGreaterThan(0);
  });

  test("the cancellation drive answers unavailable until the runner is up, and after it stops", async () => {
    // The method both drives are composed over (`runner.cancelJob`): before
    // the instance exists, and after the runner stops, there is nothing to
    // drive through — the same honest answer the runner-row read gives, so a
    // cancellation requested against an unstarted runner is retried by the
    // sweeper rather than reported against.
    const runner = runnerWith({ warn: () => {} });
    await expect(runner.cancelJob("not-a-uuid")).resolves.toEqual({
      verdict: "unavailable",
      reason: "the runner has not started",
    });
    runner.start();
    try {
      // A failed start's instance is discarded — the answer is still
      // unavailable, with the loop retrying underneath.
      await expect(runner.cancelJob("not-a-uuid")).resolves.toMatchObject({
        verdict: "unavailable",
      });
    } finally {
      await runner.stop();
    }
    await expect(runner.cancelJob("not-a-uuid")).resolves.toEqual({
      verdict: "unavailable",
      reason: "the runner has not started",
    });
  });
});
