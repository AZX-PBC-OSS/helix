import { randomUUID } from "node:crypto";
import type { PgBoss, Db } from "pg-boss";
import type { Pool, PoolClient } from "pg";

import { JobStatusSchema, type JobError, type JobStatus } from "@azx-pbc/shared";
import { sha256BodyDigest, type JobsSubmitClaims } from "@azx-pbc/shared/jobsSigning";

import { lifecycleEligibilityInTx } from "./lifecycle.js";
import { createJobsPool, withJobsClient } from "./pool.js";
import {
  JOBS_QUEUE_NAME,
  JOBS_JOB_RECORD_QUALIFIED,
  JOBS_TYPE_POLICIES,
  jobsAppEnvGroupId,
  jobTypePolicy,
  type JobsTypePolicy,
} from "./policy.js";

/**
 * The jobs-local acceptance seam (ADR-0003, background-jobs-plane design §4)
 * — the one transaction that decides whether a submission becomes durable
 * work. A lost response or a simultaneous retry must recover the one durable
 * job instead of duplicating work or leaving a key without a job, so the
 * decision, the runner enqueue and the wrapper record all land or all roll
 * back together.
 *
 * The order inside the transaction is the adopted contract's, and each
 * precedence is load-bearing:
 *
 * 1. the app's lifecycle row is locked `FOR UPDATE` (the lifecycle
 *    authority's serialization boundary, `lifecycleEligibilityInTx`) — the
 *    lock is held to the caller's commit, so a lifecycle
 *    apply cannot land between this decision and its effect, and a second
 *    admission for the same app cannot interleave with this one;
 * 2. the retained-key comparison — before new-input validation, before the
 *    eligibility verdict is applied, and therefore before intake closes to
 *    it. Identical original bytes recover the original job even when
 *    validation rules have since changed; different bytes conflict even when
 *    they are invalid for new work;
 * 3. new-work validation (the type's installed policy and its input
 *    contract) — refusing here creates no job and no key claim;
 * 4. the eligibility verdict — `closed` refuses new work finally, `unseen`
 *    leaves the generation to the portal's delivery (retryable 503);
 * 5. the runner enqueue over the borrowed connection, then the wrapper
 *    insert — the unique scoped-key constraint is the concurrent-retry
 *    backstop; a claim lost to it rolls the already-enqueued runner job back
 *    with the transaction, and the retry identity is resolved against the
 *    winner's committed mapping.
 *
 * Every store failure throws: the route answers the protocol's retryable
 * unavailability, nothing is committed, and a client retries with a fresh
 * instruction carrying the same retry identity.
 */

/** The verified submission an admission decides on — claims from the receiver, bytes as received. */
export interface JobsAdmissionRequest {
  /** The instruction's verified submit claims — the trusted identity and retry key. */
  claims: JobsSubmitClaims;
  /** The exact input body bytes received, already bound to the instruction by digest. */
  body: Uint8Array;
}

/**
 * What one admission decided. Every outcome is one exit of the transaction;
 * the responses they map to are the submit route's.
 */
export type JobsAdmissionResult =
  | { outcome: "accepted"; jobId: string; status: JobStatus }
  | { outcome: "recovered"; jobId: string; status: JobStatus }
  | { outcome: "conflict"; status: JobStatus; error: JobError | null }
  | { outcome: "invalid_input" }
  | { outcome: "type_unknown" }
  | { outcome: "closed" }
  | { outcome: "unseen" };

/** The admission seam the submit route consumes (the durable store implements it; tests may substitute). */
export interface JobsAdmission {
  admit(request: JobsAdmissionRequest): Promise<JobsAdmissionResult>;
}

/** A job handed to the runner enqueue — the validated work, scoped to its trusted group. */
export interface JobsRunnerJob {
  /** The qualified type — selects the send-time execution policy. */
  type: string;
  /** The trusted app half of the fairness group. */
  appId: string;
  /** The trusted environment half of the fairness group. */
  env: string;
  /** The validated input — the runner job's data. */
  input: object;
}

/**
 * The runner enqueue the acceptance transaction borrows: the implementation
 * must run its insert on the CALLER'S client — so one transaction commits
 * wrapper and runner row together, and one rollback discards both — and
 * return the runner job id it created. Throwing is the failure contract: the
 * caller's transaction rolls back and nothing is accepted.
 */
