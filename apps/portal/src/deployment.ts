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

import { CONNECTIONS_CALLBACK_PATH } from "@azx-pbc/shared";

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
 * The fixed OAuth callback URL an administrator registers with the vendor:
 * `auth.<APP_PUBLIC_BASE host>` + {@link CONNECTIONS_CALLBACK_PATH} — the
 * reserved-subdomain convention the edge's host classifier routes to the auth
 * host (apps/edge/src/routing/hosts.ts, `classifyHost`). The edge's
 * `/connections/*` reverse proxy forwards that prefix to this portal, and the
 * shared constant is the single source both planes read (the keep-in-sync
 * convention REGISTRY_CHANNEL sets, sourced in @azx-pbc/shared).
 *
 * Derived, never configured: the edge owns the auth base as a single source,
 * and a second auth-base config field here could drift from it. Served at
 * runtime through the providers
 * payload, never a build-time variable.
 */
export function connectionsCallbackUrl(env: NodeJS.ProcessEnv = process.env): string {
  const base = resolveAppPublicBase(env);
  return `${base.protocol}//auth.${base.host}${CONNECTIONS_CALLBACK_PATH}`;
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
 * Internal base URL of helix-egress (`PORTAL_EGRESS_URL`), or null when it is
 * not configured — the same opt-in posture as the edge's `EDGE_EGRESS_URL`.
 * The code-exchange delegation (the callback
 * delegates the vendor token exchange to the mechanism plane) rides this base;
 * null leaves the delegation unwired and the consuming route refuses rather
 * than degrades — a plausible-but-wrong URL is worse than a clear absence.
 */
export function resolveEgressBaseUrl(env: NodeJS.ProcessEnv = process.env): URL | null {
  const raw = env.PORTAL_EGRESS_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    throw new Error(`PORTAL_EGRESS_URL is not a valid absolute URL: ${raw}`);
  }
}

/**
 * This portal's public origin, the exact `aud` the CI deploy route accepts
 * (ADR-0051 decision 4): `PORTAL_PUBLIC_ORIGIN` when set, otherwise
 * `https://portal.<APP_PUBLIC_BASE host>`, the hostname the Bicep binds for the
 * portal. Never derived from the request's `Host` header: a value the caller
 * controls cannot decide which audience the caller's token must carry.
 */
export function resolvePortalPublicOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PORTAL_PUBLIC_ORIGIN?.trim();
  if (raw) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`PORTAL_PUBLIC_ORIGIN is not a valid absolute URL: ${raw}`);
    }
    if (url.protocol !== "https:" || url.origin !== raw.replace(/\/$/, "")) {
      throw new Error(`PORTAL_PUBLIC_ORIGIN must be an https origin with no path: ${raw}`);
    }
    return url.origin;
  }
  const base = resolveAppPublicBase(env);
  return `https://portal.${base.host}`;
}

/** GitHub's Actions OIDC issuer; GitHub Enterprise Cloud tenants can customize it. */
const DEFAULT_GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const DEFAULT_GITHUB_SERVER_URL = "https://github.com";

export interface RepoDeployConfig {
  /** `PORTAL_REPO_DEPLOY_ENABLED`; default on. Off answers 404 on the CI and binding routes. */
  enabled: boolean;
  /** `PORTAL_GITHUB_OIDC_ISSUER`, https only, no trailing slash. */
  issuer: string;
  /** {@link resolvePortalPublicOrigin}. */
  audience: string;
  /** `PORTAL_GITHUB_SERVER_URL`: the web origin commit and run links point at. */
  serverUrl: string;
}

function httpsOrigin(name: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid absolute URL: ${raw}`);
  }
  if (url.protocol !== "https:") throw new Error(`${name} must be https: ${raw}`);
  return raw.replace(/\/+$/, "");
}

/** Repo-backed deploy settings (ADR-0051). */
export function resolveRepoDeployConfig(env: NodeJS.ProcessEnv = process.env): RepoDeployConfig {
  const flag = env.PORTAL_REPO_DEPLOY_ENABLED?.trim();
  if (flag && flag !== "true" && flag !== "false") {
    throw new Error(`PORTAL_REPO_DEPLOY_ENABLED must be true or false (got ${flag})`);
  }
  return {
    enabled: flag !== "false",
    issuer: httpsOrigin(
      "PORTAL_GITHUB_OIDC_ISSUER",
      env.PORTAL_GITHUB_OIDC_ISSUER?.trim() || DEFAULT_GITHUB_OIDC_ISSUER,
    ),
    audience: resolvePortalPublicOrigin(env),
    serverUrl: httpsOrigin(
      "PORTAL_GITHUB_SERVER_URL",
      env.PORTAL_GITHUB_SERVER_URL?.trim() || DEFAULT_GITHUB_SERVER_URL,
    ),
  };
}

/**
 * Validate the deployment config at boot so a bad value is a startup error, not
 * a per-request surprise. Called from `buildApp`; the resolvers themselves stay
 * lazy so tests can override env per case.
 */
export function assertDeploymentConfig(env: NodeJS.ProcessEnv = process.env): void {
  resolveAppPublicBase(env);
  resolveDevApiBase(env);
  resolveEgressBaseUrl(env);
  resolveRepoDeployConfig(env);
}
