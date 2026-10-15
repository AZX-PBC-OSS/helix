import type { Pool } from "pg";
import type { PoolClientErrorPhase } from "../db/pool.js";
import { createEdgePool, DEFAULT_STATEMENT_TIMEOUT_MS } from "../db/pool.js";
import { instruments } from "../telemetry.js";
import { ATTR_OUTCOME, type JobsBurnSweepOutcome } from "@azx-pbc/shared/telemetry";
import { JOBS_INSTRUCTION_BURN_RETENTION_SECONDS } from "@azx-pbc/shared/jobsSigning";

/**
 * The edge's durable nonce-burn store for signed jobs→edge callback
 * instructions (background-jobs-plane design §3, ADR-0002). A callback
 * instruction is a bearer capability verifiable for up to
 * `JOBS_INSTRUCTION_MAX_LIFETIME_SECONDS + 2 × JOBS_INSTRUCTION_CLOCK_TOLERANCE_SECONDS`
 * — a signature alone cannot stop an on-path party from re-presenting a
 * captured token inside that window. The burn makes each `jti` single-use: the
 * freshness test IS the insert, one statement, so two edge replicas presenting
 * the same token race a unique constraint and exactly one proceeds — and the
 * rows live in the platform database, so the refusal survives a restart. A
 * legitimate retry mints a fresh instruction (fresh `jti`) and is never caught
 * by this store.
 *
 * The table is the migration's `jobs_callback_jti` — deliberately NOT the
 * egress burn set `instruction_jti`, which the edge holds no grant on — and it
 * is RLS-partitioned by {@link env} tier: this store's rows carry the tier its
 * process serves (`prod` on the edge, `dev` on the dev-gateway, both roles'
 * policies pinning the literal), so the database itself refuses a cross-tier
 * burn, read, or delete. The tier is fixed at construction, never a call
 * argument: which tier a process consumes nonces under is a property of the
 * role it connects as, and pinning it there means a receiver cannot pass the
 * wrong one.
 *
 * Retention is the shared floor {@link JOBS_INSTRUCTION_BURN_RETENTION_SECONDS}
 * — the longest a burned token could still verify against any replica — and
 * there is deliberately no knob below it: a shorter retention accepts replays,
 * so the safe value is the only value. The sweep removes what has expired in
 * bounded batches on a timer this store owns; the store is also the sweep's
 * supervisor, mirroring `apps/jobs/src/burns.ts`: `start()` never throws,
 * every pass is counted, failures are logged and never fatal, and `stop()`
 * releases the pool and the timer on every exit path.
 */

/** What one burn attempt decided — never a throw: a store that cannot answer is a verdict the caller denies on. */
export type JobsCallbackBurnOutcome =
  | { verdict: "first-use" }
  | { verdict: "replay" }
  | { verdict: "store-unavailable"; error: unknown };

/**
 * The callback burn seam the jobs-callback receiver consumes (the pg
 * implementation below; tests may substitute). The tier is the store's own —
 * see the class docblock.
 */
export interface JobsCallbackBurnStore {
  /**
   * Consume a callback nonce. `first-use` means this presentation is the
   * first — proceed with the operation; `replay` means it was already spent —
   * refuse; `store-unavailable` means the claim could not be made — refuse
   * without pretending to know whether the token was fresh.
   */
  burn(jti: string): Promise<JobsCallbackBurnOutcome>;
}

/** The structural logger the burn store reports through (the pino surface, without importing Fastify). */
export interface JobsCallbackBurnLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * The burn store's options. Deliberately NOT the full `EdgePoolOpts`: the
 * pool's size, label and connect wait are this store's own policy (a burn is
 * one bounded statement on the callback path), so they are not options here —
 * only what a caller may tune is declared.
 */
