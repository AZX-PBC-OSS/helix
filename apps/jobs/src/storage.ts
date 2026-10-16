import type { Pool } from "pg";

import { ATTR_OUTCOME, type JobsStorageProbeOutcome } from "@azx-pbc/shared/telemetry";

import { checkJobsStorageCompatibility, type JobsStorageCompatibility } from "./compat.js";
import { createJobsPool } from "./pool.js";
import { describeDsn } from "./dsn.js";
import { instruments } from "./telemetry.js";

/**
 * The jobs storage lifecycle — the supervisor that owns the service's private
 * store connection and answers, continuously and honestly, one question: can
 * this service rely on its store right now?
 *
 * The design's boot contract (background-jobs-plane §8, ADR-0009) is
 * health-first: the HTTP listener and `/health` come up before the store is
 * usable, bounded connection/schema checks retry with capped backoff while
 * `/health` reports the store unavailable, and a later check that succeeds
 * recovers the service — storage becoming usable after startup is an ordinary,
 * observable transition, not a boot failure. Nothing here ever throws out of
 * the loop: a store that never answers keeps the service alive and unhealthy,
 * which is exactly the state an operator must be able to observe.
 *
 * The probe cadence is the bounded-wait discipline: every probe is bounded by
 * the pool's connect timeout and statement timeout, the wait between probes is
 * capped, and each probe is counted (`helix.jobs.storage.probes`) so the
 * retries a store outage absorbs are visible, not silent. State transitions
 * are logged; the health body (`/health` via `jobsDatabaseCheck`) and the
 * probe counter carry the ongoing story between them.
 */

/** What the supervisor currently believes about the store — the health body's source. */
export interface JobsStorageSnapshot {
  /**
   * `pending` — no probe has completed yet, so readiness is **unknown**;
   * `ready` — the last probe verified a compatible store; `unavailable` — the
   * last probe named why the store cannot be relied on.
   */
  state: "pending" | "ready" | "unavailable";
  /** The last probe's verdict; null while pending. */
  verdict: JobsStorageCompatibility | null;
  /** Wall-clock ISO instant the store last verified compatible; null while it never has. */
  lastReadyAt: string | null;
  /** Wall-clock ISO instant the current unavailable episode began; null otherwise. */
  unavailableSince: string | null;
  /** Total probes run since start — the retries an outage absorbs, as a count. */
  probes: number;
}

/** The structural logger the supervisor reports through (the pino surface, without importing Fastify). */
export interface JobsStorageLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface JobsStorageOptions {
  databaseUrl: string;
  /**
   * Per-query ceiling, applied as both the pool's statement timeout and its
   * connect timeout — the bound that keeps every probe (and so every wait in
   * this loop) finite even against a store that accepts connections and never
   * answers.
   */
  statementTimeoutMs: number;
  /**
   * The compatibility probe. Defaults to the real read-only check; injected in
   * unit tests so the state machine can be driven without a database — the
   * real check against a real store is covered by the integration suites.
   */
  check?: (pool: Pool) => Promise<JobsStorageCompatibility>;
  /** First retry delay after a failed probe. */
  retryInitialMs?: number;
  /** The cap the retry backoff never exceeds. */
  retryMaxMs?: number;
  /** Steady cadence while ready — the later-failure detection bound. */
  readyIntervalMs?: number;
  log: JobsStorageLogger;
}

/** Retry backoff: first delay, and the cap it never exceeds. */
const RETRY_INITIAL_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** Steady probe cadence while ready — how long a later storage failure can stay unobserved. */
const READY_INTERVAL_MS = 30_000;
/** The runtime pool stays small: the probes are the only consumer until the runner tickets add stores. */
const POOL_MAX = 2;

export class JobsStorage {
  private readonly databaseUrl: string;
  private readonly statementTimeoutMs: number;
  private readonly check: (pool: Pool) => Promise<JobsStorageCompatibility>;
  private readonly retryInitialMs: number;
  private readonly retryMaxMs: number;
  private readonly readyIntervalMs: number;
  private readonly log: JobsStorageLogger;

  private pool: Pool | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private failedProbesInEpisode = 0;

  private current: JobsStorageSnapshot = {
    state: "pending",
    verdict: null,
    lastReadyAt: null,
    unavailableSince: null,
    probes: 0,
  };

  constructor(options: JobsStorageOptions) {
    this.databaseUrl = options.databaseUrl;
    this.statementTimeoutMs = options.statementTimeoutMs;
    this.check = options.check ?? checkJobsStorageCompatibility;
    this.retryInitialMs = options.retryInitialMs ?? RETRY_INITIAL_MS;
    this.retryMaxMs = options.retryMaxMs ?? RETRY_MAX_MS;
    this.readyIntervalMs = options.readyIntervalMs ?? READY_INTERVAL_MS;
    this.log = options.log;
  }

  /**
   * Begin probing. Never throws and never awaits the first probe: the caller
   * brings up its listener immediately, and readiness is `pending` — reported
   * unhealthy — until the first verdict lands.
   */
  start(): void {
    if (this.pool || this.stopped) return;
    this.pool = createJobsPool({
      databaseUrl: this.databaseUrl,
      statementTimeoutMs: this.statementTimeoutMs,
      max: POOL_MAX,
      onClientError: (err, phase) => {
        this.log.warn(
          {
            event: "jobs.storage.pool_error",
            store: describeDsn(this.databaseUrl),
            phase,
            err,
          },
          "pooled jobs-store client dropped",
        );
      },
    });
    this.launchProbe();
  }

