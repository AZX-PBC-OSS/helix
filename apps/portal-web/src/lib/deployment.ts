import { useQuery } from "@tanstack/react-query";
import type { App } from "@azx-pbc/shared";
import { deploymentConfigQuery } from "../api/queries";

/** Just enough of an app to locate it: the server URL, or the slug to compose one. */
type Locatable = Pick<App, "slug"> & Partial<Pick<App, "url">>;

export interface Deployment {
  /** An app's host for display, preferring the server-computed `url`. */
  hostFor: (app: Locatable) => string | null;
  /** An app's URL for an href, preferring the server-computed `url`. */
  urlFor: (app: Locatable) => string | null;
  /** `<slug>.<apps host>` for a slug with no app behind it yet (previews). */
  appHost: (slug: string) => string | null;
  /** `https://<slug>.<apps host>` for a slug with no app behind it yet. */
  appUrl: (slug: string) => string | null;
  /** The dev-gateway prefix an app points its `/_api/*` calls at. */
  devApiBaseUrl: (slug: string) => string | null;
  /** False when the opt-in dev gateway isn't deployed here. */
  devModeAvailable: boolean;
  /** Bare apps host, no slug — for prose that talks about `<slug>.<host>` generically. */
  appsHost: string | null;
  /** Bare dev-gateway base, no slug — same, for documentation-shaped surfaces. */
  devApiBase: string | null;
  /** Display-only monthly spend watch line, or null for no ceiling. */
  platformMonthlyUsdCap: number | null;
  /** Deploy size caps in MB — null only while the config query is in flight. */
  deployMaxFileMb: number | null;
  deployMaxBundleMb: number | null;
}

/**
 * This deployment's topology, from `GET /api/v1/config` at runtime.
 *
 * The SPA ships as a prebuilt bundle baked into the portal image, so anything
 * domain-shaped it burned in at build time was wrong everywhere but the machine
 * it was built on — it showed `*.local.helix.azxlabs.io:8080` in production.
 * Nothing here is derived from `window.location` either: the portal need not be a
 * sibling of the apps domain, and the scheme and port aren't recoverable from it
 * (the edge is :8080 in dev, 443 in prod).
 *
 * Every getter returns `null` while the query is in flight, or when the value is
 * absent from the deployment, so callers degrade rather than render a guess.
 * Prefer `hostFor`/`urlFor` wherever a full app is in hand — they use the URL the
 * control plane computed, which is what will carry per-app custom domains. Call
 * this once per component: the returned functions are safe inside a `.map()`,
 * a hook call would not be.
 */
export function useDeployment(): Deployment {
  const { data } = useQuery(deploymentConfigQuery);
  const appBase = data ? new URL(data.appPublicBase) : null;

  const appHost = (slug: string) => (appBase ? `${slug}.${appBase.host}` : null);
  const appUrl = (slug: string) =>
    appBase ? `${appBase.protocol}//${slug}.${appBase.host}` : null;

  return {
    hostFor: (app) => hostOf(app.url) ?? appHost(app.slug),
    urlFor: (app) => app.url ?? appUrl(app.slug),
    appHost,
    appUrl,
    devApiBaseUrl: (slug) =>
      data?.devApiBase ? `${data.devApiBase.replace(/\/+$/, "")}/${slug}` : null,
    devModeAvailable: Boolean(data?.devApiBase),
    appsHost: appBase?.host ?? null,
    devApiBase: data?.devApiBase ? data.devApiBase.replace(/\/+$/, "") : null,
    platformMonthlyUsdCap: data?.platformMonthlyUsdCap ?? null,
    deployMaxFileMb: data?.deployMaxFileMb ?? null,
    deployMaxBundleMb: data?.deployMaxBundleMb ?? null,
  };
}

/**
 * The host of a server-provided app URL, for display next to the link. Tolerates
 * a missing `url` (an older portal that predates the field) so callers fall back
 * to composing the slug onto the deployment base.
 */
export function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * The origin the portal API is on — the one deployment value this SPA may read
 * off `window.location`, because it is the origin the portal served it from.
 * Contrast everything above: apps live on a *different* domain whose scheme and
 * port aren't recoverable from the portal's URL, which is why that has to come
 * from `GET /api/v1/config`.
 *
 * Kept as a named function so the two surfaces that hand out `helix` commands
 * (`modals/HelpModal.tsx`, `modals/DeployModal.tsx`) can't quietly diverge, and
 * so it's clear this is not the apps host. It matters because the CLI's built-in
 * portal URL is `http://localhost:3001` (`packages/cli/src/config.ts`) — any
 * instruction that omits it works only against a local dev portal.
 */
export function portalOrigin(): string {
  return window.location.origin;
}
