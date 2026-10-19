import { request } from "undici";
import {
  HealthStatusSchema,
  JOBS_MAX_RESULT_BYTES,
  JOBS_REACHABILITY_CHECK,
  JOBS_SERVICE_NAME,
  lastPassAgeSuffix,
  passFreshness,
  type HealthCheck,
} from "@azx-pbc/shared";
import { ATTR_OUTCOME, type JobsReachabilityProbeOutcome } from "@azx-pbc/shared/telemetry";

import { instruments } from "../telemetry.js";
import { readBoundedBody } from "./boundedBody.js";

/**
 * The edge's bounded jobs-reachability observation (ADR-0009) — the producer
 * of the `jobs_reachability` health check. One supervised loop probes every
 * configured jobs server's `/health` on its own cadence: independent of user
 * requests (a quiet deployment is still observed; a burst of forwards adds no
 * probes), each probe bounded well under the cadence, and `/health` reads the
 * last snapshot — never a live probe, so a slow jobs server cannot hold a
 * health request.
 *
 * The probe reads the body, not just the wire: the jobs service's `/health`
 * answers 200 in every state with the shared contract, so "reachable" means
 * "answered as the jobs service we configured", and what the server reported
 * about itself rides the snapshot as evidence. The check's own grade stays
 * about reachability — the server's storage/worker/cleanup state is its own
 * body's story; this check says whether this edge can reach it at all.
 *
 * Every wait is bounded (per-probe timeout), every probe is counted
 * (`helix.jobs.reachability.probes`), and every per-server transition is
 * logged once — the counter and the health body carry the continuation
 * between transitions, the same division the storage supervisor uses.
 */

/** One configured server's observed state — the snapshot's per-server entry. */
export interface JobsReachabilityServerState {
  /** The validated deployment-map server id (bounded; never an endpoint URL). */
  server: string;
  /** `pending` — no probe has answered for it yet; otherwise the last probe's verdict. */
  state: "pending" | "reachable" | "unreachable";
  /**
   * The server's own `/health` roll-up when last reachable, as evidence — the
   * grade below never treats it as reachability, but an operator reading one
   * body deserves the join. Null while never reachable.
   */
  reported: "ok" | "degraded" | "error" | null;
  /**
   * Wall-clock ISO instant the server last answered as the health contract;
   * null when it has never answered. Rendered in the down detail as the
   * operator's anchor — a server down since boot ("never answered") is
   * distinguishable from one that died ("last answered <instant>") — and
   * deliberately preserved through an outage, never rewritten by one.
   */
  lastReachableAt: string | null;
  /** Wall-clock ISO instant the current unreachable episode began; null otherwise. */
  unreachableSince: string | null;
  /** Why the server is unreachable — a bounded classification word, never an error's text or a URL. */
  reason: "no_answer" | "off_protocol" | null;
}

/** What the loop currently observes across the configured servers. */
export interface JobsReachabilitySnapshot {
  started: boolean;
  /** Probe passes launched since start. */
  passes: number;
  /** Wall-clock ISO instant the last pass completed, successful or not. */
  lastPassAt: string | null;
  /** Wall-clock ISO instant the last pass that completed its measurements ran. */
  lastOkPassAt: string | null;
  /** One entry per configured server, in configuration order. */
  servers: readonly JobsReachabilityServerState[];
}

/** The structural logger the loop reports through (the pino surface, without importing Fastify). */
export interface JobsReachabilityLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface JobsReachabilityOptions {
  /** The configured servers to observe — validated deployment-map entries. */
  servers: ReadonlyArray<{ server: string; endpoint: string }>;
  /** Steady cadence — how long a jobs server's state change can stay unobserved. */
  intervalMs?: number;
  /** Per-probe bound; the whole pass is bounded by it (probes run together). */
  timeoutMs?: number;
  /**
   * One reachability probe — the network boundary, named at every
   * construction site: production passes {@link probeJobsHealth}; the unit
   * suite injects a double so the state machine runs without a network, and
   * the integration suite drives the real one over real HTTP.
   */
  probe: (endpoint: string, timeoutMs: number) => Promise<JobsProbeAnswer>;
  log: JobsReachabilityLogger;
}