export interface JobsEnqueuer {
  enqueue(withinTx: PoolClient, job: JobsRunnerJob): Promise<string>;
}

/**
 * The real enqueue adapter, over the runtime pg-boss instance's public
 * borrowed-transaction API: the runner's insert SQL executes on the caller's
 * transaction client through the {@link Db} seam, so the runner row shares
 * the acceptance transaction's fate. The send-time options are the type's
 * installed policy (never queue defaults — a silently weaker claim bound
 * would go unnoticed) and the trusted (appId, env) fairness group.
 */
export function createPgbossEnqueuer(boss: PgBoss): JobsEnqueuer {
  return {
    async enqueue(withinTx, job) {
      const { retryLimit, expireInSeconds } = jobTypePolicy(job.type);
      const runnerJobId = await boss.send(JOBS_QUEUE_NAME, job.input, {
        retryLimit,
        expireInSeconds,
        group: { id: jobsAppEnvGroupId(job.appId, job.env) },
        db: {
          executeSql: (text, values) => withinTx.query(text, values),
        } satisfies Db,
      });
      if (runnerJobId === null) {
        // Unreachable for this queue's policy (no singleton options), but a
        // null here would mean an enqueued-then-dropped job — never accept.
        throw new Error(`the runner did not enqueue the ${job.type} job`);
      }
      return runnerJobId;
    },
  };
}

/** The durable mapping one keyed submission resolves against, as the row stores it. */
interface KeyMappingRow {
  job_id: string;
  status: string;
  body_sha256: string;
}

/**
 * Why a decision refused — the transaction's only early exit: the refusal
 * carries its outcome back to the caller while the transaction's catch rolls
 * the unit back and releases the client. A refusal is a decision, never a
 * store failure.
 */
class JobsAdmissionRefusal extends Error {
  constructor(readonly refusal: JobsAdmissionResult) {
    super("the submission was refused by a decision of the acceptance transaction");
  }
}

/**
 * The scoped-key claim lost to a concurrent identical submission. The losing
 * transaction — including the runner row it had already enqueued — must roll
 * back entirely, so the marker escapes the transaction and the retry identity
 * is resolved against the winner's committed mapping outside it.
 */
class JobsKeyClaimRace extends Error {
  constructor() {
    super("the retry key's scoped claim was taken by a concurrent submission");
  }
}

/** The scoped-key namespace, in column order — the unique constraint's arbiter and the lookup's predicate. */
const KEY_SCOPE_PREDICATE =
  "server = $1 AND app_id = $2 AND env = $3 AND owner_kind = $4 AND owner_oid = $5 AND type = $6 AND retry_key = $7";

/** The lookup's parameters, in the predicate's order — one spelling for both reads. */
function keyScopeParams(claims: JobsSubmitClaims, key: string): string[] {
  return [
    claims.server,
    claims.appId,
    claims.env,
    claims.ownerKind,
    claims.ownerOid,
    claims.type,
    key,
  ];
}

export interface JobsAcceptanceStoreOptions {
  databaseUrl: string;
  /** Per-query ceiling, applied as both the pool's statement and connect timeout. */
  statementTimeoutMs: number;
  /** The runner enqueue borrowed into the transaction — the real adapter wraps the runtime pg-boss. */
  enqueuer: JobsEnqueuer;
  log: JobsAcceptanceLogger;
}

/** The structural logger the store reports through (the pino surface, without importing Fastify). */
export interface JobsAcceptanceLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** The runtime pool stays small: admissions serialize per app on the lifecycle row lock. */
const POOL_MAX = 2;

/**
 * The durable acceptance store — the transaction above, against the service's
 * private store, with the same pool discipline as the lifecycle store:
 * `start()` never throws, `stop()` releases the pool on every exit path, and
 * an admission against a store that is not running throws for the route to
 * refuse (503, retryable), never silently succeeds.
 */
export class JobsAcceptanceStore implements JobsAdmission {
  private readonly databaseUrl: string;
  private readonly statementTimeoutMs: number;
  private readonly enqueuer: JobsEnqueuer;
  private readonly log: JobsAcceptanceLogger;

