import {
  JOBS_LIFECYCLE_DELIVERY_CHECK,
  lastPassAgeSuffix,
  passFreshness,
  type HealthCheck,
  type JobRequestError,
} from "@azx-pbc/shared";
import { JOBS_INSTRUCTION_MAX_LIFETIME_SECONDS } from "@azx-pbc/shared/jobsSigning";
import {
  ATTR_APP_ID,
  ATTR_JOBS_ARCHIVED,
  ATTR_JOBS_GENERATION,
  ATTR_JOBS_SERVER,
  ATTR_OUTCOME,
  ATTR_REASON,
  SPAN_JOBS_LIFECYCLE_DELIVER,
  type JobsLifecycleDeliveryOutcome,
} from "@azx-pbc/shared/telemetry";

import type { PortalJobsDeliveryTarget } from "../deployment.js";
import type { PrismaClient } from "../db/client.js";
import { withConsumerSpan } from "../telemetry.js";

/**
 * The supervised portal sender (ADR-0007, ADR-0009, background-jobs-plane
 * design §5) — the loop that makes the lifecycle outbox's durable intent
 * effective. On a bounded cadence it scans the pending
 * `jobs_lifecycle_outbox` rows oldest-first and delivers each to its target
 * server with a **freshly minted** portal→jobs instruction over the exact
 * `{generation, archived}` bytes; a target's applied-generation
 * acknowledgement — validated to be at least as new as the row it clears —
 * is the only thing that marks a row delivered. The acknowledgement means the
 * intent is durable on the target, never that cancellation has finished
 * running (the receiver applies before it acknowledges; the cancellation
 * recovery that consumes the applied state is the jobs service's own loop).
 *
 * The independence the per-target rows buy is delivered here: the pass
 * attempts every configured target's rows on every pass, one attempt per row,
 * so one unavailable target can neither acknowledge nor block another's
 * delivery. A server-level failure (no answer, an off-protocol answer, a
 * receiver whose store is down) ends that server's attempts for the pass —
 * one failed attempt per unavailable server per pass — and never touches the
 * others. A row-level refusal (the receiver answered a validated error for
 * this one delivery) leaves that row pending and continues with the next.
 * Pending rows for a server this portal no longer delivers to (a target
 * removed after it stopped acknowledging) are never attempted; they stay
 * pending, keep aging into the health grade, and each pass logs them —
 * retirement keeps a target addressable until it acknowledges, so reaching
 * this state is a deployment-map mistake the evidence must surface.
 *
 * Two portal replicas running this loop together are safe by construction:
 * every delivery is idempotent on the receiver (its watermark merge answers
 * `stale` for redeliveries and acks the highest applied generation), and the
 * delivered-marking write is conditional on `deliveredAt` still being null.
 *
 * Supervision mirrors the platform's other pass loops (the jobs service's
 * `JobsRecovery`): `start()` never throws and never blocks the caller, each
 * pass is bounded (a per-server batch cap, a per-attempt transport bound, the
 * shared client's own query timeouts), a pass that fails is logged and counted
 * and never ends the cadence, `stop()` releases the timer and awaits the
 * in-flight pass on every exit path, and the snapshot is what the
 * `jobs_lifecycle_delivery` health check grades — stopped, stale or overdue
 * delivery is never healthy.
 */

/** The resolved attempt one transport call carries. */
export interface LifecycleDeliveryAttempt {
  readonly server: string;
  readonly endpoint: string;
  readonly key: Uint8Array;
  readonly appId: string;
  /** The exact `{generation, archived}` bytes the instruction and body bind. */
  readonly body: Uint8Array;
}

/**
 * How one delivery hop ended — the transport's classification of the
 * receiver's answer. `acknowledged` is a validated 200 ack; `refused` a
 * validated jobs error response (any 4xx/5xx); `unreachable` no answer at
 * all; `invalid_response` an answer that is neither (an unparseable body, a
 * redirect, an off-protocol success). The three non-acknowledged kinds are
 * all retryable by the next pass; none of them ever marks a row delivered.
 */
