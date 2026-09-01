import {
  ROOT_CONTEXT,
  defaultTextMapGetter,
  defaultTextMapSetter,
  trace,
} from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { defaultPropagator, injectOnly, propagatorFor } from "./propagation.js";

/**
 * ADR-0037 decision 7, as an assertion rather than an absence. These run
 * against the real W3C propagators — the point is that a well-formed,
 * perfectly valid `traceparent` is ignored, not that a malformed one is.
 */

/** A syntactically valid W3C traceparent, sampled. */
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";
const TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`;

describe("injectOnly", () => {
  it("ignores a valid inbound traceparent", () => {
    const carrier = { traceparent: TRACEPARENT, tracestate: "vendor=opaque" };
    const extracted = injectOnly(defaultPropagator()).extract(
      ROOT_CONTEXT,
      carrier,
      defaultTextMapGetter,
    );
    expect(trace.getSpanContext(extracted)).toBeUndefined();
  });

  it("returns the SAME context object, so an ignored header is indistinguishable from none", () => {
    const carrier = { traceparent: TRACEPARENT };
    expect(
      injectOnly(defaultPropagator()).extract(ROOT_CONTEXT, carrier, defaultTextMapGetter),
    ).toBe(ROOT_CONTEXT);
  });

  it("still injects outward — inject-only is a direction, not an off switch", () => {
    const context = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: 1,
    });
    const carrier: Record<string, string> = {};
    injectOnly(defaultPropagator()).inject(context, carrier, defaultTextMapSetter);
    expect(carrier.traceparent).toBe(TRACEPARENT);
  });

  it("reports the same fields as the propagator it wraps", () => {
    // `fields()` is what a caller uses to clear stale keys off a carrier before
    // injecting; under-reporting would leave someone else's traceparent behind.
    expect(injectOnly(defaultPropagator()).fields()).toEqual(defaultPropagator().fields());
  });

  it("keeps baggage propagating, which is why the default is reconstructed not replaced", () => {
    // If `inject-only` had been implemented as "install a bare trace-context
    // propagator", baggage would have silently stopped propagating alongside it.
    expect(defaultPropagator().fields()).toContain("baggage");
  });
});

describe("propagatorFor", () => {
  it("extracts under `full` — the egress case", () => {
    const carrier = { traceparent: TRACEPARENT };
    const extracted = propagatorFor("full").extract(ROOT_CONTEXT, carrier, defaultTextMapGetter);
    expect(trace.getSpanContext(extracted)?.traceId).toBe(TRACE_ID);
  });

  it("does not extract under `inject-only` — every other service", () => {
    const carrier = { traceparent: TRACEPARENT };
    const extracted = propagatorFor("inject-only").extract(
      ROOT_CONTEXT,
      carrier,
      defaultTextMapGetter,
    );
    expect(trace.getSpanContext(extracted)).toBeUndefined();
  });
});
