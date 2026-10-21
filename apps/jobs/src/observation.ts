import type { Pool } from "pg";

import {
  JobSnapshotSchema,
  type JobError,
  type JobSnapshot,
  type JobStatus,
} from "@azx-pbc/shared";
import type { JobsResultClaims, JobsSnapshotClaims } from "@azx-pbc/shared/jobsSigning";

import { publicStatus, storedExecutionError } from "./execution.js";
import { createJobsPool } from "./pool.js";
import {
  JOBS_JOB_RECORD_QUALIFIED,
  JOBS_RECORD_TTL_SECONDS,
  JOBS_RESULT_TTL_SECONDS,
} from "./policy.js";

/**
 * The jobs observation seam (background-jobs-plane design §7) — the
 * owner-scoped status and result reads, projected from the stored record
 * against the logical public-read horizons. The horizons are computed, never
 * awaited: a record reads `expired` from the instant its successful result's
 * seven-day lifetime ends and reads as unknown from the instant its thirty-day
 * record lifetime ends, whatever the physical cleanup's timing — the row's
 * `terminal_at` (every terminal write stamps it) is the only input.
 *
 * The projection is one shared view, and every reader of the record's public
 * state consumes it — the snapshot and result reads here, the cancellation
 * seam's terminal classification, and the acceptance transaction's
 * retained-key comparison — so no path can show a stale `succeeded` past the
 * result horizon or a readable record past the record horizon.
 *
 * Authorization is the same fail-closed classification every record operation
 * applies: existence, then the signed caller's identity (app, environment,
 * principal kind, owner), then the record's public readability, then the
 * type grant — and every mismatch a caller cannot distinguish is answered
 * with the unknown-job 404 (spec criterion 4). A failed observation changes
 * nothing and mutates nothing: these are read-only paths, and an observation
 * failure is never an execution failure.
 */

/** The stored columns the public-read view projects from — the shape every consumer supplies. */
export interface JobRecordHorizonRow {
  status: string;
  /** The original terminal outcome's instant; null while the record is non-terminal. */
  terminal_at: Date | null;
}

/**
 * Is the record past its public record horizon at `now` — the state every
 * reader answers with the unknown-job 404 while the row is still physically
 * retained? Only terminal records have a horizon; active work is never
 * expired by age.
 */
export function recordHorizonPassed(record: JobRecordHorizonRow, now: Date): boolean {
  return (
    record.terminal_at !== null &&
    record.terminal_at.getTime() + JOBS_RECORD_TTL_SECONDS * 1_000 <= now.getTime()
  );
}

/**
 * Has the successful result's seven-day lifetime ended at `now`? Applies only
 * to a formerly successful result — a stored `expired` row (the cleanup's own
 * projection) and a stored `succeeded` row past its horizon; every other
 * status has no result to expire.
 */
export function resultHorizonPassed(record: JobRecordHorizonRow, now: Date): boolean {
  if (record.terminal_at === null) return false;
  if (record.status !== "succeeded" && record.status !== "expired") return false;
  return record.terminal_at.getTime() + JOBS_RESULT_TTL_SECONDS * 1_000 <= now.getTime();
}

/**
 * The public status a stored record projects at `now`: the stored status,
 * with a successful result whose lifetime has ended reading `expired` at the
 * boundary — irrespective of delayed physical cleanup. The one derivation
 * every reader of the status column consumes (spec criterion 35).
 */
export function projectedPublicStatus(record: JobRecordHorizonRow, now: Date): JobStatus {
  const stored = publicStatus(record.status);
  if (stored === "succeeded" && resultHorizonPassed(record, now)) return "expired";
  return stored;
}

/** The public `resultExpiresAt` — when the result stopped (stops) being readable; null without a successful result. */
export function resultExpiresAtIso(record: JobRecordHorizonRow): string | null {
  if (record.status !== "succeeded" && record.status !== "expired") return null;
  if (record.terminal_at === null) {
    // The store's own CHECK constraint (a result exists only on a row
    // projecting success, and success is always dated) makes this a defect,
    // not a state — thrown for the caller's failure contract, never read as
    // an absent horizon.
    throw new Error(
      "a successful record carries no terminal instant — the horizon cannot be derived",
    );
  }
  return new Date(record.terminal_at.getTime() + JOBS_RESULT_TTL_SECONDS * 1_000).toISOString();
}

