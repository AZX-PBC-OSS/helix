import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  context,
  defaultTextMapGetter,
  propagation,
  ROOT_CONTEXT,
  trace,
} from "@opentelemetry/api";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";
import { propagatorFor } from "@azx-pbc/telemetry";
import { REQUEST_HEADER_SAFELIST } from "@azx-pbc/shared";
import { withRootSpan } from "./telemetry.js";

/**
 * ADR-0037 decision 7, end to end: propagation runs **inward only**.
 *
 * The edge starts a fresh root for every app-user request and never continues
 * the caller's trace; it injects outward on the edge → egress hop, where the
 * request's authority already comes from the signed attested instruction, and
 * egress extracts there and only there.
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

const APP_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const APP_SPAN_ID = "00f067aa0ba902b7";
const APP_TRACEPARENT = `00-${APP_TRACE_ID}-${APP_SPAN_ID}-01`;

describe("an app-user request never joins the caller's trace", () => {
  it("starts a fresh root even when a valid traceparent is supplied", async () => {
    // Simulate the inbound side as the edge is configured: an inject-only
    // propagator installed globally, then a handler span.
    propagation.setGlobalPropagator(propagatorFor("inject-only"));
    const inbound = propagation.extract(
      ROOT_CONTEXT,
      { traceparent: APP_TRACEPARENT, tracestate: "vendor=app-chosen" },
      defaultTextMapGetter,
    );

    await context.with(inbound, () => withRootSpan("helix.gateway.fetch", {}, async () => {}));

    const span = recording.spans()[0];
    expect(span?.spanContext().traceId).not.toBe(APP_TRACE_ID);
    expect(span?.parentSpanContext).toBeUndefined();
  });

  it("records nothing from the app's trace headers", async () => {
    propagation.setGlobalPropagator(propagatorFor("inject-only"));
    await withRootSpan("helix.gateway.fetch", {}, async () => {});

    // Project before serialising: a ReadableSpan holds a back-reference to its
    // processor and exporter, so it is circular.
    const dump = JSON.stringify(
      recording.spans().map((sp) => ({ ...sp.attributes, ...sp.spanContext() })),
    );
    expect(dump).not.toContain(APP_TRACE_ID);
    expect(dump).not.toContain("vendor=app-chosen");
  });
});

describe("the edge → egress hop is one trace", () => {
  it("injects the edge's own trace id, and egress adopts it as the parent", async () => {
    propagation.setGlobalPropagator(propagatorFor("inject-only"));

    // Edge side: a root span, then inject as `HttpEgressProvider.proxy` does.
    const carrier: Record<string, string> = {};
    let edgeTraceId = "";
    let edgeSpanId = "";
    await withRootSpan("helix.gateway.fetch", {}, async () => {
      const active = trace.getActiveSpan()!.spanContext();
      edgeTraceId = active.traceId;
      edgeSpanId = active.spanId;
      propagation.inject(context.active(), carrier);
    });

    expect(carrier.traceparent).toContain(edgeTraceId);

    // Egress side: `full` propagation, so the header becomes the parent.
    const extracted = propagatorFor("full").extract(ROOT_CONTEXT, carrier, defaultTextMapGetter);
    const parent = trace.getSpanContext(extracted);
    expect(parent?.traceId).toBe(edgeTraceId);
    expect(parent?.spanId).toBe(edgeSpanId);
  });

  it("never forwards traceparent to a third-party upstream", async () => {
    // Egress's `safeRequestHeaders` forwards only this list. `traceparent` is a
    // platform correlation value and is nobody else's business — one word away
    // from regressing.
    expect(REQUEST_HEADER_SAFELIST).not.toContain("traceparent");
    expect(REQUEST_HEADER_SAFELIST).not.toContain("tracestate");
  });
});