  private pool: Pool | null = null;
  private stopped = false;

  constructor(options: JobsAcceptanceStoreOptions) {
    this.databaseUrl = options.databaseUrl;
    this.statementTimeoutMs = options.statementTimeoutMs;
    this.enqueuer = options.enqueuer;
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
          { event: "jobs.admission.pool_error", phase, err },
          "pooled jobs acceptance-store client dropped",
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

  async admit(request: JobsAdmissionRequest): Promise<JobsAdmissionResult> {
    try {
      return await this.transact(request, sha256BodyDigest(request.body));
    } catch (error) {
      if (error instanceof JobsKeyClaimRace) {
        // The transaction rolled back — the runner row it had enqueued with
        // it included — so the winner's committed mapping is the one truth.
        return this.resolveKeyMapping(request.claims, sha256BodyDigest(request.body));
      }
      throw error;
    }
  }

  /**
   * One admission as one transaction: decide, then commit — or roll back on
   * every other exit. The rollback runs on the refusal path too (a refused
   * decision is not a committed one). The checkout window is
   * {@link withJobsClient}'s: a connection death mid-decision is recorded on
   * the client (destroying it on release, never parking a socket-dead
   * connection in the idle set) and reported, while the awaited query's own
   * rejection reaches this catch and the caller answers the retryable
   * unavailability.
   */
  private async transact(
    request: JobsAdmissionRequest,
    digest: string,
  ): Promise<JobsAdmissionResult> {
    const pool = this.pool;
    if (this.stopped || !pool) {
      throw new Error("the acceptance store is not running");
    }
    return withJobsClient(pool, async (client) => {
      await client.query("BEGIN");
      try {
        const result = await this.decide(client, request, digest);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        // The decision refused or the store failed: nothing this transaction
        // did may survive. On a dead socket the ROLLBACK itself rejects
        // through pg's handleError — the same death the client-level
        // listener recorded — and the release below destroys that client.
        await client.query("ROLLBACK").catch(() => {});
        if (error instanceof JobsAdmissionRefusal) {
          return error.refusal;
        }
        throw error;
      }
    });
  }

  /** The decision sequence, inside the caller's open transaction. */
  private async decide(
    client: PoolClient,
    request: JobsAdmissionRequest,
    digest: string,
  ): Promise<JobsAdmissionResult> {
    const { claims } = request;

    // The serialization boundary first — the lock held to this transaction's
    // end. Its VERDICT is applied only to new work, after the retained-key
    // comparison has had its chance to recover.
    const eligibility = await lifecycleEligibilityInTx(client, claims.appId, claims.generation);

    if (claims.idempotencyKey !== null) {
      const existing = await this.findKeyMapping(client, claims, claims.idempotencyKey);
      if (existing) {
        return this.compareKeyMapping(existing, digest);
      }
    }

    // New work: the type's installed policy and its input contract, before
    // the eligibility verdict is applied (design §4's ordering: key, then
    // validation, then intake). A refusal creates nothing.
    const policy = (JOBS_TYPE_POLICIES as Record<string, JobsTypePolicy | undefined>)[claims.type];
    if (!policy) {
      throw new JobsAdmissionRefusal({ outcome: "type_unknown" });
    }
    const input = validatedInput(policy, request.body);

    if (eligibility.verdict === "closed") {
      throw new JobsAdmissionRefusal({ outcome: "closed" });
    }
    if (eligibility.verdict === "unseen") {
      throw new JobsAdmissionRefusal({ outcome: "unseen" });
    }

    // The enqueue and the wrapper claim commit or roll back together. The
    // scoped-key unique constraint is the concurrent-retry backstop: the
    // lifecycle lock above already serializes same-app admissions, so losing
    // this claim means a path outside that serialization took the key first.
    const jobId = randomUUID();
    const runnerJobId = await this.enqueuer.enqueue(client, {
      type: claims.type,
      appId: claims.appId,
      env: claims.env,
      input,
    });
    const inserted = await client.query(
      `INSERT INTO ${JOBS_JOB_RECORD_QUALIFIED}
         (server, job_id, runner_job_id, app_id, env, owner_kind, owner_oid, type,
          generation, status, retry_key, body_sha256, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (server, app_id, env, owner_kind, owner_oid, type, retry_key) DO NOTHING`,
      [
        claims.server,
        jobId,
        runnerJobId,
        claims.appId,
        claims.env,
        claims.ownerKind,
        claims.ownerOid,
        claims.type,
        claims.generation,
        "queued",
        claims.idempotencyKey,
        digest,
        new Date().toISOString(),
      ],
    );
    if ((inserted.rowCount ?? 0) !== 1) {
      throw new JobsKeyClaimRace();
    }
    return { outcome: "accepted", jobId, status: "queued" };
  }

  /** The retained mapping for a scoped key, or null while it does not exist. */
  private async findKeyMapping(
    client: PoolClient,
    claims: JobsSubmitClaims,
    key: string,
  ): Promise<KeyMappingRow | null> {
    const result = await client.query<KeyMappingRow>(
      `SELECT job_id, status, body_sha256
         FROM ${JOBS_JOB_RECORD_QUALIFIED}
        WHERE ${KEY_SCOPE_PREDICATE}`,
      keyScopeParams(claims, key),
    );
    return result.rows[0] ?? null;
  }

  /**
   * The retained-key comparison, from a row as stored: identical original
   * bytes recover the original job with its current status; different bytes
   * conflict with the job's state. Neither answer validates the input and
   * neither creates work — the comparison precedes new-work validation by
   * contract, so a job accepted under older validation rules still recovers.
   */
  private compareKeyMapping(row: KeyMappingRow, digest: string): JobsAdmissionResult {
    const status = publicStatus(row.status);
    if (row.body_sha256 !== digest) {
      // The conflict's error is the job's stored execution error — none
      // until execution persists outcomes (the execution ticket's seam); a
      // queued job has none to report.
      return { outcome: "conflict", status, error: null };
    }
    return { outcome: "recovered", jobId: row.job_id, status };
  }

  /**
   * Resolve the retry identity after a lost claim race — outside any
   * transaction, against the winner's committed mapping. A mapping that has
   * already vanished (physical cleanup removed it between the constraint and
   * this read) is not resolvable here: the submission failed without
   * accepting anything, and the caller's retry starts a fresh decision.
   */
  private async resolveKeyMapping(
    claims: JobsSubmitClaims,
    digest: string,
  ): Promise<JobsAdmissionResult> {
    const pool = this.pool;
    if (this.stopped || !pool) {
      throw new Error("the acceptance store is not running");
    }
    if (claims.idempotencyKey === null) {
      throw new Error("a key claim race cannot arise for an unkeyed submission");
    }
    const result = await pool.query<KeyMappingRow>(
      `SELECT job_id, status, body_sha256
         FROM ${JOBS_JOB_RECORD_QUALIFIED}
        WHERE ${KEY_SCOPE_PREDICATE}`,
      keyScopeParams(claims, claims.idempotencyKey),
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(
        `the retry key's scoped claim vanished between the constraint and its resolution`,
      );
    }
    return this.compareKeyMapping(row, digest);
  }
}

/**
 * The public status a stored record projects, parsed against the wire enum
 * before it can reach a response — a stored value the contract does not
 * carry is a defect answered by the error boundary, never a malformed body
 * on the wire.
 */
function publicStatus(status: string): JobStatus {
  const parsed = JobStatusSchema.safeParse(status);
  if (!parsed.success) {
    throw new Error(`the stored job status is not a public status: ${JSON.stringify(status)}`);
  }
  return parsed.data;
}

/**
 * The validated input of new work: the exact bytes parsed as JSON, then
 * parsed against the type's input contract. Any refusal is an admission
 * refusal — no job, no key claim.
 */
function validatedInput(policy: JobsTypePolicy, body: Uint8Array): object {
  let candidate: unknown;
  try {
    candidate = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new JobsAdmissionRefusal({ outcome: "invalid_input" });
  }
  const parsed = policy.inputSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new JobsAdmissionRefusal({ outcome: "invalid_input" });
  }
  const input: unknown = parsed.data;
  // The registered input contracts are strict wire objects, so this holds by
  // construction — checked rather than cast, because a contract registered
  // that produced anything else would otherwise hand the runner a payload it
  // cannot carry, discovered only at execution.
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("the type's input contract produced a non-object for new work");
  }
  return input;
}
