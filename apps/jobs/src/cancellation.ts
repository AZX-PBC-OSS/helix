import type { Pool } from "pg";

import { JOB_TERMINAL_STATUSES, type JobError, type JobStatus } from "@azx-pbc/shared";
import type { JobsCancelClaims } from "@azx-pbc/shared/jobsSigning";

import { storedExecutionError } from "./execution.js";
import { projectedPublicStatus, recordHorizonPassed } from "./observation.js";
import { createJobsPool } from "./pool.js";
import { JOBS_JOB_RECORD_QUALIFIED } from "./policy.js";

/**
 * The owner-cancellation seam (background-jobs-plane design §6) — the one
 * component that turns an authorized cancel request into durable intent and
 * drives it through the runner. The order is the contract:
 *
 * 1. **Intent first.** One conditional write records
 *    `cancellation_requested` on the addressed record — conditional on the
 *    signed caller's identity (app, environment, principal kind, owner), the
 *    record's type being inside the signed grants, and the record still being
 *    non-terminal. A lost acknowledgement or a crash after this commit leaves
 *    the intent pending on the record, where the worker-start gate and the
 *    recovery sweeper both read it: the write is the acknowledgement's whole
 *    basis (a 202 never precedes it).
 * 2. **Then the runner.** The record's runner row is cancelled through the
 *    runner's own fenced cancel — a waiting row stops before dispatch, an
 *    active row's claim is lost (its worker's signal aborts on the next
 *    heartbeat) — and a lost or refused runner cancel is recovered by the
 *    sweeper's cancellation arm, which re-drives exactly this. The runner
 *    cancel's own answer is evidence, never the acknowledgement: the intent
 *    is what was confirmed.
 *
 * Terminal-write fencing is the shared rule every outcome write in this
 * service obeys (and the runner's own claim semantics enforce on its rows):
 * whichever terminal outcome commits first wins. A completion settling after
 * the cancellation's terminal projection is fenced by the conditional write;
 * a cancellation arriving after a committed completion reads `terminal` here
 * and changes nothing.
 */

/** What one owner-cancellation request decided. */
export type JobsCancelVerdict =
  | { outcome: "requested" }
  | { outcome: "not_found" }
  | { outcome: "forbidden" }
  | { outcome: "terminal"; status: JobStatus; error: JobError | null };

/** The verified cancellation a decision decides on — claims from the receiver, the reference as addressed. */
export interface JobsCancelRequest {
  /** The instruction's verified cancel claims — the trusted identity and grants. */
  claims: JobsCancelClaims;
  /** The job's public id, from the route the instruction was bound to. */
  jobId: string;
}

/** The cancellation seam the cancel route consumes (the durable store implements it; tests may substitute). */
export interface JobsCancellation {
  requestCancel(request: JobsCancelRequest): Promise<JobsCancelVerdict>;
}

/**
 * What the runner-cancel answered — the runner row's own fence, read by the
 * component for its evidence and by the sweeper's re-drive for its decision:
 *
 * - `cancelled` — the runner row moved to cancelled: a waiting row will never
 *   dispatch, an active row's claim is lost and its worker's signal aborts on
 *   the next heartbeat.
 * - `not_cancellable` — the runner row was already terminal: the completion
 *   or failure won its race, and the wrapper's reconciliation reads the row's
 *   own state.
 * - `unavailable` — the runner could not answer: the durable intent remains
 *   pending and the sweeper's cancellation arm re-drives it.
 */
export type RunnerCancelVerdict =
  | { verdict: "cancelled" }
  | { verdict: "not_cancellable" }
  | { verdict: "unavailable"; reason: string };

/** The seam the runner's fenced cancel is reached through — production composes the runtime runner; tests may substitute. */
export type RunnerJobCanceller = (runnerJobId: string) => Promise<RunnerCancelVerdict>;

/** The structural logger the store reports through (the pino surface, without importing Fastify). */
export interface JobsCancellationLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface JobsCancellationStoreOptions {
  databaseUrl: string;
  /** Per-query ceiling, applied as both the pool's statement and connect timeout. */
  statementTimeoutMs: number;
  /** The runner's fenced cancel, driven after the intent commits (and re-driven by the sweeper's arm). */
  cancelRunnerJob: RunnerJobCanceller;
  log: JobsCancellationLogger;
}

/** The runtime pool stays small: one short conditional write per request. */
const POOL_MAX = 2;

/** The record columns the refusal classification reads. */
interface RecordRow {
  app_id: string;
  env: string;
  owner_kind: string;
  owner_oid: string;
  type: string;
  status: string;
  error_code: string | null;
  terminal_at: Date | null;
}

/**
 * Why the conditional intent write affected no row — the disambiguation the
 * refusal paths read out of the record itself. The checks apply in the order
 * the contract fixes: existence, then identity (both answer the unknown-job
 * 404), then the record's public readability (a record past its thirty-day
 * horizon is indistinguishable from an unknown one — cancelling it cannot
 * disclose it), then the type grant, then the terminal state — projected at
 * the read horizons, so a successful result past its seven-day lifetime
 * answers `expired` however delayed the physical cleanup is. One `now` judges
 * the whole classification: the horizon check and the projected status read
 * the same instant, so they cannot straddle a boundary.
 */
