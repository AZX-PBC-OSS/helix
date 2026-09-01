import { afterEach, describe, expect, it } from "vitest";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";
import { INSTR_GATEWAY_CALLS, INSTR_GATEWAY_DURATION } from "@azx-pbc/shared/telemetry";
import { instruments, tracer } from "./telemetry.js";

/**
 * What this file exists for is the *ordering* property, not the instrument
 * list. `metrics.getMeter()` has no proxy: it resolves against whatever
 * provider is global at call time, and with nothing registered that is a
 * permanently-inert noop meter. ES imports are hoisted, so `server.ts`'s
 * `import { buildApp } from "./app.js"` evaluates this module *before* the
 * `startTelemetry()` call on the next line runs.
 *
 * A module-level `const meter = metrics.getMeter(…)` therefore produces a build
 * where every metric silently vanishes in production and every test passes —
 * tests register a provider before they assert, so they never reproduce the
 * production ordering. These cases reproduce it deliberately.
 */

let recording: RecordingTelemetry | null = null;

afterEach(async () => {
  await recording?.restore();
  recording = null;
});

describe("the edge instruments", () => {
  it("records against a provider registered AFTER this module was evaluated", async () => {
    // The import at the top of this file already ran, with no provider global —
    // exactly the production ordering. Registering now must still work.
    recording = startRecordingTelemetry();

    instruments().gatewayCalls.add(1, { "helix.capability": "llm" });

    const points = await recording.metrics();
    const call = points.find((p) => p.name === INSTR_GATEWAY_CALLS);
    expect(call, "the counter bound to the noop provider at import time").toBeDefined();
    expect(call?.value).toBe(1);
  });

  it("rebuilds when the provider changes, so one test cannot poison the next", async () => {
    recording = startRecordingTelemetry();
    const first = instruments();
    instruments().gatewayCalls.add(1);
    await recording.restore();

    recording = startRecordingTelemetry();
    const second = instruments();
    // A plain module-level singleton would return the same objects here, still
    // wired to the torn-down provider, and the assertion below would read zero.
    expect(second).not.toBe(first);

    instruments().gatewayCalls.add(1);
    const points = await recording.metrics();
    expect(points.find((p) => p.name === INSTR_GATEWAY_CALLS)?.value).toBe(1);
  });

  it("memoizes within one provider, so instruments are not rebuilt per call", () => {
    recording = startRecordingTelemetry();
    expect(instruments()).toBe(instruments());
  });

  it("gives the duration histogram a bucket range that survives a slow LLM stream", async () => {
    recording = startRecordingTelemetry();
    // 45s: past OTel's 10s default top bucket, which is the reason for the
    // explicit boundaries. What matters is that it lands as a real observation
    // with its value intact, not that it picks any particular bucket.
    instruments().gatewayDuration.record(45_000, { "helix.capability": "llm" });

    const points = await recording.metrics();
    const hist = points.find((p) => p.name === INSTR_GATEWAY_DURATION);
    expect(hist?.value).toBe(1);
    expect(hist?.sum).toBe(45_000);
  });

  it("no-ops rather than throwing when nothing is registered", () => {
    // The platform's default state (ADR-0037 decision 5): no OTLP endpoint, so
    // no provider. Recording must be free and silent — a request path must
    // never take an exception from telemetry.
    //
    // Deliberately not asserting `span.isRecording() === false` here: the
    // module-level `tracer` is a `ProxyTracer`, and once it has resolved a
    // delegate it caches it (`ProxyTracer._getTracer`), so a case earlier in
    // this file leaves it pointed at that provider even after `restore()`.
    // That caching is harmless in production — one provider, registered once —
    // and asserting around it here would only pin OTel's behaviour, not ours.
    expect(() =>
      instruments().sessionGateDenied.add(1, { "helix.reason": "no_session" }),
    ).not.toThrow();
    expect(() => tracer.startSpan("probe").end()).not.toThrow();
  });
});
