import type { Pool, PoolClient } from "pg";

import {
  JOB_TERMINAL_STATUSES,
  JobsGenerationSchema,
  type JobsLifecycleUpdate,
} from "@azx-pbc/shared";

import { createJobsPool, withJobsClient } from "./pool.js";
import { JOBS_APP_LIFECYCLE_QUALIFIED, JOBS_JOB_RECORD_QUALIFIED } from "./policy.js";

/**
 * The jobs-side app-lifecycle authority (ADR-0007, background-jobs-plane
 * design §5) — the durable state the admission and worker-start gates are
 * judged against, and the apply-before-acknowledge receiver for the portal's
 * lifecycle delivery.
 *
 * The state is one row per known app: the highest lifecycle generation this
 * server has durably applied, and whether that generation is archived (closed
 * to new work). The portal — the generation authority — delivers
 * `{generation, archived}` per transition under a separately signed
 * instruction; every transition (creation, archive, unarchive) opens a new
 * generation, so the delivery of generation G means exactly:
 *
 * - every generation below G is closed forever — a job may only ever be
 *   admitted under a generation that was, at some moment, the newest open
 *   one, and each new generation supersedes it;
 * - generation G itself is open only when the delivery says `archived: false`.
 *
 * Those two facts make out-of-order delivery safe without extra bookkeeping:
 * an older delivery arriving after a newer one can reopen nothing (its whole
 * closure intent is already covered by the newer generation's watermark), and
 * an immediate archive followed by unarchive closes every pre-archive
 * generation whether the deliveries arrive in order or not. The cancelled-work
 * recovery that consumes this state — cancelling still-active jobs under
 * closed generations until none remain — is its own supervised loop, which
 * reads the same row: active work under a generation below the applied one
 * (or equal to it while archived) is cancellation-eligible work. The apply is
 * where that eligibility becomes per-record durable intent for the app the
 * delivery names: every apply stamps `cancellation_requested` on the
 * still-active closed-generation records of its own app before it commits
 * ({@link stampClosedGenerationCancellations}), so the acknowledgement
 * confirms intent the recovery paths can act on, and the worker-start gate
 * and recovery sweeper read the same per-record flag an owner cancellation
 * writes.
 *
 * Application acknowledges with the highest applied generation — never the
 * delivered one — so a replayed older update cannot make the portal believe a
 * generation was applied that this server has not reached.
 */

/** The durable lifecycle state of one app, as the gate and the merge see it. */
export interface AppLifecycleState {
  /** The highest applied generation — the wire's canonical decimal string. */
  generation: string;
  /** Whether that generation is archived (closed to new work). */
  archived: boolean;
}

/**
 * Whether a job under a claimed generation may be admitted or started, judged
 * against the durable state. The three verdicts are the admission gate's whole
 * vocabulary:
 *
 * - `admit` — the claimed generation is the applied one and it is open.
 * - `closed` — the claimed generation is older than the applied one, or equal
 *   to it while archived: no new work may start under it, and a job already
 *   admitted under it may not start. The answer is final — waiting cannot
 *   change it.
 * - `unseen` — the claimed generation is newer than the applied one, or the
 *   app is not known here at all: the portal has not (yet) delivered that
 *   state. The answer is temporary — the caller reports retryable
 *   unavailability and the portal's delivery opens the generation; no edge
 *   assertion ever opens one here.
 */
export type JobsGenerationEligibility =
  | { verdict: "admit" }
  | { verdict: "closed"; appliedGeneration: string }
  | { verdict: "unseen"; appliedGeneration: string | null };

