import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTelemetryConfig } from "./config.js";

/**
 * The env is passed in rather than read from `process.env` precisely so these
 * cases are distinguishable: the whole suite runs under `NODE_ENV=test`, so a
 * resolver reading the ambient env would return `null` here for one reason and
 * the tests would prove nothing about the other two.
 */
const LIVE = {
  NODE_ENV: "production",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
} satisfies NodeJS.ProcessEnv;

describe("resolveTelemetryConfig", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Swallow the warn line so a passing test doesn't print to the suite's stderr. */
  function captureStderr(): { lines: () => string } {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    return { lines: () => spy.mock.calls.map((c) => String(c[0])).join("") };
  }

  it("is null under NODE_ENV=test even with an endpoint configured", () => {
    expect(resolveTelemetryConfig("helix-edge", { ...LIVE, NODE_ENV: "test" })).toBeNull();
  });

  it("is null when OTEL_SDK_DISABLED is set", () => {
    for (const value of ["1", "true", "TRUE", " true "]) {
      expect(
        resolveTelemetryConfig("helix-edge", { ...LIVE, OTEL_SDK_DISABLED: value }),
      ).toBeNull();
    }
  });

  it("stays enabled for the falsey spellings of OTEL_SDK_DISABLED", () => {
    // A kill switch that fires on `OTEL_SDK_DISABLED=0` would be worse than
    // none: an operator setting it that way means "leave it on".
    for (const value of ["0", "false", "", "no"]) {
      expect(
        resolveTelemetryConfig("helix-edge", { ...LIVE, OTEL_SDK_DISABLED: value }),
      ).not.toBeNull();
    }
  });

  it("is null when no OTLP endpoint is configured — the platform's default state", () => {
    expect(resolveTelemetryConfig("helix-edge", { NODE_ENV: "production" })).toBeNull();
  });

  it("appends the signal path to a base endpoint", () => {
    expect(resolveTelemetryConfig("helix-edge", LIVE)).toEqual({
      serviceName: "helix-edge",
      tracesUrl: "http://collector:4318/v1/traces",
      metricsUrl: "http://collector:4318/v1/metrics",
    });
  });

  it("does not double the slash on a base endpoint with a trailing one", () => {
    const config = resolveTelemetryConfig("helix-portal", {
      ...LIVE,
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318//",
    });
    expect(config?.tracesUrl).toBe("http://collector:4318/v1/traces");
    expect(config?.metricsUrl).toBe("http://collector:4318/v1/metrics");
  });

  it("uses a signal-specific endpoint verbatim, per the OTLP spec", () => {
    // Verbatim, NOT suffixed: a signal endpoint already names its own path, and
    // suffixing it would POST traces somewhere that 404s in silence.
    const config = resolveTelemetryConfig("helix-egress", {
      ...LIVE,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector:4318/custom/traces",
    });
    expect(config?.tracesUrl).toBe("http://collector:4318/custom/traces");
    // The base still covers the signal that has no override.
    expect(config?.metricsUrl).toBe("http://collector:4318/v1/metrics");
  });

  it("resolves from signal-specific endpoints alone, with no base", () => {
    expect(
      resolveTelemetryConfig("helix-egress", {
        NODE_ENV: "production",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://a/v1/traces",
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://b/v1/metrics",
      }),
    ).toEqual({
      serviceName: "helix-egress",
      tracesUrl: "http://a/v1/traces",
      metricsUrl: "http://b/v1/metrics",
    });
  });

  it("is null when only one signal resolves — there is no half-on state", () => {
    const stderr = captureStderr();
    expect(
      resolveTelemetryConfig("helix-egress", {
        NODE_ENV: "production",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://a/v1/traces",
      }),
    ).toBeNull();
    // ...and it SAYS so. Returning null here happens before `startTelemetry`
    // installs a diag logger, so without this line an operator who set one
    // endpoint gets a service that boots, reports `/health: ok`, and never
    // exports — with no diagnostic anywhere to tell them why.
    expect(stderr.lines()).toContain('"event":"otel.config"');
    expect(stderr.lines()).toContain("only the traces endpoint resolved");
  });

  it("names the signal that DID resolve, so the missing one is obvious", () => {
    const stderr = captureStderr();
    expect(
      resolveTelemetryConfig("helix-edge", {
        NODE_ENV: "production",
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://b/v1/metrics",
      }),
    ).toBeNull();
    expect(stderr.lines()).toContain("only the metrics endpoint resolved");
  });

  it("stays silent when telemetry is simply unconfigured", () => {
    // The default state of the platform. A warn line here would fire on every
    // boot of every service and train everyone to ignore the channel.
    const stderr = captureStderr();
    expect(resolveTelemetryConfig("helix-portal", { NODE_ENV: "production" })).toBeNull();
    expect(resolveTelemetryConfig("helix-portal", { ...LIVE, NODE_ENV: "test" })).toBeNull();
    expect(resolveTelemetryConfig("helix-portal", { ...LIVE, OTEL_SDK_DISABLED: "1" })).toBeNull();
    expect(stderr.lines()).toBe("");
  });

  it("carries the service name through unchanged", () => {
    // `service.name` is each service's SERVICE_NAME, so it cannot drift from
    // the `/health` `service` field.
    expect(resolveTelemetryConfig("helix-portal", LIVE)?.serviceName).toBe("helix-portal");
  });
});
