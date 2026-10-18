import { SpanStatusCode, type Span } from "@opentelemetry/api";
import type { JobWithMetadata, PgBoss, WorkOptions } from "pg-boss";
import type { Pool, PoolClient } from "pg";

import {
  JOBS_MAX_RESULT_BYTES,
  JOB_TERMINAL_STATUSES,
  EnvSchema,
  JobErrorCodeSchema,
  JobOwnerKindSchema,
  JobProgressSchema,
  JobStatusSchema,
  jobError,
  stringifyJsonValue,
  type JobError,
  type JobErrorCode,
  type JobStatus,
  type JobsCapacityLimits,
} from "@azx-pbc/shared";
import {
  ATTR_APP_ID,
  ATTR_JOBS_ATTEMPT,
  ATTR_JOBS_JOB_ID,
  ATTR_JOBS_TYPE,
  ATTR_OUTCOME,
  ATTR_REASON,
  type JobsExecuteOutcome,
} from "@azx-pbc/shared/telemetry";

import { lifecycleEligibilityInTx } from "./lifecycle.js";
import { createJobsPool, withJobsClient } from "./pool.js";
import {
  JOBS_JOB_RECORD_QUALIFIED,
  JOBS_QUEUE_NAME,
  jobTypePolicy,
  jobsAbsoluteDeadline,
  jobsWorkOptions,
} from "./policy.js";
import { countExecution, failSpan, withExecutionSpan } from "./telemetry.js";

/**
 * The jobs execution seam — worker registration, the handler dispatch and the
 * bounded latest progress/result persistence (background-jobs-plane design §6,
 * ADR-0009). The acceptance transaction commits accepted work; this seam runs
 * it: one pg-boss worker on the service's single queue dispatches each claim
 * to the handler registered for the record's qualified type, and every
 * attempt's state — running, progress, terminal outcome — is projected into
 * the `jobs.job_record` wrapper whose rows the observation paths read.
 *
 * Three invariants shape the projection:
 *
 * - **A claim's settlement is the arbiter for outcomes.** The runner's own
 *   attempt-fenced `complete`/`fail` run FIRST on each path; the wrapper
 *   write follows only when the settlement reports the claim still held. A
 *   late completion whose claim lapsed (a claim timeout, a lost lease) is
 *   discarded, never stored — the timeout outcome that the claim's expiry
 *   produced is the truth, and the recovery path projects it (design §6:
 *   "fence late completion using runner claim/terminal semantics and
 *   conditional wrapper updates").
 * - **Every wrapper write is conditional.** The outcome writes update only a
 *   nonterminal record at the attempt they name; the progress reports update
 *   only the record's CURRENT attempt (a lapsed claim's late reports still
 *   land while no newer attempt has begun — the attribution the recovery
 *   path reads is the last attempt's, which is the contract). A cancelled
 *   record, a lapsed claim's late completion, or a retry that already moved
 *   the attempt forward changes nothing.
 * - **The start gate holds the lifecycle row.** An attempt begins in the same
 *   transaction that judges the record's admitted generation
 *   (`lifecycleEligibilityInTx`), so work starts only under an eligible
 *   generation and a lifecycle apply cannot land between the gate's decision
 *   and the recorded start (ADR-0007). The same transaction judges the
 *   record's durable cancellation intent: a claim arriving after the intent
 *   was recorded never runs the handler and commits the record's terminal
 *   `cancelled` outcome in the gate's own transaction, and the begin's
 *   projection itself is conditional on the intent, so an intent committing
 *   between the gate's read and its write stops the attempt at the write.
 */

/** The bounded progress a handler reports for its attempt. */
export interface JobsProgressInput {
  step: number;
  of: number;
  label: string;
}

/** The context one execution attempt hands its handler. */
export interface JobsExecutionContext {
  /**
   * The job's input, re-validated against the type's CURRENT input contract
   * at execution time. A job accepted under older rules that no longer parse
   * is terminated before the handler runs (the version-skew terminal failure,
   * distinct from a pre-acceptance rejection).
   */
  input: unknown;
  /** Which attempt this execution is — 1 for the first, +1 per retry. */
  attempt: number;
  /**
   * The job's record identity, as the start gate read it: the immutable
   * attribution (server, app, environment, principal kind, owner, qualified
   * type), the job's public id and its admitted lifecycle generation. A
   * trusted handler mints its outbound authority from here — never from the
   * input, which is the only app-supplied part of the context.
   */
  record: JobsAttemptRecord;
  /**
   * Aborts when the attempt can no longer land its outcome: the runner claim
   * was cancelled or expired (the dependency aborts the per-job signal when
   * its heartbeat finds the claim gone). A supported handler honors it —
   * bounded I/O stops rather than running on past its own fence — and an
   * ignored one changes nothing: the claim's settlement is fenced either
   * way, so the attempt's result can never land after the abort.
   */
  signal: AbortSignal;
  /**
   * Persist one bounded progress snapshot for THIS attempt. Answers
   * `refused` — and writes nothing — when the value is off the bounded shape
   * or the attempt is no longer the record's current one; the handler decides
   * whether a refused report fails its work.
   */
  report(progress: JobsProgressInput): Promise<"persisted" | "refused">;
}

/**
 * A trusted job handler — the platform-authored work for one installed type.
 * It resolves with the job's result (any JSON value, within the platform's
 * result bound) or throws: a {@link JobsExecutionError} carries the failure's
 * distinct reason, and any other throw is a platform error.
 */
export type JobsHandler = (context: JobsExecutionContext) => Promise<unknown>;

/** A handler failure carrying its distinct sanitized reason. */
export class JobsExecutionError extends Error {
  constructor(
    readonly code: JobErrorCode,
    options?: { cause?: unknown },
  ) {
    super(`the job's execution failed with reason "${code}"`, options);
    this.name = "JobsExecutionError";
  }
}