/** One probe's classified answer, before the snapshot records it. */
export type JobsProbeAnswer =
  | { outcome: "reachable"; reported: "ok" | "degraded" | "error" }
  | { outcome: "unreachable"; reason: "no_answer" }
  | { outcome: "invalid_response" };

/** Steady probe cadence — the storage-readiness probe's cadence class (30 s). */
export const JOBS_REACHABILITY_INTERVAL_MS = 30_000;
/** Per-probe bound: a server that has not answered in 10 s is not serving forwards either. */
export const JOBS_REACHABILITY_TIMEOUT_MS = 10_000;
/** Staleness, in multiples of the cadence, that degrades — the house skeleton's three. */
export const JOBS_REACHABILITY_STALE_AFTER_MS = 3 * JOBS_REACHABILITY_INTERVAL_MS;

/**
 * The real probe: `GET {endpoint}/health` over undici's `request` — the
 * forwarding seam's own client for this hop — bounded by the timeout,
 * redirects never followed (`request` follows none: the answer comes back as
 * the 3xx response and is classified below, and the redirect target is never
 * contacted), the body read bounded on EVERY answered path (the socket is
 * released at the trip or the end, never left for the GC; anything over the
 * hop's response allowance is unusable without being read whole), the body
 * validated against the shared contract AND the `service` field it carries —
 * every helix service answers the same contract shape, so only the name
 * distinguishes the jobs service from a misrouted sibling. Never throws:
 * every transport ending is a classified answer, so the loop sees verdicts,
 * not exceptions — the *reason* is a bounded word and the endpoint URL never
 * reaches a log or a span attribute.
 */
export async function probeJobsHealth(
  endpoint: string,
  timeoutMs: number,
): Promise<JobsProbeAnswer> {
  let res: Awaited<ReturnType<typeof request>>;
  try {
    res = await request(`${endpoint}/health`, {
      method: "GET",
      headers: { accept: "application/json" },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { outcome: "unreachable", reason: "no_answer" };
  }
  const bounded = await readBoundedBody(res.body, JOBS_MAX_RESULT_BYTES);
  if (bounded.over || bounded.failed || res.statusCode !== 200) {
    return { outcome: "invalid_response" };
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bounded.bytes));
  } catch {
    return { outcome: "invalid_response" };
  }
  const parsed = HealthStatusSchema.safeParse(body);
  if (!parsed.success || parsed.data.service !== JOBS_SERVICE_NAME) {
    return { outcome: "invalid_response" };
  }
  return { outcome: "reachable", reported: parsed.data.status };
}

export class JobsReachability {
  private readonly endpoints: ReadonlyArray<{ server: string; endpoint: string }>;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly probe: (endpoint: string, timeoutMs: number) => Promise<JobsProbeAnswer>;
  private readonly log: JobsReachabilityLogger;

  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  private current: JobsReachabilitySnapshot;

  constructor(options: JobsReachabilityOptions) {
    this.endpoints = options.servers;
    this.intervalMs = options.intervalMs ?? JOBS_REACHABILITY_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? JOBS_REACHABILITY_TIMEOUT_MS;
    this.probe = options.probe;
    this.log = options.log;
    this.current = {
      started: false,
      passes: 0,
      lastPassAt: null,
      lastOkPassAt: null,
      servers: this.endpoints.map(({ server }) => ({
        server,
        state: "pending",
        reported: null,
        lastReachableAt: null,
        unreachableSince: null,
        reason: null,
      })),
    };
  }

