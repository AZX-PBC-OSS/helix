import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { trace } from "@opentelemetry/api";
import { traceContextMixin } from "./correlation.js";
import { startRecordingTelemetry, type RecordingTelemetry } from "./testing.js";

describe("traceContextMixin with no SDK registered", () => {
  it("returns an empty object — the platform's default state", () => {
    // Not `{ trace_id: undefined }`: pino would render the keys with null
    // values on every line of a deployment that has no collector.
    expect(traceContextMixin()).toEqual({});
  });
});

describe("traceContextMixin under a registered provider", () => {
  let recording: RecordingTelemetry;

  beforeAll(() => {
    recording = startRecordingTelemetry();
  });
  afterAll(async () => {
    await recording.restore();
  });

  it("returns the active span's ids in the OTel log data model's spelling", () => {
    const tracer = trace.getTracer("test");
    tracer.startActiveSpan("op", (span) => {
      const fields = traceContextMixin();
      const ctx = span.spanContext();
      // snake_case deliberately, unlike every other field this platform logs:
      // it is what OTel-aware backends key their log-to-trace jump off.
      expect(fields).toEqual({ trace_id: ctx.traceId, span_id: ctx.spanId });
      span.end();
    });
  });

  it("returns nothing outside a span", () => {
    expect(traceContextMixin()).toEqual({});
  });
});
