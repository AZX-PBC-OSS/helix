import { z } from "zod";

/**
 * `GET /api/v1/config` (public): the deployment's topology, as the browser needs
 * to see it. The portal SPA is served as a prebuilt bundle baked into the portal
 * image, so anything domain-shaped it burns in at build time is wrong in every
 * deployment but the one it was built for — it reads these at runtime instead,
 * and its only build-time configuration is the portal origin it is served from.
 *
 * Deliberately separate from `GET /api/v1/auth/config`, which 404s when no IdP
 * is configured (a dev-token-only portal) — that would leave the SPA with no
 * base at all. This endpoint always answers.
 *
 * Optional fields mean "not enabled on this deployment", the same convention as
 * `allowPublicApps` on {@link AuthConfigResponseSchema} — clients hide the
 * corresponding surface rather than inventing a value.
 */
export const DeploymentConfigResponseSchema = z.object({
  /**
   * Scheme + host + (non-default) port where apps are served, as reachable by
   * this browser (architecture §4.1). The app slug is prepended as a subdomain:
   * `https://<slug>.<host>`.
   */
  appPublicBase: z.url(),
  /**
   * Base of the opt-in dev gateway (dev-mode design §3), absent when it is not
   * deployed. Unlike {@link appPublicBase} the slug goes in the *path*, not the
   * host. Absent ⇒ dev mode is unavailable here, so the UI says so instead of
   * printing an unreachable host.
   */
  devApiBase: z.url().optional(),
  /**
   * Month-to-date platform spend ceiling (USD) for the admin budget watch line.
   * Display-only — the gateway is the choke point, so the rollup is exact, but
   * nothing enforces this. Absent ⇒ no ceiling shown.
   */
  platformMonthlyUsdCap: z.number().positive().optional(),
  /**
   * Deploy bundle size caps in megabytes (`DEPLOY_MAX_FILE_MB` /
   * `DEPLOY_MAX_BUNDLE_MB` on the portal) — `deployMaxFileMb` is per file,
   * `deployMaxBundleMb` the whole-archive total. A current portal always sends
   * both; optional only to tolerate one that predates the fields, same as `url`
   * on {@link AppSchema}. Absent means "don't state a number" — a client must not
   * substitute a default, because printing the wrong cap to an agent sends it
   * chasing a rejection it can't see the cause of.
   */
  deployMaxFileMb: z.number().positive().optional(),
  deployMaxBundleMb: z.number().positive().optional(),
});
export type DeploymentConfigResponse = z.infer<typeof DeploymentConfigResponseSchema>;
