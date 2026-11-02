import type { Pool, PoolClient } from "pg";

import {
  ATTR_JOBS_INTAKE_CHANGED,
  ATTR_JOBS_SERVER,
  ATTR_OUTCOME,
  type JobsIntakeOutcome,
} from "@azx-pbc/shared/telemetry";

import { JOBS_ADMISSION_LOCK_KEY } from "./acceptance.js";
import { createJobsPool, withJobsClient } from "./pool.js";
import { JOBS_INTAKE_QUALIFIED, JOBS_JOB_RECORD_QUALIFIED } from "./policy.js";
import { withIntakeSpan } from "./telemetry.js";

/**
 * The intake closure applier — the component that makes this process's
 * configured intake posture (`JOBS_ACCEPTING`) durable on the store, so every
 * replica's admissions honor it and the closure survives restarts.
 *
 * The apply is one transaction that takes the same transaction-scoped
 * advisory lock new-work admissions take (`JOBS_ADMISSION_LOCK_KEY`): it
 * waits for any admission currently holding the lock to commit, and every
 * admission that acquires the lock afterwards reads the new state — the
 * serialization a closure needs so it never retroactively refuses an
 * in-flight enqueue. The transaction also binds the store to this server id
 * (and refuses when the store already belongs to another), so two servers
 * configured against one database cannot each believe they own it.
 *
 * Supervision mirrors the service's other stores (`src/lifecycle.ts`,
 * `src/cleanup.ts`): `start()` never throws and never blocks — the first
 * apply attempt runs in the background; a store that will not answer retries
 * on a capped backoff; a REFUSAL stops the retrying (reopening needs an
 * operator fix and a restart, never a lunge); and `stop()` releases the pool
 * and the timer on every exit path. Until the apply lands, admissions follow
 * this process's configured posture AND the durable row's previous state, so
 * a closed configuration refuses immediately while a reopening one waits for
 * its apply; the `jobs_intake` health check reports the gap.
 */

/** What one intake apply decided. */
export type JobsIntakeApplyOutcome =
  /** The configured posture is durable (`accepting` as configured; `changed` says whether the row moved). */
  | { kind: "applied"; accepting: boolean; changed: boolean }
  /** The store is bound to another server's namespace; nothing was written. */
  | { kind: "refused"; boundServer: string }
  /** The store could not answer; nothing was written. */
  | { kind: "unavailable" };

/** The intake apply's supervision state, as `/health` reports it. */
export interface JobsIntakeSnapshot {
  /** The posture this process is configured with (`JOBS_ACCEPTING`). */
  configuredAccepting: boolean;
  /** `pending`: started, no settled apply yet; `applied`/`refused`: the last apply's exit. */
  phase: "not_started" | "pending" | "applied" | "refused";
  /** The server namespace the store was found bound to, on a refusal; null otherwise. */
  boundServer: string | null;
  /** Wall-clock ISO instant of the last successful apply. */
  appliedAt: string | null;
  /** Wall-clock ISO instant of the last apply attempt, of any outcome. */
  lastAttemptAt: string | null;
}

/** The structural logger the store reports through (the pino surface, without importing Fastify). */
export interface JobsIntakeLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface JobsIntakeOptions {
  databaseUrl: string;
  /** Per-query ceiling, applied as both the pool's statement and connect timeout. */
  statementTimeoutMs: number;
  /** The configured job server this instance runs as — the namespace it binds the store to. */
  serverId: string;
  /** The posture to apply durably: `true` admits new work, `false` closes intake. */
  accepting: boolean;
  /** The capped backoff a failed apply retries under; defaults to 1 s doubling to 30 s. */
  retry?: { initialMs: number; maxMs: number };
  log: JobsIntakeLogger;
}

/** The runtime pool stays minimal: one serialized transaction at a time. */
const POOL_MAX = 1;

const RETRY_INITIAL_MS = 1_000;
const RETRY_MAX_MS = 30_000;

export class JobsIntake {
  private readonly databaseUrl: string;
  private readonly statementTimeoutMs: number;
  private readonly serverId: string;
  private readonly accepting: boolean;
  private readonly retryInitialMs: number;
  private readonly retryMaxMs: number;
  private readonly log: JobsIntakeLogger;

  private pool: Pool | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** The supervised attempt in flight — the one `stop()` awaits. */
  private supervised: Promise<void> | null = null;
  /** The apply transaction in flight — a concurrent `applyOnce` coalesces into it (the write is idempotent). */
  private inFlight: Promise<JobsIntakeApplyOutcome> | null = null;
  private stopped = false;
  /** The next failed attempt's backoff step — the capped ladder's position. */
  private backoffMs: number;

