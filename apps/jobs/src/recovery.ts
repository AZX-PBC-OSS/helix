import type { Pool } from "pg";

import { JOB_TERMINAL_STATUSES, JobErrorCodeSchema, type JobErrorCode } from "@azx-pbc/shared";
import {
  ATTR_APP_ID,
  ATTR_JOBS_ATTEMPT,
  ATTR_JOBS_JOB_ID,
  ATTR_JOBS_TYPE,
  ATTR_OUTCOME,
  ATTR_REASON,
  type JobsRecoverOutcome,
} from "@azx-pbc/shared/telemetry";

import { deadlinePassed, publicStatus, terminatePastDeadline } from "./execution.js";
import { createJobsPool } from "./pool.js";
import { JOBS_JOB_RECORD_QUALIFIED, jobsAbsoluteDeadline } from "./policy.js";
import { countRecovery, withRecoverySpan } from "./telemetry.js";

/**
 * The jobs recovery sweeper — the supervised loop that owns interruption
 * recovery for accepted work (background-jobs-plane design §§5–6, ADR-0009).
 * The runner's own maintenance settles a dead worker's claim; the wrapper
 * record it was projecting stays mid-flight, and nothing else in the service
 * reads the runner's state back. This loop is that reader: on a bounded
 * cadence it scans the non-terminal wrapper records and reconciles each
 * against the runner row's own durable state, so interrupted work either
 * recovers under its type's attempt policy or reaches the truthful terminal
 * outcome — `crashed` for execution lost with no attempt left, `timeout` when
 * the absolute deadline has passed, `cancelled` for cancelled runner rows —
 * without ever changing its reference or reissuing the work.
 *
 * The reconciliation is a projection, never a re-driver: the only mechanism
 * that re-runs work is the runner's own retry policy, so a single-attempt
 * fetch job whose worker died is projected `crashed` here — its execution is
 * lost, not repeated (spec criteria 22, 24, 31, 33). Every write is
 * conditional on the record still being non-terminal, so a worker settling,
 * a cancellation or another replica's sweeper passing concurrently fences
 * this one out instead of racing it.
 *
 * Supervision mirrors the service's other loops (`src/storage.ts`,
 * `src/burns.ts`): `start()` never throws, each pass is bounded (a batch cap,
 * the pool's statement and connect timeouts), a failed pass is logged and
 * counted and never ends the cadence, `stop()` releases the pool and the
 * timer on every exit path, and the snapshot is what the `jobs_sweeper`
 * health check grades — stopped or stale recovery is never healthy.
 */

/** The runner row's state, as the pinned adapter's public API reports it. */
export type RunnerJobState = "created" | "retry" | "active" | "completed" | "cancelled" | "failed";

/**
 * The runner row's answer for one wrapper record. `missing` — no row exists
 * for a record that should have one (the acceptance transaction commits both
 * together, and only the physical cleanup removes them together): a corrupt
 * store, reported and left for the deadline arm's bounded termination.
 * `unavailable` — the reader could not answer (the runner has not started,
 * or its store did not answer): the pass aborts its reconciliation and
 * retries on the next cadence.
 */
export type RunnerJobLookup =
  | { verdict: "found"; state: RunnerJobState; output: unknown }
  | { verdict: "missing" }
  | { verdict: "unavailable"; reason: string };

/** The seam the sweeper reads runner-row state through — the runtime runner supplies it from the pinned adapter's public job read. */
export type RunnerJobStateReader = (runnerJobId: string) => Promise<RunnerJobLookup>;

/** A runner row that answered — the unavailable case is the pass's abort, not a decision. */
type AnsweredRunnerJobLookup = Exclude<RunnerJobLookup, { verdict: "unavailable" }>;

/**
 * What the sweeper decided one interrupted job's recovery is. Every value is
 * a bounded disposition of the reconciliation decision; the write each one
 * leads to is conditional, so the decision's effect is fenced like every
 * other wrapper write.
 */
export type WorkRecoveryDecision =
  | { outcome: "deadline_exceeded"; code: "timeout" }
  | { outcome: "requeued"; code: JobErrorCode }
  | { outcome: "failed"; code: JobErrorCode }
  | { outcome: "crashed"; code: "platform_error" }
  | { outcome: "cancelled"; code: "cancelled" }
  | { outcome: "row_missing" }
  | { outcome: "unaffected" };