/** The public `recordExpiresAt` — when the record stopped (stops) being readable; null while the job is unfinished. */
export function recordExpiresAtIso(record: JobRecordHorizonRow): string | null {
  if (record.terminal_at === null) return null;
  return new Date(record.terminal_at.getTime() + JOBS_RECORD_TTL_SECONDS * 1_000).toISOString();
}

/** The verified record operation an observation decides on — claims from the receiver, the reference as addressed. */
export interface JobsObservationRequest {
  /** The instruction's verified snapshot or result claims — the trusted identity and grants. */
  claims: JobsSnapshotClaims | JobsResultClaims;
  /** The job's public id, from the route the instruction was bound to. */
  jobId: string;
}

/** What one owner status poll decided. */
export type JobsSnapshotVerdict =
  | { outcome: "found"; snapshot: JobSnapshot }
  | { outcome: "not_found" }
  | { outcome: "forbidden" };

/** What one owner result read decided. */
export type JobsResultVerdict =
  | { outcome: "found"; resultText: string }
  | { outcome: "not_ready"; status: JobStatus; error: JobError | null }
  | { outcome: "terminal"; status: JobStatus; error: JobError | null }
  | { outcome: "expired" }
  | { outcome: "not_found" }
  | { outcome: "forbidden" };

/** The observation seam the snapshot and result routes consume (the durable store implements it; tests may substitute). */
export interface JobsObservation {
  snapshot(request: JobsObservationRequest): Promise<JobsSnapshotVerdict>;
  result(request: JobsObservationRequest): Promise<JobsResultVerdict>;
}

/** The structural logger the store reports through (the pino surface, without importing Fastify). */
export interface JobsObservationLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface JobsObservationStoreOptions {
  databaseUrl: string;
  /** Per-query ceiling, applied as both the pool's statement and connect timeout. */
  statementTimeoutMs: number;
  log: JobsObservationLogger;
}

/** The runtime pool stays small: one short read per poll. */
const POOL_MAX = 2;

/** The record columns one observation reads. */
interface RecordRow extends JobRecordHorizonRow {
  app_id: string;
  env: string;
  owner_kind: string;
  owner_oid: string;
  type: string;
  attempt: number | null;
  progress: unknown;
  error_code: string | null;
  result: string | null;
  cancellation_requested: boolean;
}

/** Why an observation was refused before any state was read — the same 404 for a foreign or unreadable record, the 403 for a lapsed grant. */
type AccessVerdict =
  | { ok: true; row: RecordRow }
  | { ok: false; verdict: Exclude<JobsSnapshotVerdict["outcome"], "found"> };

/**
 * The read authorization's classification, in the order the contract fixes:
 * existence, then the signed identity (both answer the unknown-job 404),
 * then the record's public readability (a record past its horizon is
 * indistinguishable from an unknown one — to any caller), then the type
 * grant (403 — the owner's own lapsed grant, fail-closed, ahead of any state
 * revelation).
 */
function classifyAccess(
  row: RecordRow | undefined,
  claims: JobsSnapshotClaims | JobsResultClaims,
  now: Date,
): AccessVerdict {
  if (
    !row ||
    row.app_id !== claims.appId ||
    row.env !== claims.env ||
    row.owner_kind !== claims.ownerKind ||
    row.owner_oid !== claims.ownerOid ||
    recordHorizonPassed(row, now)
  ) {
    return { ok: false, verdict: "not_found" };
  }
  if (!claims.allowedTypes.includes(row.type)) {
    return { ok: false, verdict: "forbidden" };
  }
  return { ok: true, row };
}

