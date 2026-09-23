/**
 * The trust-proxy self-report (ADR-0011, 2026-09-23 amendment): turn "did the
 * forwarded walk ever move past the socket peer" into a `/health` sub-check an
 * operator and an alert rule read.
 *
 * The failure it exists for is not a malformed `EDGE_TRUST_PROXY` — the boot
 * guards in `config.ts` (`parseTrustProxy`) and `main.bicep`
 * (`trustProxyIsAddress`) already refuse those. It is the **well-formed value
 * pointed at the wrong network**, which is exactly what shipped on M5: `auto`
 * resolved to the apps subnet, the ACA ingress actually connects from the RFC
 * 6598 range (`100.100.x.x`), so the edge trusted nothing, every `req.ip`
 * collapsed to the Envoy pod, and all three per-IP consumers — the anon
 * limiter, the login throttle, the collection audit hash — bucketed per
 * ingress pod with `/health` green throughout. No config check can catch that
 * (the config was internally consistent); only watching the *behaviour* can.
 *
 * The behaviour, in one question: **did `req.ip` ever differ from
 * `req.socket.remoteAddress` on a request that arrived through a proxy?** Not
 * "is `req.ip` plausible" and not "is it inside the configured CIDR" — both of
 * those pass on the broken config, since the config is the very thing being
 * graded.
 *
 * The denominator is **forwarded requests only** (a non-empty
 * `X-Forwarded-For`). ACA liveness/readiness probes, `containerapp exec` curls
 * and local dev carry no forwarded header, and for them `req.ip === socket
 * peer` is *correct* — counting them would degrade a quiet install for no
 * reason. Anything genuinely not behind a proxy also stays `ok` forever, which
 * is the right answer there too.
 *
 * Windowed, not latched, on purpose. Counting since boot would stay `ok` for
 * the life of the process once one request resolved — enough for a config
 * mistake (a config change is a new revision and a new process), but blind to
 * Azure moving the ingress range *under* a running replica. A ring of the last
 * N forwarded samples re-arms: the walk can stop resolving later and the check
 * goes bad again. Cost is O(1) per request — one counter increment and one
 * ring write — because this sits on the hot path of every hosted app.
 *
 * Known shape this accepts: a client that reaches the edge *directly* (not
 * through the ingress) while sending `X-Forwarded-For` also records unresolved
 * samples. On the deployed topology the container has no public address and is
 * only reachable through the ingress, so forwarded-header traffic that never
 * resolves **is** the anomaly, not noise to filter out.
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