/**
 * The reconciliation decision for one non-terminal wrapper record — the pure
 * heart of the pass, so the state machine is table-testable without a store.
 * Inputs: the record's own status (the sweep only reads non-terminal
 * records), whether its absolute deadline has passed, and the runner row's
 * answer. The deadline arm decides first and needs no runner I/O — deadline
 * enforcement never depends on the runner being up.
 *
 * The state machine, from the runner row's side:
 *
 * - waiting (`created`/`retry`) — the work is queued or will be re-driven;
 *   a record still reading `running` is put back to `queued` with the lost
 *   attempt's attribution retained (its failure code if the settle carried a
 *   worker-reported one, else `timeout` — the claim expiry that re-queued
 *   it), and the next claim's begin resets it. A record already reading
 *   `queued` is consistent.
 * - `active` — the claim is live and the worker is between its claim and its
 *   projections; nothing to reconcile, and a stale claim is the runner's own
 *   maintenance business, never a second settlement mechanism here.
 * - terminal `failed` — no attempt remains and the wrapper never got the
 *   outcome: a settle output carrying a worker-reported code projects that
 *   code (the reported failure whose wrapper projection was lost — the
 *   execution-store-outage case); anything else is a claim the runner's own
 *   expiry machinery settled — execution lost through a platform
 *   interruption, projected `crashed`.
 * - terminal `completed` — the attempt finished but its result was never
 *   projected (a crash or a store outage between the claim's completion and
 *   the wrapper write): the result bytes are gone with the attempt's
 *   process, so the truthful outcome is `crashed`, not a fabricated success.
 * - terminal `cancelled` — the row's cancellation wins: the wrapper projects
 *   `cancelled` and recovery never reissues the work.
 */
export function decideWorkRecovery(input: {
  status: "queued" | "running";
  pastDeadline: boolean;
  row: AnsweredRunnerJobLookup;
}): WorkRecoveryDecision {
  if (input.pastDeadline) {
    return { outcome: "deadline_exceeded", code: "timeout" };
  }
  const row = input.row;
  if (row.verdict === "missing") {
    return { outcome: "row_missing" };
  }
  switch (row.state) {
    case "created":
    case "retry":
      if (input.status === "running") {
        return { outcome: "requeued", code: reportedFailureCode(row.output) ?? "timeout" };
      }
      return { outcome: "unaffected" };
    case "active":
      return { outcome: "unaffected" };
    case "failed": {
      const reported = reportedFailureCode(row.output);
      return reported
        ? { outcome: "failed", code: reported }
        : { outcome: "crashed", code: "platform_error" };
    }
    case "completed":
      return { outcome: "crashed", code: "platform_error" };
    case "cancelled":
      return { outcome: "cancelled", code: "cancelled" };
  }
}

/**
 * The worker-reported failure code a runner row's settle output carries —
 * the execution seam fails a claim with `{code}` as the row's output, so a
 * row that settled through the worker's own path names its reason there.
 * Anything else (the dependency's own timeout/heartbeat shapes, a shutdown
 * string, an unparseable value) is not a worker report: the caller falls
 * back to the outcome its own reading of the loss implies.
 */
function reportedFailureCode(output: unknown): JobErrorCode | null {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return null;
  const code = (output as { code?: unknown }).code;
  if (typeof code !== "string") return null;
  const parsed = JobErrorCodeSchema.safeParse(code);
  return parsed.success ? parsed.data : null;
}

/** A decision whose write (or report) the pass applies — the pass filters `unaffected` before either. */
type ActionableRecoveryDecision = Exclude<WorkRecoveryDecision, { outcome: "unaffected" }>;

/** The sweeper's supervision state, as `/health` reports it. */
export interface JobsRecoverySnapshot {
  /** The loop has been started (its first pass may not have completed yet). */
  started: boolean;
  /** Passes run since start, successful or not. */
  passes: number;
  /** Wall-clock ISO instant of the last completed pass, of any outcome. */
  lastPassAt: string | null;
  /** Wall-clock ISO instant of the last pass that could complete its reconciliation. */
  lastOkPassAt: string | null;
  /** Jobs the sweeper has dispositioned (including fenced attempts) since start. */
  reconciled: number;
}