  /**
   * Begin probing. Never throws and never awaits the first pass: the listener
   * comes up immediately, and every server is `pending` — reported unhealthy
   * by the check — until its first answer lands.
   */
  start(): void {
    if (this.stopped || this.timer || this.inFlight) return;
    this.current = { ...this.current, started: true };
    this.launchPass();
  }

  /**
   * Stop probing — every exit path's release: the timer is cleared, the
   * in-flight pass is awaited so its recordings land before the snapshot is
   * read for the last time, and the loop does not restart. Safe to call
   * twice; safe before start.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.current = { ...this.current, started: false };
    // A rejected pass must not break the release chain. The report is
    // sink-guarded because the sink throwing is exactly how a pass comes to
    // reject here.
    await this.inFlight?.catch((error) => {
      try {
        this.log.error(
          { event: "edge.jobs_reachability.pass_rejected", err: error },
          "a reachability pass rejected out of its own failure reporting — the release continues",
        );
      } catch {
        // The reporting sink is the rejection's origin; the release above is
        // the part that must survive.
      }
    });
    this.inFlight = null;
  }

  /** The current observation, for `/health` and any other reachability consumer. */
  snapshot(): JobsReachabilitySnapshot {
    return {
      ...this.current,
      servers: this.current.servers.map((s) => ({ ...s })),
    };
  }

  /**
   * The guarded launch every pass gets — the first from `start()`, the rest
   * from the cadence's timer. A rejected pass (its own reporting threw) must
   * not become an unhandled rejection in the process that serves the health
   * body: the report is sink-guarded because the sink throwing is exactly how
   * a pass comes to reject here, and the pass's own `finally` has already
   * scheduled the next one.
   */
  private launchPass(): void {
    void this.runPass().catch((error) => {
      try {
        this.log.error(
          { event: "edge.jobs_reachability.pass_rejected", err: error },
          "a reachability pass rejected out of its own failure reporting — the cadence continues",
        );
      } catch {
        // The reporting sink is the rejection's origin; survival is the point.
      }
    });
  }

  /** One pass over every configured server, then the next scheduling. */
  private runPass(): Promise<void> {
    const pass = this.passOnce();
    this.inFlight = pass;
    return pass;
  }