/**
 * Thrown when the attempt must not run and the runner row must not complete:
 * the worker-start gate refused (the lifecycle generation is not eligible), or
 * the record was already terminal. The throw settles the runner row through
 * its own retry policy; the wrapper record stays untouched and its outcome —
 * cancellation of closed-generation work — belongs to the recovery paths.
 */
export class JobsStartRefused extends Error {
  constructor(reason: string) {
    super(`the attempt did not start: ${reason}`);
    this.name = "JobsStartRefused";
  }
}

/**
 * The attempt's runner claim was already settled elsewhere when the wrapper
 * projection reached it — a claim timeout landed first, or the settlement's
 * own answer was lost. Thrown on the success path after the handler resolved:
 * the late result is discarded, never stored.
 */
export class JobsClaimLapsed extends Error {
  constructor() {
    super("the runner claim had lapsed before the attempt could settle");
    this.name = "JobsClaimLapsed";
  }
}

/**
 * The attempt's `unavailable` disposition: the execution store could not
 * answer, so the attempt fails through the runner's own retry policy with
 * nothing projected. The wrapper's message is fixed and bounded — the
 * store's own failure rides the cause — and the type is one of the attempt's
 * own dispositions, so the span's grading stays where the disposition is
 * decided (an infrastructure fault grades ERROR at every site, deliberately,
 * never incidentally by an escape hatch).
 */
export class JobsStoreUnavailable extends Error {
  constructor(options?: { cause?: unknown }) {
    super("the execution store could not answer the attempt", options);
    this.name = "JobsStoreUnavailable";
  }
}

/**
 * The handler registry — the seam the production type registrations compose
 * (the outbound fetch handler, the development fixtures). Registration
 * requires an installed execution policy: a type the policy registry does not
 * carry — any synthetic name, any non-catalogue type — cannot register, and a
 * second registration of one type is a composition defect that fails loudly
 * instead of silently replacing.
 */
export class JobsHandlerRegistry {
  readonly #handlers = new Map<string, JobsHandler>();

  register(qualifiedType: string, handler: JobsHandler): this {
    jobTypePolicy(qualifiedType);
    if (this.#handlers.has(qualifiedType)) {
      throw new Error(`a handler is already registered for job type "${qualifiedType}"`);
    }
    this.#handlers.set(qualifiedType, handler);
    return this;
  }

  /** The handler for a qualified type, or undefined — the dispatch's refusal answer. */
  handler(qualifiedType: string): JobsHandler | undefined {
    return this.#handlers.get(qualifiedType);
  }
}

/**
 * Validate and bound a handler's returned result: it must be a complete JSON
 * value and serialize within the platform's result allowance. The value
 * returned is the JSON round-trip of the handler's own; the result column
 * stores that round-trip's canonical text (the same walk's bytes, written by
 * `completeAttempt`). A refusal is a terminal failure reason, never a
 * truncated store.
 */
export function serializeBoundedResult(value: unknown): unknown {
  // One walk judges and serializes ({@link stringifyJsonValue}): the bound
  // refuses exactly what the value contract refuses, and the serialization
  // is iterative — a result at the byte cap's maximum legal depth (~32,000
  // levels) round-trips, where the engine's recursive JSON.stringify throws
  // past ~5,000.
  let text: string;
  try {
    text = stringifyJsonValue(value);
  } catch (error) {
    throw new JobsExecutionError("result_invalid", { cause: error });
  }
  if (Buffer.byteLength(text, "utf8") > JOBS_MAX_RESULT_BYTES) {
    throw new JobsExecutionError("result_too_large");
  }
  return JSON.parse(text) as unknown;
}

/**
 * The wrapper-record fields an attempt's projection needs, as read from the
 * store — including the job's immutable attribution, which the platform
 * handlers consume as their own execution authority (the outbound fetch
 * handler mints its callback instruction from it). The fields are the
 * record's stored columns, projected verbatim: no default owner, environment
 * or generation exists to invent.
 */
export interface JobsAttemptRecord {
  server: string;
  jobId: string;
  type: string;
  appId: string;
  env: "prod" | "dev";
  ownerKind: "user" | "dev";
  ownerOid: string;
  /** The lifecycle generation the job was admitted under (decimal string). */
  generation: string;
}

/**
 * What one attempt's begin decided. `started` hands back the record and the
 * attempt number the projection wrote; the refusals leave the record
 * untouched and the claim to the runner's own retry policy — except the
 * deadline refusal and the cancellation refusal, which terminate the record
 * themselves (their outcomes committed in the same transaction that decided
 * them, so recovery never authorizes execution past the deadline and never
 * re-runs cancelled work).
 */
export type BeginAttemptVerdict =
  | { verdict: "started"; record: JobsAttemptRecord; attempt: number }
  | { verdict: "gate_refused"; reason: "closed" | "unseen" }
  | { verdict: "deadline_exceeded"; record: JobsAttemptRecord }
  | { verdict: "cancelled"; record: JobsAttemptRecord }
  | { verdict: "terminal_fenced" };

export interface JobsExecutionStoreOptions {
  databaseUrl: string;
  /** Per-query ceiling, applied as both the pool's statement and connect timeout. */
  statementTimeoutMs: number;
  log: JobsExecutionLogger;
}

/**
 * Has the absolute deadline of a record accepted at `acceptedAt` passed —
 * measured on this process's clock, the same clock that wrote the
 * acceptance instant. The platform's deadline arithmetic keeps one clock for
 * its own policy; the runner's claim ceilings are the store's own business.
 */
export function deadlinePassed(acceptedAt: Date, deadlineSeconds: number): boolean {
  return acceptedAt.getTime() + deadlineSeconds * 1_000 <= Date.now();
}

