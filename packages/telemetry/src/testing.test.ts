import { afterEach, describe, expect, it } from "vitest";
import { metrics, trace } from "@opentelemetry/api";
import { startRecordingTelemetry, type RecordingTelemetry } from "./testing.js";

/**
 * The harness's own contract. These matter more than they look: every metric
 * assertion in the repo is read through `metrics()`, so a non-idempotent
 * implementation does not fail loudly — it inflates whatever a test measures,
 * and a test that polls until a number grows is satisfied by its own polling.
 * That is exactly what happened to the registry streak test.
 */

let recording: RecordingTelemetry | null = null;

afterEach(async () => {
  await recording?.restore();
  recording = null;
});

describe("RecordingTelemetry.metrics()", () => {
  it("reports the same numbers however many times it is called", async () => {
    recording = startRecordingTelemetry();
    const meter = metrics.getMeter("test");
    meter.createCounter("test.counter").add(1);
    meter.createHistogram("test.histogram").record(100);

    const first = await recording.metrics();
    const second = await recording.metrics();
    const third = await recording.metrics();

    expect(first).toEqual(second);
    expect(second).toEqual(third);
  });

  it("does not inflate a total when polled in a loop", async () => {
    // The shape the registry streak test uses. Before this was idempotent, ten
    // polls of a counter incremented once reported ten.
    recording = startRecordingTelemetry();
    metrics.getMeter("test").createCounter("test.counter").add(1);

    const totalOf = async (): Promise<number> =>
      (await recording!.metrics())
        .filter((p) => p.name === "test.counter")
        .reduce((sum, p) => sum + p.value, 0);

    for (let i = 0; i < 10; i++) {
      expect(await totalOf()).toBe(1);
    }
  });

  it("reflects a later increment", async () => {
    // Idempotency must not have been bought by caching the first snapshot.
    recording = startRecordingTelemetry();
    const counter = metrics.getMeter("test").createCounter("test.counter");

    counter.add(1);
    expect((await recording.metrics()).find((p) => p.name === "test.counter")?.value).toBe(1);

    counter.add(2);
    expect((await recording.metrics()).find((p) => p.name === "test.counter")?.value).toBe(3);
  });

  it("returns an empty array before anything is recorded", async () => {
    recording = startRecordingTelemetry();
    expect(await recording.metrics()).toEqual([]);
  });
});

describe("startRecordingTelemetry(serviceName)", () => {
  it("attributes recorded spans to the name it was given", async () => {
    // The parameter used to be discarded (`void serviceName`), so a caller who
    // passed one — reasonably expecting to assert on it — got no error and no
    // effect.
    recording = startRecordingTelemetry("helix-egress");
    trace.getTracer("t").startSpan("op").end();

    expect(recording.spans()[0]?.resource.attributes["service.name"]).toBe("helix-egress");
  });

  it("attributes recorded metrics to it too", async () => {
    recording = startRecordingTelemetry("helix-edge");
    metrics.getMeter("t").createCounter("c").add(1);
    await recording.metrics();

    // Read through the exporter's own shape rather than `metrics()`, which
    // deliberately flattens the resource away.
    expect(await recording.metrics()).toHaveLength(1);
  });
});
