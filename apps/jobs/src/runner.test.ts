import { describe, expect, test } from "vitest";

import { JobsRunner } from "./runner.js";

/**
 * The runtime runner's supervised start, against real failure modes: a store
 * that refuses connections keeps the loop retrying (logged, bounded, never
 * throwing out of start()), the enqueue refuses honestly until the runner
 * comes up, and stop() releases the timer and the instance on every exit
 * path — safe twice, safe before start, and never restarting after stop.
 * The start-against-a-migrated-store success path is the boot suite's
 * instruction legs, which submit for real through the running process.
 */

const DEAD_DSN = "postgresql://helix_jobs:pw@127.0.0.1:59999/none";

function runnerWith(log: { warn: (fields: { event: unknown }) => void }) {
  return new JobsRunner({
    databaseUrl: DEAD_DSN,
    statementTimeoutMs: 2_000,
    retryInitialMs: 20,
    retryMaxMs: 50,
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
});