  private current: JobsIntakeSnapshot;

  constructor(options: JobsIntakeOptions) {
    this.databaseUrl = options.databaseUrl;
    this.statementTimeoutMs = options.statementTimeoutMs;
    this.serverId = options.serverId;
    this.accepting = options.accepting;
    this.retryInitialMs = options.retry?.initialMs ?? RETRY_INITIAL_MS;
    this.retryMaxMs = options.retry?.maxMs ?? RETRY_MAX_MS;
    this.log = options.log;
    this.backoffMs = this.retryInitialMs;
    this.current = {
      configuredAccepting: this.accepting,
      phase: "not_started",
      boundServer: null,
      appliedAt: null,
      lastAttemptAt: null,
    };
  }

  /**
   * Begin applying. Never throws and never blocks the caller: the first
   * attempt runs immediately in the background, and a store that will not
   * answer leaves the service alive — the attempts retry, and the health
   * body says the state is not yet applied.
   */
  start(): void {
    if (this.pool || this.stopped) return;
    this.current = { ...this.current, phase: "pending" };
    this.pool = createJobsPool({
      databaseUrl: this.databaseUrl,
      statementTimeoutMs: this.statementTimeoutMs,
      max: POOL_MAX,
      onClientError: (err, phase) => {
        this.log.warn(
          { event: "jobs.intake.pool_error", phase, err },
          "pooled jobs intake client dropped",
        );
      },
    });
    this.scheduleAttempt(0);
  }

  /**
   * Stop retrying and release the pool — every exit path's release: the
   * timer is cleared, the in-flight attempt is awaited so no client is
   * pulled out from under itself, and the pool ends. Safe to call twice and
   * safe before start; the applier does not restart after stop.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.supervised;
    const pool = this.pool;
    this.pool = null;
    await pool?.end();
  }

  /** The supervision state, for `/health` — a lookup, never a live probe. */
  snapshot(): JobsIntakeSnapshot {
    return { ...this.current };
  }

  /**
   * One apply attempt — the transaction, and the seam a caller (or a test)
   * drives synchronously. Never throws for a store that will not answer
   * (that is the `unavailable` verdict); a store that is not running does
   * throw, like the service's other stores. An attempt that arrives while
   * another is running coalesces into it — the write is idempotent, so a
   * repeated apply is harmless.
   */
  applyOnce(): Promise<JobsIntakeApplyOutcome> {
    const pool = this.pool;
    if (this.stopped || !pool) {
      return Promise.reject(new Error("the intake store is not running"));
    }
    if (this.inFlight) return this.inFlight;
    const attempt = this.runApply();
    this.inFlight = attempt;
    const clear = (): void => {
      if (this.inFlight === attempt) this.inFlight = null;
    };
    // Both halves: a rejected attempt must release the guard exactly like a
    // settled one, and this derived chain must never reject unhandled.
    void attempt.then(clear, clear);
    return attempt;
  }