  /**
   * The guarded launch every probe gets — the first from `start()`, the rest
   * from the cadence's timer. A rejected probe (its own reporting threw)
   * must not become an unhandled rejection in the process that serves the
   * health body: the report is sink-guarded because the sink throwing is
   * exactly how a probe comes to reject here, and the probe's own `finally`
   * has already scheduled the next one.
   */
  private launchProbe(): void {
    void this.runProbe().catch((error) => {
      try {
        this.log.error(
          { event: "jobs.storage.probe_rejected", err: error },
          "a storage probe rejected out of its own failure reporting — the cadence continues",
        );
      } catch {
        // The reporting sink is the rejection's origin; survival is the point.
      }
    });
  }

  /**
   * Stop probing and release the pool — every exit path's release: the retry
   * timer is cleared, the in-flight probe is awaited so no client is pulled
   * out from under itself, and the pool ends. Safe to call twice and safe
   * before start; the supervisor does not restart after stop.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // A rejected probe must not break the release chain: its pool still
    // ends. The report is sink-guarded because the sink throwing is exactly
    // how a probe comes to reject here.
    await this.inFlight?.catch((error) => {
      try {
        this.log.error(
          { event: "jobs.storage.probe_rejected", err: error },
          "a storage probe rejected out of its own failure reporting — the release continues",
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

  /** The current readiness, for `/health` and any other readiness consumer. */
  snapshot(): JobsStorageSnapshot {
    return { ...this.current };
  }

  /**
   * One bounded probe, then the next wait. The check's every outcome —
   * including a defect that made it throw — is answered as a verdict, never
   * a silent skip; a probe rejects only when its own reporting threw, and
   * that rejection is carried to the guarded launch's report while the
   * `finally` inside has already scheduled the next probe.
   */
  private runProbe(): Promise<void> {
    const probe = this.probeOnce();
    this.inFlight = probe;
    return probe;
  }

  private async probeOnce(): Promise<void> {
    if (this.stopped || !this.pool) return;
    let verdict: JobsStorageCompatibility;
    try {
      verdict = await this.check(this.pool);
    } catch (error) {
      // The catch arm's own report is sink-guarded: a sink that threw must
      // not stop the verdict below from being recorded and the scheduling
      // finally from being reached — a supervisor that died here would
      // freeze the snapshot on its last `ready` and /health would read ok
      // with the store down.
      try {
        this.log.error(
          { event: "jobs.storage.probe_error", store: describeDsn(this.databaseUrl), err: error },
          "the jobs storage compatibility probe threw — treating the store as unreachable",
        );
      } catch {
        // The reporting sink is already failing; the verdict is the part
        // that must survive.
      }
      verdict = {
        kind: "unreachable",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    // The probe's evidence and the next scheduling are the loop's two halves:
    // a reporting failure ends neither. The rejection (a reporting sink that
    // threw) is carried to the guarded launch's report (`launchProbe`).
    try {
      this.recordProbe(verdict);
    } finally {
      if (!this.stopped && this.pool) this.scheduleNext(verdict.kind === "compatible");
    }
  }

  private recordProbe(verdict: JobsStorageCompatibility): void {
    const ready = verdict.kind === "compatible";
    const outcome: JobsStorageProbeOutcome = ready ? "ok" : "unavailable";
    // A probe that cannot run is still a probe that ran: the counter absorbs
    // the retries, so a sustained store outage is a rate an alert can read.
    instruments().storageProbes.add(1, { [ATTR_OUTCOME]: outcome });

    const previous = this.current;
    const probes = previous.probes + 1;
    const now = new Date().toISOString();

    if (ready) {
      const recovered = previous.state === "unavailable";
      this.current = {
        state: "ready",
        verdict,
        lastReadyAt: now,
        unavailableSince: null,
        probes,
      };
      this.failedProbesInEpisode = 0;
      if (recovered) {
        this.log.info(
          { event: "jobs.storage.ready", store: describeDsn(this.databaseUrl) },
          "jobs storage became usable",
        );
      }
      return;
    }

    const firstFailure = previous.state !== "unavailable";
    this.current = {
      state: "unavailable",
      verdict,
      lastReadyAt: previous.lastReadyAt,
      unavailableSince: firstFailure ? now : previous.unavailableSince,
      probes,
    };
    this.failedProbesInEpisode += 1;
    if (firstFailure) {
      // The transition is the signal — one line naming why the store cannot be
      // relied on; the probe counter and the health body carry the continuation.
      this.log.error(
        {
          event: "jobs.storage.unavailable",
          store: describeDsn(this.databaseUrl),
          verdict,
        },
        "jobs storage is unavailable",
      );
    }
  }

  /** The capped backoff while unavailable; the steady cadence while ready. */
  private scheduleNext(lastReady: boolean): void {
    if (this.stopped) return;
    const delay = lastReady
      ? this.readyIntervalMs
      : Math.min(
          this.retryInitialMs * 2 ** Math.max(0, this.failedProbesInEpisode - 1),
          this.retryMaxMs,
        );
    this.timer = setTimeout(() => {
      this.timer = null;
      this.launchProbe();
    }, delay);
    // Never hold the process open for a probe: the listener and the graceful
    // shutdown own this process's lifetime, and stop() clears the timer anyway.
    this.timer.unref();
  }
}
