/**
 * Env → resolved telemetry config, or `null` for "stay completely inert"
 * (ADR-0037 decision 5).
 *
 * Factored out of {@link ../index.ts} and kept free of every SDK import so the
 * inertness branch is unit-testable without constructing a provider, an
 * exporter or a timer. That is not a stylistic preference: the whole test suite
 * runs under `NODE_ENV=test`, so a test that called `startTelemetry` and
 * asserted "nothing happened" would pass through the test branch and prove
 * nothing about the other two. The env is a parameter for the same reason
 * `loggerOption(env)` takes one — otherwise nothing catches a service that
 * silently starts exporting from the test suite.
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
 * `OTEL_SDK_DISABLED` is a standard OTel env var whose spec defines only
 * `true`/`false` (case-insensitive). We additionally accept `1`, because every
 * other kill switch in a container platform is spelled that way and a disable
 * flag that silently fails to disable is the worst possible failure mode here.
 * Anything else — including `0`, `false` and unset — leaves the SDK enabled.
 */
function isDisabled(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * Per the OTLP exporter spec, a signal-specific endpoint is used **verbatim**
 * (it already names the signal's path), while the base endpoint has the signal
 * path appended. Getting this backwards is silent: the exporter would happily
 * POST traces at the metrics path and log a 404 nobody reads.
 *
 * We resolve it here rather than letting the exporter read the env itself
 * because {@link resolveTelemetryConfig} gates on exactly this fact — whether
 * an endpoint is configured at all — and it has to answer that without
 * constructing an exporter to ask. The URL it produces matches what the
 * exporter's own env path would have derived.
 *
 * Passing `url` overrides **only** the URL, and deliberately so. The exporter's
 * `mergeOtlpHttpConfigurationWithDefaults` layers a code-provided config over
 * the environment field by field, so `OTEL_EXPORTER_OTLP_HEADERS`, `_TIMEOUT`,
 * `_COMPRESSION` and the three certificate vars all still reach it — which is
 * what an operator pointing this at an authenticated collector needs. Resist
 * "finishing the job" by resolving those here too: we have no opinion about
 * them, and a default we invent would shadow the one they set.
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
 * Say out loud that a half-configured endpoint turned telemetry off.
 *
 * Refusing to run half-on is the decision; refusing *silently* was the bug. An
 * operator who sets `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and nothing else — the
 * commonest OTLP setting after the base endpoint, and the one most vendor
 * quickstarts hand you — otherwise gets a service that boots normally, reports
 * `/health: ok`, and never exports a span, with no diagnostic anywhere: this
 * returns `null` and `startTelemetry` returns its inert handle *before* it
 * installs the diag logger, so there is not even a sink to log through.
 *
 * Written straight to stderr in the same shape as `diagSink`'s line, for the
 * same reason: config resolution runs before `buildApp()`, so there is no
 * Fastify logger to borrow. Only the asymmetric case is noisy — telemetry
 * configured nowhere at all is the platform's default state and stays quiet.
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
 * Resolve the telemetry config for a service, or `null` when telemetry must
 * stay off. `null` for any of:
 *
 *  - `NODE_ENV === "test"` — the test-quiet branch, mirroring `loggerOption`.
 *  - `OTEL_SDK_DISABLED` set — the standard kill switch.
 *  - no OTLP endpoint configured — the default state, and the reason running
 *    the platform with no OTel env produces exactly the telemetry it produces
 *    today (none).
 *
 * A partial endpoint config (traces but not metrics, or vice versa) is honoured
 * per signal only when the *other* signal also resolves; a base endpoint covers
 * both. Anything less than both signals resolving is treated as unconfigured,
 * so there is no half-on state to reason about at 3am — but the *asymmetric*
 * case says so on stderr first; see {@link warnAsymmetric}.
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