  private scheduleAttempt(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const attempt = this.supervisedAttempt();
      this.supervised = attempt;
      const reschedule = (): void => {
        if (this.supervised === attempt) this.supervised = null;
        if (this.stopped) return;
        // Only an unavailable attempt retries: a refusal needs an operator
        // fix and a restart, and a settled apply is done.
        if (this.current.phase === "pending") {
          this.scheduleAttempt(this.backoffMs);
          this.backoffMs = Math.min(this.backoffMs * 2, this.retryMaxMs);
        }
      };
      void attempt.then(reschedule, reschedule);
    }, delayMs);
    // Never hold the process open for an attempt: the listener and the
    // graceful shutdown own this process's lifetime, and stop() clears the
    // timer anyway.
    this.timer.unref();
  }

  /** One supervised attempt: apply, absorbing the rejection that cannot happen on a running pool. */
  private async supervisedAttempt(): Promise<void> {
    try {
      await this.applyOnce();
    } catch (error) {
      this.log.warn(
        { event: "jobs.intake.attempt_rejected", err: error },
        "an intake attempt rejected out of its own accounting — the retry continues",
      );
    }
  }

  private async runApply(): Promise<JobsIntakeApplyOutcome> {
    const pool = this.pool;
    if (this.stopped || !pool) {
      throw new Error("the intake store is not running");
    }
    return withIntakeSpan(async (span) => {
      this.current = { ...this.current, lastAttemptAt: new Date().toISOString() };
      try {
        const outcome = await withJobsClient(pool, (client) => this.transact(client));
        const word: JobsIntakeOutcome =
          outcome.kind === "applied" ? (outcome.accepting ? "opened" : "closed") : outcome.kind;
        span.setAttributes({
          [ATTR_OUTCOME]: word,
          [ATTR_JOBS_SERVER]: this.serverId,
          ...(outcome.kind === "applied" ? { [ATTR_JOBS_INTAKE_CHANGED]: outcome.changed } : {}),
        });
        return outcome;
      } catch (error) {
        // A checkout that cannot connect (the store down) never reaches the
        // transaction's own catch: the verdict is the same unavailable one,
        // logged here.
        this.log.warn(
          { event: "jobs.intake.apply_failed", err: error },
          "the intake apply could not run — the configured state is not yet durable",
        );
        span.setAttributes({
          [ATTR_OUTCOME]: "unavailable" satisfies JobsIntakeOutcome,
          [ATTR_JOBS_SERVER]: this.serverId,
        });
        return { kind: "unavailable" };
      }
    });
  }

  /**
   * One apply as one transaction: take the admission lock (serializing with
   * every in-flight enqueue transaction, here and on every other replica),
   * judge the repointing guard, write the configured state, commit. A store
   * error — including an absent intake row, which only a missing migration
   * produces — rolls the transaction back and answers `unavailable`.
   */
  private async transact(client: PoolClient): Promise<JobsIntakeApplyOutcome> {
    await client.query("BEGIN");
    try {
      // The repointing guard, record half: a store holding another server's
      // job records is refused, never rebound. The scan runs before the
      // admission lock so a large retained store never holds admissions
      // behind it.
      const foreign = await client.query<{ server: string }>(
        `SELECT server
           FROM ${JOBS_JOB_RECORD_QUALIFIED}
          WHERE server <> $1
          LIMIT 1`,
        [this.serverId],
      );
      const foreignRow = foreign.rows[0];
      if (foreignRow !== undefined) {
        await client.query("ROLLBACK").catch(() => {});
        this.recordRefused(foreignRow.server);
        return { kind: "refused", boundServer: foreignRow.server };
      }
      await client.query("SELECT pg_advisory_xact_lock($1)", [JOBS_ADMISSION_LOCK_KEY]);
      const current = await client.query<{ accepting: boolean; server: string | null }>(
        `SELECT accepting, server
           FROM ${JOBS_INTAKE_QUALIFIED}
          WHERE singleton
         FOR UPDATE`,
      );
      const row = current.rows[0];
      if (!row) {
        throw new Error(
          "the intake row is absent — the migration seeds it; run the migration command",
        );
      }
      // The repointing guard, row half: a store already bound to another
      // server's namespace is refused, never rebound. Nothing is written on a
      // refusal.
      if (row.server !== null && row.server !== this.serverId) {
        await client.query("ROLLBACK").catch(() => {});
        this.recordRefused(row.server);
        return { kind: "refused", boundServer: row.server };
      }
      const changed = row.accepting !== this.accepting;
      await client.query(
        `UPDATE ${JOBS_INTAKE_QUALIFIED}
            SET accepting = $1,
                server = $2,
                changed_at = CASE WHEN accepting IS DISTINCT FROM $1 THEN now() ELSE changed_at END`,
        [this.accepting, this.serverId],
      );
      await client.query("COMMIT");
      this.current = {
        ...this.current,
        phase: "applied",
        boundServer: null,
        appliedAt: new Date().toISOString(),
      };
      this.log.info(
        {
          event: "jobs.intake.applied",
          serverId: this.serverId,
          accepting: this.accepting,
          changed,
        },
        this.accepting
          ? "the intake is open: new work is admitted while both this process's posture and the durable row say so"
          : "the intake is closed: new work is refused from this point, and in-flight admissions committed before it keep their acceptance",
      );
      return { kind: "applied", accepting: this.accepting, changed };
    } catch (error) {
      // The apply failed or the store refused: nothing this transaction did
      // may survive. On a dead socket the ROLLBACK itself rejects through
      // pg's handleError — the same death the client-level listener
      // recorded — and the release destroys that client.
      await client.query("ROLLBACK").catch(() => {});
      this.log.warn(
        { event: "jobs.intake.apply_failed", err: error },
        "the intake apply could not run — the configured state is not yet durable",
      );
      return { kind: "unavailable" };
    }
  }

  private recordRefused(boundServer: string): void {
    this.current = {
      ...this.current,
      phase: "refused",
      boundServer,
    };
    this.log.error(
      { event: "jobs.intake.refused", serverId: this.serverId, boundServer },
      "the store is bound to another server's namespace — the intake state is not applied; repoint the configuration or the store and restart",
    );
  }
}
