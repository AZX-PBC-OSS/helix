import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
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
import { SPAN_CONNECTIONS_PROXY, SPAN_CONSENT_START } from "@azx-pbc/shared/telemetry";
import { withRootSpan } from "./telemetry.js";
import { buildApp } from "./app.js";
import { testAuthConfig, testEdgeConfig } from "./test/config.js";
import {
  FakeBlobReader,
  FakeOidcClient,
  FakePortalProvider,
  FakeRegistry,
  FakeSessionStore,
  registryEntry,
} from "./test/fakes.js";

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

describe("the /connections/* proxy route is a fresh root too (T-0015)", () => {
  /**
   * Driven through the real route: the callback URL is where a vendor's
   * redirect lands, so an inbound `traceparent` on it is exactly as
   * untrustworthy as on any app host — the proxy's root span must not adopt
   * it, and the portal-ward hop must inject the edge's own context.
   */
  it("an inbound traceparent never parents the route span", async () => {
    propagation.setGlobalPropagator(propagatorFor("inject-only"));
    const app: FastifyInstance = buildApp({
      config: testEdgeConfig({ auth: testAuthConfig(), internalSecret: Buffer.alloc(32, 7) }),
      registry: new FakeRegistry([
        registryEntry({
          appId: "11111111-1111-4111-8111-111111111111",
          slug: "demo",
          blobPrefix: "apps/a/1/",
        }),
      ]),
      blob: new FakeBlobReader(),
      sessions: new FakeSessionStore(),
      oidc: new FakeOidcClient(),
      portal: new FakePortalProvider(),
    });
    const res = await app.inject({
      method: "GET",
      url: "/connections/callback?code=x&state=y",
      headers: {
        host: "auth.local.helix.azxlabs.io",
        traceparent: APP_TRACEPARENT,
        tracestate: "vendor=app-chosen",
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();

    const span = recording.spans().find((sp) => sp.name === SPAN_CONNECTIONS_PROXY);
    expect(span).toBeDefined();
    expect(span?.spanContext().traceId).not.toBe(APP_TRACE_ID);
    expect(span?.parentSpanContext).toBeUndefined();
  });
});

describe("the consent start route is a fresh root too (T-0014)", () => {
  /**
   * The start route is a plain app-host navigation — an untrusted opener can
   * plant a `traceparent` on it as easily as on a gateway call, and the route
   * must open its own trace regardless.
   */
  it("an inbound traceparent never parents the route span", async () => {
    propagation.setGlobalPropagator(propagatorFor("inject-only"));
    const app: FastifyInstance = buildApp({
      config: testEdgeConfig({ auth: testAuthConfig(), internalSecret: Buffer.alloc(32, 7) }),
      registry: new FakeRegistry([
        registryEntry({
          appId: "22222222-2222-4222-8222-222222222222",
          slug: "demo",
          blobPrefix: "apps/a/1/",
        }),
      ]),
      blob: new FakeBlobReader(),
      sessions: new FakeSessionStore(),
      oidc: new FakeOidcClient(),
      portal: new FakePortalProvider(),
    });
    const res = await app.inject({
      method: "GET",
      url: "/_api/connections/asana/start?attempt=x",
      headers: {
        host: "demo.local.helix.azxlabs.io",
        traceparent: APP_TRACEPARENT,
        tracestate: "vendor=app-chosen",
      },
    });
    // The navigation guard refuses this one (no same-origin headers beyond the
    // trace headers) — the span fires anyway, and that is the span under test.
    expect(res.statusCode).toBe(403);
    await app.close();

    const span = recording.spans().find((sp) => sp.name === SPAN_CONSENT_START);
    expect(span).toBeDefined();
    expect(span?.spanContext().traceId).not.toBe(APP_TRACE_ID);
    expect(span?.parentSpanContext).toBeUndefined();
    // And nothing from the app's trace headers lands anywhere.
    const dump = JSON.stringify(
      recording.spans().map((sp) => ({ ...sp.attributes, ...sp.spanContext() })),
    );
    expect(dump).not.toContain(APP_TRACE_ID);
    expect(dump).not.toContain("vendor=app-chosen");
  });
});