/**
 * The canonical wire form of a generation — the decimal string of the value
 * it denotes. The delivery side of the grammar discipline the eligibility
 * gate enforces on claims: a string the wire schema would refuse (a hex or
 * octal prefix, padding, an explicit sign) still denotes a number, and the
 * bigint column coerces it silently on write, so the merge canonicalizes
 * rather than copies — what is durably held and what is answered is always
 * the wire form, never the delivered spelling. Canonicalizing repairs the
 * spelling only, so the canonical form itself is checked against the wire
 * schema before it is returned: a value whose canonical form the wire
 * refuses (`"-1"` — BigInt is happy, the bigint column stores it, and no
 * acknowledgement could ever name the poisoned row) is not a generation at
 * all and throws here — the route's boundary refuses it first, and a direct
 * caller sees the throw, never a stored guess. (`"-0"` repairs to `"0"` and
 * is in-space: the check is on the canonical form, not the spelling.)
 */
function canonicalGeneration(value: string): string {
  const canonical = BigInt(value).toString();
  if (!JobsGenerationSchema.safeParse(canonical).success) {
    throw new Error(
      `the generation "${value}" denotes ${canonical}, which the wire form does not carry — generations are unsigned`,
    );
  }
  return canonical;
}

/**
 * Merge one delivered lifecycle update into the stored state — the pure heart
 * of {@link JobsLifecycleStore.apply}. `changed` says whether the delivery
 * moved the state forward (`applied`) or was not newer than it (`stale`):
 * an older delivery is a no-op, a redelivery of the newest state is a no-op,
 * and a delivery claiming an already-applied generation is archived closes it
 * if it was somehow still open — an archive is never undone by a delivery at
 * the same generation, whatever produced the conflict. The yielded state's
 * generation is always the wire-canonical form of the delivered value
 * ({@link canonicalGeneration}) — a delivery cannot launder a non-canonical
 * spelling through the merge into state the column then coerces.
 */
export function mergeLifecycleUpdate(
  stored: AppLifecycleState | null,
  delivered: JobsLifecycleUpdate,
): { state: AppLifecycleState; changed: boolean } {
  const deliveredGeneration = canonicalGeneration(delivered.generation);
  if (stored === null) {
    return {
      state: { generation: deliveredGeneration, archived: delivered.archived },
      changed: true,
    };
  }
  const applied = BigInt(stored.generation);
  const value = BigInt(deliveredGeneration);
  if (value > applied) {
    return {
      state: { generation: deliveredGeneration, archived: delivered.archived },
      changed: true,
    };
  }
  if (value < applied) {
    return { state: stored, changed: false };
  }
  if (delivered.archived && !stored.archived) {
    return { state: { generation: stored.generation, archived: true }, changed: true };
  }
  return { state: stored, changed: false };
}

/**
 * Judge a claimed generation against stored state — the pure decision both
 * consumers of the gate share. Inputs are schema-validated wire values
 * (`JobsGenerationSchema`, `AppLifecycleState` as read from the store); a
 * claimed generation that somehow cannot be compared is `closed` — the gate
 * fails closed, never admits on an unreadable claim. The claim's own grammar
 * is re-checked here against the wire schema rather than trusted: `BigInt`
 * parses a strictly wider set than the wire form (hex/binary/octal prefixes,
 * an explicit sign, surrounding whitespace) and would compare such a claim
 * numerically — admitting `0x4` against an applied `4` — where the boundary
 * refuses the value outright.
 */
export function lifecycleEligibility(
  stored: AppLifecycleState | null,
  claimedGeneration: string,
): JobsGenerationEligibility {
  if (stored === null) return { verdict: "unseen", appliedGeneration: null };
  const applied = BigInt(stored.generation);
  const parsedClaim = JobsGenerationSchema.safeParse(claimedGeneration);
  if (!parsedClaim.success) {
    return { verdict: "closed", appliedGeneration: stored.generation };
  }
  const claimed = BigInt(parsedClaim.data);
  if (claimed < applied) return { verdict: "closed", appliedGeneration: stored.generation };
  if (claimed > applied) return { verdict: "unseen", appliedGeneration: stored.generation };
  return stored.archived
    ? { verdict: "closed", appliedGeneration: stored.generation }
    : { verdict: "admit" };
}
/** What one durable application produced, for the acknowledgement and the span. */
export interface JobsLifecycleApplyResult {
  /** The generation to acknowledge — the highest applied after the merge. */
  appliedGeneration: string;
  /** Whether the delivery moved the state forward (`applied`) or not (`stale`). */
  changed: boolean;
  /**
   * How many still-active job records of this app the apply stamped with
   * cancellation intent — every queued/running job under a generation this
   * state closes, in both environments. The delivery's cancellation reach,
   * carried on the route span; the records' convergence to their terminal
   * `cancelled` outcomes is the recovery paths' (the worker-start gate and
   * the recovery sweeper), never this transaction's.
   */
  stamped: number;
}