/** The structural logger the sweeper reports through (the pino surface, without importing Fastify). */
export interface JobsRecoveryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface JobsRecoveryOptions {
  databaseUrl: string;
  /** Per-query ceiling, applied as both the pool's statement and connect timeout. */
  statementTimeoutMs: number;
  /**
   * The runner-row reader — production composes the runtime runner's public
   * job read; the sweeper never opens its own pg-boss instance or SQL.
   */
  readRunnerJob: RunnerJobStateReader;
  /** The cadence between passes. */
  intervalMs?: number;
  /** The largest number of records one pass considers — the bound that keeps a pass bounded. */
  batch?: number;
  log: JobsRecoveryLogger;
}

/** Steady recovery cadence — how long an interrupted job's reconciliation can wait. */
const RECOVERY_INTERVAL_MS = 15_000;
/** One pass considers at most this many records, oldest first. */
const RECOVERY_BATCH = 100;
/**
 * How long without a successful pass the `jobs_sweeper` check waits before
 * reading stale — three cadences, inside the 60-second healthy-service bound
 * the cancellation and recovery visibility hang from.
 */
export const JOBS_RECOVERY_STALE_AFTER_MS = 3 * RECOVERY_INTERVAL_MS;

/** The runtime pool stays small: one candidate read and one bounded write per disposition. */
const POOL_MAX = 2;

/** The sweep's candidate, as the store stores it. */
interface RecoveryCandidateRow {
  server: string;
  job_id: string;
  type: string;
  app_id: string;
  env: string;
  status: string;
  attempt: number | null;
  runner_job_id: string;
  created_at: Date;
}

export class JobsRecovery {
  private readonly databaseUrl: string;
  private readonly statementTimeoutMs: number;
  private readonly readRunnerJob: RunnerJobStateReader;
  private readonly intervalMs: number;
  private readonly batch: number;
  private readonly log: JobsRecoveryLogger;

  private pool: Pool | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  private current: JobsRecoverySnapshot = {
    started: false,
    passes: 0,
    lastPassAt: null,
    lastOkPassAt: null,
    reconciled: 0,
  };

  constructor(options: JobsRecoveryOptions) {
    this.databaseUrl = options.databaseUrl;
    this.statementTimeoutMs = options.statementTimeoutMs;
    this.readRunnerJob = options.readRunnerJob;
    this.intervalMs = options.intervalMs ?? RECOVERY_INTERVAL_MS;
    this.batch = options.batch ?? RECOVERY_BATCH;
    this.log = options.log;
  }