export type LifecycleDeliveryAnswer =
  | { kind: "acknowledged"; appliedGeneration: string }
  | { kind: "refused"; status: number; error: JobRequestError }
  | { kind: "unreachable"; error: unknown }
  | { kind: "invalid_response"; status: number };

/**
 * The transport seam the pass delivers through — the mint-and-carry hop to
 * one target. The network is the boundary this seam exists for: production
 * supplies the HTTP implementation (`HttpLifecycleDelivery`); tests supply a
 * stand-in over the same verdicts and assert the sender's own logic against
 * it.
 */
export type LifecycleDeliveryTransport = (
  attempt: LifecycleDeliveryAttempt,
) => Promise<LifecycleDeliveryAnswer>;

/** The structural logger the sender reports through (the pino surface, without importing Fastify). */
export interface JobsDeliveryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** The pending row state a pass reads, as the outbox stores it. */
interface PendingIntent {
  appId: string;
  generation: number;
  server: string;
  archived: boolean;
}

/** One server's pending backlog, as the pass's aggregate measured it. */
export interface JobsDeliveryBacklogEntry {
  server: string;
  outstanding: number;
  /** Wall-clock ISO instant of the server's oldest pending intent; null when it has none. */
  oldestPendingAt: string | null;
}

/** The sender's supervision state, as `/health` reports it. */
export interface JobsDeliverySnapshot {
  /** The loop has been started (its first pass may not have completed yet). */
  started: boolean;
  /** Passes run since start, successful or not. */
  passes: number;
  /** Wall-clock ISO instant of the last completed pass, of any outcome. */
  lastPassAt: string | null;
  /** Wall-clock ISO instant of the last pass that could complete its scan. */
  lastOkPassAt: string | null;
  /** Pending intents cleared by acknowledgement, cumulatively since start. */
  delivered: number;
  /** Delivery attempts that ended without an acknowledgement, cumulatively since start. */
  failedDeliveries: number;
  /**
   * The last pass's per-server backlog measurement — null before the first
   * pass measures. Taken at pass start: the same pass may clear some of it.
   */
  backlog: JobsDeliveryBacklogEntry[] | null;
}

/** Steady delivery cadence — how long a lifecycle change can wait between attempts. */
export const JOBS_DELIVERY_INTERVAL_MS = 15_000;
/**
 * Each pass attempts up to this many of EACH configured target's pending
 * intents, oldest first — a per-server window, so one server's full backlog
 * can never consume another target's delivery capacity (criterion 50). The
 * pass's total attempt bound is this times the configured target count, each
 * attempt individually bounded by the transport's own timeout.
 */
export const JOBS_DELIVERY_BATCH = 100;
/**
 * How long without a successful pass the `jobs_lifecycle_delivery` check
 * waits before reading stale — three cadences, the house bound for loop
 * checks. One honest mismatch it carries, by design: a pass's duration grows
 * with the targets that are DOWN (each dark server burns one per-attempt
 * transport bound before the pass moves on), so with a dark server the
 * pass-plus-cadence period can exceed this bound briefly, and the check reads
 * `stale` — the degraded STATE is correct (a slow loop is a degraded loop)
 * with the wrong REASON, and the per-attempt `unreachable` events plus the
 * backlog arm's overdue grade carry the true story until the pass completes
 * and the reading self-corrects. Resizing the bound past the worst-case pass
 * duration would mute the stall signal for every healthy-cadence outage;
 * the transient wrong-reason reading is the cheaper error.
 */
export const JOBS_DELIVERY_STALE_AFTER_MS = 3 * JOBS_DELIVERY_INTERVAL_MS;
/**
 * How old a pending intent may be before its delivery reads degraded — the
 * acceptance contract's own bound (criterion 52: pending work older than 60
 * seconds degrades the corresponding health check; ADR-0009: lifecycle
 * backlog older than 60 seconds remains degraded).
 */
