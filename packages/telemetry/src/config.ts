/**
 * Resolve telemetry configuration without importing SDKs or creating providers,
 * exporters, or timers (ADR-0037 decision 5). Injecting env lets tests cover
 * production configuration even though the test process has NODE_ENV=test.
 */

/** Resolved, ready-to-construct exporter config. Never partially populated. */
export interface TelemetryConfig {
  /** `service.name` resource attribute — each service's own SERVICE_NAME. */
  serviceName: string;
  /** Fully-resolved signal endpoint, passed verbatim to the OTLP exporter. */
  tracesUrl: string;
  /** Fully-resolved signal endpoint, passed verbatim to the OTLP exporter. */
  metricsUrl: string;
}

/**
 * Accept standard OTel true/false values case-insensitively, plus 1 for disabled.
 * Other values leave the SDK enabled, subject to endpoint configuration.
 */
function isDisabled(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * Use a signal-specific endpoint verbatim; append the signal path to a base
 * endpoint. Resolve here so config can detect missing endpoints without
 * constructing an exporter.
 *
 * Override only the URL. The exporter still reads headers, timeout, compression,
 * and certificate settings from env; defaults here would override those values.
 */
function signalUrl(
  base: string | undefined,
  specific: string | undefined,
  path: string,
): string | null {
  const own = specific?.trim();
  if (own) return own;
  const shared = base?.trim();
  if (!shared) return null;
  return `${shared.replace(/\/+$/, "")}${path}`;
}

/**
 * Warn when only one signal has an endpoint; telemetry requires both.
 * Write to stderr because config resolves before Fastify or the OTel logger
 * exists. No endpoints is the default and needs no warning.
 */
function warnAsymmetric(serviceName: string, resolved: "traces" | "metrics"): void {
  process.stderr.write(
    `${JSON.stringify({
      level: "warn",
      service: serviceName,
      event: "otel.config",
      msg: `only the ${resolved} endpoint resolved; telemetry stays off (both signals or neither)`,
    })}\n`,
  );
}

/**
 * Return null in tests, when disabled, or when either endpoint is missing.
 * A base endpoint supplies both signals. If only one resolves, warn before
 * returning null; see warnAsymmetric.
 */
export function resolveTelemetryConfig(
  serviceName: string,
  env: NodeJS.ProcessEnv = process.env,
): TelemetryConfig | null {
  if (env.NODE_ENV === "test") return null;
  if (isDisabled(env.OTEL_SDK_DISABLED)) return null;

  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const tracesUrl = signalUrl(base, env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, "/v1/traces");
  const metricsUrl = signalUrl(base, env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT, "/v1/metrics");
  if (!tracesUrl || !metricsUrl) {
    // One signal resolved and the other did not: that is a typo, not a default.
    if (tracesUrl || metricsUrl) warnAsymmetric(serviceName, tracesUrl ? "traces" : "metrics");
    return null;
  }

  return { serviceName, tracesUrl, metricsUrl };
}
