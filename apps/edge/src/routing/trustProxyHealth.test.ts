import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";
import { INSTR_TRUST_PROXY_UNRESOLVED } from "@azx-pbc/shared/telemetry";
import { instruments } from "../telemetry.js";
import { buildApp } from "../app.js";
import { FakeBlobReader, FakeRegistry, registryEntry } from "../test/fakes.js";
import { testEdgeConfig } from "../test/config.js";
import {
  TRUST_PROXY_CHECK_NAME,
  TRUST_PROXY_WINDOW,
  TrustProxyObserver,
  trustProxyCheck,
  type TrustProxySample,
} from "./trustProxyHealth.js";

const APP_ID = "11111111-1111-4111-8111-111111111111";

function sample(overrides: Partial<TrustProxySample> = {}): TrustProxySample {
  return { hasForwardedFor: true, ip: "203.0.113.7", remoteAddress: "127.0.0.1", ...overrides };
}

describe("TrustProxyObserver", () => {
  it("counts only forwarded-header requests", () => {
    const observer = new TrustProxyObserver();
    // Probes, exec curls, local dev, and everything not behind a proxy: no
    // header, never counted — `req.ip === peer` is correct for them.
    observer.record({ hasForwardedFor: false, ip: "127.0.0.1", remoteAddress: "127.0.0.1" });
    observer.record({ hasForwardedFor: false, ip: "10.1.2.3", remoteAddress: "10.1.2.3" });
    expect(observer.snapshot()).toEqual({
      forwardedSeen: 0,
      forwardedResolved: 0,
      windowSeen: 0,
      windowResolved: 0,
    });
  });

  it("counts a sample as resolved when the walk moved past the peer", () => {
    const observer = new TrustProxyObserver();
    observer.record(sample());
    expect(observer.snapshot()).toEqual({
      forwardedSeen: 1,
      forwardedResolved: 1,
      windowSeen: 1,
      windowResolved: 1,
    });
    // Same address on both sides — the proxied traffic the config refuses to
    // believe XFF for.
    observer.record(sample({ ip: "100.100.1.0", remoteAddress: "100.100.1.0" }));
    expect(observer.snapshot()).toEqual({
      forwardedSeen: 2,
      forwardedResolved: 1,
      windowSeen: 2,
      windowResolved: 1,
    });
  });

  it("treats a missing ip or peer as unresolved, never a throw", () => {
    const observer = new TrustProxyObserver();
    observer.record(sample({ ip: undefined }));
    observer.record(sample({ remoteAddress: undefined }));
    expect(observer.snapshot()).toEqual({
      forwardedSeen: 2,
      forwardedResolved: 0,
      windowSeen: 2,
      windowResolved: 0,
    });
  });

  it("evicts resolved samples once the ring fills, so the check can go bad again", () => {
    const observer = new TrustProxyObserver(3);
    for (let i = 0; i < 3; i++) observer.record(sample()); // window fully resolved
    expect(observer.snapshot()).toMatchObject({ windowSeen: 3, windowResolved: 3 });
    // The Azure-moves-the-range case: the walk stops resolving under a live
    // replica, and three unresolved samples push every resolved one out.
    for (let i = 0; i < 3; i++) {
      observer.record(sample({ ip: "100.100.1.0", remoteAddress: "100.100.1.0" }));
    }
    expect(observer.snapshot()).toEqual({
      forwardedSeen: 6,
      forwardedResolved: 3,
      windowSeen: 3,
      windowResolved: 0,
    });
  });

  it("caps windowSeen at the window size while cumulative counters keep climbing", () => {
    const observer = new TrustProxyObserver(2);
    for (let i = 0; i < 5; i++) observer.record(sample());
    expect(observer.snapshot()).toEqual({
      forwardedSeen: 5,
      forwardedResolved: 5,
      windowSeen: 2,
      windowResolved: 2,
    });
  });
});

