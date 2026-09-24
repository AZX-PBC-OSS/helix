/**
 * Reports whether proxy address resolution works (ADR-0011, 2026-09-23).
 * A valid trustProxy setting can still name the wrong network, leaving req.ip
 * at the ingress address and combining users into one rate-limit/audit bucket.
 *
 * Sample requests with non-empty X-Forwarded-For and check whether req.ip differs
 * from the socket peer. Exclude direct probes and local requests without that
 * header, where equality is expected. A ring of the last N samples detects
 * failures that begin after startup; updates cost O(1) per request.
 *
 * Direct clients sending X-Forwarded-For also count as unresolved. In the
 * Azure deployment, the edge is reachable only through ingress, so repeated
 * unresolved forwarded requests indicate a configuration or routing problem.
 */
import type { ObservableResult } from "@opentelemetry/api";
import type { HealthCheck } from "@azx-pbc/shared";
import type { FastifyInstance } from "fastify";
import { instruments } from "../telemetry.js";

/** Stable check name — this is what an alert rule keys on; don't rename lightly. */
export const TRUST_PROXY_CHECK_NAME = "trust-proxy";

/**
 * The ring size: of the last N forwarded requests, at least one must have
 * resolved to the forwarded client for the check to read `ok`. Small enough
 * that a fresh replica reaches it on the availability probes alone (they hit
 * `auth.<domain>/health` through the ingress every few minutes from five
 * regions, `X-Forwarded-For` attached), large enough that one odd request
 * cannot matter.
 */
export const TRUST_PROXY_WINDOW = 50;

/** One observed request, already extracted from the framework. */
export interface TrustProxySample {
  /** A non-empty `X-Forwarded-For` was present — the only thing counted. */
  hasForwardedFor: boolean;
  /** Fastify's derived client address (`req.ip`). */
  ip: string | undefined;
  /** The TCP peer (`req.socket.remoteAddress`). */
  remoteAddress: string | undefined;
}

export interface TrustProxySnapshot {
  /** Forwarded-header requests since boot. */
  forwardedSeen: number;
  /** Of those, how many ever resolved `req.ip` past the peer, since boot. */
  forwardedResolved: number;
  /** Samples currently in the window (≤ the ring size once full). */
  windowSeen: number;
  /** Of the windowed samples, how many resolved. */
  windowResolved: number;
}

/**
 * The runtime counter. Holds no clock and no I/O — the grading below is a pure
 * function of a {@link TrustProxySnapshot}, so the thresholds are
 * table-testable without standing up a server, and `/health` stays a lookup.
 */
export class TrustProxyObserver {
  readonly #window: number;
  readonly #ring: boolean[] = [];
  #forwardedSeen = 0;
  #forwardedResolved = 0;
  #windowSeen = 0;
  #windowResolved = 0;

  constructor(window = TRUST_PROXY_WINDOW) {
    this.#window = window;
  }

  /** Feed one request. O(1): two counters and one ring slot, no allocation. */
  record(sample: TrustProxySample): void {
    if (!sample.hasForwardedFor) return;
    const resolved =
      sample.ip !== undefined &&
      sample.remoteAddress !== undefined &&
      sample.ip !== sample.remoteAddress;
    this.#forwardedSeen += 1;
    if (resolved) this.#forwardedResolved += 1;

    const slot = this.#windowSeen % this.#window;
    if (this.#windowSeen >= this.#window && this.#ring[slot]) {
      // The slot is being evicted: a resolved sample leaving the window is
      // exactly what lets the check go bad again once the ring fills with
      // unresolved ones.
      this.#windowResolved -= 1;
    }
    this.#ring[slot] = resolved;
    this.#windowSeen += 1;
    if (resolved) this.#windowResolved += 1;
  }

  snapshot(): TrustProxySnapshot {
    return {
      forwardedSeen: this.#forwardedSeen,
      forwardedResolved: this.#forwardedResolved,
      windowSeen: Math.min(this.#windowSeen, this.#window),
      windowResolved: this.#windowResolved,
    };
  }
}

/**
 * Grade the walk. Never throws: `/health` must answer even when the config it
 * reasons about is nonsense (same rule as `registryFreshnessCheck`).
 */
export function trustProxyCheck(
  snapshot: TrustProxySnapshot,
  window = TRUST_PROXY_WINDOW,
): HealthCheck {
  const metrics: Record<string, number> = {
    forwardedSeen: snapshot.forwardedSeen,
    forwardedResolved: snapshot.forwardedResolved,
    windowSeen: snapshot.windowSeen,
    windowResolved: snapshot.windowResolved,
  };
  const base = { name: TRUST_PROXY_CHECK_NAME, metrics };

  if (snapshot.windowSeen < window) {
    return {
      ...base,
      status: "ok",
      detail: `not enough proxied traffic yet (${snapshot.windowSeen}/${window})`,
    };
  }
  if (snapshot.windowResolved > 0) {
    return { ...base, status: "ok" };
  }
  return {
    ...base,
    status: "degraded",
    detail:
      `${snapshot.windowSeen} proxied requests and the forwarded client IP was never used — ` +
      "`req.ip` is the proxy peer, so per-IP rate limiting, the login throttle and the " +
      "audit hash have collapsed to one bucket. Check EDGE_TRUST_PROXY against the " +
      "address the ingress actually presents (ADR-0011, issue #13).",
  };
}

/**
 * Wire the counter into a Fastify instance: the `onRequest` hook that feeds it,
 * the `helix.edge.trust_proxy.unresolved` observable gauge (ADR-0037 decision
 * 8), and the `onClose` detach that keeps a closed app from being observed by
 * the next collection (same discipline as the staleness gauge's callback in
 * `registry/listener.ts`).
 *
 * Call it **before routes are registered** — Fastify applies `onRequest` hooks
 * to routes declared after the hook.
 *
 * The gauge is **observable, not pushed at request time**: read at collection,
 * it reports `1` while the window is fully unresolved, `0` while healthy, and
 * **nothing below N** — a gauge reading `0` on a replica that has not seen
 * enough proxied traffic would claim "verified healthy" about a state nobody
 * has measured, the same direction-wrongness the staleness gauge refuses
 * (see `#observeStaleness`). The alert rule keys on the gauge's presence.
 *
 * Returns the observer so the `/health` route can grade
 * `trustProxyCheck(observer.snapshot())` from the same state the hook feeds.
 */
export function wireTrustProxyHealth(app: FastifyInstance): TrustProxyObserver {
  const observer = new TrustProxyObserver();
  app.addHook("onRequest", async (req) => {
    const forwarded = req.headers["x-forwarded-for"];
    observer.record({
      hasForwardedFor:
        forwarded !== undefined &&
        (Array.isArray(forwarded) ? forwarded.length > 0 : forwarded.trim() !== ""),
      ip: req.ip,
      // Present on every real socket; `light-my-request` sets it from inject's
      // `remoteAddress`. Optional access so a weird harness cannot fail a
      // request — the hook must never throw.
      remoteAddress: req.socket?.remoteAddress,
    });
  });

  const gauge = instruments().trustProxyUnresolved;
  const observe = (result: ObservableResult): void => {
    const s = observer.snapshot();
    if (s.windowSeen < TRUST_PROXY_WINDOW) return;
    result.observe(s.windowResolved === 0 ? 1 : 0);
  };
  gauge.addCallback(observe);
  app.addHook("onClose", async () => {
    // Remove from the instance the callback was attached to: `instruments()`
    // may have rebuilt against a different provider since (tests), and a
    // callback left attached would keep this observer alive on the meter.
    gauge.removeCallback(observe);
  });
  return observer;
}
