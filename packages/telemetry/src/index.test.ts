import { context, diag, metrics, propagation, trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shutdownTelemetry, startTelemetry } from "./index.js";

/**
 * These three cases matter more than they look: nothing else in the repo would
 * catch a service that silently starts exporting from the test suite — the same
 * gap `loggerOption`'s test-quiet branch exists to close.
 *
 * There is deliberately **no** test that drives `startTelemetry` down its
 * *successful* live path. Doing so would register global providers and start an
 * OTLP exporter inside the suite, which is the exact thing this package exists
 * to prevent. The live path is covered at `resolveTelemetryConfig`, which is why
 * the env resolution is a pure function in its own module.
 *
 * The failure cases at the bottom are the exception, and they honour that rule:
 * construction throws, so nothing is left registered and no exporter ever runs.
 * They exist because a throw out of `startTelemetry` is an uncaught top-level
 * exception in every `server.ts` — the service would not boot.
 */

/** An env that WOULD start telemetry, so each case below turns on one variable. */
const LIVE = {
  NODE_ENV: "production",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid:4318",
} satisfies NodeJS.ProcessEnv;

/**
 * The behavioural half of "inert": if a provider had been registered, spans
 * from the global tracer would record. `enabled` is a claim; this is the fact.
 */
function globalTracerIsUnregistered(): boolean {
  const span = trace.getTracer("telemetry-inertness-probe").startSpan("probe");
  const recording = span.isRecording();
  span.end();
  return !recording;
}

describe("startTelemetry", () => {
  it("is inert under NODE_ENV=test", () => {
    const handle = startTelemetry("helix-edge", { env: { ...LIVE, NODE_ENV: "test" } });
    expect(handle.enabled).toBe(false);
    expect(globalTracerIsUnregistered()).toBe(true);
  });

  it("is inert under OTEL_SDK_DISABLED=1", () => {
    const handle = startTelemetry("helix-portal", { env: { ...LIVE, OTEL_SDK_DISABLED: "1" } });
    expect(handle.enabled).toBe(false);
    expect(globalTracerIsUnregistered()).toBe(true);
  });

  it("is inert when no OTLP endpoint is configured", () => {
    const handle = startTelemetry("helix-egress", { env: { NODE_ENV: "production" } });
    expect(handle.enabled).toBe(false);
    expect(globalTracerIsUnregistered()).toBe(true);
  });

  it("is inert with no options at all — the suite's own ambient env", () => {
    // Belt and braces: the services call `startTelemetry(SERVICE_NAME)` with no
    // second argument, and that call must stay quiet in CI.
    expect(startTelemetry("helix-edge").enabled).toBe(false);
    expect(globalTracerIsUnregistered()).toBe(true);
  });

  it("resolves shutdown on an inert handle without throwing", async () => {
    const handle = startTelemetry("helix-edge", { env: { NODE_ENV: "production" } });
    await expect(handle.shutdown()).resolves.toBeUndefined();
    // Twice, because Fastify's `onClose` can run more than once in tests.
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});

/**
 * `startTelemetry` runs at module scope in every `server.ts`, before the pools
 * and before `buildApp()`. A throw there is an uncaught top-level exception, so
 * a typo in one env var would stop the edge from booting at all — the exact
 * failure ADR-0037 decision 5 forbids ("telemetry that can take the platform
 * down is worse than no telemetry").
 */
describe("startTelemetry, misconfigured", () => {
  afterEach(() => {
    // Belt and braces. `startTelemetry`'s failure path now drops the diag sink
    // and unregisters whatever it installed itself — the assertions below check
    // that — but a *new* failure shape that forgets to must not leak a stderr
    // sink or a stale global into every suite that runs after this file.
    diag.disable();
    trace.disable();
    context.disable();
    propagation.disable();
    metrics.disable();
    vi.restoreAllMocks();
  });

  /** Swallow the warn line so a passing test doesn't print to the suite's stderr. */
  function captureStderr(): { lines: () => string } {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    return { lines: () => spy.mock.calls.map((c) => String(c[0])).join("") };
  }

  /**
   * The diag sink is installed before construction is known to fail, so a
   * failure that leaves it up owns the process's stderr for the life of the
   * process. The API has no "is a logger installed" query, so probe it through
   * the capture already in place: `diag.warn` reaches the sink, and therefore
   * writes, only while one is registered.
   */
  function diagSinkIsUninstalled(stderr: { lines: () => string }): boolean {
    const before = stderr.lines().length;
    diag.warn("post-failure probe");
    return stderr.lines().length === before;
  }

  it("degrades to inert instead of throwing on an unparseable endpoint", () => {
    // `new URL("//collector:4318/v1/traces")` throws with no base, and
    // OTLPTraceExporter validates its URL in the constructor. Not exotic: it is
    // what you get from pasting a host:port with the scheme left off.
    const stderr = captureStderr();
    const handle = startTelemetry("helix-edge", {
      env: { NODE_ENV: "production", OTEL_EXPORTER_OTLP_ENDPOINT: "//collector:4318" },
    });
    expect(handle.enabled).toBe(false);
    expect(globalTracerIsUnregistered()).toBe(true);
    expect(stderr.lines()).toContain("telemetry failed to start");
    expect(diagSinkIsUninstalled(stderr)).toBe(true);
  });

  it("unregisters the tracer provider when only the metrics endpoint is bad", async () => {
    // The metrics exporter is built AFTER `tracerProvider.register()`, so this
    // is the shape that leaves a globally-registered provider with no owner:
    // `current` is never assigned, so `shutdownTelemetry()` could not reach it.
    const stderr = captureStderr();
    const handle = startTelemetry("helix-egress", {
      env: {
        NODE_ENV: "production",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector.invalid:4318/v1/traces",
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "//collector:4318",
      },
    });
    expect(handle.enabled).toBe(false);
    expect(globalTracerIsUnregistered()).toBe(true);
    expect(stderr.lines()).toContain("telemetry failed to start");
    expect(diagSinkIsUninstalled(stderr)).toBe(true);
    // And nothing was memoized, so the next start is not short-circuited.
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });

  it("reports the underlying error, not an empty object", () => {
    // `JSON.stringify(new Error(...))` is `"{}"` — message, stack and cause are
    // all non-enumerable. OTel hands every export failure to `diag.error(msg,
    // error)`, so a sink that stringifies naively explains nothing, forever.
    const stderr = captureStderr();
    startTelemetry("helix-portal", {
      env: { NODE_ENV: "production", OTEL_EXPORTER_OTLP_ENDPOINT: "//collector:4318" },
    });
    expect(stderr.lines()).toContain("Could not parse user-provided export URL");
    expect(stderr.lines()).not.toContain("{}");
  });
});

describe("shutdownTelemetry", () => {
  it("resolves when nothing was ever started", async () => {
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });

  it("resolves after an inert start", async () => {
    startTelemetry("helix-egress", { env: { NODE_ENV: "test" } });
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });
});