  private async passOnce(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.probeAll();
      this.recordPass(true);
    } catch (error) {
      // The pass's own bookkeeping failed — the measurement is unrecorded, so
      // the evidence stays where it was and freshness will age it. The
      // transition log is the report; a probe classification failure cannot
      // reach here (the real probe classifies everything).
      try {
        this.log.error(
          { event: "edge.jobs_reachability.pass_failed", err: error },
          "the jobs reachability pass failed — the observation stands until the next pass",
        );
      } catch {
        // The reporting sink is already failing; the scheduling below is the
        // part that must survive.
      }
      this.recordPass(false);
    } finally {
      if (!this.stopped) this.scheduleNext();
    }
  }

  /** Probe every server together; each answer is bounded, so the pass is too. */
  private async probeAll(): Promise<void> {
    await Promise.all(
      this.endpoints.map(async ({ server, endpoint }) => {
        let answer: JobsProbeAnswer;
        try {
          answer = await this.probe(endpoint, this.timeoutMs);
        } catch {
          // A probe that throws (an injected double's defect, or a
          // classification gap) is recorded as no answer, never skipped —
          // missing evidence is the one reading this contract forbids.
          answer = { outcome: "unreachable", reason: "no_answer" };
        }
        this.recordProbe(server, answer);
      }),
    );
  }

  private recordProbe(server: string, answer: JobsProbeAnswer): void {
    const reachable = answer.outcome === "reachable";
    instruments().jobsReachabilityProbes.add(1, {
      [ATTR_OUTCOME]: answer.outcome satisfies JobsReachabilityProbeOutcome,
    });
    // The server state's bounded reason word, from the answer's ending: the
    // snapshot keeps the two distinguishing words (the health body's detail
    // reads them), the counter keeps the vocabulary's three.
    const reason: "no_answer" | "off_protocol" =
      answer.outcome === "unreachable" ? "no_answer" : "off_protocol";

    const servers = this.current.servers.map((s): JobsReachabilityServerState => {
      if (s.server !== server) return s;
      if (reachable) {
        const recovered = s.state === "unreachable";
        if (recovered) {
          this.log.info(
            { event: "edge.jobs_reachability.recovered", server },
            "a configured jobs server answers the health contract again",
          );
        }
        return {
          ...s,
          state: "reachable",
          reported: answer.reported,
          lastReachableAt: new Date().toISOString(),
          unreachableSince: null,
          reason: null,
        };
      }
      const firstFailure = s.state !== "unreachable";
      if (firstFailure) {
        // The transition is the signal — one line naming the server and the
        // bounded reason; the probe counter and the health body carry the
        // continuation. Never the endpoint URL and never the error text.
        this.log.warn(
          { event: "edge.jobs_reachability.unreachable", server, reason },
          "a configured jobs server did not answer the health contract",
        );
      }
      return {
        ...s,
        state: "unreachable",
        reason,
        unreachableSince: firstFailure ? new Date().toISOString() : s.unreachableSince,
        // The last reachable instant and the server's last reported status
        // survive the outage — "last known good" is the operator's anchor,
        // and the snapshot never rewrites them.
      };
    });
    this.current = { ...this.current, servers };
  }

  private recordPass(ok: boolean): void {
    const now = new Date().toISOString();
    // `started` is start()'s and stop()'s to set, never a pass's: a pass
    // settling during a stop must not report the loop running again.
    this.current = {
      ...this.current,
      passes: this.current.passes + 1,
      lastPassAt: now,
      lastOkPassAt: ok ? now : this.current.lastOkPassAt,
    };
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.launchPass();
    }, this.intervalMs);
    // Never hold the process open for a probe: the listener and the graceful
    // shutdown own this process's lifetime, and stop() clears the timer anyway.
    this.timer.unref();
  }
}

/**
 * Grade the reachability observation into the `jobs_reachability` health
 * check (ADR-0009) — a pure function on the loop's snapshot, so `/health`
 * stays a lookup and the grading is table-testable without a server. The
 * shared pass-freshness skeleton first (a stopped or never-passed loop
 * errors, a stale one degrades — missing or stale evidence never reads ok),
 * then the per-server evidence the check exists for: every configured server
 * reachable reads `ok`; some unreachable degrades, naming each one and since
 * when; all of them unreachable errors — the entire configured jobs plane is
 * refusing this edge's forwards. A server still `pending` after a fresh pass
 * is refused as error, never read as healthy. The server's own reported
 * status rides the detail as evidence; the jobs service's body stays
 * authoritative for its own state.
 */