export interface JobsCallbackBurnStoreOptions {
  /** The platform DSN — the edge's or the dev-gateway's own, per its role. */
  databaseUrl: string;
  /** The callback tier this process consumes nonces under, pinned for its lifetime. */
  env: "prod" | "dev";
  /** Per-query ceiling in ms — `0` disables it, the pool's documented meaning. The
   * callback's connect wait is derived from it but is never unbounded: with the
   * ceiling off, the wait runs at the platform's default ceiling (a zero connect
   * timeout reads as no timer in pg-pool and the pg client alike). */
  statementTimeoutMs?: number;
  /** Called when a pooled client errors, like every edge store's pool. */
  onClientError?: (err: unknown, ctx: { phase: PoolClientErrorPhase; label: string }) => void;
  /** The fixed cadence between sweeps. */
  sweepIntervalMs?: number;
  /** The largest number of rows one sweep pass may remove — the bound that keeps cleanup bounded. */
  sweepBatch?: number;
  /** Wall-clock milliseconds — injectable so tests can age burns past retention without waiting. */
  nowMs?: () => number;
  log: JobsCallbackBurnLogger;
}

/** Steady sweep cadence — how long an expired burn can outlive its usefulness, not a correctness bound. */
const SWEEP_INTERVAL_MS = 30_000;
/** One pass removes at most this many expired rows; the next pass continues the work. */
const SWEEP_BATCH = 1_000;
/** The runtime pool stays small: burns are one statement per internal callback. */
const POOL_MAX = 2;

export class PgJobsCallbackBurnStore implements JobsCallbackBurnStore {
  #pool: Pool | null;
  readonly #env: "prod" | "dev";
  readonly #sweepIntervalMs: number;
  readonly #sweepBatch: number;
  readonly #nowMs: () => number;
  readonly #log: JobsCallbackBurnLogger;

  #timer: NodeJS.Timeout | null = null;
  #inFlight: Promise<void> | null = null;
  #stopped = false;