/**
 * The closed-generation cancellation predicate over `job_record r` joined to
 * `app_lifecycle l` — the records whose admitted generation the applied state
 * closes (below the watermark, or equal to it while archived). One spelling
 * for every statement that selects, stamps or measures cancellation-eligible
 * work, so the apply's intent, the recovery loop's healing stamp and the
 * backlog's health evidence cannot drift into three definitions of the same
 * fact.
 */
const CLOSED_GENERATION_PREDICATE =
  "(r.generation < l.generation OR (r.generation = l.generation AND l.archived))";

/**
 * Stamp durable cancellation intent on the still-active job records the
 * applied lifecycle state closes — the one write that turns a delivered
 * archive (or a newer generation) into per-record intent the existing
 * cancellation machinery carries to terminal outcomes. Conditional on the
 * record still being non-terminal and not already carrying intent, so a
 * repeat is a no-op; returns the stamped count.
 *
 * The scope is the caller's contract:
 *
 * - **The lifecycle apply passes its own `appId`** — the intent commits with
 *   that app's generation change, before the acknowledgement, and the count
 *   is the delivery's own cancellation reach (the route span's
 *   `helix.jobs.lifecycle.stamped`). Stamping across apps there would
 *   misattribute another app's residue to a delivery that never named it.
 * - **The recovery sweeper's healing arm passes none** — the store-wide
 *   reach that re-records intent a store's closed generations imply but no
 *   record carries yet (a store whose closed generations predate the
 *   stamping, or any record the stamp could not have covered); its evidence
 *   is the healing log event and the backlog measurement, never one
 *   delivery's.
 */
export async function stampClosedGenerationCancellations(
  executor: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  appId?: string,
): Promise<number> {
  const stamped = await executor.query(
    `UPDATE ${JOBS_JOB_RECORD_QUALIFIED} r
        SET cancellation_requested = true,
            cancellation_requested_at = COALESCE(r.cancellation_requested_at, now())
       FROM ${JOBS_APP_LIFECYCLE_QUALIFIED} l
      WHERE l.app_id = r.app_id
        AND ($2::text IS NULL OR l.app_id = $2)
        AND NOT r.cancellation_requested
        AND NOT (r.status = ANY($1::text[]))
        AND ${CLOSED_GENERATION_PREDICATE}`,
    [JOB_TERMINAL_STATUSES, appId ?? null],
  );
  return stamped.rowCount ?? 0;
}

/** The archive-cancellation backlog one measurement reports. */
export interface ClosedGenerationBacklog {
  /** Active (queued/running) records under a closed generation — the remaining work. */
  outstanding: number;
  /** The oldest pending cancellation's instant (the intent's own stamp), null when nothing is pending. */
  oldestPendingAt: Date | null;
}

/**
 * Measure the archive-cancellation backlog: the still-active closed-generation
 * records and the oldest pending-cancellation instant among them — the
 * outstanding count and oldest age criterion 52 makes separately visible from
 * delivery lag. The age reads the records' own intent stamps, so it measures
 * how long the work has been awaiting its cancellation (the healthy-service
 * bound's input), never how old the work itself is.
 */
