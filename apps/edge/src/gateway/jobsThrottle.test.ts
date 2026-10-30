import { describe, expect, it } from "vitest";
import { JOBS_CAPACITY_DEFAULTS } from "@azx-pbc/shared";
import { JobsSubmissionThrottle } from "./jobsThrottle.js";
import { InMemoryCounterStore, type CounterStore } from "./counterStore.js";

/** The in-memory store, recording every key a bump charged. */
function recordingStore(): CounterStore & { bumps: string[] } {
  const inner = new InMemoryCounterStore();
  const bumps: string[] = [];
  return {
    bumps,
    bump: (key, windowMs) => {
      bumps.push(key);
      return inner.bump(key, windowMs);
    },
    reset: (key) => inner.reset(key),
    sweep: () => inner.sweep(),
    close: () => inner.close(),
  };
}

/**
 * The submission throttle buckets (design §4): two fixed windows over the
 * shared counter primitive — per app/environment and one deployment-wide
 * aggregate — an authorized attempt consumes, per-app first, with no refund.
 * The route
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

  it("an attempt the per-app window refuses never charges the deployment window", async () => {
    const store = recordingStore();
    const t = new JobsSubmissionThrottle(store, limits(3));
    expect(await t.consume("app-a", "prod")).toBe(true); // app 1, deployment 1
    expect(await t.consume("app-a", "prod")).toBe(true); // app 2, deployment 2
    // Over its own window: refused, and the deployment window is untouched.
    for (let i = 0; i < 5; i += 1) expect(await t.consume("app-a", "prod")).toBe(false);
    expect(store.bumps.filter((k) => k === "jobs:submit:deployment")).toHaveLength(2);
    expect(store.bumps.filter((k) => k === "jobs:submit:app:prod:app-a")).toHaveLength(7);
    // The one deployment slot app-a's refusals did not spend is app-b's.
    expect(await t.consume("app-b", "prod")).toBe(true);
    expect(await t.consume("app-c", "prod")).toBe(false);
  });

  it("an attempt the deployment window refuses keeps its per-app charge — no refund", async () => {
    const store = recordingStore();
    const t = new JobsSubmissionThrottle(store, limits(1));
    expect(await t.consume("app-a", "prod")).toBe(true);
    // app-b's per-app window admits it; the deployment window refuses it, and
    // the per-app charge stands.
    expect(await t.consume("app-b", "prod")).toBe(false);
    expect(await t.consume("app-b", "prod")).toBe(false);
    // Its per-app window (2) is now spent by the two refused attempts, so the
    // next one never reaches the deployment window.
    expect(await t.consume("app-b", "prod")).toBe(false);
    expect(store.bumps).toEqual([
      "jobs:submit:app:prod:app-a",
      "jobs:submit:deployment",
      "jobs:submit:app:prod:app-b",
      "jobs:submit:deployment",
      "jobs:submit:app:prod:app-b",
      "jobs:submit:deployment",
      "jobs:submit:app:prod:app-b",
    ]);
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

  it("applies the platform's capacity defaults when constructed with them", async () => {
    // The composition builds the throttle with the config-resolved limits —
    // the platform defaults when no override is configured. Constructing with
    // the shared defaults explicitly pins that the window that takes effect
    // is the shared one (10 per app/env), not a local copy that could drift
    // from the deployment schema's defaults.
    const t = new JobsSubmissionThrottle(new InMemoryCounterStore(), JOBS_CAPACITY_DEFAULTS);
    for (let i = 0; i < JOBS_CAPACITY_DEFAULTS.submissionAttemptsPerAppEnv; i += 1) {
      expect(await t.consume("app-a", "prod")).toBe(true);
    }
    expect(await t.consume("app-a", "prod")).toBe(false);
  });
});