/**
 * The timeout outcome's one write — the statement both enforcers of the
 * absolute deadline run: the worker-start gate (inside its own transaction)
 * and the recovery sweeper (against its own pool). Conditional on the record
 * still being nonterminal; returns the affected count, so a caller that lost
 * a race to a competing terminal write knows nothing was changed. The
 * attempt and progress columns stay — they are the attribution of the work
 * the deadline denied. The write stamps `terminal_at` (the store clock,
 * atomic with the status): the original terminal outcome's instant, the
 * input both public-read horizons derive from.
 */
export async function terminatePastDeadline(
  executor: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  server: string,
  jobId: string,
): Promise<number> {
  const updated = await executor.query(
    `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
        SET status = 'failed', error_code = 'timeout', terminal_at = now()
      WHERE server = $1 AND job_id = $2 AND NOT (status = ANY($3::text[]))`,
    [server, jobId, JOB_TERMINAL_STATUSES],
  );
  return updated.rowCount ?? 0;
}

/**
 * The cancellation outcome's one write — the statement every committer of
 * the terminal `cancelled` outcome runs: the worker-start gate's intent arm,
 * the gate's fenced-begin re-read, and the recovery sweeper's cancellation
 * arm. Conditional on the record still being nonterminal; returns the
 * affected count, so a caller that lost a race to a competing terminal write
 * knows nothing was changed (the first terminal outcome to commit wins). The
 * attempt and progress columns stay — they are the attribution of the work
 * the cancellation denied. The write stamps `terminal_at` (the store clock,
 * atomic with the status): the original terminal outcome's instant, the
 * input both public-read horizons derive from.
 */
export async function projectCancellation(
  executor: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  server: string,
  jobId: string,
): Promise<number> {
  const updated = await executor.query(
    `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
        SET status = 'cancelled', error_code = 'cancelled', terminal_at = now()
      WHERE server = $1 AND job_id = $2 AND NOT (status = ANY($3::text[]))`,
    [server, jobId, JOB_TERMINAL_STATUSES],
  );
  return updated.rowCount ?? 0;
}

/** The structural logger the execution seam reports through (the pino surface, without importing Fastify). */
export interface JobsExecutionLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** The runtime pool stays small: one short write per attempt milestone. */
const POOL_MAX = 2;

/** The stored columns of the wrapper record the execution paths read and write. */
interface RecordRow {
  server: string;
  job_id: string;
  type: string;
  app_id: string;
  env: string;
  status: string;
  generation: string;
  owner_kind: string;
  owner_oid: string;
  cancellation_requested: boolean;
  created_at: Date;
}

/**
 * The attempt record projected from a stored row — one spelling for every
 * verdict that hands the record to the handler or names it in evidence. The
 * stored enum columns are parsed against their wire schemas (the same
 * discipline the public status and error readers keep): a stored value the
 * contract does not carry is a defect answered by a throw, never a
 * malformed attribution handed to a handler.
 */
function attemptRecordOf(row: RecordRow): JobsAttemptRecord {
  return {
    server: row.server,
    jobId: row.job_id,
    type: row.type,
    appId: row.app_id,
    env: EnvSchema.parse(row.env),
    ownerKind: JobOwnerKindSchema.parse(row.owner_kind),
    ownerOid: row.owner_oid,
    generation: row.generation,
  };
}

/**
 * The execution state's durable store — the wrapper record's attempt,
 * progress and outcome projections, with the same pool discipline as every
 * store in this service: `start()` never throws, `stop()` releases on every
 * exit path, and use before start throws for the caller's failure contract.
 */
export class JobsExecutionStore {
  private readonly databaseUrl: string;
  private readonly statementTimeoutMs: number;
  private readonly log: JobsExecutionLogger;

  private pool: Pool | null = null;
  private stopped = false;