export async function measureClosedGenerationBacklog(
  executor: Pick<Pool, "query"> | Pick<PoolClient, "query">,
): Promise<ClosedGenerationBacklog> {
  const result = await executor.query<{
    outstanding: number;
    oldest_pending_at: Date | null;
  }>(
    `SELECT count(*)::int AS outstanding, min(r.cancellation_requested_at) AS oldest_pending_at
       FROM ${JOBS_JOB_RECORD_QUALIFIED} r
       JOIN ${JOBS_APP_LIFECYCLE_QUALIFIED} l ON l.app_id = r.app_id
      WHERE NOT (r.status = ANY($1::text[]))
        AND ${CLOSED_GENERATION_PREDICATE}`,
    [JOB_TERMINAL_STATUSES],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("the closed-generation backlog measurement returned no row");
  }
  return { outstanding: row.outstanding, oldestPendingAt: row.oldest_pending_at };
}

/**
 * The apply seam the lifecycle route consumes — the durable store implements
 * it against Postgres; tests may substitute an in-memory variant over the
 * same pure merge, the way the burn store's seam is shared. The route's
 * contract is exact: apply durably before the acknowledgement exists, or
 * throw and acknowledge nothing.
 */
export interface JobsLifecycleApplier {
  apply(appId: string, update: JobsLifecycleUpdate): Promise<JobsLifecycleApplyResult>;
}

/** The structural logger the store reports through (the pino surface, without importing Fastify). */
export interface JobsLifecycleLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface JobsLifecycleStoreOptions {
  databaseUrl: string;
  /** Per-query ceiling, applied as both the pool's statement and connect timeout. */
  statementTimeoutMs: number;
  log: JobsLifecycleLogger;
}

/** The runtime pool stays small: one short transaction per lifecycle delivery. */
const POOL_MAX = 2;

/**
 * The durable lifecycle store — the portal-delivered state's owner, with the
 * same pool discipline as the service's other components: `start()` never
 * throws, `stop()` releases the pool on every exit path, and an apply against
 * a store that is not running throws for the route to refuse (503, retryable),
 * never silently succeeds.
 *
 * The apply is one transaction: ensure the app's row exists, lock it, merge
 * the delivery, write the merge, stamp the still-active closed-generation
 * records with cancellation intent, commit — and only the committed state is
 * acknowledged, so a crash or a refusal between them acknowledges nothing the
 * store does not already hold. The row lock held to the commit is also the
 * serialization boundary the admission and worker-start gates use: a
 * lifecycle apply waits for in-flight acceptance transactions to commit (and
 * therefore sees, and refuses, any enqueue that raced it), and an acceptance
 * transaction locking the same row cannot interleave with a generation change.
 */
export class JobsLifecycleStore implements JobsLifecycleApplier {
  private readonly databaseUrl: string;
  private readonly statementTimeoutMs: number;
  private readonly log: JobsLifecycleLogger;

  private pool: Pool | null = null;
  private stopped = false;

