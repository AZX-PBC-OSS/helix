import type { Env } from "@azx-pbc/shared";
import type { JobsCapacityLimits } from "@azx-pbc/shared";
import type { CounterStore } from "./counterStore.js";

/**
 * The submission throttle buckets (background-jobs-plane design §4, ADR-0003):
 * two fixed windows an authorized submission attempt consumes —
 *
 *  - per app/environment (`submissionAttemptsPerAppEnv`, default 10), and
 *  - one deployment-wide aggregate (`submissionAttemptsDeployment`, default 100)
 *    shared across serving edge replicas and every configured server.
 *
 * Operators tune both windows and their length through `EDGE_JOBS_LIMITS`;
 * the composition passes the resolved limits in, so there is no default here.
 *
 * The route calls {@link consume} only after the caller has passed the jobs
 * gates and holds a grant for the requested type on a configured server, so a
 * caller with no grant can spend neither window. The windows are checked in
 * order, per-app first: an attempt the per-app window refuses never reaches
 * the deployment window, so one app over its own limit cannot drain the
 * allowance every other app shares.
 *
 * A buggy client must not multiply its allowance: the bucket keys carry **no
 * server id and no type** — another server prefix (or a type rename) adds no
 * edge allowance — and there is no refund: an authorized attempt is charged
 * when it reaches the throttle, and replays, invalid input, refusals and
 * uncertain endings all stay charged. An exhausted window answers 429
 * `rate_limited` until the window rolls; adjacent-window bursts are the
 * fixed-window counter's own contract, not this class's.
 *
 * The store is the shared {@link CounterStore} primitive — Postgres-backed on
 * the edge so the limit holds across the edge fleet (issue #13's shape), in
 * memory for tests and for the dev gateway. The dev gateway's role has no
 * grant on the shared counter table, so its dev-tier windows are its own and
 * never count toward the edge's deployment-wide window. Status/result/cancel
 * never touch these buckets: they keep their ordinary request controls.
 */
export class JobsSubmissionThrottle {
  readonly #limits: JobsCapacityLimits;
  readonly #store: CounterStore;

  constructor(store: CounterStore, limits: JobsCapacityLimits) {
    this.#limits = limits;
    this.#store = store;
  }

  /**
   * Charge one authorized attempt and report whether it is within budget.
   * The per-app/env window is charged first; only an attempt it admits is
   * charged to the deployment window. `false` means a window refused it — the
   * caller answers 429 `rate_limited` — and every charge made stands.
   */
  async consume(appId: string, env: Env): Promise<boolean> {
    const windowMs = this.#limits.submissionWindowSeconds * 1_000;
    const appEnvCount = await this.#store.bump(`jobs:submit:app:${env}:${appId}`, windowMs);
    if (appEnvCount > this.#limits.submissionAttemptsPerAppEnv) return false;
    const deploymentCount = await this.#store.bump("jobs:submit:deployment", windowMs);
    return deploymentCount <= this.#limits.submissionAttemptsDeployment;
  }
}
