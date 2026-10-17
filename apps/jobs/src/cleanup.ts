import type { Pool } from "pg";

import { JOB_TERMINAL_STATUSES } from "@azx-pbc/shared";
import {
  ATTR_JOBS_CLEANUP_RECORDS_RETIRED,
  ATTR_JOBS_CLEANUP_RESULTS_REMOVED,
  ATTR_OUTCOME,
  type JobsCleanupOutcome,
} from "@azx-pbc/shared/telemetry";

import { createJobsPool, withJobsClient } from "./pool.js";
import {
  JOBS_JOB_RECORD_QUALIFIED,
  JOBS_RECORD_TTL_SECONDS,
  JOBS_REMOVAL_GRACE_SECONDS,
  JOBS_RESULT_TTL_SECONDS,
} from "./policy.js";
import type { JobsRunnerDeleter } from "./runner.js";
import { countCleanup, withCleanupSpan } from "./telemetry.js";

/**
 * The jobs cleanup loop — the supervised cadence that owns the retention
 * contract's physical half (background-jobs-plane design §7): the logical
 * horizons make expired content unreadable from the instant it expires
 * (`src/observation.ts`); this loop is what releases the storage itself,
 * within the design's 48-hour bound after each boundary:
 *
 * - **The result arm** removes a successful result's bytes from live jobs
 *   storage once its seven-day lifetime has ended, converging the row's
 *   stored status to `expired` in the same statement — the stored form the
 *   store's own CHECK constraints were shaped for (`result` is legal only on
 *   a row projecting success, and a success always carries its result). The
 *   record itself stays: it is publicly readable as `expired` until its
 *   record horizon, and its retry key stays attached to it.
 * - **The record arm** retires, in ONE transaction per batch, every terminal
 *   record past its thirty-day record horizon together with the runner row
 *   it was accepted under — the primary record, its retry-key mapping, the
 *   attempts, progress, any remaining payload bytes and the runner row's
 *   stored input, all removed together (design §7: "prunes the primary row
 *   plus wrapper/key identity atomically"). The runner row's deletion rides
 *   the runner adapter's own borrowed-connection delete — no second copy of
 *   the pinned dependency's schema knowledge. Only terminal records are
 *   ever selected, so active work is never pruned by age: the absolute
 *   deadline's enforcement is the recovery sweeper's and the start gate's,
 *   and a terminal status is absorbing.
 *
 * The pass also measures the server-wide occupancy and the overdue content —
 * how much has already stood past its 48-hour removal deadline at the
 * pass's opening. That measurement is the evidence the `jobs_capacity`
 * check (retained saturation) and the `jobs_cleanup` check (overdue cleanup)
 * grade: a loop that cannot run leaves the evidence stale, and a backlog
 * past the bound reads degraded until a pass has actually cleared it.
 *
 * Supervision mirrors the service's other loops (`src/recovery.ts`,
 * `src/burns.ts`): `start()` never throws, each pass is bounded (batch caps,
 * the pool's statement and connect timeouts), a failed pass is counted,
 * logged and never ends the cadence, `stop()` releases the pool and the
 * timer on every exit path, and a pass that removed a full batch is
 * immediately followed by the next — a backlog left by an outage converges
 * in minutes of drained passes instead of standing on the cadence. A
 * FAILED pass retries on the storage supervisor's capped backoff, not the
 * steady cadence: the recovery after a repair is measured in seconds, and a
 * long outage's retry rate is bounded.
 */

/** The pass's evidence for the two cleanup-owned health checks — measured server-wide, at the pass's opening. */
export interface JobsCleanupEvidence {
  /** Every physically stored job of the server — active or terminal, until the record arm removes it. */
  retainedServer: number;
  /** Nonterminal jobs of the server — the occupancy the admission caps count. */
  unfinishedServer: number;
  /** Result bytes still stored past their 48-hour removal deadline. */
  overdueResults: number;
  /** Whole records (with their runner rows and retry keys) still stored past their 48-hour removal deadline. */
  overdueRecords: number;
}

/** The cleanup loop's supervision state, as `/health` reports it. */
export interface JobsCleanupSnapshot {
  /** The loop has been started (its first pass may not have completed yet). */
  started: boolean;
  /** Passes run since start, successful or not. */
  passes: number;
  /** Wall-clock ISO instant of the last completed pass, of any outcome. */
  lastPassAt: string | null;
  /** Wall-clock ISO instant of the last pass that could complete its removals and measurement. */
  lastOkPassAt: string | null;
  /** Results removed from live storage since start. */
  resultsRemoved: number;
  /** Records retired (each with its runner row and retry mapping) since start. */
  recordsRetired: number;
  /** The last successful pass's measurement; a failed pass leaves the previous one standing. */
  evidence: JobsCleanupEvidence | null;
}