/**
 * The durable observation store — the owner-scoped reads against the
 * service's private store, with the same pool discipline as every store in
 * this service: `start()` never throws, `stop()` releases the pool on every
 * exit path, and a read against a store that is not running throws for the
 * route's failure contract (the retryable 503), never silently succeeds.
 * Read-only: no statement here writes, so polling can never mutate
 * execution, and a poll of a logically expired record projects nothing.
 */
export class JobsObservationStore implements JobsObservation {
  private readonly databaseUrl: string;
  private readonly statementTimeoutMs: number;
  private readonly log: JobsObservationLogger;

  private pool: Pool | null = null;
  private stopped = false;

  constructor(options: JobsObservationStoreOptions) {
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
          { event: "jobs.observation.pool_error", phase, err },
          "pooled jobs observation-store client dropped",
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

  async snapshot(request: JobsObservationRequest): Promise<JobsSnapshotVerdict> {
    const pool = this.pool;
    if (this.stopped || !pool) {
      throw new Error("the observation store is not running");
    }
    const { claims } = request;
    const now = new Date();
    const result = await pool.query<RecordRow>(
      `SELECT app_id, env, owner_kind, owner_oid, type, status, attempt, progress,
              error_code, result, cancellation_requested, terminal_at
         FROM ${JOBS_JOB_RECORD_QUALIFIED}
        WHERE server = $1 AND job_id = $2`,
      [claims.server, request.jobId],
    );
    const access = classifyAccess(result.rows[0], claims, now);
    if (!access.ok) return { outcome: access.verdict };
    const row = access.row;
    return {
      outcome: "found",
      // The snapshot is the wire shape, validated before it can be called
      // found — a stored value the contract does not carry (a progress off
      // the bounded shape, an unknown status) is a defect thrown here, never
      // a malformed body on the wire.
      snapshot: JobSnapshotSchema.parse({
        server: claims.server,
        jobId: request.jobId,
        type: row.type,
        status: projectedPublicStatus(row, now),
        attempt: row.attempt,
        progress: row.progress ?? null,
        cancellationRequested: row.cancellation_requested,
        resultExpiresAt: resultExpiresAtIso(row),
        recordExpiresAt: recordExpiresAtIso(row),
        error: storedExecutionError(row.error_code),
      }),
    };
  }

  async result(request: JobsObservationRequest): Promise<JobsResultVerdict> {
    const pool = this.pool;
    if (this.stopped || !pool) {
      throw new Error("the observation store is not running");
    }
    const { claims } = request;
    const now = new Date();
    const result = await pool.query<RecordRow>(
      `SELECT app_id, env, owner_kind, owner_oid, type, status, attempt, progress,
              error_code, result, cancellation_requested, terminal_at
         FROM ${JOBS_JOB_RECORD_QUALIFIED}
        WHERE server = $1 AND job_id = $2`,
      [claims.server, request.jobId],
    );
    const access = classifyAccess(result.rows[0], claims, now);
    if (!access.ok) return { outcome: access.verdict };
    const row = access.row;
    const stored = publicStatus(row.status);
    // Expiry first: a formerly successful result past its lifetime (or the
    // cleanup's own `expired` projection) answers 410 however delayed the
    // physical removal is — and a stored success within its lifetime holds
    // its bytes (the store's CHECK constraint keeps a successful row's
    // result non-null; a null here is the constraint's defect, thrown).
    if (resultHorizonPassed(row, now) || stored === "expired") {
      return { outcome: "expired" };
    }
    if (stored === "succeeded") {
      if (row.result === null) {
        throw new Error(
          "a successful record carries no stored result — the store's own constraint refuses this state",
        );
      }
      // The stored text is the bound's own canonical JSON — sent as exact
      // bytes, never re-serialized: a result at the byte cap nests past the
      // engine's recursive serializer, and the value the job produced is the
      // value the caller reads.
      return { outcome: "found", resultText: row.result };
    }
    if (stored === "queued" || stored === "running") {
      return { outcome: "not_ready", status: stored, error: storedExecutionError(row.error_code) };
    }
    return { outcome: "terminal", status: stored, error: storedExecutionError(row.error_code) };
  }
}
