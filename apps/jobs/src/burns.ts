import { Pool } from "pg";

import { JOBS_INSTRUCTION_BURN_RETENTION_SECONDS } from "@azx-pbc/shared/jobsSigning";
import { ATTR_OUTCOME, type JobsBurnSweepOutcome } from "@azx-pbc/shared/telemetry";

import { JOBS_INSTRUCTION_BURNS_QUALIFIED } from "./policy.js";
import { instruments } from "./telemetry.js";

/**
 * The jobs service's durable nonce-burn store (ADR-0002). Every signed
 * instruction is a bearer capability verifiable for up to
 * `JOBS_INSTRUCTION_MAX_LIFETIME_SECONDS + 2 × JOBS_INSTRUCTION_CLOCK_TOLERANCE_SECONDS`
 * — a signature alone cannot stop an on-path party from re-presenting a
 * captured instruction inside that window. The burn makes each `jti`
 * single-use: the freshness test IS the insert, one statement, so two
 * replicas presenting the same token race a unique constraint and exactly one
 * proceeds — and the rows live in this service's own database, so the
 * refusal survives a receiver restart. A legitimate retry mints a fresh
 * instruction (fresh `jti`) and is never caught by this store; the optional
 * retry key that carries its identity is a different mechanism with a
 * different lifetime.
 *
 * Retention is the shared floor {@link JOBS_INSTRUCTION_BURN_RETENTION_SECONDS}
 * — the longest a burned token could still verify against any replica — and
 * there is deliberately no knob below it: a shorter retention accepts replays,
 * so the safe value is the only value. The sweep removes what has expired in
 * bounded batches on a timer this store owns; the store is also the sweep's
 * supervisor, mirroring `src/storage.ts`: `start()` never throws, every pass
 * is counted, failures are logged and never fatal, and `stop()` releases the
 * pool and the timer on every exit path.
 */

/** What one burn attempt decided — never a throw: a store that cannot answer is a verdict the caller denies on. */
export type JobsBurnOutcome =
  | { verdict: "first-use" }
  | { verdict: "replay" }
  | { verdict: "store-unavailable"; error: unknown };

/** The burn seam the instruction receiver consumes (the pg implementation below; tests may substitute). */
export interface JobsBurnStore {
  /**
   * Consume a nonce within a signing scope. `first-use` means this
   * presentation is the first — proceed with the operation; `replay` means it
   * was already spent — refuse; `store-unavailable` means the claim could not
   * be made — refuse without pretending to know whether the token was fresh.
   */
  burn(scope: string, jti: string): Promise<JobsBurnOutcome>;
}

/** The structural logger the burn store reports through (the pino surface, without importing Fastify). */
export interface JobsBurnLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface JobsInstructionBurnsOptions {
  databaseUrl: string;
  /** Per-query ceiling, applied as both the pool's statement and connect timeout. */
  statementTimeoutMs: number;
  /** The fixed cadence between sweeps. */
  sweepIntervalMs?: number;
  /** The largest number of rows one sweep pass may remove — the bound that keeps cleanup bounded. */
  sweepBatch?: number;
  /** Wall-clock milliseconds — injectable so tests can age burns past retention without waiting. */
  nowMs?: () => number;
  log: JobsBurnLogger;
}

/** Steady sweep cadence — how long an expired burn can outlive its usefulness, not a correctness bound. */
const SWEEP_INTERVAL_MS = 30_000;
/** One pass removes at most this many expired rows; the next pass continues the work. */
const SWEEP_BATCH = 1_000;
/** The runtime pool stays small: burns are one statement per internal instruction. */
const POOL_MAX = 2;

export class JobsInstructionBurns implements JobsBurnStore {
  private readonly databaseUrl: string;
  private readonly statementTimeoutMs: number;
  private readonly sweepIntervalMs: number;
  private readonly sweepBatch: number;
  private readonly nowMs: () => number;
  private readonly log: JobsBurnLogger;

  private pool: Pool | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(options: JobsInstructionBurnsOptions) {
    this.databaseUrl = options.databaseUrl;
    this.statementTimeoutMs = options.statementTimeoutMs;
    this.sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    this.sweepBatch = options.sweepBatch ?? SWEEP_BATCH;
    this.nowMs = options.nowMs ?? Date.now;
    this.log = options.log;
  }