export const JOBS_DELIVERY_OVERDUE_MS = 60_000;

/**
 * Default bound for one delivery round-trip — the signed instruction's own
 * validity window (ADR-0002's rule for these hops: the whole mint→answer wait
 * is capped at the lifetime the token is valid for), derived from the shared
 * constant so the two cannot drift.
 */
export const JOBS_DELIVERY_TIMEOUT_MS = JOBS_INSTRUCTION_MAX_LIFETIME_SECONDS * 1000;

/**
 * The exact `{generation, archived}` bytes one delivery carries. The
 * generation travels as the wire's canonical decimal string (`JobsLifecycleUpdateSchema`)
 * built from the row's integer authority; these bytes are what the
 * instruction's digest binds and what the receiver parses, so they are built
 * once, here, and never re-serialized.
 */
export function lifecycleUpdateBytes(intent: {
  generation: number;
  archived: boolean;
}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ generation: String(intent.generation), archived: intent.archived }),
  );
}

/**
 * Does a target's applied-generation acknowledgement cover one pending row?
 * The ack names the highest generation the target has durably applied —
 * applying a generation covers every older one's intent (the watermark: an
 * older delivery after a newer one can reopen nothing), so an ack at least as
 * new as the row's generation settles it. A LOWER acknowledgement must not
 * clear anything: a stale acknowledgement can never clear newer pending work.
 */
export function ackCoversGeneration(appliedGeneration: string, rowGeneration: number): boolean {
  return BigInt(appliedGeneration) >= BigInt(rowGeneration);
}

export interface JobsLifecycleDeliveryOptions {
  /** The boot's Prisma client — the outbox lives in the platform database it already connects to. */
  prisma: PrismaClient;
  /** The resolved delivery targets; a pending row for a server absent from this map is never attempted. */
  targets: ReadonlyMap<string, PortalJobsDeliveryTarget>;
  transport: LifecycleDeliveryTransport;
  log: JobsDeliveryLogger;
  intervalMs?: number;
}

export class JobsLifecycleDelivery {
  private readonly prisma: PrismaClient;
  private readonly targets: ReadonlyMap<string, PortalJobsDeliveryTarget>;
  private readonly transport: LifecycleDeliveryTransport;
  private readonly intervalMs: number;
  private readonly log: JobsDeliveryLogger;

  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  private current: JobsDeliverySnapshot = {
    started: false,
    passes: 0,
    lastPassAt: null,
    lastOkPassAt: null,
    delivered: 0,
    failedDeliveries: 0,
    backlog: null,
  };

  constructor(options: JobsLifecycleDeliveryOptions) {
    this.prisma = options.prisma;
    this.targets = options.targets;
    this.transport = options.transport;
    this.intervalMs = options.intervalMs ?? JOBS_DELIVERY_INTERVAL_MS;
    this.log = options.log;
  }

  /**
   * Begin the cadence. Never throws and never blocks the caller: the first
   * pass runs immediately in the background, and a database that will not
   * answer leaves the service alive — the passes retry and the health body
   * says so.
   */
  start(): void {
    if (this.stopped || this.current.started) return;
    this.current = { ...this.current, started: true };
    this.schedulePass(0);
  }

  /**
   * Stop the cadence — every exit path's release: the timer is cleared, the
   * in-flight pass is awaited so no delivery is pulled out from under itself,
   * and the snapshot reports the stop. Safe to call twice and safe before
   * start; the sender does not restart after stop.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.current = { ...this.current, started: false };
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // A rejected pass must not break the release chain. The report is
    // sink-guarded because the sink throwing is exactly how a pass comes to
    // reject here.
    await this.inFlight?.catch((error) => {
      try {
        this.log.error(
          { event: "jobs.delivery.pass_rejected", err: error },
          "a delivery pass rejected out of its own failure reporting — the release continues",
        );
      } catch {
        // The reporting sink is the rejection's origin; the release below is
        // the part that must survive.
      }
    });
  }

  /** The supervision state, for `/health` — a lookup, never a live probe. */
  snapshot(): JobsDeliverySnapshot {
    return {
      ...this.current,
      backlog: this.current.backlog?.map((entry) => ({ ...entry })) ?? null,
    };
  }