export function jobsReachabilityCheck(
  snapshot: JobsReachabilitySnapshot,
  options?: { staleAfterMs?: number; nowMs?: number },
): HealthCheck {
  const staleAfterMs = options?.staleAfterMs ?? JOBS_REACHABILITY_STALE_AFTER_MS;
  const nowMs = options?.nowMs ?? Date.now();
  const reachable = snapshot.servers.filter((s) => s.state === "reachable").length;
  const unreachable = snapshot.servers.filter((s) => s.state === "unreachable").length;
  const base = {
    name: JOBS_REACHABILITY_CHECK,
    metrics: {
      passes: snapshot.passes,
      servers: snapshot.servers.length,
      reachable,
      unreachable,
    },
  };

  const freshness = passFreshness(snapshot, staleAfterMs, nowMs);
  switch (freshness.kind) {
    case "not_started":
      return {
        ...base,
        status: "error",
        detail:
          "the jobs reachability probe is not running — the configured jobs servers' availability is unobserved",
      };
    case "no_pass":
      return {
        ...base,
        status: "error",
        detail: `the reachability probe has completed no successful pass${lastPassAgeSuffix(freshness.lastPassSeconds)} — jobs-server availability is unobserved`,
      };
    case "stale":
      return {
        ...base,
        status: "degraded",
        detail: `the reachability probe's last pass was ${freshness.sinceSeconds}s ago — the per-server evidence is stale`,
        lastSuccessAt: snapshot.lastOkPassAt ?? undefined,
      };
    case "fresh": {
      if (snapshot.servers.length === 0) {
        // The wiring composes this check only when jobs servers are
        // configured; refuse the healthy reading rather than assume one.
        return {
          ...base,
          status: "error",
          detail: "no jobs servers are configured for observation",
        };
      }
      const pending = snapshot.servers.filter((s) => s.state === "pending");
      if (pending.length > 0) {
        const names = pending.map((s) => s.server).join(", ");
        return {
          ...base,
          status: "error",
          detail: `${names} ${pending.length === 1 ? "has" : "have"} never answered a probe — jobs-server availability is unobserved`,
          lastSuccessAt: snapshot.lastOkPassAt ?? undefined,
        };
      }
      const down = snapshot.servers.filter((s) => s.state === "unreachable");
      const reporting = snapshot.servers
        .filter((s) => s.state === "reachable" && s.reported !== null && s.reported !== "ok")
        .map((s) => `${s.server} reports ${s.reported}`);
      if (down.length === snapshot.servers.length) {
        return {
          ...base,
          status: "error",
          detail: `every configured jobs server is unreachable (${down
            .map((s) => downSince(s, nowMs))
            .join("; ")}) — jobs operations forwarded from this edge cannot be served`,
          lastSuccessAt: snapshot.lastOkPassAt ?? undefined,
        };
      }
      if (down.length > 0) {
        const parts = [
          ...down.map((s) => downSince(s, nowMs)),
          ...(reporting.length > 0 ? reporting : []),
        ];
        return {
          ...base,
          status: "degraded",
          detail: `unreachable: ${parts.join("; ")} — jobs operations on those servers answer the retryable 503`,
          lastSuccessAt: snapshot.lastOkPassAt ?? undefined,
        };
      }
      if (reporting.length > 0) {
        return {
          ...base,
          status: "ok",
          detail: `all servers reachable; ${reporting.join("; ")}`,
          lastSuccessAt: snapshot.lastOkPassAt ?? undefined,
        };
      }
      return { ...base, status: "ok", lastSuccessAt: snapshot.lastOkPassAt ?? undefined };
    }
  }
}

/**
 * The per-server evidence a down server contributes — bounded name, age,
 * reason, and the "last known good" anchor: when the server last answered
 * the health contract (or that it never has — a server down since boot reads
 * differently from one that died). A corrupted instant (a snapshot carrying
 * a present-but-non-date string) DEGRADES THE WORDING — never a throw: this
 * function runs inside the `/health` handler, and a throw there is a non-200
 * answer, the liveness-probe restart the always-200 contract exists to
 * prevent. (Null fields are the loop's own states, not corruption: no
 * unreachable episode, or no answer yet recorded.)
 */
function downSince(s: JobsReachabilityServerState, nowMs: number): string {
  const reason = s.reason ?? "no_answer";
  const sinceMs = s.unreachableSince === null ? null : Date.parse(s.unreachableSince);
  const lastAnsweredMs = s.lastReachableAt === null ? null : Date.parse(s.lastReachableAt);
  if (sinceMs === null || Number.isNaN(sinceMs)) {
    return `${s.server} (${reason})`;
  }
  const ageSeconds = Math.max(0, Math.round((nowMs - sinceMs) / 1000));
  const anchor =
    lastAnsweredMs === null
      ? "never answered"
      : Number.isNaN(lastAnsweredMs)
        ? "an unreadable last-answered instant"
        : `last answered ${new Date(lastAnsweredMs).toISOString()}`;
  return `${s.server} (${reason}, ${ageSeconds}s, ${anchor})`;
}