  /**
   * Begin the cadence. Never throws and never blocks the caller: the first
   * pass runs immediately in the background, and a store that will not
   * answer leaves the service alive — the passes retry and the health body
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
          { event: "jobs.recovery.pool_error", phase, err },
          "pooled jobs recovery-store client dropped",
        );
      },
    });
    this.schedulePass(0);
  }

  /**
   * Stop the cadence and release the pool — every exit path's release: the
   * timer is cleared, the in-flight pass is awaited so no client is pulled
   * out from under itself, and the pool ends. Safe to call twice and safe
   * before start; the sweeper does not restart after stop, and its snapshot
   * reports the stop like the runner's does.
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
          { event: "jobs.recovery.pass_rejected", err: error },
          "a recovery pass rejected out of its own failure reporting — the release continues",
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
  snapshot(): JobsRecoverySnapshot {
    return { ...this.current };
  }

  /**
   * One reconciliation pass — the loop's own body, and the seam a caller (or
   * a test) uses to drive a pass synchronously. Never throws out of its own
   * accounting, and a pass whose own failure reporting threw rejects to the
   * caller without ending the cadence: the in-flight guard clears on either
   * settlement half, so the next call runs its own pass instead of
   * coalescing into a settled one forever, and the timer's fault arm keeps
   * the cadence. A pass that arrives while another is running coalesces into
   * it — the writes are conditional, so a repeated pass is harmless.
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
      // A pass may reject only through its own reporting (a sink that threw);
      // the fault arm keeps the cadence on either settlement half, so even
      // that rejection cannot silently end the loop.
      const reschedule = (): void => {
        if (!this.stopped) this.schedulePass(this.intervalMs);
      };
      void pass.then(reschedule, reschedule);
    }, delayMs);
    // Never hold the process open for a pass: the listener and the graceful
    // shutdown own this process's lifetime, and stop() clears the timer anyway.
    this.timer.unref();
  }

  /**
   * One bounded pass over the oldest non-terminal records: the deadline arm
   * first (wrapper-only — deadline enforcement never depends on the runner
   * being up), then the reconciliation against the runner row's answer. The
   * pass aborts its reconciliation when the runner cannot answer (the next
   * pass retries) and fails as a whole when its own store cannot.
   */
  private async passOnce(): Promise<void> {
    const pool = this.pool;
    if (this.stopped || !pool) return;
    const startedAt = Date.now();
    const counts: Record<string, number> = {};
    let reconciled = 0;
    // The pass is accounted EXACTLY ONCE. Every report below is unguarded —
    // its throw is the caller-facing rejection the runPass seam's contract
    // carries — so a report that threw re-enters the catch arm, and the
    // flag is what keeps that re-entry from accounting the same pass twice
    // (a succeeded pass's summary throwing would otherwise count the pass
    // again, mislabeled failed). Set BEFORE recordPass returns-safely
    // matters not: recordPass's accounting is its first statement, so the
    // flag marks that the accounting landed even when its own summary
    // report threw.
    let recorded = false;
    const recordFailure = (): void => {
      if (recorded) return;
      recorded = true;
      // Account BEFORE reporting: the pass ran, and its count is the
      // operator's evidence even when the reporting sink is what is broken
      // (the storage supervisor's own standard — the counter absorbs the
      // retries so a sustained outage is a rate an alert can read).
      this.recordPass(false, startedAt, reconciled);
    };
    try {
      const candidates = await this.nextCandidates(pool);
      for (const candidate of candidates) {
        // The status column is check-constrained to the public vocabulary;
        // the parse is the shared judgment, and the sweep's filter makes the
        // nonterminal pair the only values a candidate can carry.
        const status = publicStatus(candidate.status);
        if (status !== "queued" && status !== "running") continue;
        const pastDeadline = deadlinePassed(
          candidate.created_at,
          jobsAbsoluteDeadline(candidate.type),
        );
        let row: AnsweredRunnerJobLookup | null = null;
        if (!pastDeadline) {
          const lookup = await this.readRunnerJob(candidate.runner_job_id);
          if (lookup.verdict === "unavailable") {
            recordFailure();
            this.log.warn(
              { event: "jobs.recovery.runner_unavailable", reason: lookup.reason },
              "the recovery pass could not read the runner's state — the reconciliation retries on the next pass",
            );
            return;
          }
          row = lookup;
        }
        const decision = decideWorkRecovery({
          status,
          pastDeadline,
          row: row ?? { verdict: "missing" },
        });
        if (decision.outcome === "unaffected") continue;
        const outcome = await this.apply(candidate, decision);
        counts[outcome] = (counts[outcome] ?? 0) + 1;
        reconciled += 1;
        await this.dispositioned(candidate, decision, outcome);
      }
      recorded = true;
      this.recordPass(true, startedAt, reconciled, counts);
    } catch (error) {
      recordFailure();
      this.log.error(
        { event: "jobs.recovery.pass_failed", err: error },
        "the recovery pass could not run — interrupted work stays mid-flight until a later pass",
      );
    }
  }

  /** The oldest non-terminal records, up to the batch cap — the reconciliation's candidates. */
  private async nextCandidates(pool: Pool): Promise<RecoveryCandidateRow[]> {
    const result = await pool.query<RecoveryCandidateRow>(
      `SELECT server, job_id, type, app_id, env, status, attempt, runner_job_id, created_at
         FROM ${JOBS_JOB_RECORD_QUALIFIED}
        WHERE NOT (status = ANY($1::text[]))
         ORDER BY created_at
         LIMIT $2`,
      [JOB_TERMINAL_STATUSES, this.batch],
    );
    return result.rows;
  }