  /**
   * One delivery pass — the loop's own body, and the seam a caller (or a
   * test) uses to drive a pass synchronously. Never throws out of its own
   * accounting, and a pass whose own failure reporting threw rejects to the
   * caller without ending the cadence: the in-flight guard clears on either
   * settlement half, so the next call runs its own pass instead of
   * coalescing into a settled one forever, and the timer's fault arm keeps
   * the cadence. A pass that arrives while another is running coalesces into
   * it — every delivery and write is idempotent or conditional, so a repeated
   * pass is harmless.
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
   * One bounded pass: measure the backlog, then attempt each configured
   * target's pending intents oldest-first, each server out of its OWN batch
   * window. The per-server window is the fairness the delivery contract
   * hangs on (criterion 50: one unavailable server neither acknowledges nor
   * blocks another's delivery) — a global take across servers would let one
   * dead server's full backlog occupy every pass's window forever, and the
   * healthy targets' rows would never be attempted. The measurement happens
   * first so the evidence is the state the pass worked from; individual
   * delivery failures are accounted per attempt and never abort the scan of
   * the other servers; a database failure fails the pass as a whole.
   */
  private async passOnce(): Promise<void> {
    if (this.stopped) return;
    const startedAt = Date.now();
    let delivered = 0;
    let failures = 0;
    // The pass is accounted EXACTLY ONCE — the same discipline as the
    // recovery sweeper's: every report below is unguarded, so a report that
    // threw re-enters the catch arm, and the flag is what keeps that re-entry
    // from accounting the same pass twice.
    let recorded = false;
    const recordFailure = (): void => {
      if (recorded) return;
      recorded = true;
      this.recordPass(false, startedAt, delivered, failures);
    };
    try {
      const backlog = await this.measureBacklog();
      // A server-level ending (unreachable, off-protocol, the receiver's own
      // unavailability) ends THAT server's attempts for the pass — one failed
      // attempt per unavailable server — and never touches the others.
      const unavailable = new Set<string>();
      for (const [server, target] of this.targets) {
        const rows = await this.prisma.jobsLifecycleOutbox.findMany({
          where: { deliveredAt: null, server },
          orderBy: [{ createdAt: "asc" }, { generation: "asc" }],
          select: { appId: true, generation: true, server: true, archived: true },
          take: JOBS_DELIVERY_BATCH,
        });
        for (const row of rows) {
          if (unavailable.has(server)) break;
          // An attempt that THREW out of its own transport — a mint refusal
          // for a row the outbox should never have carried, or a transport
          // defect — is that row's failed attempt, not the pass's: the row
          // stays pending, the failure is counted, and the scan continues
          // with the others. Aborting the pass here would let one poison row
          // starve every other app's delivery.
          let verdict;
          try {
            verdict = await this.deliverOne(row, target);
          } catch (error) {
            this.log.error(
              {
                event: "jobs.delivery.attempt_threw",
                appId: row.appId,
                server: row.server,
                err: error,
              },
              "a lifecycle delivery attempt failed unexpectedly — the intent stays pending and the next pass retries",
            );
            failures += 1;
            continue;
          }
          if (verdict.outcome === "acknowledged") {
            delivered += await this.clearDelivered(row);
          } else {
            failures += 1;
          }
          if (verdict.serverUnavailable) unavailable.add(server);
        }
      }
      // The measurement is also where a row for a server this portal no
      // longer delivers to surfaces: its backlog keeps aging into health,
      // and the pass names it — retirement keeps a target addressable until
      // it acknowledges, so this state is a deployment-map mistake the
      // evidence must surface, never a silent pending row. Reported AFTER
      // the deliveries, on purpose: this is the pass's reporting, and the
      // pass's work must never be gated on its reporting succeeding (a
      // throwing report rejects the pass, per this module's own contract —
      // but never before the deliveries it owed have been attempted).
      for (const entry of backlog) {
        if (!this.targets.has(entry.server)) {
          this.log.error(
            {
              event: "jobs.delivery.target_unknown",
              server: entry.server,
              outstanding: entry.outstanding,
            },
            "pending lifecycle intents name a server this portal does not deliver to",
          );
        }
      }
      recorded = true;
      this.recordPass(true, startedAt, delivered, failures, backlog);
    } catch (error) {
      recordFailure();
      this.log.error(
        { event: "jobs.delivery.pass_failed", err: error },
        "the lifecycle delivery pass could not run — pending intents stay pending until a later pass",
      );
    }
  }