/** The structural logger the loop reports through (the pino surface, without importing Fastify). */
export interface JobsCleanupLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface JobsCleanupOptions {
  databaseUrl: string;
  /** Per-query ceiling, applied as both the pool's statement and connect timeout. */
  statementTimeoutMs: number;
  /**
   * The runner-row retirement the record arm's transaction borrows — the
   * composition's runner adapter (`runner.deleter`). Required: a cleanup
   * that cannot reach the runner rows must roll its retirement back, never
   * orphan a runner row's stored input behind a removed record.
   */
  deleteRunnerRows: JobsRunnerDeleter;
  /** The cadence between passes. */
  intervalMs?: number;
  /** The largest number of rows each arm of one pass touches — the bound that keeps a pass bounded. */
  batch?: number;
  log: JobsCleanupLogger;
}

/** Steady cleanup cadence — how long content past a logical horizon can wait for its removal. */
const CLEANUP_INTERVAL_MS = 60_000;
/**
 * The capped backoff a FAILED pass retries under — the storage supervisor's
 * ladder: a pass failed because the store could not answer, and waiting the
 * steady cadence to re-learn that would stretch the recovery after a repair
 * (a schema migration landing, a store coming back) to a full cadence. The
 * first retry follows in seconds; the cap keeps a long outage's passes at a
 * bounded rate.
 */
const CLEANUP_RETRY_INITIAL_MS = 1_000;
const CLEANUP_RETRY_MAX_MS = 30_000;
/** One arm of one pass touches at most this many rows; the next pass continues the work. */
const CLEANUP_BATCH = 500;
/**
 * The gap between passes while a backlog is draining — a pass that removed a
 * full batch is followed by the next one here, not at the steady cadence.
 * The steady cadence alone meets the design's 48-hour restoration bound at
 * the retained ceiling (~33 hours of passes for a million-row backlog); the
 * drain is the margin, and it is what lets the `jobs_cleanup` check's
 * overdue reading clear in minutes after a restoration instead of standing
 * degraded for a day and a half.
 */
const CLEANUP_DRAIN_DELAY_MS = 1_000;
/**
 * How long without a successful pass the `jobs_cleanup` and `jobs_capacity`
 * checks wait before reading the evidence stale — three cadences, the same
 * multiple the sweeper check uses.
 */
export const JOBS_CLEANUP_STALE_AFTER_MS = 3 * CLEANUP_INTERVAL_MS;

/** The runtime pool stays small: one measurement and two bounded writes per pass. */
const POOL_MAX = 2;

export class JobsCleanup {
  private readonly databaseUrl: string;
  private readonly statementTimeoutMs: number;
  private readonly deleteRunnerRows: JobsRunnerDeleter;
  private readonly intervalMs: number;
  private readonly batch: number;
  private readonly log: JobsCleanupLogger;

  private pool: Pool | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  /**
   * The delay the pass that last settled asked the reschedule to wait — the
   * drain signal, the steady cadence, or a failed pass's backoff step. Passes
   * never overlap (the single-flight guard), so the value is always the last
   * pass's own answer.
   */
  private nextDelayMs = CLEANUP_INTERVAL_MS;
  /** Failed passes since the last successful one — the backoff ladder's step. */
  private failedPasses = 0;

  private current: JobsCleanupSnapshot = {
    started: false,
    passes: 0,
    lastPassAt: null,
    lastOkPassAt: null,
    resultsRemoved: 0,
    recordsRetired: 0,
    evidence: null,
  };

  constructor(options: JobsCleanupOptions) {
    this.databaseUrl = options.databaseUrl;
    this.statementTimeoutMs = options.statementTimeoutMs;
    this.deleteRunnerRows = options.deleteRunnerRows;
    this.intervalMs = options.intervalMs ?? CLEANUP_INTERVAL_MS;
    this.batch = options.batch ?? CLEANUP_BATCH;
    this.log = options.log;
  }

