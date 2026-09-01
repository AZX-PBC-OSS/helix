import { Readable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";
import { withRootSpan } from "./telemetry.js";

/**
 * ADR-0037 decision 5: "Spans over streamed responses end on stream close, not
 * on response headers. […] a span ended at headers records every streamed call
 * at approximately zero milliseconds, which is worse than no metric because it
 * looks like data."
 *
 * The design review expected `return reply.send(stream)` to need special
 * handling — it looks like it resolves the moment the pipe is wired. It does
 * not: Fastify's `Reply` is thenable and resolves when the response finishes,
 * so one `try/finally` helper is correct for both streaming shapes. That is a
 * property of a dependency rather than of our code, so it is pinned here with
 * a deliberately slow body: if a future Fastify resolves `send` early, every
 * streamed span silently collapses to ~0 ms and this is what catches it.
 */

/**
 * ONE recording for the whole file. A second `startRecordingTelemetry()` would
 * record nothing: the module-level tracer in `./telemetry.js` is a `ProxyTracer`
 * that caches its delegate on first use, so it keeps writing into the first
 * provider even after `restore()` shuts it down — silently, with every
 * assertion after the first failing on an empty array. (Found the hard way.)
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

/** A body that takes real time to produce, so a headers-ended span shows ~0. */
function slowStream(chunks: number, gapMs: number): Readable {
  let i = 0;
  return new Readable({
    read() {
      if (i++ >= chunks) {
        this.push(null);
        return;
      }
      setTimeout(() => this.push(`chunk-${i}\n`), gapMs);
    },
  });
}

function durationMs(span: { startTime: [number, number]; endTime: [number, number] }): number {
  const toMs = (t: [number, number]): number => t[0] * 1000 + t[1] / 1e6;
  return toMs(span.endTime) - toMs(span.startTime);
}

const SLOW_MS = 60;

describe("a span over a reply.send(stream) handler", () => {
  it("measures the whole transfer, not the time to wire up the pipe", async () => {
    // This is the case a naive `try/finally` gets wrong: `reply.send(stream)`
    // resolves as soon as the pipe is wired, so the handler's promise settles
    // in ~0ms while the body is still flowing.
    const app: FastifyInstance = Fastify();
    app.get("/proxy", (_req, reply) =>
      withRootSpan("test.streamed", {}, async () => {
        await reply.send(slowStream(6, SLOW_MS / 6));
      }),
    );

    const res = await app.inject({ method: "GET", url: "/proxy" });
    expect(res.statusCode).toBe(200);
    await app.close();

    const spans = recording.spans();
    expect(spans).toHaveLength(1);
    expect(durationMs(spans[0]!)).toBeGreaterThanOrEqual(SLOW_MS * 0.5);
  });

  it("ends the span exactly once", async () => {
    const app: FastifyInstance = Fastify();
    app.get("/proxy", (_req, reply) =>
      withRootSpan("test.streamed", {}, async () => {
        await reply.send(slowStream(3, 5));
      }),
    );
    await app.inject({ method: "GET", url: "/proxy" });
    await app.close();

    expect(recording.spans()).toHaveLength(1);
  });

  it("still ends the span when the handler refuses before sending anything", async () => {
    const app: FastifyInstance = Fastify();
    app.get("/proxy", (_req, reply) =>
      withRootSpan("test.streamed", {}, async () => {
        await reply.code(403).send({ error: "no" });
      }),
    );
    const res = await app.inject({ method: "GET", url: "/proxy" });
    expect(res.statusCode).toBe(403);
    await app.close();

    expect(recording.spans()).toHaveLength(1);
  });

  it("does not leak a span when the handler throws before responding", async () => {
    const app: FastifyInstance = Fastify({ logger: false });
    app.get("/proxy", () =>
      withRootSpan("test.streamed", {}, async () => {
        throw new Error("boom");
      }),
    );
    await app.inject({ method: "GET", url: "/proxy" });
    await app.close();

    const spans = recording.spans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.status.code).toBe(2); // ERROR
    expect(spans[0]?.events.some((e) => e.name === "exception")).toBe(true);
  });
});

describe("a span over an in-handler stream", () => {
  it("measures work the handler awaits itself", async () => {
    await withRootSpan("test.inline", {}, async () => {
      await new Promise((r) => setTimeout(r, SLOW_MS));
    });

    const spans = recording.spans();
    expect(spans).toHaveLength(1);
    expect(durationMs(spans[0]!)).toBeGreaterThanOrEqual(SLOW_MS * 0.5);
  });

  it("records the exception and rethrows", async () => {
    await expect(
      withRootSpan("test.inline", {}, async () => {
        throw new Error("kaboom");
      }),
    ).rejects.toThrow("kaboom");

    expect(recording.spans()[0]?.status.code).toBe(2);
  });
});

describe("withRootSpan starts a ROOT span", () => {
  it("ignores an ambient parent, so an app cannot graft onto a platform trace", async () => {
    // Belt-and-braces over the inject-only propagator: even if something did
    // put a span in the active context, `root: true` refuses it as a parent.
    await withRootSpan("outer", {}, async () => {
      await withRootSpan("inner", {}, async () => {});
    });

    const spans = recording.spans();
    const inner = spans.find((s) => s.name === "inner");
    const outer = spans.find((s) => s.name === "outer");
    expect(inner?.parentSpanContext).toBeUndefined();
    expect(inner?.spanContext().traceId).not.toBe(outer?.spanContext().traceId);
  });
});
