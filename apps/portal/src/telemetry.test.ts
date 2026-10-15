import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";
import { inChildSpan } from "./telemetry.js";

/**
 * The shared child-span helper's observable contract (one emitter: the
 * lifecycle outbox and every deploy phase span come from here). Asserted
 * against recorded spans, the same surface an operator's span search reads —
 * the value must pass through untouched, and a failure must grade the span
 * ERROR and rethrow, never absorb.
 *
 * One recording for the whole file (packages/telemetry's testing module:
 * module-level ProxyTracers cache their first provider, so re-registering
 * mid-file silently records nowhere); `reset()` between tests restores
 * isolation instead.
 */
let recording: RecordingTelemetry;

beforeAll(() => {
  recording = startRecordingTelemetry();
});

afterEach(() => {
  recording.reset();
});

afterAll(async () => {
  await recording.restore();
});

describe("inChildSpan", () => {
  it("passes the value through, attaching the attributes, and ends the span ungraded", async () => {
    const value = await inChildSpan("test.child.ok", async () => 42, {
      "test.attr": "known-before",
    });
    expect(value).toBe(42);

    const spans = recording.spans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("test.child.ok");
    expect(spans[0]?.attributes["test.attr"]).toBe("known-before");
    // INTERNAL — a sub-step, not an entry point (the difference from withSpan).
    expect(spans[0]?.kind).toBe(SpanKind.INTERNAL);
    expect(spans[0]?.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("attributes may be omitted — the span still opens and ends", async () => {
    const value = await inChildSpan("test.child.bare", async () => "done");
    expect(value).toBe("done");
    const spans = recording.spans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("test.child.bare");
    expect(spans[0]?.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("grades the span ERROR and records the exception when the step throws, then rethrows", async () => {
    await expect(
      inChildSpan("test.child.fail", async () => {
        throw new Error("intent write failed");
      }),
    ).rejects.toThrow("intent write failed");

    const spans = recording.spans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.status.code).toBe(SpanStatusCode.ERROR);
    // The failure carries its cause on the span — what a span search for a 5xx
    // reads to say which step failed and why.
    const exception = spans[0]?.events.find((e) => e.name === "exception");
    expect(exception).toBeDefined();
    expect(exception?.attributes?.["exception.message"]).toBe("intent write failed");
  });

  it("records a non-Error throw as an Error exception carrying its stringified value", async () => {
    await expect(
      inChildSpan("test.child.nonerror", async () => {
        throw "driver exploded"; // some drivers throw strings, not Errors
      }),
    ).rejects.toBe("driver exploded");

    const exception = recording.spans()[0]?.events.find((e) => e.name === "exception");
    expect(exception?.attributes?.["exception.type"]).toBe("Error");
    expect(exception?.attributes?.["exception.message"]).toBe("driver exploded");
  });
});