  /**
   * The per-server pending-backlog measurement the pass reports and the
   * health check grades: one aggregate query, bounded by the target count.
   */
  private async measureBacklog(): Promise<JobsDeliveryBacklogEntry[]> {
    const groups = await this.prisma.jobsLifecycleOutbox.groupBy({
      by: ["server"],
      where: { deliveredAt: null },
      _count: { _all: true },
      _min: { createdAt: true },
    });
    return groups.map((group) => ({
      server: group.server,
      outstanding: group._count._all,
      oldestPendingAt: group._min.createdAt?.toISOString() ?? null,
    }));
  }

  /**
   * Deliver one pending intent to its target and classify the ending. The
   * span is the attempt's own evidence (bounded identity, the bounded
   * outcome, the refusal's code on `helix.reason` — never the endpoint, the
   * token, or an exception's text). The body bytes are built here, once, and
   * are exactly what the transport binds and sends.
   *
   * The outcome is the pass's accounting vocabulary: `acknowledged` says the
   * validated ack COVERED this row (the caller clears it), `stale_ack` that a
   * validated ack named an older generation (nothing cleared), and the rest
   * that no usable acknowledgement arrived. `serverUnavailable` marks the
   * endings that implicate the target itself — no answer, an off-protocol
   * answer, or a 5xx refusal (its own unavailability or a fault; a 4xx is
   * that row's refusal alone) — so the pass stops spending its batch window
   * on that server while still delivering to the others.
   */
  private async deliverOne(
    row: PendingIntent,
    target: PortalJobsDeliveryTarget,
  ): Promise<{ outcome: JobsLifecycleDeliveryOutcome; serverUnavailable: boolean }> {
    return withConsumerSpan(
      SPAN_JOBS_LIFECYCLE_DELIVER,
      {
        [ATTR_APP_ID]: row.appId,
        [ATTR_JOBS_SERVER]: row.server,
        [ATTR_JOBS_GENERATION]: row.generation,
        [ATTR_JOBS_ARCHIVED]: row.archived,
      },
      async (span) => {
        const received = await this.transport({
          server: row.server,
          endpoint: target.endpoint,
          key: target.portalToJobsKey,
          appId: row.appId,
          body: lifecycleUpdateBytes(row),
        });
        // A validated ack that does not cover the row is the stale-ack
        // ending, not an acknowledged one — the delivery answered, but the
        // answer cannot clear newer pending work.
        const covered =
          received.kind === "acknowledged" &&
          ackCoversGeneration(received.appliedGeneration, row.generation);
        const outcome: JobsLifecycleDeliveryOutcome =
          received.kind === "acknowledged" && !covered ? "stale_ack" : received.kind;
        span.setAttributes({
          [ATTR_OUTCOME]: outcome,
          ...(received.kind === "refused" ? { [ATTR_REASON]: received.error.code } : {}),
        });
        if (received.kind === "acknowledged" && !covered) {
          this.log.error(
            {
              event: "jobs.delivery.stale_ack",
              appId: row.appId,
              server: row.server,
              generation: row.generation,
              appliedGeneration: received.appliedGeneration,
            },
            "a lifecycle acknowledgement named an older generation than the row it answered — nothing cleared; the receiver is behind or misrouted",
          );
        } else if (received.kind === "refused") {
          if (received.error.code === "jobs_unavailable") {
            this.log.warn(
              { event: "jobs.delivery.unavailable", appId: row.appId, server: row.server },
              "the target's lifecycle store could not apply a delivery — the intent stays pending and the next pass retries",
            );
          } else {
            this.log.error(
              {
                event: "jobs.delivery.refused",
                appId: row.appId,
                server: row.server,
                reason: received.error.code,
              },
              "the target refused a lifecycle delivery — the intent stays pending until the refusal's cause is fixed",
            );
          }
        } else if (received.kind === "unreachable") {
          this.log.warn(
            { event: "jobs.delivery.unreachable", appId: row.appId, server: row.server },
            "a lifecycle delivery got no answer — the intent stays pending and the next pass retries",
          );
        } else if (received.kind === "invalid_response") {
          this.log.error(
            { event: "jobs.delivery.invalid_response", appId: row.appId, server: row.server },
            "a lifecycle delivery was answered off-protocol — the intent stays pending and the next pass retries",
          );
        }
        return {
          outcome,
          serverUnavailable:
            !covered &&
            (received.kind === "unreachable" ||
              received.kind === "invalid_response" ||
              (received.kind === "refused" && received.status >= 500)),
        };
      },
    );
  }

