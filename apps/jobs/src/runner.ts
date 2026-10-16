import { PgBoss } from "pg-boss";

import { createPgbossEnqueuer, type JobsEnqueuer } from "./acceptance.js";
import { jobsRuntimeBossOptions } from "./policy.js";

/**
 * The jobs service's runtime runner — the one pg-boss instance the service
 * composes, owned by its supervised start (ADR-0009: boot owns supervision
 * and resource lifetime). The instance is the enqueue half of the acceptance
 * seam today; the worker tickets register their execution on the same
 * instance, so one queue, one pool and one maintenance lifecycle serve the
 * whole service.
 *
 * Starting is health-first, like every store in this service: the instance's
 * own start runs a read-only schema check (`migrate: false`) and refuses a
 * missing or behind schema — so it cannot start before the migration command
 * has run, and it must not fail the boot when it cannot. `start()` therefore
 * only begins a bounded retry loop; each failed attempt is logged and retried
 * with capped backoff until the store verifies and the instance comes up.
 * Until then the enqueue refuses — the admission's failure contract answers
 * that as retryable unavailability, which is the honest answer: nothing can
 * be durably enqueued into a store that has not come up.
 */

export interface JobsRunnerOptions {
  databaseUrl: string;
  /** Per-attempt ceiling, applied as the instance pool's statement and connect timeout. */
  statementTimeoutMs: number;
  /** First retry delay after a failed start attempt. */
  retryInitialMs?: number;
  /** The cap the retry backoff never exceeds. */
  retryMaxMs?: number;
  log: JobsRunnerLogger;
}

/** The structural logger the runner reports through (the pino surface, without importing Fastify). */
export interface JobsRunnerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

const RETRY_INITIAL_MS = 1_000;
const RETRY_MAX_MS = 30_000;

export class JobsRunner {
  private readonly databaseUrl: string;
  private readonly statementTimeoutMs: number;
  private readonly retryInitialMs: number;
  private readonly retryMaxMs: number;
  private readonly log: JobsRunnerLogger;

  private boss: PgBoss | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private started = false;
  private failedStarts = 0;

  constructor(options: JobsRunnerOptions) {
    this.databaseUrl = options.databaseUrl;
    this.statementTimeoutMs = options.statementTimeoutMs;
    this.retryInitialMs = options.retryInitialMs ?? RETRY_INITIAL_MS;
    this.retryMaxMs = options.retryMaxMs ?? RETRY_MAX_MS;
    this.log = options.log;
  }

  /**
   * Begin the supervised start. Never throws and never awaits the first
   * attempt: the listener comes up regardless, and the enqueue refuses until
   * an attempt succeeds.
   */
  start(): void {
    if (this.boss || this.stopped) return;
    this.boss = new PgBoss({
      connectionString: this.databaseUrl,
      connectionTimeoutMillis: this.statementTimeoutMs,
      // The per-statement ceiling rides the connection options string —
      // pg-boss's own pool config has no dedicated statement-timeout field.
      options: `-c statement_timeout=${this.statementTimeoutMs}`,
      ...jobsRuntimeBossOptions(),
    });
    // pg-boss emits the errors its own loops absorbed (a failed maintenance
    // pass, a dropped pool client) on its event emitter; unhandled, they
    // would kill the process. The storage supervisor's probes and each
    // operation's own failure carry the causes an operator needs; this
    // listener keeps the service alive through them.
    this.boss.on("error", (error) => {
      this.log.warn(
        { event: "jobs.runner.instance_error", err: error },
        "the runner emitted an error from its own supervision",
      );
    });
    void this.runAttempt();
  }

  /**
   * Stop the retry loop and the instance — every exit path's release. Safe
   * to call twice and safe before start; the runner does not restart after
   * stop.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.inFlight;
    const boss = this.boss;
    this.boss = null;
    this.started = false;
    await boss?.stop({ graceful: true, timeout: 5_000 }).catch(() => {});
  }

  /**
   * The enqueue adapter over this instance — the acceptance transaction's
   * borrowed-connection enqueue. Refuses while the runner has not started:
   * the admission's failure contract answers that as retryable unavailability.
   */
  get enqueuer(): JobsEnqueuer {
    return {
      enqueue: async (withinTx, job) =>
        createPgbossEnqueuer(this.requireBoss()).enqueue(withinTx, job),
    };
  }

  /** The started instance, or the refusal every early consumer answers. */
  private requireBoss(): PgBoss {
    if (!this.started || !this.boss) {
      throw new Error("the runner has not started — nothing can be enqueued yet");
    }
    return this.boss;
  }

  private runAttempt(): Promise<void> {
    const attempt = this.attemptOnce();
    this.inFlight = attempt;
    return attempt;
  }

  /**
   * One bounded start attempt, then the next wait until one succeeds. Never
   * throws out of here: a failed attempt is logged and retried, which is the
   * loop's whole job.
   */
  private async attemptOnce(): Promise<void> {
    if (this.stopped || !this.boss || this.started) return;
    try {
      await this.boss.start();
      this.started = true;
      this.failedStarts = 0;
      this.log.info(
        { event: "jobs.runner.started" },
        "the runner started against its store — enqueue and execution are available",
      );
    } catch (error) {
      this.failedStarts += 1;
      this.log.warn(
        { event: "jobs.runner.start_failed", err: error },
        "the runner could not start — the store is not usable yet; retrying",
      );
    }
    if (this.stopped || this.started || !this.boss) return;
    this.scheduleNext();
  }

  /** The capped backoff between failed start attempts. */
  private scheduleNext(): void {
    if (this.stopped || this.started) return;
    const delay = Math.min(
      this.retryInitialMs * 2 ** Math.max(0, this.failedStarts - 1),
      this.retryMaxMs,
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runAttempt();
    }, delay);
    // Never hold the process open for a start attempt: the listener and the
    // graceful shutdown own this process's lifetime, and stop() clears the
    // timer anyway.
    this.timer.unref();
  }
}