  constructor(options: JobsCallbackBurnStoreOptions) {
    this.#env = options.env;
    this.#sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    this.#sweepBatch = options.sweepBatch ?? SWEEP_BATCH;
    this.#nowMs = options.nowMs ?? Date.now;
    this.#log = options.log;
    const statementTimeoutMs = options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
    this.#pool = createEdgePool(options.databaseUrl, {
      max: POOL_MAX,
      statementTimeoutMs,
      // The burn rides the callback's request path: a caller waiting for a
      // free connection must be bounded, so a slow store denies retryably
      // instead of parking the callback. The ceiling usually provides that
      // bound — but its `0` means "disabled" (createEdgePool's documented
      // contract), and both pg-pool and the pg client read a zero connect
      // timeout as NO timer. So when the ceiling is off, the wait runs at the
      // platform's default ceiling instead: the operator's disabled query
      // ceiling must not become an unbounded request-path wait.
      connectionTimeoutMs:
        statementTimeoutMs > 0 ? statementTimeoutMs : DEFAULT_STATEMENT_TIMEOUT_MS,
      onClientError: options.onClientError,
      label: "jobs-callback-jti",
    });
  }

  /**
   * Begin sweeping. Never throws and never blocks the caller: the first pass
   * runs immediately in the background, the timer keeps the cadence, and a
   * store that will not answer leaves the service alive — burns are denied
   * (fail closed) while the sweep retries. Idempotent under every
   * interleaving: a call landing while a pass is in flight (the timer's slot
   * is vacated mid-pass) does not fork a second chain — the in-flight one
   * reschedules itself.
   */
  start(): void {
    if (this.#timer || this.#inFlight || this.#stopped) return;
    this.scheduleSweep(0);
  }

  /**
   * Stop sweeping and release the pool — every exit path's release: the timer
   * is cleared, the in-flight sweep is awaited, the pool ends. Safe to call
   * twice; the store does not restart after stop, and burns on a stopped store
   * answer `store-unavailable` (denied), never silently proceed.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.#inFlight;
    // Take the pool before ending it: pg-pool throws "Called end on pool more
    // than once" on a second end(), and stop() must stay safe twice (the
    // onClose hook and the failed-boot exit can both reach it).
    const pool = this.#pool;
    this.#pool = null;
    await pool?.end();
  }

  async burn(jti: string): Promise<JobsCallbackBurnOutcome> {
    if (this.#stopped || !this.#pool) {
      return { verdict: "store-unavailable", error: new Error("the burn store is stopped") };
    }
    const burnUntil = new Date(this.#nowMs() + JOBS_INSTRUCTION_BURN_RETENTION_SECONDS * 1_000);
    try {
      // The freshness test IS the insert: one statement, judged by the unique
      // constraint, so two replicas cannot both win (the concurrency concern's
      // claim-the-thing shape, not check-then-claim). The env literal rides the
      // statement, and the row-level policy pins it to this role's tier — a
      // wrong tier is a policy refusal, i.e. the fail-closed arm below.
      const result = await this.#pool.query(
        `INSERT INTO jobs_callback_jti ("env", jti, "burnUntil")
           VALUES ($1, $2, $3)
         ON CONFLICT ("env", jti) DO NOTHING`,
        [this.#env, jti, burnUntil.toISOString()],
      );
      return result.rowCount === 1 ? { verdict: "first-use" } : { verdict: "replay" };
    } catch (error) {
      return { verdict: "store-unavailable", error };
    }
  }

  private scheduleSweep(delayMs: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const pass = this.sweepPass();
      this.#inFlight = pass;
      // The pass never rejects by design; the fault arm keeps the cadence
      // anyway, so one unexpected rejection cannot silently end the loop.
      const reschedule = (): void => {
        if (!this.#stopped) this.scheduleSweep(this.#sweepIntervalMs);
      };
      void pass.then(reschedule, reschedule);
    }, delayMs);
    // Never hold the process open for a sweep: the listener and the graceful
    // shutdown own this process's lifetime, and stop() clears the timer anyway.
    this.#timer.unref();
  }

  /**
   * One bounded cleanup pass: remove up to {@link sweepBatch} expired burns.
   * Never throws — a failed pass is counted and logged, and the next pass
   * retries; the batch cap is what makes cleanup bounded when a backlog has
   * accumulated. The env-literal policy scopes every pass to this role's own
   * tier, so the two edge processes sweep independently without touching each
   * other's rows.
   */
  private async sweepPass(): Promise<void> {
    const pool = this.#pool;
    if (this.#stopped || !pool) return;
    try {
      const cutoff = new Date(this.#nowMs());
      // One cutoff for both the outer filter and the batch selection, so the
      // two reads cannot disagree about which rows are expired. The env filter
      // restates the row-level policy: redundant for the runtime roles (the
      // policy already scopes them) and load-bearing for an owner connection,
      // which RLS does not constrain.
      const result = await pool.query(
        `DELETE FROM jobs_callback_jti
           WHERE "env" = $1
             AND "burnUntil" < $2
             AND ctid IN (
               SELECT ctid FROM jobs_callback_jti
                WHERE "env" = $1
                  AND "burnUntil" < $2
                LIMIT $3
             )`,
        [this.#env, cutoff.toISOString(), this.#sweepBatch],
      );
      const removed = result.rowCount ?? 0;
      instruments().jobsBurnSweeps.add(1, { [ATTR_OUTCOME]: "ok" });
      if (removed === this.#sweepBatch) {
        // The batch cap absorbed removals — either steady-state volume or a
        // backlog. One line either way: a sustained run of these means the
        // sweep is falling behind callback volume.
        this.#log.warn(
          { event: "edge.jobs_burn.sweep_backlog", removed },
          "the jobs-callback burn sweep removed a full batch of expired nonces",
        );
      }
    } catch (error) {
      instruments().jobsBurnSweeps.add(1, {
        [ATTR_OUTCOME]: "failed" satisfies JobsBurnSweepOutcome,
      });
      this.#log.warn(
        { event: "edge.jobs_burn.sweep_failed", err: error },
        "the jobs-callback burn sweep could not run — expired nonces remain until a later pass",
      );
    }
  }
}
