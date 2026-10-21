import { randomUUID } from "node:crypto";
import type { PgBoss, Db } from "pg-boss";
import type { Pool, PoolClient } from "pg";

import {
  JOB_TERMINAL_STATUSES,
  type JobError,
  type JobStatus,
  type JobsCapacityLimits,
} from "@azx-pbc/shared";
import { sha256BodyDigest, type JobsSubmitClaims } from "@azx-pbc/shared/jobsSigning";

import { lifecycleEligibilityInTx } from "./lifecycle.js";
import { createJobsPool, withJobsClient } from "./pool.js";
import { storedExecutionError } from "./execution.js";
import { projectedPublicStatus, recordHorizonPassed } from "./observation.js";
import {
  JOBS_QUEUE_NAME,
  JOBS_INTAKE_QUALIFIED,
  JOBS_JOB_RECORD_QUALIFIED,
  JOBS_TYPE_POLICIES,
  type JobsTypePolicies,
  jobsAppEnvGroupId,
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
 * 1. the retained-key comparison — before the admission lock, before
 *    new-input validation, and before every gate that can close to new work.
 *    Identical original bytes recover the original job even when validation
 *    rules have since changed; different bytes conflict even when they are
 *    invalid for new work; and a replay never queues behind the admission
 *    lock, because it never takes it;
 * 2. new-work validation (the type's installed policy and its input
 *    contract) — refusing here creates no job and no key claim, and the
 *    answer is about the payload even while intake is closed;
 * 3. the server-wide admission lock (`JOBS_ADMISSION_LOCK_KEY`) — held to
 *    the caller's commit, so the intake read, the eligibility verdicts and
 *    the capacity count that follow cannot interleave with another
 *    admission's, or with a concurrent intake apply (which takes the same
 *    lock);
 * 4. the intake check — this process's configured posture AND the durable
 *    intake row must both admit; a closed intake refuses new work with 503
 *    `jobs_disabled` while retained-key recovery above still works;
 * 5. the eligibility verdict — `closed` refuses new work finally, `unseen`
 *    leaves the generation to the portal's delivery (retryable 503);
 * 6. the capacity comparison — new work is admitted only inside the
 *    admission lock's serialization (design §4), against the unfinished and
 *    retained occupancy of the app/environment and the whole server, under
 *    the platform's resolved limits. Full or lowered capacity refuses with
 *    no eviction and no slot taken;
 * 7. the runner enqueue over the borrowed connection, then the wrapper
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
  | { outcome: "intake_closed" }
  | { outcome: "unseen" }
  | { outcome: "capacity_exceeded" }
  | { outcome: "not_found" };

/** The admission seam the submit route consumes (the durable store implements it; tests may substitute). */
export interface JobsAdmission {
  admit(request: JobsAdmissionRequest): Promise<JobsAdmissionResult>;
}