describe("trustProxyCheck", () => {
  it("is ok below the window, saying how far off it is", () => {
    const check = trustProxyCheck(
      { forwardedSeen: 4, forwardedResolved: 0, windowSeen: 4, windowResolved: 0 },
      TRUST_PROXY_WINDOW,
    );
    expect(check).toEqual({
      name: TRUST_PROXY_CHECK_NAME,
      status: "ok",
      detail: `not enough proxied traffic yet (4/${TRUST_PROXY_WINDOW})`,
      metrics: {
        forwardedSeen: 4,
        forwardedResolved: 0,
        windowSeen: 4,
        windowResolved: 0,
      },
    });
  });

  it("degrades at the window with zero resolved, naming the knob", () => {
    const check = trustProxyCheck(
      { forwardedSeen: 50, forwardedResolved: 0, windowSeen: 50, windowResolved: 0 },
      TRUST_PROXY_WINDOW,
    );
    expect(check.status).toBe("degraded");
    expect(check.detail).toContain("EDGE_TRUST_PROXY");
    expect(check.detail).toContain("issue #13");
  });

  it("is ok with no detail once a single sample resolved", () => {
    const check = trustProxyCheck(
      { forwardedSeen: 50, forwardedResolved: 1, windowSeen: 50, windowResolved: 1 },
      TRUST_PROXY_WINDOW,
    );
    expect(check.status).toBe("ok");
    expect(check.detail).toBeUndefined();
  });

  it("honours a custom window for both arms", () => {
    const snap = { forwardedSeen: 2, forwardedResolved: 0, windowSeen: 2, windowResolved: 0 };
    expect(trustProxyCheck(snap, 3).status).toBe("ok");
    expect(trustProxyCheck(snap, 2).status).toBe("degraded");
  });
});

/**
 * The gauge end to end: a fresh recording per case (metric accumulation lives
 * in the provider — see `@azx-pbc/telemetry/testing`'s lifecycle note), one app
 * per recording so the gauge has exactly one callback.
 */
describe("the helix.edge.trust_proxy.unresolved gauge", () => {
  let recording: RecordingTelemetry | null = null;

  afterEach(async () => {
    await recording?.restore();
    recording = null;
  });

  function buildTestApp(trustProxy: boolean | string): FastifyInstance {
    const registry = new FakeRegistry([
      registryEntry({ appId: APP_ID, slug: "demo", blobPrefix: `apps/${APP_ID}/1/` }),
    ]);
    return buildApp({
      config: testEdgeConfig({ trustProxy }),
      registry,
      blob: new FakeBlobReader(),
    });
  }

  const proxyTraffic = (app: FastifyInstance, n: number): Promise<unknown> =>
    Promise.all(
      Array.from({ length: n }, () =>
        app.inject({
          url: "/health",
          headers: { host: "localhost:8080", "x-forwarded-for": "203.0.113.7" },
        }),
      ),
    );

  it("is absent below N, 1 when degraded, 0 when resolved", async () => {
    // Degraded life: trust nothing, so every forwarded request stays on the peer.
    recording = startRecordingTelemetry();
    const broken = buildTestApp(false);
    await broken.ready();

    const gaugePoint = async () =>
      (await recording!.metrics()).find((p) => p.name === INSTR_TRUST_PROXY_UNRESOLVED);

    // A quiet replica reports nothing — health nobody has measured is not a 0.
    await broken.inject({ url: "/health", headers: { host: "localhost:8080" } });
    expect(await gaugePoint()).toBeUndefined();

    await proxyTraffic(broken, TRUST_PROXY_WINDOW);
    expect((await gaugePoint())?.value).toBe(1);
    await broken.close();
  });

  it("reads 0 once the walk resolves on the same traffic", async () => {
    // Inject's loopback peer stands in for the ingress (config.test.ts's
    // `ipFrom` precedent); the CIDR names it, so XFF is believed.
    recording = startRecordingTelemetry();
    const working = buildTestApp("127.0.0.0/8");
    await working.ready();
    await proxyTraffic(working, TRUST_PROXY_WINDOW);
    const points = await recording.metrics();
    expect(points.find((p) => p.name === INSTR_TRUST_PROXY_UNRESOLVED)?.value).toBe(0);
    await working.close();
  });

  it("detaches the gauge callback on close (the listener.ts discipline)", async () => {
    recording = startRecordingTelemetry();
    const app = buildTestApp(false);
    await app.ready();
    // Same provider as buildApp used, so `instruments()` hands back the very
    // gauge the app's callback was attached to.
    const gauge = instruments().trustProxyUnresolved;
    const removeSpy = vi.spyOn(gauge, "removeCallback");
    await app.close();
    expect(removeSpy).toHaveBeenCalledTimes(1);
    // NB the SDK's observable gauges STICK at their last observed value once
    // the callback is gone (collection re-runs, the LastValue aggregation
    // keeps reporting) — so the detach is a lifetime discipline (a callback
    // left attached keeps this app's observer alive on the meter), not a
    // value-freeze. Fresh-provider-per-test above is what keeps that from
    // leaking between cases, exactly as the testing package's lifecycle note
    // says.
  });
});