  constructor(options: JobsLifecycleStoreOptions) {
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
          { event: "jobs.lifecycle.pool_error", phase, err },
          "pooled jobs lifecycle-store client dropped",
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
   * Apply one delivered update durably and report what to acknowledge. Every
   * failure throws — the transaction (if it began) is rolled back and nothing
   * is applied; the route answers the retryable unavailability and the
   * portal's sender delivers again with a fresh instruction.
   */
  async apply(appId: string, update: JobsLifecycleUpdate): Promise<JobsLifecycleApplyResult> {
    const pool = this.pool;
    if (this.stopped || !pool) {
      throw new Error("the lifecycle store is not running");
    }
    // The delivery's canonical wire form, before anything is acquired: the
    // column coerces a non-canonical spelling silently, so the value INSERTed
    // is the same canonical string the acknowledgement reports — what is
    // stored and what is answered can never diverge. A delivery that is not a
    // generation at all throws here, with no client checked out and nothing
    // acquired — never between the pool's acquire and its release.
    const deliveredGeneration = canonicalGeneration(update.generation);
    // The checkout window is withJobsClient's (the same lesson the edge's
    // partition helper encodes): a mid-apply socket death is recorded on the
    // client — destroyed on release, never parked back — while the awaited
    // query's own rejection reaches the catch below, rolls the unit back and
    // answers the route's retryable unavailability.
    return withJobsClient(pool, async (client) => {
      await client.query("BEGIN");
      try {
        // Make the row exist, then judge against what was there: the insert's
        // row count says whether the app was unknown (the delivery IS the new
        // state) or the row predate the delivery (merge against it). The
        // FOR UPDATE on the existing row is the serialization point against
        // admissions and any other delivery for this app.
        const inserted = await client.query(
          `INSERT INTO ${JOBS_APP_LIFECYCLE_QUALIFIED} (app_id, generation, archived)
             VALUES ($1, $2, $3)
           ON CONFLICT (app_id) DO NOTHING`,
          [appId, deliveredGeneration, update.archived],
        );
        let result: Omit<JobsLifecycleApplyResult, "stamped">;
        if ((inserted.rowCount ?? 0) === 1) {
          result = { appliedGeneration: deliveredGeneration, changed: true };
        } else {
          const current = await client.query<{
            generation: string;
            archived: boolean;
          }>(
            `SELECT generation, archived
                 FROM ${JOBS_APP_LIFECYCLE_QUALIFIED}
                WHERE app_id = $1
              FOR UPDATE`,
            [appId],
          );
          const row = current.rows[0];
          if (!row) {
            throw new Error(
              `the app lifecycle row for "${appId}" vanished inside its own transaction`,
            );
          }
          const merged = mergeLifecycleUpdate(
            { generation: row.generation, archived: row.archived },
            update,
          );
          if (merged.changed) {
            await client.query(
              `UPDATE ${JOBS_APP_LIFECYCLE_QUALIFIED}
                  SET generation = $2, archived = $3
                WHERE app_id = $1`,
              [appId, merged.state.generation, merged.state.archived],
            );
          }
          result = { appliedGeneration: merged.state.generation, changed: merged.changed };
        }
        // The per-record cancellation intent, committed with the generation
        // change it follows from — never after the acknowledgement. The
        // stamp is idempotent and scoped to THIS app: the transaction's own
        // row lock serializes it against the admissions, so every admission
        // that committed before it is visible to the stamp and every
        // admission after it reads the closed generation at the gate and is
        // refused — no active record of this app slips past unclosed.
        // Another app's unstamped residue is the recovery sweeper's healing
        // arm's news, never this delivery's count.
        const stamped = await stampClosedGenerationCancellations(client, appId);
        await client.query("COMMIT");
        return { ...result, stamped };
      } catch (error) {
        // A failed unit is rolled back so no aborted transaction is returned
        // to the pool. On a dead socket the ROLLBACK itself rejects through
        // pg's handleError — the same death the client-level listener
        // recorded — and the release below destroys that client.
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    });
  }
}

/**
 * The admission/start gate's read: the eligibility of a claimed generation,
 * judged under the caller's own transaction with the app's lifecycle row
 * locked `FOR UPDATE`. The lock held to the caller's commit is the whole
 * point — an admission transaction calls this before it enqueues, so a
 * lifecycle apply for the same app cannot land between its decision and its
 * effect, and a lifecycle apply waits for the admission's transaction to
 * commit before it can close the generation (ADR-0007: intake closure
 * synchronizes with in-flight enqueue transactions). A caller not inside a
 * transaction gets no serialization at all — the lock releases at the read.
 */
export async function lifecycleEligibilityInTx(
  client: PoolClient,
  appId: string,
  claimedGeneration: string,
): Promise<JobsGenerationEligibility> {
  const current = await client.query<{ generation: string; archived: boolean }>(
    `SELECT generation, archived
       FROM ${JOBS_APP_LIFECYCLE_QUALIFIED}
      WHERE app_id = $1
    FOR UPDATE`,
    [appId],
  );
  const row = current.rows[0];
  return lifecycleEligibility(
    row ? { generation: row.generation, archived: row.archived } : null,
    claimedGeneration,
  );
}