function classifyRefusal(
  row: RecordRow | undefined,
  claims: JobsCancelClaims,
  now: Date,
): JobsCancelVerdict {
  if (
    !row ||
    row.app_id !== claims.appId ||
    row.env !== claims.env ||
    row.owner_kind !== claims.ownerKind ||
    row.owner_oid !== claims.ownerOid
  ) {
    // The same 404 an unknown job answers with: a different app, owner,
    // principal kind or environment must not disclose that a job exists
    // (spec criterion 4).
    return { outcome: "not_found" };
  }
  if (recordHorizonPassed(row, now)) {
    return { outcome: "not_found" };
  }
  if (!claims.allowedTypes.includes(row.type)) {
    return { outcome: "forbidden" };
  }
  return {
    outcome: "terminal",
    status: projectedPublicStatus(row, now),
    error: storedExecutionError(row.error_code),
  };
}

/**
 * The durable cancellation store — the intent write plus the runner drive,
 * against the service's private store, with the same pool discipline as every
 * store in this service: `start()` never throws, `stop()` releases the pool
 * on every exit path, and a request against a store that is not running
 * throws for the route's failure contract (the retryable 503), never silently
 * succeeds. The runner cancel is composed like the acceptance store composes
 * its enqueuer — an injected seam over the runtime runner, never a second
 * pg-boss instance.
 */
export class JobsCancellationStore implements JobsCancellation {
  private readonly databaseUrl: string;
  private readonly statementTimeoutMs: number;
  private readonly cancelRunnerJob: RunnerJobCanceller;
  private readonly log: JobsCancellationLogger;

  private pool: Pool | null = null;
  private stopped = false;

  constructor(options: JobsCancellationStoreOptions) {
    this.databaseUrl = options.databaseUrl;
    this.statementTimeoutMs = options.statementTimeoutMs;
    this.cancelRunnerJob = options.cancelRunnerJob;
    this.log = options.log;
  }

  /** Open the pool. No background work: the store has no loop of its own. */
  start(): void {
    if (this.pool || this.stopped) return;
    this.pool = createJobsPool({
      databaseUrl: this.databaseUrl,
      statementTimeoutMs: this.statementTimeoutMs,
      max: POOL_MAX,
      onClientError: (err, phase) => {
        this.log.warn(
          { event: "jobs.cancellation.pool_error", phase, err },
          "pooled jobs cancellation-store client dropped",
        );
      },
    });
  }

  /** Release the pool. Safe to call twice; the store does not restart after stop. */
  async stop(): Promise<void> {
    this.stopped = true;
    const pool = this.pool;
    this.pool = null;
    await pool?.end();
  }

  async requestCancel(request: JobsCancelRequest): Promise<JobsCancelVerdict> {
    const pool = this.pool;
    if (this.stopped || !pool) {
      throw new Error("the cancellation store is not running");
    }
    const { claims } = request;
    // The intent write IS the authorization check and the fence in one
    // statement: identity, grant and non-terminal are predicates on the
    // write, so a state that changed between any earlier read and here
    // cannot be acted on — the write either lands on the row it was judged
    // against or affects nothing. A repeat while active writes the same
    // value again and answers the same acknowledgement (harmless by
    // construction). RETURNING hands back the runner id the drive below
    // needs — no second read on the happy path. The pending-since stamp is
    // COALESCEd for the same reason: the first intent's instant is the one
    // the recovery backlog's age reads, whatever later writers rewrote the
    // flag beside.
    const recorded = await pool.query<{ runner_job_id: string }>(
      `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
          SET cancellation_requested = true,
              cancellation_requested_at = COALESCE(cancellation_requested_at, now())
        WHERE server = $1 AND job_id = $2
          AND app_id = $3 AND env = $4 AND owner_kind = $5 AND owner_oid = $6
          AND type = ANY($7::text[])
          AND NOT (status = ANY($8::text[]))
        RETURNING runner_job_id`,
      [
        claims.server,
        request.jobId,
        claims.appId,
        claims.env,
        claims.ownerKind,
        claims.ownerOid,
        claims.allowedTypes,
        JOB_TERMINAL_STATUSES,
      ],
    );
    const recordedRow = recorded.rows[0];
    if (!recordedRow) {
      // No row matched: classify against the record as it stands now — the
      // current state is the correct answer for a repeat request (a job
      // that completed before this write answers 409 terminal). The read is
      // classification, never a decision a later write then acts on.
      const current = await pool.query<RecordRow>(
        `SELECT app_id, env, owner_kind, owner_oid, type, status, error_code, terminal_at
           FROM ${JOBS_JOB_RECORD_QUALIFIED}
          WHERE server = $1 AND job_id = $2`,
        [claims.server, request.jobId],
      );
      return classifyRefusal(current.rows[0], claims, new Date());
    }
    // The intent is durable — the acknowledgement's basis is committed. Now
    // the runner: its fenced cancel stops a waiting row before dispatch and
    // loses an active row's claim. The drive runs with no client checked
    // out (single-statement flow — the checkout closed with the query), and
    // a refusal or a failure here is evidence, never a failed request: the
    // pending intent is what the worker-start gate refuses on and the
    // recovery sweeper re-drives.
    const runnerVerdict = await this.cancelRunnerJob(recordedRow.runner_job_id);
    if (runnerVerdict.verdict === "unavailable") {
      this.log.warn(
        { event: "jobs.cancellation.runner_unavailable", reason: runnerVerdict.reason },
        "the runner could not be driven for a recorded cancellation — the recovery sweeper re-drives the pending intent",
      );
    } else if (runnerVerdict.verdict === "not_cancellable") {
      this.log.info(
        { event: "jobs.cancellation.runner_terminal" },
        "the runner row was already terminal when the cancellation drove it — an earlier request already cancelled it, or a competing outcome won its race",
      );
    }
    return { outcome: "requested" };
  }
}