  /**
   * Begin sweeping. Never throws and never blocks the caller: the first pass
   * runs immediately in the background, the timer keeps the cadence, and a
   * store that will not answer leaves the service alive — burns are denied
   * (fail closed) while the sweep retries.
   */
  start(): void {
    if (this.pool || this.stopped) return;
    this.pool = new Pool({
      connectionString: this.databaseUrl,
      max: POOL_MAX,
      connectionTimeoutMillis: this.statementTimeoutMs,
      statement_timeout: this.statementTimeoutMs,
    });
    // pg-pool strips a checked-out client's 'error' listener, so a connection
    // death while no query is outstanding would be an unhandled event that
    // kills the process; this listener keeps the service alive and lets the
    // next burn's own failure carry the cause.
    this.pool.on("error", (error) => {
      this.log.warn(
        { event: "jobs.burn.pool_error", err: error },
        "pooled jobs burn-store client dropped",
      );
    });
    this.scheduleSweep(0);
  }

  /**
   * Stop sweeping and release the pool — every exit path's release: the timer
   * is cleared, the in-flight sweep is awaited, the pool ends. Safe to call
   * twice; the store does not restart after stop, and burns on a stopped store
   * answer `store-unavailable` (denied), never silently proceed.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.inFlight;
    const pool = this.pool;
    this.pool = null;
    await pool?.end();
  }

  async burn(scope: string, jti: string): Promise<JobsBurnOutcome> {
    const pool = this.pool;
    if (this.stopped || !pool) {
      return { verdict: "store-unavailable", error: new Error("the burn store is stopped") };
    }
    const burnUntil = new Date(this.nowMs() + JOBS_INSTRUCTION_BURN_RETENTION_SECONDS * 1_000);
    try {
      // The freshness test IS the insert: one statement, judged by the unique
      // constraint, so two replicas cannot both win (the concurrency concern's
      // claim-the-thing shape, not check-then-claim).
      const result = await pool.query(
        `INSERT INTO ${JOBS_INSTRUCTION_BURNS_QUALIFIED} (scope, jti, burn_until)
           VALUES ($1, $2, $3)
         ON CONFLICT (scope, jti) DO NOTHING`,
        [scope, jti, burnUntil.toISOString()],
      );
      return result.rowCount === 1 ? { verdict: "first-use" } : { verdict: "replay" };
    } catch (error) {
      return { verdict: "store-unavailable", error };
    }
  }

  private scheduleSweep(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const pass = this.sweepPass();
      this.inFlight = pass;
      // The pass never rejects by design; the fault arm keeps the cadence
      // anyway, so one unexpected rejection cannot silently end the loop.
      const reschedule = (): void => {
        if (!this.stopped) this.scheduleSweep(this.sweepIntervalMs);
      };
      void pass.then(reschedule, reschedule);
    }, delayMs);
    // Never hold the process open for a sweep: the listener and the graceful
    // shutdown own this process's lifetime, and stop() clears the timer anyway.
    this.timer.unref();
  }

  /**
   * One bounded cleanup pass: remove up to {@link sweepBatch} expired burns.
   * Never throws — a failed pass is counted and logged, and the next pass
   * retries; the batch cap is what makes cleanup bounded when a backlog has
   * accumulated.
   */
  private async sweepPass(): Promise<void> {
    const pool = this.pool;
    if (this.stopped || !pool) return;
    try {
      const cutoff = new Date(this.nowMs());
      // One cutoff for both the outer filter and the batch selection, so the
      // two reads cannot disagree about which rows are expired.
      const result = await pool.query(
        `DELETE FROM ${JOBS_INSTRUCTION_BURNS_QUALIFIED}
           WHERE burn_until < $1
             AND ctid IN (
               SELECT ctid FROM ${JOBS_INSTRUCTION_BURNS_QUALIFIED}
                WHERE burn_until < $1
                LIMIT $2
             )`,
        [cutoff.toISOString(), this.sweepBatch],
      );
      const removed = result.rowCount ?? 0;
      instruments().burnSweeps.add(1, { [ATTR_OUTCOME]: "ok" });
      if (removed === this.sweepBatch) {
        // The batch cap absorbed removals — either steady-state volume or a
        // backlog. One line either way: a sustained run of these means the
        // sweep is falling behind instruction volume.
        this.log.warn(
          { event: "jobs.burn.sweep_backlog", removed },
          "the burn sweep removed a full batch of expired nonces",
        );
      }
    } catch (error) {
      instruments().burnSweeps.add(1, { [ATTR_OUTCOME]: "failed" satisfies JobsBurnSweepOutcome });
      this.log.warn(
        { event: "jobs.burn.sweep_failed", err: error },
        "the burn sweep could not run — expired nonces remain until a later pass",
      );
    }
  }
}