/** A job handed to the runner enqueue — the validated work, scoped to its trusted group. */
export interface JobsRunnerJob {
  /** The qualified type — selects the execution-time policy. */
  type: string;
  /** The trusted app half of the fairness group. */
  appId: string;
  /** The trusted environment half of the fairness group. */
  env: string;
  /** The validated input — the runner job's data. */
  input: object;
  /**
   * The send-time retry limit — from the SAME installed policy the admission
   * decision resolved, so the enqueue cannot consult a second (possibly
   * different) copy of the numbers.
   */
  retryLimit: number;
  /** The send-time per-attempt claim bound, in seconds — from the same policy. */
  expireInSeconds: number;
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
 * the acceptance transaction's fate. The send-time options are the job's
 * carried policy values — admission resolved them from the composition's
 * installed policy set (never queue defaults — a silently weaker claim bound
 * would go unnoticed) — and the trusted (appId, env) fairness group.
 */
export function createPgbossEnqueuer(boss: PgBoss): JobsEnqueuer {
  return {
    async enqueue(withinTx, job) {
      const runnerJobId = await boss.send(JOBS_QUEUE_NAME, job.input, {
        retryLimit: job.retryLimit,
        expireInSeconds: job.expireInSeconds,
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
  error_code: string | null;
  terminal_at: Date | null;
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

/**
 * The new-work admission's serialization lock (design §4: "A local admission
 * lock and bounded indexed counts are sufficient for the initial scale") — one
 * transaction-scoped advisory lock per store. It is taken only for new work,
 * after the retained-key comparison and validation, and held to the
 * transaction's end: the intake read, the eligibility verdicts and the
 * occupancy count it guards cannot interleave with another admission's, or
 * with a concurrent intake apply — across types, apps and replicas (advisory
 * locks are per-database state, and the store's replicas share one database).
 * Same-app admissions serialize on this lock taken first and the lifecycle
 * row lock second everywhere, so no admission ordering can cycle. The jobs
 * store is private to one server (the deployment schema refuses two servers
 * sharing a database), so one fixed key cannot collide with another server's
 * or another component's locks.
 */
export const JOBS_ADMISSION_LOCK_KEY = 6_283_185_307;

/** The occupancy one new-work admission is compared against (design §4's four controls). */
interface JobsOccupancyCounts {
  /** Every physically stored job of the server — active or terminal, until the physical cleanup removes it. */
  retained_server: number;
  /** Every physically stored job of the app/environment. */
  retained_app_env: number;
  /** Nonterminal jobs of the server — queued or running, including delayed retries and pending cancellation. */
  unfinished_server: number;
  /** Nonterminal jobs of the app/environment. */
  unfinished_app_env: number;
}

/** The saturated cap a refusal names — the operator's bounded evidence of which limit refused. */
interface JobsSaturatedCap {
  /** The control's own name in the shared limit set (`unfinishedPerAppEnv`, …). */
  cap: keyof JobsCapacityLimits;
  /** The limit that refused. */
  limit: number;
  /** The occupancy at the refusal — the count the comparison saw. */
  occupancy: number;
}

/**
 * Which capacity control — if any — the occupancy has exhausted: the first
 * control whose count has reached its limit (the refused job would be the
 * limit-plus-one-th). Every candidate is checked so a refusal names the cap
 * that actually bound, in a stable order (unfinished before retained,
 * app/environment before server).
 */
function saturatedCapacityCap(
  occupancy: JobsOccupancyCounts,
  limits: JobsCapacityLimits,
): JobsSaturatedCap | null {
  const candidates: [keyof JobsCapacityLimits, number, number][] = [
    ["unfinishedPerAppEnv", limits.unfinishedPerAppEnv, occupancy.unfinished_app_env],
    ["unfinishedPerServer", limits.unfinishedPerServer, occupancy.unfinished_server],
    ["retainedPerAppEnv", limits.retainedPerAppEnv, occupancy.retained_app_env],
    ["retainedPerServer", limits.retainedPerServer, occupancy.retained_server],
  ];
  for (const [cap, limit, count] of candidates) {
    if (count >= limit) return { cap, limit, occupancy: count };
  }
  return null;
}

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
  /**
   * The resolved capacity limits this store enforces with new enqueue —
   * the shared defaults with any operator override applied
   * (`resolveJobsCapacityLimits`). Platform-owned: no input, manifest or
   * grant can change them.
   */
  limits: JobsCapacityLimits;
  /**
   * This process's configured intake posture (`JOBS_ACCEPTING`): new work is
   * admitted only while BOTH this flag and the durable intake row admit.
   * Required — a store that cannot say whether it admits work must not guess.
   */
  accepting: boolean;
  /**
   * The composition's installed policy set — the new-work validation's source.
   * Defaults to the production set; a composition that installed the
   * diagnostic type hands the same set its registry screened against.
   */
  typePolicies?: JobsTypePolicies;
  /** The runner enqueue borrowed into the transaction — the real adapter wraps the runtime pg-boss. */
  enqueuer: JobsEnqueuer;
  log: JobsAcceptanceLogger;
}

/** The structural logger the store reports through (the pino surface, without importing Fastify). */
export interface JobsAcceptanceLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** The runtime pool stays small: new-work admissions serialize per app on the lifecycle row lock, then server-wide on the admission lock. */
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
  private readonly limits: JobsCapacityLimits;
  private readonly accepting: boolean;
  private readonly typePolicies: JobsTypePolicies;
  private readonly enqueuer: JobsEnqueuer;
  private readonly log: JobsAcceptanceLogger;

  private pool: Pool | null = null;
  private stopped = false;

  constructor(options: JobsAcceptanceStoreOptions) {
    this.databaseUrl = options.databaseUrl;
    this.statementTimeoutMs = options.statementTimeoutMs;
    this.limits = options.limits;
    this.accepting = options.accepting;
    this.typePolicies = options.typePolicies ?? JOBS_TYPE_POLICIES;
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

    // The retained-key comparison first — before the admission lock, before
    // validation, and before every gate that can close to new work: a replay
    // recovers (or conflicts) immediately, never queuing behind the lock it
    // must not take.
    if (claims.idempotencyKey !== null) {
      const existing = await this.findKeyMapping(client, claims, claims.idempotencyKey);
      if (existing) {
        return this.compareKeyMapping(existing, digest, new Date());
      }
    }

    // New work: the type's installed policy and its input contract, before
    // the gates that close to it (design §4's ordering: key, then
    // validation, then intake). A refusal creates nothing.
    const policy = (this.typePolicies as Record<string, JobsTypePolicy | undefined>)[claims.type];
    if (!policy) {
      throw new JobsAdmissionRefusal({ outcome: "type_unknown" });
    }
    const input = validatedInput(policy, request.body);

    // The serialization boundary — the lock held to this transaction's end.
    // Every gate judged after it (intake, eligibility, capacity) and the
    // insert it guards are indivisible against concurrent new work and
    // against a concurrent intake apply, which takes the same lock.
    await client.query("SELECT pg_advisory_xact_lock($1)", [JOBS_ADMISSION_LOCK_KEY]);

    // Intake: this process's configured posture AND the durable row must
    // both admit. The read is safe under the lock — an intake apply cannot
    // land between this read and this commit, because it takes the same
    // lock. A missing row refuses (the gate fails closed: the migration
    // seeds it, and a store without it is not ready to serve).
    const intake = await client.query<{ accepting: boolean; server: string | null }>(
      `SELECT accepting, server FROM ${JOBS_INTAKE_QUALIFIED} WHERE singleton`,
    );
    const intakeRow = intake.rows[0];
    const intakeOpen = intakeRow !== undefined && intakeRow.accepting;
    const intakeBoundHere =
      intakeRow === undefined || intakeRow.server === null || intakeRow.server === claims.server;
    if (!this.accepting || !intakeOpen || !intakeBoundHere) {
      throw new JobsAdmissionRefusal({ outcome: "intake_closed" });
    }

    const eligibility = await lifecycleEligibilityInTx(client, claims.appId, claims.generation);

    if (eligibility.verdict === "closed") {
      throw new JobsAdmissionRefusal({ outcome: "closed" });
    }
    if (eligibility.verdict === "unseen") {
      throw new JobsAdmissionRefusal({ outcome: "unseen" });
    }

    // Capacity, at the design's position in the order (after validation and
    // intake, before enqueue): under the same server-wide serialization lock
    // taken above, so the count and the insert it guards are indivisible
    // against concurrent new work — across types, apps and replicas. Only
    // admissions consume capacity (completion and physical cleanup only free
    // it), so nothing outside this lock can move the counts in the unsafe
    // direction. A lowered limit refuses with no eviction; a retained-key
    // replay above never reached this point (no lock, no slot).
    const occupancy = await this.countOccupancy(client, claims);
    const saturated = saturatedCapacityCap(occupancy, this.limits);
    if (saturated) {
      // Bounded rejection logging (ADR-0003): one line per refusal — the cap
      // that bound, its limit and the count it saw — never a persistent
      // audit row. The response stays the fixed 429 envelope; the app and
      // environment are bounded, non-personal evidence of whose capacity
      // refused.
      this.log.warn(
        {
          event: "jobs.admission.capacity_refused",
          cap: saturated.cap,
          limit: saturated.limit,
          occupancy: saturated.occupancy,
          appId: claims.appId,
          env: claims.env,
        },
        "new work refused: a capacity limit is exhausted",
      );
      throw new JobsAdmissionRefusal({ outcome: "capacity_exceeded" });
    }

    // The enqueue and the wrapper claim commit or roll back together. The
    // scoped-key unique constraint is the concurrent-retry backstop: the
    // serialization above already holds every new-work admission (and the
    // lifecycle lock every same-app one), so losing this claim means a path
    // outside the admission transaction took the key first.
    const jobId = randomUUID();
    const runnerJobId = await this.enqueuer.enqueue(client, {
      type: claims.type,
      appId: claims.appId,
      env: claims.env,
      input,
      // The send-time options from the policy already resolved above — the
      // enqueue consults no second copy of the numbers.
      retryLimit: policy.retryLimit,
      expireInSeconds: policy.expireInSeconds,
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
      `SELECT job_id, status, body_sha256, error_code, terminal_at
         FROM ${JOBS_JOB_RECORD_QUALIFIED}
        WHERE ${KEY_SCOPE_PREDICATE}`,
      keyScopeParams(claims, key),
    );
    return result.rows[0] ?? null;
  }

  /**
   * The four occupancy counts one comparison needs, from one indexed query.
   * Retained counts EVERY physically stored row of the scope — active or
   * terminal, whatever transient state the runner's own row is in (the
   * wrapper record and its input bytes are the retained storage; only the
   * physical cleanup removes it) — and unfinished counts the nonterminal
   * statuses, the terminal list arriving as a parameter from the shared
   * constant so the SQL and the wire contract cannot drift. The
   * `(server, app_id, env, status)` index bounds every count.
   */
  private async countOccupancy(
    client: PoolClient,
    claims: JobsSubmitClaims,
  ): Promise<JobsOccupancyCounts> {
    const result = await client.query<JobsOccupancyCounts>(
      `SELECT count(*)::int AS retained_server,
              count(*) FILTER (WHERE app_id = $2 AND env = $3)::int AS retained_app_env,
              count(*) FILTER (WHERE NOT status = ANY($4::text[]))::int AS unfinished_server,
              count(*) FILTER (WHERE app_id = $2 AND env = $3
                                 AND NOT status = ANY($4::text[]))::int AS unfinished_app_env
         FROM ${JOBS_JOB_RECORD_QUALIFIED}
        WHERE server = $1`,
      [claims.server, claims.appId, claims.env, JOB_TERMINAL_STATUSES],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("the occupancy count returned no row");
    }
    return row;
  }

  /**
   * The retained-key comparison, from a row as stored: identical original
   * bytes recover the original job with its CURRENT public status — the
   * read horizons' projection, so a replay after result expiry returns the
   * original job as `expired` while its record is still publicly readable
   * (criterion 14). Different bytes conflict with the job's state at any
   * age — the key-holder's own claim is what the conflict answers. A
   * record past its public record horizon is unreadable: the identical
   * replay answers `not_found` (404, no work created, no slot taken) while
   * the row is still physically retained, and the changed-bytes conflict
   * still stands. Neither answer validates the input and neither creates
   * work — the comparison precedes new-work validation by contract, so a
   * job accepted under older validation rules still recovers.
   */
  private compareKeyMapping(row: KeyMappingRow, digest: string, now: Date): JobsAdmissionResult {
    const status = projectedPublicStatus(row, now);
    if (row.body_sha256 !== digest) {
      // The conflict's error is the job's stored execution error — the code
      // the execution projection wrote for the attempt that failed (a queued
      // job never executed, so none to report).
      return { outcome: "conflict", status, error: storedExecutionError(row.error_code) };
    }
    if (recordHorizonPassed(row, now)) {
      return { outcome: "not_found" };
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
      `SELECT job_id, status, body_sha256, error_code, terminal_at
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
    return this.compareKeyMapping(row, digest, new Date());
  }
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
