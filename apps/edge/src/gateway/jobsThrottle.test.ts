import { describe, expect, it } from "vitest";
import { JOBS_CAPACITY_DEFAULTS } from "@azx-pbc/shared";
import { JobsSubmissionThrottle } from "./jobsThrottle.js";
import { InMemoryCounterStore } from "./counterStore.js";

/**
 * The submission throttle buckets (design §4): two fixed windows over the
 * shared counter primitive — per app/environment and one deployment-wide
 * aggregate — every authenticated attempt consumes, with no refund. The route
 * behaviors around them (429s, what counts and what does not, the ledger
 * rows) are pinned in `gateway/jobs.test.ts`; here the bucket arithmetic
 * itself is, against the real in-memory store.
 */
describe("JobsSubmissionThrottle", () => {
  /** Small per-app window so a test can drain it by hand. */
  const appWindow = 2;
  const limits = (deployment: number) => ({
    ...JOBS_CAPACITY_DEFAULTS,
    submissionAttemptsPerAppEnv: appWindow,
    submissionAttemptsDeployment: deployment,
  });
  const throttle = (deployment = 3, now?: () => number) =>
    new JobsSubmissionThrottle(new InMemoryCounterStore(now), limits(deployment));

  it("admits up to the per-app/env window and refuses past it", async () => {
    const t = throttle(100);
    expect(await t.consume("app-a", "prod")).toBe(true);
    expect(await t.consume("app-a", "prod")).toBe(true);
    expect(await t.consume("app-a", "prod")).toBe(false);
  });

  it("budgets each app and each env separately", async () => {
    const t = throttle(100);
    expect(await t.consume("app-a", "prod")).toBe(true);
    expect(await t.consume("app-a", "prod")).toBe(true);
    // A different app is untouched by the noisy one's spend…
    expect(await t.consume("app-b", "prod")).toBe(true);
    // …and so is the same app's dev partition — everything in this ledger
    // partitions on env.
    expect(await t.consume("app-a", "dev")).toBe(true);
  });

  it("the deployment window spans apps and environments", async () => {
    const t = throttle(3);
    // Three apps (or envs) each spending one attempt fill the deployment
    // window; the fourth attempt from anywhere is refused by it.
    expect(await t.consume("app-a", "prod")).toBe(true);
    expect(await t.consume("app-b", "prod")).toBe(true);
    expect(await t.consume("app-a", "dev")).toBe(true);
    expect(await t.consume("app-c", "prod")).toBe(false);
  });

  it("an attempt refused by one window is still charged to the other — no refund", async () => {
    const t = throttle(3);
    await t.consume("app-a", "prod"); // app 1, deployment 1
    await t.consume("app-a", "prod"); // app 2, deployment 2
    // The per-app window is exhausted, but the attempt was still charged:
    // the deployment aggregate now sits at 3 of 3.
    expect(await t.consume("app-a", "prod")).toBe(false);
    // app-b has its whole per-app window ahead of it and is refused anyway —
    // the deployment window the refusals kept consuming is spent.
    expect(await t.consume("app-b", "prod")).toBe(false);
    expect(await t.consume("app-c", "prod")).toBe(false);
  });

  it("restarts both windows when they elapse — the fixed-window counter contract", async () => {
    let clock = 0;
    const t = throttle(100, () => clock);
    for (let i = 0; i < 2; i += 1) expect(await t.consume("app-a", "prod")).toBe(true);
    expect(await t.consume("app-a", "prod")).toBe(false);
    clock += 60_000; // the whole window, exactly — the store restarts on resetAt
    expect(await t.consume("app-a", "prod")).toBe(true);
  });

  it("carries no server or type in its charge — the charge is (app, env) only", async () => {
    // The allowance-multiplier trap the buckets exist to close: the key the
    // charge lands on is the app and env alone — `consume` takes no server id
    // and no type, so there is nowhere a second prefix could buy a fresh
    // window from. The observable route behavior (submissions to another
    // configured server draining the same window) is pinned in
    // `gateway/jobs.test.ts`.
    const t = throttle();
    expect(await t.consume("app-a", "prod")).toBe(true);
    expect(await t.consume("app-a", "prod")).toBe(true);
    expect(await t.consume("app-a", "prod")).toBe(false);
  });

  it("defaults to the platform's capacity defaults when no limits are handed in", async () => {
    // The composition builds the throttle with no explicit limits: the window
    // that takes effect is the shared one (10 per app/env), not a local copy
    // that could drift from the deployment schema's defaults.
    const t = new JobsSubmissionThrottle(new InMemoryCounterStore());
    for (let i = 0; i < JOBS_CAPACITY_DEFAULTS.submissionAttemptsPerAppEnv; i += 1) {
      expect(await t.consume("app-a", "prod")).toBe(true);
    }
    expect(await t.consume("app-a", "prod")).toBe(false);
  });
});