  /**
   * Begin the cadence. Never throws and never blocks the caller: the first
   * pass runs immediately in the background, and a store that will not
   * answer leaves the service alive — the passes retry, and the health body
   * says so.
   */
  start(): void {
    if (this.pool || this.stopped) return;
    this.current = { ...this.current, started: true };
    this.pool = createJobsPool({
      databaseUrl: this.databaseUrl,
      statementTimeoutMs: this.statementTimeoutMs,
      max: POOL_MAX,
      onClientError: (err, phase) => {
        this.log.warn(
          { event: "jobs.cleanup.pool_error", phase, err },
          "pooled jobs cleanup-store client dropped",
        );
      },
    });
    this.schedulePass(0);
  }

  /**
   * Stop the cadence and release the pool — every exit path's release: the
   * timer is cleared, the in-flight pass is awaited so no client is pulled
   * out from under itself, and the pool ends. Safe to call twice and safe
   * before start; the loop does not restart after stop, and its snapshot
   * reports the stop like the sweeper's does.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.current = { ...this.current, started: false };
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // A rejected pass must not break the release chain: its pool still ends.
    // The report is sink-guarded because the sink throwing is exactly how a
    // pass comes to reject here.
    await this.inFlight?.catch((error) => {
      try {
        this.log.error(
          { event: "jobs.cleanup.pass_rejected", err: error },
          "a cleanup pass rejected out of its own failure reporting — the release continues",
        );
      } catch {
        // The reporting sink is the rejection's origin; the release below is
        // the part that must survive.
      }
    });
    const pool = this.pool;
    this.pool = null;
    await pool?.end();
  }

  /** The supervision state, for `/health` — a lookup, never a live probe. */
  snapshot(): JobsCleanupSnapshot {
    return { ...this.current };
  }

  /**
   * One cleanup pass — the loop's own body, and the seam a caller (or a
   * test) uses to drive a pass synchronously. Never throws out of its own
   * accounting, and a pass whose own failure reporting threw rejects to the
   * caller without ending the cadence: the in-flight guard clears on either
   * settlement half, so the next call runs its own pass instead of
   * coalescing into a settled one forever, and the timer's fault arm keeps
   * the cadence. A pass that arrives while another is running coalesces into
   * it — every statement is bounded and idempotent, so a repeated pass is
   * harmless.
   */
  runPass(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const pass = this.passOnce();
    this.inFlight = pass;
    const clear = (): void => {
      if (this.inFlight === pass) this.inFlight = null;
    };
    // Both halves: a pass that rejected (its own reporting threw — the one
    // way `passOnce`'s catch can escape) must release the guard exactly like
    // a settled one, and this derived chain must never reject unhandled.
    void pass.then(clear, clear);
    return pass;
  }