  /**
   * Mark the acknowledged intent — and any OLDER pending intent for the same
   * app and server, which the covering generation settles with it —
   * delivered. The write is conditional on `deliveredAt` still being null, so
   * a concurrent sender's clear is a no-op rather than a second
   * acknowledgement of the same intent.
   */
  private async clearDelivered(row: PendingIntent): Promise<number> {
    const cleared = await this.prisma.jobsLifecycleOutbox.updateMany({
      where: {
        appId: row.appId,
        server: row.server,
        generation: { lte: row.generation },
        deliveredAt: null,
      },
      data: { deliveredAt: new Date() },
    });
    this.log.info(
      {
        event: "jobs.delivery.acknowledged",
        appId: row.appId,
        server: row.server,
        generation: row.generation,
        cleared: cleared.count,
      },
      "a lifecycle intent was delivered and acknowledged by its target",
    );
    return cleared.count;
  }

  private recordPass(
    ok: boolean,
    startedAt: number,
    delivered: number,
    failures: number,
    backlog?: JobsDeliveryBacklogEntry[],
  ): void {
    const now = new Date().toISOString();
    // `started` is start()'s and stop()'s to set, never a pass's: a pass
    // settling during a stop must not report the sender running again.
    this.current = {
      ...this.current,
      passes: this.current.passes + 1,
      lastPassAt: now,
      lastOkPassAt: ok ? now : this.current.lastOkPassAt,
      delivered: this.current.delivered + delivered,
      failedDeliveries: this.current.failedDeliveries + failures,
      ...(backlog !== undefined ? { backlog } : {}),
    };
    if (ok && (delivered > 0 || failures > 0)) {
      this.log.info(
        { event: "jobs.delivery.pass", delivered, failures, durationMs: Date.now() - startedAt },
        "the lifecycle delivery pass finished",
      );
    }
  }
}

/**
 * Grade the sender's supervision and backlog into the `jobs_lifecycle_delivery`
 * health check (ADR-0009) — a pure function on the supervisor's snapshot, so
 * `/health` stays a lookup and the grading is table-testable without a
 * server. Beyond the shared pass-freshness skeleton (a stopped or
 * never-passed sender errors, a stale one degrades), the check carries the
 * backlog evidence the acceptance contract binds: pending work older than 60
 * seconds degrades (criterion 52), with the outstanding count and oldest age
 * — per server — in the metrics and detail an operator reads. The
 * acknowledgement that clears a row means the intent is durable on its
 * target, never that cancellation has finished, so a degraded reading here is
 * about DELIVERY, and the jobs service's own checks speak for the recovery.
 */