  constructor(options: JobsExecutionStoreOptions) {
    this.databaseUrl = options.databaseUrl;
    this.statementTimeoutMs = options.statementTimeoutMs;
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
          { event: "jobs.execution.pool_error", phase, err },
          "pooled jobs execution-store client dropped",
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

  /**
   * Begin one attempt: under the app's lifecycle row lock, judge the record's
   * admitted generation and its absolute deadline; an eligible, nonterminal,
   * in-deadline record is projected to `running` at this attempt — progress
   * reset, the previous attempt's error cleared — before the verdict
   * returns. Every refusal rolls back and returns; every store failure
   * throws for the caller's failure contract.
   */
  async beginAttempt(runnerJobId: string, attempt: number): Promise<BeginAttemptVerdict> {
    const pool = this.pool;
    if (this.stopped || !pool) {
      throw new Error("the execution store is not running");
    }
    return withJobsClient(pool, async (client) => {
      await client.query("BEGIN");
      try {
        const found = await client.query<RecordRow>(
          `SELECT server, job_id, type, app_id, env, status, generation,
                  owner_kind, owner_oid, cancellation_requested, created_at
             FROM ${JOBS_JOB_RECORD_QUALIFIED}
            WHERE runner_job_id = $1`,
          [runnerJobId],
        );
        const row = found.rows[0];
        if (!row) {
          // The acceptance transaction commits the wrapper record and the
          // runner row together, and only the physical cleanup removes them —
          // together. A claim with no record is corruption; nothing honest
          // can be projected for it.
          throw new Error(
            `no wrapper record is joined to runner job "${runnerJobId}" — the acceptance transaction commits both or neither`,
          );
        }
        const status = publicStatus(row.status);

        // The start gate, under the serialization lock: a generation that is
        // no longer eligible (or was never delivered) stops the job here —
        // the handler never runs, and the record stays exactly as it was.
        const eligibility = await lifecycleEligibilityInTx(client, row.app_id, row.generation);
        if (eligibility.verdict !== "admit") {
          await client.query("ROLLBACK");
          return { verdict: "gate_refused", reason: eligibility.verdict };
        }

        if ((JOB_TERMINAL_STATUSES as readonly string[]).includes(status)) {
          await client.query("ROLLBACK");
          return { verdict: "terminal_fenced" };
        }

        // The absolute deadline: queue wait and every retry delay consumed
        // the acceptance-to-close bound, so this attempt must not run. The
        // gate terminates the record here — the timeout outcome committed in
        // the same transaction that decided it — rather than leaving it to
        // the sweeper's next pass, and the claim settles through the runner's
        // own retry policy (spec criterion 24: recovery never authorizes
        // execution after the deadline).
        if (deadlinePassed(row.created_at, jobsAbsoluteDeadline(row.type))) {
          const terminated = await terminatePastDeadline(client, row.server, row.job_id);
          await client.query("COMMIT");
          return terminated === 1
            ? { verdict: "deadline_exceeded", record: attemptRecordOf(row) }
            : { verdict: "terminal_fenced" };
        }

        // Durable cancellation intent: the owner's (or a lifecycle
        // delivery's) recorded request was committed before this claim, so
        // the work must not start and the terminal `cancelled` outcome
        // commits here — the same transaction that decided it, so the
        // intent can never turn into a run or a retry (spec criterion 48).
        // Conditional like every terminal write: a completion that settled
        // the record between the read and here loses this write, and its
        // outcome keeps the record.
        if (row.cancellation_requested) {
          const cancelled = await projectCancellation(client, row.server, row.job_id);
          await client.query("COMMIT");
          return cancelled === 1
            ? { verdict: "cancelled", record: attemptRecordOf(row) }
            : { verdict: "terminal_fenced" };
        }

        // The attempt's projection, conditional on the record still being
        // nonterminal AND this attempt's number being newer than the stored
        // one AND no cancellation intent having been recorded: a competing
        // terminal write between the read and here loses this update, so
        // does a claim whose begin was delayed past its own claim expiry and
        // lands after a newer claim's begin — the stale attempt number is
        // fenced instead of overwriting the newer one — and a cancellation
        // intent committed in the gap between the read above and this write
        // stops the attempt at the write itself (queued cancelled work never
        // starts).
        const updated = await client.query(
          `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
              SET status = 'running', attempt = $1, progress = NULL, error_code = NULL
            WHERE server = $2 AND job_id = $3
              AND NOT (status = ANY($4::text[]))
              AND NOT cancellation_requested
              AND (attempt IS NULL OR attempt < $1)`,
          [attempt, row.server, row.job_id, JOB_TERMINAL_STATUSES],
        );
        if ((updated.rowCount ?? 0) !== 1) {
          // The projection was fenced — a terminal write won the gap, the
          // attempt number went stale, or the intent committed inside it
          // (the fence's whole purpose). Re-read to distinguish: a record
          // still non-terminal and carrying the intent gets its terminal
          // `cancelled` outcome committed HERE, in the transaction that
          // discovered the race — the handler never runs, and the claim's
          // settle through the runner's own retry policy can never leave a
          // code-less failed row for the recovery path to mislabel as a
          // platform crash. The intent's projection is conditional like
          // every terminal write: a competing outcome committing inside
          // this second gap loses it, and the fence's original answer
          // stands.
          const current = await client.query<{
            status: string;
            cancellation_requested: boolean;
          }>(
            `SELECT status, cancellation_requested
               FROM ${JOBS_JOB_RECORD_QUALIFIED}
              WHERE server = $1 AND job_id = $2`,
            [row.server, row.job_id],
          );
          const currentRow = current.rows[0];
          const stillOpen =
            currentRow !== undefined &&
            !(JOB_TERMINAL_STATUSES as readonly string[]).includes(publicStatus(currentRow.status));
          if (stillOpen && currentRow.cancellation_requested) {
            const cancelled = await projectCancellation(client, row.server, row.job_id);
            await client.query("COMMIT");
            return cancelled === 1
              ? { verdict: "cancelled", record: attemptRecordOf(row) }
              : { verdict: "terminal_fenced" };
          }
          await client.query("ROLLBACK");
          return { verdict: "terminal_fenced" };
        }
        await client.query("COMMIT");
        return { verdict: "started", record: attemptRecordOf(row), attempt };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    });
  }

  /**
   * Persist one attempt's bounded progress. The write is conditional on the
   * attempt still being the record's current one, so a report from a lapsed
   * claim cannot poison the attribution a newer attempt wrote.
   */
  async reportProgress(
    record: JobsAttemptRecord,
    attempt: number,
    progress: JobsProgressInput,
  ): Promise<"persisted" | "refused"> {
    const pool = this.pool;
    if (this.stopped || !pool) {
      throw new Error("the execution store is not running");
    }
    const parsed = JobProgressSchema.safeParse(progress);
    if (!parsed.success) {
      this.log.warn(
        { event: "jobs.execution.progress_refused", appId: record.appId, attempt },
        "a handler reported progress off the bounded shape — nothing was persisted",
      );
      return "refused";
    }
    // Why the explicit cast and the serialized text: jsonb parameters take
    // JSON text — a top-level scalar result (the number 42, the string "ok")
    // handed to the driver as a bare value arrives as `42`/`ok`, which the
    // column refuses. The text is the bound serialization the seam already
    // produced.
    const updated = await pool.query(
      `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
          SET progress = $1::jsonb
        WHERE server = $2 AND job_id = $3 AND status = 'running' AND attempt = $4`,
      [JSON.stringify(parsed.data), record.server, record.jobId, attempt],
    );
    if ((updated.rowCount ?? 0) !== 1) {
      this.log.warn(
        { event: "jobs.execution.progress_refused", appId: record.appId, attempt },
        "a handler's progress report lost its attempt's currency — nothing was persisted",
      );
      return "refused";
    }
    return "persisted";
  }

  /**
   * Project a failed attempt: `queued` with the failure's reason when the
   * type's policy will retry (the previous attempt's progress and error stay
   * — the attribution the snapshot shows while waiting), terminal `failed`
   * when no attempt remains. The terminal arm stamps `terminal_at` (the
   * original terminal outcome's instant — the read horizons' input); the
   * retry arm never does. Conditional on this attempt still being the
   * record's current one; `fenced` means a competing outcome won.
   */
  async failAttempt(
    record: JobsAttemptRecord,
    attempt: number,
    code: JobErrorCode,
    retrying: boolean,
  ): Promise<"projected" | "fenced"> {
    const pool = this.pool;
    if (this.stopped || !pool) {
      throw new Error("the execution store is not running");
    }
    const updated = await pool.query(
      `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
          SET status = $5, error_code = $4, terminal_at = CASE WHEN $5 = 'failed' THEN now() END
        WHERE server = $1 AND job_id = $2 AND status = 'running' AND attempt = $3`,
      [record.server, record.jobId, attempt, code, retrying ? "queued" : "failed"],
    );
    return (updated.rowCount ?? 0) === 1 ? "projected" : "fenced";
  }

  /**
   * Project a successful attempt: the bounded result, the terminal success,
   * the error cleared. The progress stays — it is the attempt that produced
   * the result. `terminal_at` is stamped here (the original terminal
   * outcome's instant): the result horizon (seven days) and the record
   * horizon (thirty days) both derive from it, and a later logical expiry
   * never rewrites it. Conditional like every projection; `fenced` means a
   * competing terminal outcome (a cancellation, a recovery's crash) won the
   * race.
   */
  async completeAttempt(
    record: JobsAttemptRecord,
    attempt: number,
    result: unknown,
  ): Promise<"projected" | "fenced"> {
    const pool = this.pool;
    if (this.stopped || !pool) {
      throw new Error("the execution store is not running");
    }
    // The stored form is the bound's own canonical JSON text, serialized
    // iteratively (the same walk the bound ran — canonical of canonical is
    // the same bytes it measured) and never parsed or re-serialized by the
    // store: jsonb's parser is recursive and could not hold a result at the
    // byte cap's maximum legal depth. A refusal here is a value that
    // mutated after its judgment — the projection's failure path answers it.
    const text = stringifyJsonValue(result);
    const updated = await pool.query(
      `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
          SET status = 'succeeded', result = $4, error_code = NULL, terminal_at = now()
        WHERE server = $1 AND job_id = $2 AND status = 'running' AND attempt = $3`,
      [record.server, record.jobId, attempt, text],
    );
    return (updated.rowCount ?? 0) === 1 ? "projected" : "fenced";
  }
}

export interface JobsExecutionOptions {
  databaseUrl: string;
  /** Per-query ceiling, applied as both the execution store's statement and connect timeout. */
  statementTimeoutMs: number;
  /** The registered handlers — the dispatch's whole repertoire. */
  handlers: JobsHandlerRegistry;
  /** The resolved capacity limits — the worker's concurrency derives from them, never a second copy. */
  limits: JobsCapacityLimits;
  log: JobsExecutionLogger;
}

/**
 * The live worker registrations of every {@link JobsExecution} component,
 * per runner instance. The per-process execution allowance is the ONE worker
 * registration's options (`jobsWorkOptions`); pg-boss spawns a full
 * concurrency worker set per `work()` call, so a second live registration on
 * one instance would silently multiply the per-process total the platform
 * adopted — the exact "never let each type silently receive its own full
 * allowance" shape (design §6). The guard at `registerOn` makes that a
 * refused composition defect instead, whichever component attempted it.
 *
 * The value is the registration's own settlement, recorded synchronously
 * before the boundary call can be awaited — the decision and its record are
 * one step, so even overlapping registrations cannot both pass the check and
 * land two worker sets. The record is removed only when the boundary itself
 * refused (nothing landed); a registration that landed stays held until
 * released, whatever its own aftermath did.
 */
const liveWorkerIds = new WeakMap<PgBoss, Promise<string>>();

/**
 * The execution component — the worker registration the runner invokes on its
 * started instance, and the attempt wrapper every claim passes through. The
 * component owns no loop or timer of its own: the worker lives on the
 * runner's pg-boss instance, and its store's pool is the only resource here.
 */
export class JobsExecution {
  private readonly store: JobsExecutionStore;
  private readonly handlers: JobsHandlerRegistry;
  private readonly limits: JobsCapacityLimits;
  private readonly log: JobsExecutionLogger;

  constructor(options: JobsExecutionOptions) {
    this.store = new JobsExecutionStore({
      databaseUrl: options.databaseUrl,
      statementTimeoutMs: options.statementTimeoutMs,
      log: options.log,
    });
    this.handlers = options.handlers;
    this.limits = options.limits;
    this.log = options.log;
  }

  start(): void {
    this.store.start();
  }

  async stop(): Promise<void> {
    await this.store.stop();
  }

  /**
   * Register the worker on a started instance — the runner's registration
   * hook, invoked after each successful start. The options are the shared
   * policy's derivation (per-process total and per-app/environment group
   * concurrency), one job per batch so a batch settlement can never couple
   * unrelated jobs, and metadata on — the attempt's retry decision reads the
   * row's own policy, never a second copy of the numbers. Returns the
   * worker's id (the runner discards it; an operator or a test can target the
   * worker with it).
   */
  async registerOn(boss: PgBoss): Promise<string> {
    if (liveWorkerIds.has(boss)) {
      throw new Error(
        "this runner instance already holds a live worker registration — a second one " +
          "would multiply the per-process execution allowance (a work call spawns its own " +
          "full worker set); release the current registration first",
      );
    }
    // The literal props after the spread keep their narrow types, so the
    // `work` overload resolves to the metadata handler signature.
    const workerOptions = {
      ...jobsWorkOptions(this.limits),
      batchSize: 1,
      includeMetadata: true,
    } satisfies WorkOptions;
    // The record lands before the boundary call can be awaited: the check
    // above and the record below are one synchronous step, so an overlapping
    // registration is refused instead of doubling the worker set through the
    // guard itself.
    const registration = boss.work(JOBS_QUEUE_NAME, workerOptions, (jobs) =>
      this.runBatch(boss, jobs),
    );
    liveWorkerIds.set(boss, registration);
    let workerId: string;
    try {
      workerId = await registration;
    } catch (error) {
      // The boundary refused the worker — nothing landed, so the record
      // releases and the instance can take its worker once the boundary
      // answers. The catch ends here: past it the worker set is LIVE, and
      // nothing in the aftermath may free the record.
      liveWorkerIds.delete(boss);
      throw error;
    }
    this.log.info(
      { event: "jobs.worker.registered", queue: JOBS_QUEUE_NAME, workerId },
      "the jobs worker is registered on the runner",
    );
    return workerId;
  }

  /**
   * Release this component's worker registration on an instance — the
   * sanctioned counterpart of {@link registerOn}, so a registration can end
   * without taking the whole instance down (a test harness's per-leg worker;
   * the production composition never calls it — the runner's stop() takes
   * the instance with its worker). Releasing an unregistered instance is a
   * no-op: there is nothing to release. A registration still in flight is
   * waited out and whatever landed is released — a release can never strand
   * a worker set that is still mid-registration.
   */
  async releaseOn(boss: PgBoss): Promise<void> {
    const registration = liveWorkerIds.get(boss);
    if (!registration) return;
    const workerId = await registration;
    // Forgotten only after the release answers, and only if the record is
    // still the registration THIS release released: a stale overlapping
    // release's forget must not erase a newer registration's record and
    // reopen the guard over a live worker set. A release that threw also
    // leaves the registration held — a re-registration cannot double a live
    // worker; the next release retries the idempotent offWork.
    await boss.offWork(JOBS_QUEUE_NAME, { id: workerId });
    if (liveWorkerIds.get(boss) === registration) {
      liveWorkerIds.delete(boss);
    }
  }

  private async runBatch(boss: PgBoss, jobs: JobWithMetadata<unknown>[]): Promise<void> {
    // One job per batch (the registration fixes batchSize 1): a throw settles
    // the batch through the runner's own retry policy, which must never
    // couple unrelated jobs.
    for (const job of jobs) {
      await this.runOne(boss, job);
    }
  }

  /**
   * One attempt of one job, as the span the operator reads. Every exit sets
   * its bounded outcome; the failure's reason rides `helix.reason`.
   */
  private runOne(boss: PgBoss, job: JobWithMetadata<unknown>): Promise<void> {
    return withExecutionSpan(async (span) => {
      try {
        await this.attempt(boss, job, span);
      } catch (error) {
        // An error that is not one of the attempt's own dispositions escaped
        // without an outcome — a defect in this wrapper, not a job's answer.
        // It is recorded and failed on the span; the runner row's own
        // settlement carries the job side.
        if (
          !(error instanceof JobsExecutionError) &&
          !(error instanceof JobsStartRefused) &&
          !(error instanceof JobsClaimLapsed) &&
          !(error instanceof JobsStoreUnavailable)
        ) {
          span.recordException(error instanceof Error ? error : new Error(String(error)));
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        throw error;
      }
    });
  }

  private async attempt(boss: PgBoss, job: JobWithMetadata<unknown>, span: Span): Promise<void> {
    // ── the start gate and the attempt's projection ────────────────────────
    let begun: BeginAttemptVerdict;
    try {
      begun = await this.store.beginAttempt(job.id, job.retryCount + 1);
    } catch (error) {
      this.log.error(
        { event: "jobs.execution.unavailable", runnerJobId: job.id, err: error },
        "the execution store could not begin the attempt",
      );
      span.setAttribute(ATTR_OUTCOME, "unavailable" satisfies JobsExecuteOutcome);
      failSpan(span, error);
      countExecution("unavailable");
      // The controlled disposition: the runner row fails through its own
      // retry policy, and the span's grading stays here — the wrapper's
      // escape hatch never sees an ungraded unavailable.
      throw new JobsStoreUnavailable({ cause: error });
    }
    if (begun.verdict === "gate_refused") {
      this.log.warn(
        { event: "jobs.execution.gate_refused", runnerJobId: job.id, reason: begun.reason },
        "the worker-start gate refused the job — its lifecycle generation is not eligible to start",
      );
      span.setAttribute(ATTR_OUTCOME, "gate_refused" satisfies JobsExecuteOutcome);
      countExecution("gate_refused");
      throw new JobsStartRefused(`the job's lifecycle generation is ${begun.reason}`);
    }
    if (begun.verdict === "deadline_exceeded") {
      const { record } = begun;
      span.setAttributes({
        [ATTR_APP_ID]: record.appId,
        [ATTR_JOBS_TYPE]: record.type,
        [ATTR_JOBS_JOB_ID]: record.jobId,
      });
      this.log.warn(
        { event: "jobs.execution.deadline_exceeded", runnerJobId: job.id, appId: record.appId },
        "the worker-start gate terminated the job — its absolute deadline passed before this attempt",
      );
      span.setAttribute(ATTR_OUTCOME, "deadline_exceeded" satisfies JobsExecuteOutcome);
      countExecution("deadline_exceeded");
      throw new JobsStartRefused("the job's absolute deadline has passed");
    }
    if (begun.verdict === "terminal_fenced") {
      this.log.warn(
        { event: "jobs.execution.terminal_fenced", runnerJobId: job.id },
        "the record was already terminal or carries a durable cancellation — the attempt did not run",
      );
      span.setAttribute(ATTR_OUTCOME, "terminal_fenced" satisfies JobsExecuteOutcome);
      countExecution("terminal_fenced");
      throw new JobsStartRefused(
        "the record was already terminal or carries a durable cancellation",
      );
    }
    if (begun.verdict === "cancelled") {
      const { record } = begun;
      span.setAttributes({
        [ATTR_APP_ID]: record.appId,
        [ATTR_JOBS_TYPE]: record.type,
        [ATTR_JOBS_JOB_ID]: record.jobId,
      });
      this.log.info(
        {
          event: "jobs.execution.cancelled_before_start",
          runnerJobId: job.id,
          appId: record.appId,
        },
        "the worker-start gate committed the record's cancellation — the durable intent was recorded before the attempt could begin",
      );
      span.setAttribute(ATTR_OUTCOME, "cancelled" satisfies JobsExecuteOutcome);
      countExecution("cancelled");
      throw new JobsStartRefused("the job's cancellation was recorded before this attempt");
    }
    const { record, attempt } = begun;
    span.setAttributes({
      [ATTR_APP_ID]: record.appId,
      [ATTR_JOBS_TYPE]: record.type,
      [ATTR_JOBS_JOB_ID]: record.jobId,
      [ATTR_JOBS_ATTEMPT]: attempt,
    });

    try {
      await this.execute(boss, job, record, attempt, span);
    } catch (error) {
      if (error instanceof JobsClaimLapsed) {
        this.log.warn(
          {
            event: "jobs.execution.claim_lapsed",
            appId: record.appId,
            jobId: record.jobId,
            attempt,
          },
          "the claim lapsed before the attempt could settle — the late result is discarded, never stored",
        );
        span.setAttribute(ATTR_OUTCOME, "terminal_fenced" satisfies JobsExecuteOutcome);
        countExecution("terminal_fenced");
        return;
      }
      const code = error instanceof JobsExecutionError ? error.code : "platform_error";
      if (code === "platform_error") {
        this.log.error(
          {
            event: "jobs.execution.platform_error",
            appId: record.appId,
            jobId: record.jobId,
            attempt,
            err: error,
          },
          "the attempt failed without a job-level reason",
        );
        span.setStatus({ code: SpanStatusCode.ERROR });
      } else {
        this.log.warn(
          {
            event: "jobs.execution.failed",
            appId: record.appId,
            jobId: record.jobId,
            attempt,
            reason: code,
          },
          "the attempt failed with the handler's own reason",
        );
      }
      await this.projectFailure(boss, job, record, attempt, code, span);
      throw error;
    }
  }

  /**
   * The attempt's body: dispatch, execution-time revalidation, the handler,
   * the bounded result and the claim-settled projection.
   */
  private async execute(
    boss: PgBoss,
    job: JobWithMetadata<unknown>,
    record: JobsAttemptRecord,
    attempt: number,
    span: Span,
  ): Promise<void> {
    // The dispatch: a type with no registered handler cannot execute. The
    // attempt was accepted under an installed policy, so a gap here is
    // registration drift — a platform error, never silent.
    const handler = this.handlers.handler(record.type);
    if (!handler) {
      throw new JobsExecutionError("platform_error", {
        cause: `no handler is registered for job type "${record.type}"`,
      });
    }
    // The policy lookup cannot fail for a registered type (registration
    // required one), but the record's type is read back from the store: a
    // skew that removed the policy refuses here, loudly.
    let policy;
    try {
      policy = jobTypePolicy(record.type);
    } catch (error) {
      throw new JobsExecutionError("platform_error", { cause: error });
    }

    // Execution-time validation: the job's input is parsed against the
    // CURRENT contract. A job accepted under older rules that no longer
    // parse terminates with its own distinct reason — the same accepted job,
    // a terminal failure, never a re-run of admission.
    const parsed = policy.inputSchema.safeParse(job.data);
    if (!parsed.success) {
      throw new JobsExecutionError("execution_input_invalid");
    }

    // The handler's attempt. Its result is any JSON value within the
    // platform's bound; its distinct failures carry their own reasons. The
    // attempt's own abort signal rides with it: the runner claim's
    // cancellation (an owner's or a lifecycle delivery's) and expiry are
    // what trip it, and a supported handler stops its bounded I/O on it.
    const raw = await handler({
      input: parsed.data,
      attempt,
      record,
      signal: job.signal,
      report: (progress) => this.store.reportProgress(record, attempt, progress),
    });
    const stored = serializeBoundedResult(raw);

    // The claim's own fenced settlement, then the projection: only a settle
    // that reports the claim held may write the wrapper. The runner row and
    // the wrapper record cannot disagree about who won.
    // Why the structural type: the pinned dependency's `CommandResponse`
    // declaration is empty, but its settlement paths return
    // `{jobs, requested, affected, settled?}` (its manager's
    // `mapCommandResponse`) — the attempt fence's answer is the `affected`
    // count.
    let settled: { affected?: number };
    try {
      settled = (await boss.complete(JOBS_QUEUE_NAME, {
        id: job.id,
        retryCount: job.retryCount,
      })) as { affected?: number };
    } catch (error) {
      // The settlement's answer is lost: the row may or may not be completed.
      // Nothing is projected from an uncertain claim — the recovery path
      // reconciles the record against the runner's own state.
      this.log.error(
        {
          event: "jobs.execution.settle_uncertain",
          appId: record.appId,
          jobId: record.jobId,
          attempt,
          err: error,
        },
        "the attempt's completion could not be confirmed — nothing was projected",
      );
      span.setAttribute(ATTR_OUTCOME, "unavailable" satisfies JobsExecuteOutcome);
      failSpan(span, error);
      countExecution("unavailable");
      return;
    }
    if ((settled.affected ?? 0) === 0) {
      throw new JobsClaimLapsed();
    }
    let verdict: "projected" | "fenced";
    try {
      verdict = await this.store.completeAttempt(record, attempt, stored);
    } catch (error) {
      // The runner row is settled completed; the projection's failure leaves
      // the record mid-flight for the recovery path to reconcile.
      this.log.error(
        {
          event: "jobs.execution.projection_failed",
          appId: record.appId,
          jobId: record.jobId,
          attempt,
          err: error,
        },
        "the attempt's success could not be projected — the runner row is settled; the recovery path reconciles the record",
      );
      span.setAttribute(ATTR_OUTCOME, "unavailable" satisfies JobsExecuteOutcome);
      failSpan(span, error);
      countExecution("unavailable");
      return;
    }
    if (verdict === "fenced") {
      this.log.warn(
        {
          event: "jobs.execution.outcome_raced",
          appId: record.appId,
          jobId: record.jobId,
          attempt,
        },
        "a competing terminal outcome won the race — the attempt's success was not projected",
      );
      span.setAttribute(ATTR_OUTCOME, "terminal_fenced" satisfies JobsExecuteOutcome);
      countExecution("terminal_fenced");
      return;
    }
    span.setAttribute(ATTR_OUTCOME, "succeeded" satisfies JobsExecuteOutcome);
    countExecution("succeeded");
  }

  /**
   * Project a failed attempt: the runner's own attempt-fenced fail first — a
   * claim the timeout (or another worker) already settled refuses, and the
   * wrapper stays untouched for the recovery path — then the conditional
   * wrapper write. The span's outcome reflects what actually landed.
   */
  private async projectFailure(
    boss: PgBoss,
    job: JobWithMetadata<unknown>,
    record: JobsAttemptRecord,
    attempt: number,
    code: JobErrorCode,
    span: Span,
  ): Promise<void> {
    try {
      // Why the structural type: `CommandResponse`'s declaration is empty —
      // see the settlement note in `execute` above.
      const failResponse = (await boss.fail(
        JOBS_QUEUE_NAME,
        { id: job.id, retryCount: job.retryCount },
        { code },
      )) as { affected?: number };
      if ((failResponse.affected ?? 0) === 0) {
        this.log.warn(
          {
            event: "jobs.execution.claim_lapsed",
            appId: record.appId,
            jobId: record.jobId,
            attempt,
          },
          "the claim was already settled elsewhere — the failure was not projected",
        );
        span.setAttribute(ATTR_OUTCOME, "terminal_fenced" satisfies JobsExecuteOutcome);
        span.setAttribute(ATTR_REASON, code);
        countExecution("terminal_fenced");
        return;
      }
    } catch (error) {
      this.log.error(
        {
          event: "jobs.execution.settle_uncertain",
          appId: record.appId,
          jobId: record.jobId,
          attempt,
          err: error,
        },
        "the attempt's failure could not be confirmed on the runner row — nothing was projected",
      );
      span.setAttribute(ATTR_OUTCOME, "unavailable" satisfies JobsExecuteOutcome);
      failSpan(span, error);
      countExecution("unavailable");
      return;
    }
    try {
      const projected = await this.store.failAttempt(
        record,
        attempt,
        code,
        job.retryCount < job.retryLimit,
      );
      if (projected === "fenced") {
        this.log.warn(
          {
            event: "jobs.execution.outcome_raced",
            appId: record.appId,
            jobId: record.jobId,
            attempt,
          },
          "a competing terminal outcome won the race — the attempt's failure was not projected",
        );
        span.setAttribute(ATTR_OUTCOME, "terminal_fenced" satisfies JobsExecuteOutcome);
        span.setAttribute(ATTR_REASON, code);
        countExecution("terminal_fenced");
        return;
      }
      span.setAttribute(ATTR_OUTCOME, "failed" satisfies JobsExecuteOutcome);
      span.setAttribute(ATTR_REASON, code);
      countExecution("failed");
    } catch (error) {
      this.log.error(
        {
          event: "jobs.execution.projection_failed",
          appId: record.appId,
          jobId: record.jobId,
          attempt,
          err: error,
        },
        "the attempt's failure could not be projected — the recovery path reconciles the record",
      );
      span.setAttribute(ATTR_OUTCOME, "unavailable" satisfies JobsExecuteOutcome);
      failSpan(span, error);
      countExecution("unavailable");
    }
  }
}

/**
 * The public status a stored record projects, parsed against the wire enum
 * before it can reach a response or a projection — a stored value the
 * contract does not carry is a defect answered by the error boundary, never a
 * malformed body on the wire. Both readers of the record's status column —
 * the acceptance transaction's keyed recovery and the execution projection —
 * go through this one parse, so the judgment cannot drift.
 */
export function publicStatus(status: string): JobStatus {
  const parsed = JobStatusSchema.safeParse(status);
  if (!parsed.success) {
    throw new Error(`the stored job status is not a public status: ${JSON.stringify(status)}`);
  }
  return parsed.data;
}

/**
 * The stored execution error a record carries, as the wire's JobError — the
 * code is schema-checked in the column, so an unmappable value is a defect
 * answered by a throw, never a malformed error body.
 */
export function storedExecutionError(code: string | null): JobError | null {
  if (code === null) return null;
  const parsed = JobErrorCodeSchema.safeParse(code);
  if (!parsed.success) {
    throw new Error(`the stored error code is not a public code: ${JSON.stringify(code)}`);
  }
  return jobError(parsed.data);
}