  private schedulePass(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const pass = this.runPass();
      // A pass may reject only through its own reporting (a sink that
      // threw); the fault arm keeps the cadence on either settlement half,
      // so even that rejection cannot silently end the loop.
      const reschedule = (): void => {
        if (!this.stopped) this.schedulePass(this.nextDelayMs);
      };
      void pass.then(reschedule, reschedule);
    }, delayMs);
    // Never hold the process open for a pass: the listener and the graceful
    // shutdown own this process's lifetime, and stop() clears the timer anyway.
    this.timer.unref();
  }

  /**
   * One bounded pass, in the order the evidence needs: the measurement first
   * (the pass's opening state — a backlog that stood past the removal bound
   * is recorded as overdue even when this very pass clears it, and the
   * overdue reading persists until a pass OPENS on a cleared store, which is
   * exactly "operators see overdue cleanup until it completes"), then the
   * two removal arms, each bounded and idempotent.
   *
   * The pass's classification and its reports are separated by what they
   * answer for: a failure of the pass's own WORK (the store could not
   * answer) is the catch's — the pass is counted and stamped failed, the
   * backoff arms, and the failure report's own rejection surfaces to the
   * caller when the sink cannot carry it. A failure of a SUCCESS report is
   * the sink's, never the pass's: the reports are sink-guarded (the burn
   * sweep's standard — a sink that threw would fail the counted pass into a
   * failure it did not have, during exactly the backlog the line exists to
   * report), so the span's `ok`, the counter's and the scheduling tail's
   * agreement never depends on the sink being up.
   */
  private async passOnce(): Promise<void> {
    const pool = this.pool;
    if (this.stopped || !pool) return;
    const startedAt = Date.now();
    // The pass is accounted EXACTLY ONCE, before reporting — the same
    // discipline as the recovery sweeper's: a report that threw must not
    // fail an already-counted pass into a second, mislabeled increment.
    let recorded = false;
    const recordFailure = (): void => {
      if (recorded) return;
      recorded = true;
      countCleanup("failed");
      this.failedPasses += 1;
      this.nextDelayMs = Math.min(
        CLEANUP_RETRY_INITIAL_MS * 2 ** Math.max(0, this.failedPasses - 1),
        CLEANUP_RETRY_MAX_MS,
      );
      this.recordPass(false, startedAt, null, 0, 0);
    };
    /** The success reports' guard: the sink being down must not fail the counted pass or skip its scheduling tail. */
    const report = (report: () => void): void => {
      try {
        report();
      } catch {
        // The reporting sink is down; the removal landed and the ok count
        // stands — the snapshot and the health body carry the rest.
      }
    };
    await withCleanupSpan(async (span) => {
      let evidence: JobsCleanupEvidence;
      let resultsRemoved: number;
      let recordsRetired: number;
      try {
        const now = new Date();
        evidence = await this.measureEvidence(pool, now);
        resultsRemoved = await this.removeExpiredResults(pool, now);
        recordsRetired = await this.retireExpiredRecords(pool, now);
        recorded = true;
        this.recordPass(true, startedAt, evidence, resultsRemoved, recordsRetired);
      } catch (error) {
        recordFailure();
        span.setAttribute(ATTR_OUTCOME, "failed" satisfies JobsCleanupOutcome);
        this.log.error(
          { event: "jobs.cleanup.pass_failed", err: error },
          "the cleanup pass could not run — expired content stays retained until a later pass",
        );
        return;
      }
      // The success path, reached only when the pass's work and accounting
      // landed: classify, count, report, and always run the scheduling tail.
      span.setAttributes({
        [ATTR_OUTCOME]: "ok" satisfies JobsCleanupOutcome,
        [ATTR_JOBS_CLEANUP_RESULTS_REMOVED]: resultsRemoved,
        [ATTR_JOBS_CLEANUP_RECORDS_RETIRED]: recordsRetired,
      });
      countCleanup("ok");
      if (evidence.overdueResults > 0 || evidence.overdueRecords > 0) {
        report(() =>
          this.log.warn(
            {
              event: "jobs.cleanup.overdue",
              overdueResults: evidence.overdueResults,
              overdueRecords: evidence.overdueRecords,
            },
            "expired job content has stood past its removal deadline — the cleanup is overdue until a pass opens on it cleared",
          ),
        );
      }
      if (resultsRemoved > 0 || recordsRetired > 0) {
        report(() =>
          this.log.info(
            {
              event: "jobs.cleanup.pass",
              resultsRemoved,
              recordsRetired,
              durationMs: Date.now() - startedAt,
            },
            "the cleanup pass removed expired job content",
          ),
        );
      }
      const drained = resultsRemoved === this.batch || recordsRetired === this.batch;
      if (drained) {
        // One line per drained pass: a sustained run of these is the backlog
        // converging; the overdue warning above is what persists until it is
        // gone.
        report(() =>
          this.log.warn(
            { event: "jobs.cleanup.backlog", resultsRemoved, recordsRetired },
            "the cleanup pass removed a full batch — the next pass follows immediately until the backlog drains",
          ),
        );
      }
      this.failedPasses = 0;
      this.nextDelayMs = drained ? CLEANUP_DRAIN_DELAY_MS : this.intervalMs;
    });
  }

  /**
   * The server-wide measurement one pass opens with — the retention counts
   * and the overdue content, from one indexed scan of the record store. The
   * terminal list rides the query as a parameter from the shared constant,
   * so the SQL and the wire contract cannot drift; the retained definition
   * is the admission's (every physically stored row — the wrapper record and
   * its input bytes are the retained storage).
   */
  private async measureEvidence(pool: Pool, now: Date): Promise<JobsCleanupEvidence> {
    const resultOverdueCutoff = new Date(
      now.getTime() - (JOBS_RESULT_TTL_SECONDS + JOBS_REMOVAL_GRACE_SECONDS) * 1_000,
    );
    const recordOverdueCutoff = new Date(
      now.getTime() - (JOBS_RECORD_TTL_SECONDS + JOBS_REMOVAL_GRACE_SECONDS) * 1_000,
    );
    const result = await pool.query<{
      retained_server: number;
      unfinished_server: number;
      overdue_results: number;
      overdue_records: number;
    }>(
      `SELECT count(*)::int AS retained_server,
              count(*) FILTER (WHERE NOT status = ANY($1::text[]))::int AS unfinished_server,
              count(*) FILTER (WHERE result IS NOT NULL AND terminal_at <= $2)::int AS overdue_results,
              count(*) FILTER (WHERE status = ANY($1::text[]) AND terminal_at <= $3)::int AS overdue_records
         FROM ${JOBS_JOB_RECORD_QUALIFIED}`,
      [JOB_TERMINAL_STATUSES, resultOverdueCutoff, recordOverdueCutoff],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("the cleanup measurement returned no row");
    }
    return {
      retainedServer: row.retained_server,
      unfinishedServer: row.unfinished_server,
      overdueResults: row.overdue_results,
      overdueRecords: row.overdue_records,
    };
  }

  /**
   * The result arm — remove every stored result whose seven-day lifetime has
   * ended, converging the row's stored status to `expired` in the same
   * statement (the store's CHECK constraints require it: a success always
   * carries its result, and a result exists only on a row projecting
   * success). Bounded by the batch cap; the row itself, its retry key and
   * every other column stay — the record's own retirement is the record
   * arm's, at the record horizon.
   */
  private async removeExpiredResults(pool: Pool, now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - JOBS_RESULT_TTL_SECONDS * 1_000);
    const result = await pool.query(
      `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
          SET status = 'expired', result = NULL
        WHERE result IS NOT NULL
          AND terminal_at <= $1
          AND ctid IN (
            SELECT ctid FROM ${JOBS_JOB_RECORD_QUALIFIED}
             WHERE result IS NOT NULL AND terminal_at <= $1
             LIMIT $2
          )`,
      [cutoff, this.batch],
    );
    return result.rowCount ?? 0;
  }

  /**
   * The record arm — retire every terminal record past its thirty-day record
   * horizon together with the runner row it was accepted under, in ONE
   * transaction: the runner ids come from the record deletion's own
   * `RETURNING`, so a key reused by a replacement job — whose record and
   * runner row cannot exist until this very deletion releases the scoped-key
   * constraint — can never be caught by this pass's runner deletes, and two
   * replicas' passes racing the same rows each delete exactly what their own
   * statement returned. The runner row's delete rides the adapter on the
   * transaction's own client; a failure of that delete rolls the record
   * deletion back with it (no orphaned runner row, no half-retired job).
   */
  private async retireExpiredRecords(pool: Pool, now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - JOBS_RECORD_TTL_SECONDS * 1_000);
    return withJobsClient(pool, async (client) => {
      await client.query("BEGIN");
      try {
        const removed = await client.query<{ runner_job_id: string }>(
          `DELETE FROM ${JOBS_JOB_RECORD_QUALIFIED}
            WHERE status = ANY($1::text[])
              AND terminal_at <= $2
              AND ctid IN (
                SELECT ctid FROM ${JOBS_JOB_RECORD_QUALIFIED}
                 WHERE status = ANY($1::text[]) AND terminal_at <= $2
                 LIMIT $3
              )
          RETURNING runner_job_id`,
          [JOB_TERMINAL_STATUSES, cutoff, this.batch],
        );
        const runnerJobIds = removed.rows.map((row) => row.runner_job_id);
        // Nothing to retire makes no runner call at all: an empty retirement
        // is not an adapter round trip, and a runner that cannot answer must
        // not fail a pass that had nothing to retire.
        if (runnerJobIds.length > 0) {
          await this.deleteRunnerRows.delete(client, runnerJobIds);
        }
        await client.query("COMMIT");
        return removed.rows.length;
      } catch (error) {
        // The retirement failed or the store refused: nothing this
        // transaction did may survive — the wrapper rows stay, and the next
        // pass retries the whole retirement. On a dead socket the ROLLBACK
        // itself rejects through pg's handleError — the same death the
        // client-level listener recorded — and the release below destroys
        // that client.
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    });
  }

  private recordPass(
    ok: boolean,
    startedAt: number,
    evidence: JobsCleanupEvidence | null,
    resultsRemoved: number,
    recordsRetired: number,
  ): void {
    const now = new Date().toISOString();
    // `started` is start()'s and stop()'s to set, never a pass's: a pass
    // settling during a stop must not report the loop running again.
    this.current = {
      ...this.current,
      passes: this.current.passes + 1,
      lastPassAt: now,
      lastOkPassAt: ok ? now : this.current.lastOkPassAt,
      resultsRemoved: this.current.resultsRemoved + resultsRemoved,
      recordsRetired: this.current.recordsRetired + recordsRetired,
      evidence: ok ? evidence : this.current.evidence,
    };
  }
}