  /** Apply a decision's write; the conditional update fences a lost race. */
  private async apply(
    candidate: RecoveryCandidateRow,
    decision: ActionableRecoveryDecision,
  ): Promise<JobsRecoverOutcome> {
    const pool = this.pool;
    if (this.stopped || !pool) return "fenced";
    switch (decision.outcome) {
      case "deadline_exceeded": {
        const affected = await terminatePastDeadline(pool, candidate.server, candidate.job_id);
        return affected === 1 ? "deadline_exceeded" : "fenced";
      }
      case "requeued": {
        // The fence names the attempt the pass read as current: a retry's
        // own begin landing between the row-read and this write has moved
        // the record to a newer attempt, and the requeue must not clobber a
        // live attempt back to queued — its success would be fenced off
        // behind it.
        const updated = await pool.query(
          `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
              SET status = 'queued', error_code = $4
            WHERE server = $1 AND job_id = $2 AND status = 'running' AND attempt = $3`,
          [candidate.server, candidate.job_id, candidate.attempt, decision.code],
        );
        return (updated.rowCount ?? 0) === 1 ? "requeued" : "fenced";
      }
      case "failed":
      case "crashed":
      case "cancelled": {
        const updated = await pool.query(
          `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
              SET status = $3, error_code = $4
            WHERE server = $1 AND job_id = $2 AND NOT (status = ANY($5::text[]))`,
          [
            candidate.server,
            candidate.job_id,
            decision.outcome,
            decision.code,
            JOB_TERMINAL_STATUSES,
          ],
        );
        return (updated.rowCount ?? 0) === 1 ? decision.outcome : "fenced";
      }
      case "row_missing":
        return "row_missing";
    }
  }

  /** The span, counter and log line one dispositioned job reports. */
  private async dispositioned(
    candidate: RecoveryCandidateRow,
    decision: ActionableRecoveryDecision,
    outcome: JobsRecoverOutcome,
  ): Promise<void> {
    await withRecoverySpan(async (span) => {
      span.setAttributes({
        [ATTR_APP_ID]: candidate.app_id,
        [ATTR_JOBS_TYPE]: candidate.type,
        [ATTR_JOBS_JOB_ID]: candidate.job_id,
        ...(candidate.attempt !== null ? { [ATTR_JOBS_ATTEMPT]: candidate.attempt } : {}),
        [ATTR_OUTCOME]: outcome,
        ...(decision.outcome !== "row_missing" ? { [ATTR_REASON]: decision.code } : {}),
      });
      countRecovery(outcome);
      const detail = {
        appId: candidate.app_id,
        jobId: candidate.job_id,
        attempt: candidate.attempt,
        outcome,
        reason: decision.outcome === "row_missing" ? undefined : decision.code,
      };
      if (outcome === "row_missing") {
        this.log.error(
          { ...detail, event: "jobs.recovery.row_missing" },
          "no runner row answered for a non-terminal job record — the store is inconsistent; the deadline arm terminates it",
        );
      } else if (outcome === "crashed" || outcome === "deadline_exceeded") {
        this.log.warn(
          { ...detail, event: "jobs.recovery.terminated" },
          "the recovery sweeper terminated interrupted work",
        );
      } else if (outcome !== "fenced") {
        this.log.info(
          { ...detail, event: "jobs.recovery.reconciled" },
          "the recovery sweeper reconciled interrupted work",
        );
      }
    });
  }

  private recordPass(
    ok: boolean,
    startedAt: number,
    reconciled: number,
    counts?: Record<string, number>,
  ): void {
    const now = new Date().toISOString();
    // `started` is start()'s and stop()'s to set, never a pass's: a pass
    // settling during a stop must not report the sweeper running again.
    this.current = {
      ...this.current,
      passes: this.current.passes + 1,
      lastPassAt: now,
      lastOkPassAt: ok ? now : this.current.lastOkPassAt,
      reconciled: this.current.reconciled + reconciled,
    };
    if (ok && counts && Object.keys(counts).length > 0) {
      this.log.info(
        { event: "jobs.recovery.pass", counts, durationMs: Date.now() - startedAt },
        "the recovery pass dispositioned interrupted work",
      );
    }
  }
}
