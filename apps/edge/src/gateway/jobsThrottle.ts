import type { Env } from "@azx-pbc/shared";
import { resolveJobsCapacityLimits, type JobsCapacityLimits } from "@azx-pbc/shared";
import type { CounterStore } from "./counterStore.js";

/**
 * The submission throttle buckets (background-jobs-plane design §4, ADR-0003):
 * two fixed windows every authenticated submission attempt consumes —
 *
 *  - per app/environment (`submissionAttemptsPerAppEnv`, default 10), and
 *  - one deployment-wide aggregate (`submissionAttemptsDeployment`, default 100)
 *    shared across serving replicas, environments and every configured server.
 *
 * A buggy client must not multiply its allowance: the bucket keys carry **no
 * server id and no type** — another server prefix (or a type rename) adds no
 * edge allowance — and there is no refund: the attempt is charged when it
 * reaches the gate, and replays, invalid input, refusals and uncertain
 * endings all stay charged. An exhausted window answers 429 `rate_limited`
 * until the window rolls; adjacent-window bursts are the fixed-window
 * counter's own contract, not this class's.
 *
 * The store is the shared {@link CounterStore} primitive — Postgres-backed in
 * production so the limit holds across the edge fleet (issue #13's shape), in
 * memory for single-process tests and dev. Status/result/cancel never touch
 * these buckets: they keep their ordinary request controls.
 */
export class JobsSubmissionThrottle {
  readonly #limits: JobsCapacityLimits;
  readonly #store: CounterStore;

  constructor(store: CounterStore, limits: JobsCapacityLimits = resolveJobsCapacityLimits()) {
    this.#limits = limits;
    this.#store = store;
  }

  /**
   * Charge one authenticated attempt against both windows and report whether
   * it is within budget. `false` means at least one window was exhausted —
   * the caller answers 429 `rate_limited` — and the charge stands either way.
   */
  async consume(appId: string, env: Env): Promise<boolean> {
    const windowMs = this.#limits.submissionWindowSeconds * 1_000;
    const appEnvCount = await this.#store.bump(`jobs:submit:app:${env}:${appId}`, windowMs);
    const deploymentCount = await this.#store.bump("jobs:submit:deployment", windowMs);
    return (
      appEnvCount <= this.#limits.submissionAttemptsPerAppEnv &&
      deploymentCount <= this.#limits.submissionAttemptsDeployment
    );
  }
}
