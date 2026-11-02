/**
 * Deployment topology: where this install's apps are served, and which optional
 * surfaces are wired up. One source for the values that differ per deployment —
 * mostly not secrets (read by `GET /api/v1/config` so the prebuilt SPA gets
 * them at runtime instead of burning them in at build time, by `toApp()` for
 * the app `url` field, and by the stopgap dashboard's links); the one
 * exception is the jobs lifecycle-delivery config at the bottom, whose
 * per-server signing roots ARE secrets and never leave this module except as
 * derived keys handed to the delivery sender.
 *
 * Resolvers take an injectable `env` and are read per call, not frozen at boot —
 * same shape as `policy/visibilityPolicy.ts`, and it keeps the env-override test
 * style (save/set/restore around an inject) working without rebuilding the app.
 * {@link assertDeploymentConfig} is the boot-time half: `buildApp` calls it so a
 * misconfigured production portal fails to start rather than silently serving
 * dev URLs.
 */

import { z } from "zod";

import {
  CONNECTIONS_CALLBACK_PATH,
  advertisedJobTypes,
  JobsCatalogueServersSchema,
  JobServerIdSchema,
  JobsInternalUrlSchema,
  JobsNonProductionCatalogueServersSchema,
  isValidJobsRootSecret,
  RawInputKeyScreen,
  strictWireObject,
  strictWireRecord,
  type JobTypeCatalogueEntry,
  type JobsCatalogueServers,
} from "@azx-pbc/shared";
import { deriveJobsInstructionKey } from "@azx-pbc/shared/jobsSigning";

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
 * The portal's jobs discovery source (`PORTAL_JOBS_CATALOGUE`): the deployment
 * map's credential-free projection — which servers are configured, their
 * serving/retiring state, and the types each has installed (`JobsCatalogueServers`
 * in `@azx-pbc/shared`). The deployment delivers the portal this projection and
 * never the credentialed map (ADR-0008's custody matrix: the portal holds no
 * jobs endpoint, database URL or signing root), so every jobs fact the portal
 * publishes or enforces — the capability catalogue's `jobs` block and the
 * installed-type addition check — derives from this document alone. Unset or
 * blank is a fully disabled installation (the empty map), the same convention
 * as `DEV_API_PUBLIC_BASE`'s absence.
 *
 * Production parses under the production catalogue schema only, so a catalogue
 * naming a non-production type (`jobs:diagnostic`) fails this parse — and the
 * boot through {@link assertDeploymentConfig}. A non-production stack parses
 * under the catalogue schema that additionally accepts the diagnostic type,
 * which is how an opted-in local stack advertises it.
 */
export function resolveJobsCatalogueServers(
  env: NodeJS.ProcessEnv = process.env,
): JobsCatalogueServers {
  const raw = env.PORTAL_JOBS_CATALOGUE?.trim();
  if (!raw) return { servers: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `PORTAL_JOBS_CATALOGUE is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  // Re-thrown as a plain error on purpose: a misconfigured deployment is a
  // platform failure (500), never a client validation (a raw ZodError would
  // answer the catalogue route 400).
  const verdict =
    env.NODE_ENV === "production"
      ? JobsCatalogueServersSchema.safeParse(parsed)
      : JobsNonProductionCatalogueServersSchema.safeParse(parsed);
  if (!verdict.success) {
    throw new Error(
      `PORTAL_JOBS_CATALOGUE is not a valid jobs catalogue source: ${verdict.error.issues
        .map((issue) => `${issue.path.join(".") || "(document)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return verdict.data;
}

/**
 * The job types this deployment advertises (`GET /api/v1/capabilities` and the
 * installed-type addition write-gate): the catalogue projection's installed
 * types, with the diagnostic type advertised only by a non-production stack —
 * one decision point, so the catalogue route and the write-gate cannot drift
 * about which types are grantable.
 */
export function resolveAdvertisedJobTypes(
  env: NodeJS.ProcessEnv = process.env,
): JobTypeCatalogueEntry[] {
  return advertisedJobTypes(resolveJobsCatalogueServers(env), {
    diagnostics: env.NODE_ENV !== "production",
  });
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
  resolveJobsCatalogueServers(env);
  resolvePortalJobsDeliveryConfig(env);
}

// ── Jobs lifecycle delivery targets ──────────────────────────────────────────

/**
 * One configured lifecycle-delivery target, as the portal's sender consumes
 * it: the server's private internal endpoint (appended to by the sender's
 * routes) and the derived portal→jobs HS256 mint key — HKDF over this
 * server's root at config-load time, so a malformed root is an explicit
 * startup error rather than a first-pass failure. No other direction's root
 * is representable (ADR-0008's custody matrix: the portal holds only
 * portal→jobs roots), and no database URL is either. The server id is the
 * map key — the sender reads it from there, so the record carries nothing
 * twice.
 */
export interface PortalJobsDeliveryTarget {
  /** The server's private internal endpoint, trailing slashes stripped. */
  endpoint: string;
  /** The derived portal→jobs mint key for this server. */
  portalToJobsKey: Uint8Array;
}

/** The portal's resolved lifecycle-delivery configuration, keyed by server id. */
export type PortalJobsDeliveryConfig = ReadonlyMap<string, PortalJobsDeliveryTarget>;

const PortalJobsDeliveryServerSchema = strictWireObject({
  endpoint: JobsInternalUrlSchema,
  portalToJobsRoot: z.string().refine(isValidJobsRootSecret, {
    message: "a signing root must be the canonical base64 encoding of exactly 32 bytes",
  }),
});

/**
 * The portal's permitted subset of the jobs deployment map, as one environment
 * document (`PORTAL_JOBS_CONFIG`) — the shape the edge's `EDGE_JOBS_CONFIG`
 * subset precedent established. Deliberately NOT the shared
 * `JobsDeploymentConfigSchema`: that document carries every server's database
 * URL and every direction's root, and this process's custody is exactly the
 * portal→jobs root it mints lifecycle deliveries with, per server (ADR-0008).
 * Strict fields at every level means handing the portal a full map entry fails
 * the boot naming the leaked field, instead of silently holding credentials it
 * must never read.
 */
const PortalJobsDeliveryDocumentSchema = RawInputKeyScreen.pipe(
  strictWireObject({
    // The strict record, not a plain z.record: a `__proto__` key in the server
    // map is shed by zod's record iteration and refused by this one — the same
    // screen every document of the jobs contract family parses under.
    servers: strictWireRecord(JobServerIdSchema, PortalJobsDeliveryServerSchema),
  }),
);

/**
 * The last parse that can see two roots side by side: roots shared across
 * servers collapse the custody that keeps one server's authority off another
 * (the shared deployment map refuses the same shape; the edge's subset parse
 * holds it for its directions). One walk sees every root in the document.
 */
function assertDistinctDeliveryRoots(servers: Record<string, { portalToJobsRoot: string }>): void {
  const seen = new Map<string, string>();
  for (const [serverId, entry] of Object.entries(servers)) {
    const first = seen.get(entry.portalToJobsRoot);
    if (first !== undefined) {
      throw new Error(
        `PORTAL_JOBS_CONFIG: the portalToJobs root configured for "${serverId}" is the ` +
          `same secret as ${first}'s — each server holds an independently generated root per direction`,
      );
    }
    seen.set(entry.portalToJobsRoot, `${serverId}'s portalToJobs root`);
  }
}