export function jobsLifecycleDeliveryCheck(
  snapshot: JobsDeliverySnapshot,
  options?: { staleAfterMs?: number; nowMs?: number; overdueAfterMs?: number },
): HealthCheck {
  const staleAfterMs = options?.staleAfterMs ?? JOBS_DELIVERY_STALE_AFTER_MS;
  const nowMs = options?.nowMs ?? Date.now();
  const overdueAfterMs = options?.overdueAfterMs ?? JOBS_DELIVERY_OVERDUE_MS;
  const base = {
    name: JOBS_LIFECYCLE_DELIVERY_CHECK,
    metrics: {
      passes: snapshot.passes,
      delivered: snapshot.delivered,
      failedDeliveries: snapshot.failedDeliveries,
    },
  };

  const freshness = passFreshness(snapshot, staleAfterMs, nowMs);
  switch (freshness.kind) {
    case "not_started":
      return {
        ...base,
        status: "error",
        detail:
          "the lifecycle delivery sender is not running — durable lifecycle intent is not being delivered to the jobs servers",
      };
    case "no_pass":
      return {
        ...base,
        status: "error",
        detail: `the lifecycle delivery sender has completed no successful pass${lastPassAgeSuffix(freshness.lastPassSeconds)} — pending intents are not being delivered`,
      };
    case "stale":
      return {
        ...base,
        status: "degraded",
        detail: `the lifecycle delivery sender's last successful pass was ${freshness.sinceSeconds}s ago — its backlog evidence is stale`,
        lastSuccessAt: snapshot.lastOkPassAt ?? undefined,
      };
    case "fresh": {
      const backlog = snapshot.backlog;
      if (backlog === null) {
        // Unreachable through the loop (a fresh pass always measures) —
        // refuse the healthy reading rather than assume one.
        return {
          ...base,
          status: "error",
          detail: "the delivery pass carried no backlog measurement",
        };
      }
      const outstanding = backlog.reduce((total, entry) => total + entry.outstanding, 0);
      const oldestPendingAt = backlog
        .map((entry) => entry.oldestPendingAt)
        .filter((at): at is string => at !== null)
        .sort()[0];
      // The overdue decision reads the MILLISECONDS the store carries —
      // rounding to whole seconds before comparing would let work aged
      // 60.4s (older than the contract's bound, criterion 52) display as 60
      // and read ok. The seconds below are the metric's display unit only.
      const oldestAgeMs = oldestPendingAt !== undefined ? nowMs - Date.parse(oldestPendingAt) : 0;
      const oldestSeconds = Math.round(oldestAgeMs / 1000);
      const metrics = {
        ...base.metrics,
        outstanding,
        oldestSeconds,
      };
      if (oldestAgeMs > overdueAfterMs) {
        // The per-server breakdown is the detail's evidence: which target is
        // behind, by how much, since when — all bounded deployment names.
        const perServer = backlog
          .filter((entry) => entry.outstanding > 0)
          .map((entry) => {
            const age = entry.oldestPendingAt
              ? ` oldest ${Math.round((nowMs - Date.parse(entry.oldestPendingAt)) / 1000)}s`
              : "";
            return `${entry.server}: ${entry.outstanding} pending${age}`;
          })
          .join(", ");
        return {
          name: JOBS_LIFECYCLE_DELIVERY_CHECK,
          status: "degraded",
          metrics,
          detail: `lifecycle delivery is overdue: ${perServer} — delivery retries until the targets acknowledge`,
          lastSuccessAt: snapshot.lastOkPassAt ?? undefined,
        };
      }
      return {
        name: JOBS_LIFECYCLE_DELIVERY_CHECK,
        status: "ok",
        metrics,
        lastSuccessAt: snapshot.lastOkPassAt ?? undefined,
      };
    }
  }
}
