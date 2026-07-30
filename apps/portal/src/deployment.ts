/**
 * Deployment topology: where this install's apps are served, and which optional
 * surfaces are wired up. One source for the values that differ per deployment
 * but are not secrets — read by `GET /api/v1/config` (so the prebuilt SPA gets
 * them at runtime instead of burning them in at build time), by `toApp()` for
 * the app `url` field, and by the stopgap dashboard's links.
 *
 * Resolvers take an injectable `env` and are read per call, not frozen at boot —
 * same shape as `policy/visibilityPolicy.ts`, and it keeps the env-override test
 * style (save/set/restore around an inject) working without rebuilding the app.
 * {@link assertDeploymentConfig} is the boot-time half: `buildApp` calls it so a
 * misconfigured production portal fails to start rather than silently serving
 * dev URLs.
 */

/** The dev edge, as reachable from the host browser: mkcert TLS on :8080. */
const DEV_APP_PUBLIC_BASE = "https://local.helix.azxlabs.io:8080";

/**
 * Scheme + host + port where apps are served, from `APP_PUBLIC_BASE`
 * (architecture §4.1). Required in production — a portal that fell back to the
 * dev default there would hand out unreachable URLs to every client, in the
 * portal UI and in `helix` output alike. Same prod-strict posture as
 * `resolvePortalRuntimeUrl` (db/client.ts).
 */
export function resolveAppPublicBase(env: NodeJS.ProcessEnv = process.env): URL {
  const raw = env.APP_PUBLIC_BASE?.trim();
  if (!raw) {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "APP_PUBLIC_BASE (scheme + host + port where apps are served, e.g. " +
          "https://azx.helix.azxlabs.io) is required in production; refusing the " +
          `dev default ${DEV_APP_PUBLIC_BASE}, which is unreachable outside the dev container.`,
      );
    }
    return new URL(DEV_APP_PUBLIC_BASE);
  }
  try {
    return new URL(raw);
  } catch {
    throw new Error(`APP_PUBLIC_BASE is not a valid absolute URL: ${raw}`);
  }
}

/** `<slug>.<base host>` — the app's host, no scheme. */
export function appPublicHost(slug: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${slug}.${resolveAppPublicBase(env).host}`;
}

/** The app's public URL (`https://<slug>.<base>`). */
export function appPublicUrl(slug: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = resolveAppPublicBase(env);
  return `${base.protocol}//${slug}.${base.host}`;
}

/**
 * Base of the opt-in dev gateway (`DEV_API_PUBLIC_BASE`), or null when it is not
 * deployed. The dev gateway is off by default (`deployDevGateway` in the Bicep),
 * and the deploy sets this to an empty string when it is skipped — so empty is
 * "not enabled", not "misconfigured". Callers surface the absence; nothing
 * invents a host, because a plausible-but-unreachable dev URL is worse than a
 * clear "unavailable".
 */
export function resolveDevApiBase(env: NodeJS.ProcessEnv = process.env): URL | null {
  const raw = env.DEV_API_PUBLIC_BASE?.trim();
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    throw new Error(`DEV_API_PUBLIC_BASE is not a valid absolute URL: ${raw}`);
  }
}

/**
 * Month-to-date platform spend ceiling in USD (`PLATFORM_MONTHLY_USD_CAP`), or
 * null for "no ceiling". Display-only: the admin dashboard draws a watch line
 * against it. `0`, unset, and unparseable all mean no ceiling — this is a
 * cosmetic hint, so it never blocks a boot.
 */
export function resolvePlatformMonthlyUsdCap(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.PLATFORM_MONTHLY_USD_CAP?.trim();
  if (!raw) return null;
  const cap = Number(raw);
  return Number.isFinite(cap) && cap > 0 ? cap : null;
}

/**
 * Validate the deployment config at boot so a bad value is a startup error, not
 * a per-request surprise. Called from `buildApp`; the resolvers themselves stay
 * lazy so tests can override env per case.
 */
export function assertDeploymentConfig(env: NodeJS.ProcessEnv = process.env): void {
  resolveAppPublicBase(env);
  resolveDevApiBase(env);
}