/**
 * Parse the portal's lifecycle-delivery configuration from the environment
 * (`PORTAL_JOBS_CONFIG`). Absent or blank is a fully disabled installation —
 * the sender is never built and the portal reports liveness only, the same
 * convention as `PORTAL_JOBS_CATALOGUE`'s absence. A present document must
 * parse whole: a malformed endpoint, a root that is not a canonical base64
 * 32-byte secret, or a leaked field from the full deployment map (a database
 * URL, another direction's root) is an explicit startup error. Keys derive
 * here, at load — never lazily inside the delivery pass.
 *
 * The catalogue projection (`PORTAL_JOBS_CATALOGUE`) and this document are two
 * halves of one deployment map; {@link assertDeliveryTargetsMatch} is the boot
 * check that they name the same server set.
 */
export function resolvePortalJobsDeliveryConfig(
  env: NodeJS.ProcessEnv = process.env,
): PortalJobsDeliveryConfig | null {
  const raw = env.PORTAL_JOBS_CONFIG?.trim();
  if (!raw) return null;
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (err) {
    throw new Error("PORTAL_JOBS_CONFIG must be a JSON object of configured job servers", {
      cause: err,
    });
  }
  // Re-thrown as a plain error on purpose (the resolveJobsCatalogueServers
  // posture): a misconfigured deployment is a platform failure at boot, never
  // a client validation.
  const verdict = PortalJobsDeliveryDocumentSchema.safeParse(document);
  if (!verdict.success) {
    throw new Error(
      `PORTAL_JOBS_CONFIG is not a valid jobs delivery config: ${verdict.error.issues
        .map((issue) => `${issue.path.join(".") || "(document)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  assertDistinctDeliveryRoots(verdict.data.servers);
  // An empty map is the fully disabled posture in document form — the sender
  // is never built and nothing depends on jobs, the same as an absent variable.
  if (Object.keys(verdict.data.servers).length === 0) return null;
  const servers: Record<string, PortalJobsDeliveryTarget> = {};
  for (const [serverId, entry] of Object.entries(verdict.data.servers)) {
    servers[serverId] = {
      endpoint: entry.endpoint.replace(/\/+$/, ""),
      portalToJobsKey: deriveJobsInstructionKey(entry.portalToJobsRoot, "portalToJobs"),
    };
  }
  return new Map(Object.entries(servers));
}

/**
 * The catalogue projection and the delivery config must name the same server
 * set: the catalogue decides which targets a lifecycle transition informs,
 * and a name on one side only is a broken deployment either way — intents
 * written for a server the portal can never deliver to, or delivery
 * credentials for a server nothing will ever inform. The boot fails naming
 * the mismatch, before a backlog that cannot drain can be created. A null
 * delivery config is a fully disabled installation — valid only while the
 * catalogue is empty too.
 */
export function assertDeliveryTargetsMatch(
  catalogue: JobsCatalogueServers,
  delivery: PortalJobsDeliveryConfig | null,
): void {
  const wanted = new Set(Object.keys(catalogue.servers));
  const have = new Set(delivery?.keys() ?? []);
  for (const server of wanted) {
    if (!have.has(server)) {
      throw new Error(
        `PORTAL_JOBS_CONFIG does not configure the lifecycle target "${server}" that ` +
          "PORTAL_JOBS_CATALOGUE names — pending intents would have no delivery path",
      );
    }
  }
  for (const server of have) {
    if (!wanted.has(server)) {
      throw new Error(
        `PORTAL_JOBS_CONFIG configures the lifecycle target "${server}" that ` +
          "PORTAL_JOBS_CATALOGUE does not name — a credential with no reader",
      );
    }
  }
}
