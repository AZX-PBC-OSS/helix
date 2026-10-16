import { PgBoss } from "pg-boss";

import { createPgbossEnqueuer, type JobsEnqueuer } from "./acceptance.js";
import { JOBS_QUEUE_NAME, jobsRuntimeBossOptions } from "./policy.js";
import type { RunnerJobLookup } from "./recovery.js";

/**
 * The jobs service's runtime runner — the one pg-boss instance the service
 * composes, owned by its supervised start (ADR-0009: boot owns supervision
 * and resource lifetime). The instance carries the acceptance seam's enqueue
 * half and the execution worker: the composition's `registerWorker` hook is
 * invoked on the started instance, and a registration failure is a failed
 * start — the half-started instance is discarded and the loop retries, so a
 * listener without its worker never reports healthy.
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

/**
 * The runner row read behind {@link JobsRunner.jobState} — the pinned
 * adapter's public job read, mapped down to the lookup's own vocabulary. One
 * spelling for the runner's method and for any caller holding a started
 * instance, so the lookup's shape cannot drift between them.
 */
export async function readRunnerJobState(
  boss: PgBoss,
  runnerJobId: string,
): Promise<RunnerJobLookup> {
  try {
    const job = await boss.getJobById(JOBS_QUEUE_NAME, runnerJobId);
    if (!job) return { verdict: "missing" };
    return { verdict: "found", state: job.state, output: job.output };
  } catch (error) {
    return {
      verdict: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The runner's supervision state, as `/health` reports it. */
export interface JobsRunnerSnapshot {
  /** The instance is started against its store. */
  started: boolean;
  /** The composition's worker registration completed on the started instance. */
  workerRegistered: boolean;
}

export interface JobsRunnerOptions {
  databaseUrl: string;
  /** Per-attempt ceiling, applied as the instance pool's statement and connect timeout. */
  statementTimeoutMs: number;
  /**
   * The worker registration, invoked on the started instance as part of every
   * start attempt — its failure is a failed start (the instance is discarded
   * and the loop retries), and its success is what `workerRegistered`
   * reports. Required: a runner without its worker is not a serving runner.
   */
  registerWorker: (boss: PgBoss) => Promise<void>;
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
  /** The rejection reports (a start attempt whose own reporting threw) are infrastructure faults. */
  error(obj: Record<string, unknown>, msg: string): void;
}

const RETRY_INITIAL_MS = 1_000;
const RETRY_MAX_MS = 30_000;

export class JobsRunner {
  private readonly databaseUrl: string;
  private readonly statementTimeoutMs: number;
  private readonly registerWorker: (boss: PgBoss) => Promise<void>;
  private readonly retryInitialMs: number;
  private readonly retryMaxMs: number;
  private readonly log: JobsRunnerLogger;

  private boss: PgBoss | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private begun = false;
  private started = false;
  private workerRegistered = false;
  private failedStarts = 0;

  constructor(options: JobsRunnerOptions) {
    this.databaseUrl = options.databaseUrl;
    this.statementTimeoutMs = options.statementTimeoutMs;
    this.registerWorker = options.registerWorker;
    this.retryInitialMs = options.retryInitialMs ?? RETRY_INITIAL_MS;
    this.retryMaxMs = options.retryMaxMs ?? RETRY_MAX_MS;
    this.log = options.log;
  }

  /** The supervision state, for `/health` — a lookup, never a live probe. */
  get snapshot(): JobsRunnerSnapshot {
    return { started: this.started, workerRegistered: this.workerRegistered };
  }

  /**
   * Begin the supervised start. Never throws and never awaits the first
   * attempt: the listener comes up regardless, and the enqueue refuses until
   * an attempt succeeds.
   */
  start(): void {
    // One supervised loop per runner: the retry attempts discard their
    // instances, so the instance's presence is not the "already begun" sign.
    if (this.begun || this.stopped) return;
    this.begun = true;
    this.boss = this.buildBoss();
    // A rejected attempt (its own reporting threw) must not become an
    // unhandled rejection — the report is sink-guarded because the sink
    // throwing is exactly how an attempt comes to reject here.
    this.launchAttempt();
  }

  /**
   * The guarded launch every start attempt gets — the first from `start()`,
   * the rest from the backoff timer's callback. A rejected attempt (its own
   * reporting threw) must not become an unhandled rejection in the process
   * the runner serves: the report is sink-guarded, and the attempt's own
   * `finally` has already scheduled the next one.
   */
  private launchAttempt(): void {
    void this.runAttempt().catch((error) => {
      try {
        this.log.error(
          { event: "jobs.runner.attempt_rejected", err: error },
          "a runner start attempt rejected out of its own failure reporting — the loop continues",
        );
      } catch {
        // The reporting sink is the rejection's origin; survival is the point.
      }
    });
  }

  /**
   * The instance, built with the runtime's own options (`migrate: false`, no
   * schedules, no native OpenTelemetry) and this attempt's timeouts, with its
   * error containment attached — here, at the construction, not in `start()`:
   * a fresh one per retry (a half-started instance is discarded below, never
   * reused), and EVERY attempt's instance must be contained, not only the
   * first. pg-boss emits the errors its own loops absorbed (a failed
   * maintenance pass, a dropped pool client) on its event emitter; unhandled,
   * they would kill the process — an `error` emission with no listener throws
   * out of the emitter, and from a maintenance timer that is an uncaught
   * exception. The storage supervisor's probes and each operation's own
   * failure carry the causes an operator needs; this listener keeps the
   * service alive through them.
   */
  private buildBoss(): PgBoss {
    const boss = new PgBoss({
      connectionString: this.databaseUrl,
      connectionTimeoutMillis: this.statementTimeoutMs,
      // The per-statement ceiling rides the connection options string —
      // pg-boss's own pool config has no dedicated statement-timeout field.
      options: `-c statement_timeout=${this.statementTimeoutMs}`,
      ...jobsRuntimeBossOptions(),
    });
    boss.on("error", (error) => {
      this.log.warn(
        { event: "jobs.runner.instance_error", err: error },
        "the runner emitted an error from its own supervision",
      );
    });
    return boss;
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
    // A rejected attempt must not break the release chain: its instance
    // still stops. The report is sink-guarded because the sink throwing is
    // exactly how an attempt comes to reject here.
    await this.inFlight?.catch((error) => {
      try {
        this.log.error(
          { event: "jobs.runner.attempt_rejected", err: error },
          "a runner start attempt rejected out of its own failure reporting — the release continues",
        );
      } catch {
        // The reporting sink is the rejection's origin; the release below is
        // the part that must survive.
      }
    });
    const boss = this.boss;
    this.boss = null;
    this.started = false;
    this.workerRegistered = false;
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

  /**
   * One runner row's own durable state, read through the pinned adapter's
   * public job read — the recovery sweeper's lookup seam, and nothing else's:
   * the wrapper projections and the enqueue have their own paths. Answers
   * `unavailable` while the runner has not started (there is no instance to
   * read through — the sweeper's pass retries on its next cadence) and when
   * the read itself fails; `missing` is the adapter's own answer for an id
   * with no row, which for a committed wrapper record is corruption the
   * sweeper reports.
   */
  async jobState(runnerJobId: string): Promise<RunnerJobLookup> {
    if (!this.started || !this.boss) {
      return { verdict: "unavailable", reason: "the runner has not started" };
    }
    return readRunnerJobState(this.boss, runnerJobId);
  }

  private runAttempt(): Promise<void> {
    const attempt = this.attemptOnce();
    this.inFlight = attempt;
    return attempt;
  }

  /**
   * One bounded start attempt — the instance's start, then the worker
   * registration — then the next wait until one succeeds. Never rejects out
   * of here except through its own reporting (a sink that threw): the
   * scheduling in the outer `finally` is what keeps the loop alive across
   * every failure, reported or not.
   */
  private async attemptOnce(): Promise<void> {
    if (this.stopped || this.started) return;
    const boss = this.boss ?? this.buildBoss();
    this.boss = boss;
    try {
      try {
        await boss.start();
        await this.registerWorker(boss);
        this.started = true;
        this.workerRegistered = true;
        this.failedStarts = 0;
        // The start's effect is committed above; the success report is its
        // evidence, not the effect — a sink that throws here must not fail
        // a serving start into the catch's discard-and-retry path (a
        // healthy instance discarded, `started` true over no instance, and
        // no retry ever scheduled: the bricked runner). The snapshot and
        // /health carry the state while the sink is down.
        try {
          this.log.info(
            { event: "jobs.runner.started" },
            "the runner started against its store — the enqueue and the worker are up",
          );
        } catch {
          // The reporting sink is down; nothing about the start failed.
        }
      } catch (error) {
        this.failedStarts += 1;
        this.workerRegistered = false;
        // The discard and the next attempt's scheduling must survive a
        // reporting failure: whether or not the failure could be logged, the
        // half-started instance is released and the loop continues.
        try {
          this.log.warn(
            { event: "jobs.runner.start_failed", err: error },
            "the runner could not start — the store is not usable yet or the worker registration failed; retrying",
          );
        } finally {
          // A half-started instance — the store verified but the registration
          // failed — is discarded: the next attempt builds a fresh one rather
          // than re-registering onto an instance whose own loops are
          // mid-flight. A discard whose own stop fails abandons that
          // instance's pool to the server's idle reaper — reported, never
          // silent.
          this.boss = null;
          await boss.stop({ graceful: true, timeout: 5_000 }).catch((stopError) => {
            try {
              this.log.warn(
                { event: "jobs.runner.discard_stop_failed", err: stopError },
                "a discarded instance's stop failed — its pool is left for the server to reap",
              );
            } catch {
              // The reporting sink is already failing; the discard report is
              // best-effort.
            }
          });
        }
      }
    } finally {
      if (!this.stopped && !this.started) this.scheduleNext();
    }
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
      this.launchAttempt();
    }, delay);
    // Never hold the process open for a start attempt: the listener and the
    // graceful shutdown own this process's lifetime, and stop() clears the
    // timer anyway.
    this.timer.unref();
  }
}
