import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { HealthStatusSchema, worstHealthState } from "@azx-pbc/shared";
import { traceContextMixin } from "@azx-pbc/telemetry/correlation";
import { loggerOption, requestIdOptions } from "@azx-pbc/shared/logging";
import type { PrismaClient } from "./db/client.js";
import type { BlobStore } from "./blob/store.js";
import type { SecretStore } from "@azx-pbc/secret-store";
import type { DirectoryProvider } from "@azx-pbc/directory";
import { prismaPlugin } from "./plugins/prisma.js";
import { blobPlugin } from "./plugins/blob.js";
import { secretStorePlugin } from "./plugins/secretStore.js";
import { errorsPlugin } from "./plugins/errors.js";
import { authPlugin, type AuthPluginOptions } from "./plugins/auth.js";
import { directoryPlugin } from "./plugins/directory.js";
import { visitorsPlugin } from "./plugins/visitors.js";
import type { GeoResolver } from "./geo/resolver.js";
import { assertBundleLimits, resolveMaxTotalBytes } from "./deploy/limits.js";
import { assertInternalJwtSecrets } from "./internalJwt.js";
import { jobsLifecycleDeliveryCheck, type JobsDeliverySnapshot } from "./jobs/delivery.js";
import { appRoutes } from "./routes/apps.js";
import { secretRoutes } from "./routes/secrets.js";
import { providerRoutes } from "./routes/providers.js";
import { devTokenRoutes } from "./routes/devTokens.js";
import { approvalRoutes } from "./routes/approvals.js";
import { cspRoutes } from "./routes/csp.js";
import { versionRoutes } from "./routes/versions.js";
import { ciVersionRoutes, type CiVersionRoutesOptions } from "./routes/ciVersions.js";
import { repoBindingRoutes } from "./routes/repoBinding.js";
import { usageRoutes } from "./routes/usage.js";
import { visitorRoutes } from "./routes/visitors.js";
import { sessionRoutes } from "./routes/sessions.js";
import { dataRoutes } from "./routes/data.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { authRoutes } from "./routes/auth.js";
import { configRoutes } from "./routes/config.js";
import { platformSettingsRoutes } from "./routes/platformSettings.js";
import { catalogueRoutes } from "./routes/catalogue.js";
import { directoryRoutes } from "./routes/directory.js";
import { connectionsInternalRoutes } from "./routes/connectionsInternal.js";
import { connectionsPageRoutes } from "./routes/connectionsPages.js";
import { myConnectionsRoutes } from "./routes/connectionsMine.js";
import { resolveSpaDist, spaRoutes } from "./routes/spa.js";
import { assertDeploymentConfig } from "./deployment.js";
import { SERVICE_NAME } from "./serviceName.js";

/**
 * helix-portal — the control plane (architecture §3, §7). Privileged: registry
 * writes, deploy endpoint, capability approvals. Not routable from app
 * subdomains. Owns the Postgres schema and migrations (Prisma).
 */

// Re-exported so `server.ts` keeps its single `./app.js` import. The constant
// itself lives in its own module to keep `telemetry.ts` out of this one's
// import graph (ADR-0037 decision 3).
export { SERVICE_NAME };

export interface BuildAppOptions {
  /** Inject a PrismaClient and BlobStore (tests). Defaults build real ones. */
  prisma?: PrismaClient;
  blobStore?: BlobStore;
  /** Inject the auth verifier chain / public config (tests). */
  auth?: AuthPluginOptions;
  /** Inject the secret-store custody (tests). Defaults build from the env. */
  secretStore?: SecretStore | null;
  /** Inject the directory provider (tests). Defaults build from the env. */
  directory?: DirectoryProvider;
  /** Inject the visitor geo resolver (tests). Defaults build from the env. */
  geo?: GeoResolver;
  /** Inject the GitHub Actions key resolver for the CI deploy route (tests). */
  repoDeploy?: CiVersionRoutesOptions;
  /**
   * Built-SPA directory; null forces the stopgap dashboard (tests),
   * undefined auto-detects ($PORTAL_WEB_DIST or apps/portal-web/dist).
   */
  spaDist?: string | null;
  /**
   * The jobs lifecycle-delivery sender's supervision snapshot, looked up per
   * `/health` request (never a live probe) — the same shape the jobs app's
   * composition reads its loops' state through. Null — jobs fully disabled on
   * this install — leaves `/health` liveness-only. The lookup is deferred (a
   * holder, not the snapshot itself) because the sender is constructed after
   * the app: its Prisma client is the boot's, created beside it. Boot owns the
   * sender's start/stop (ADR-0009: supervision belongs to the service boot,
   * construction to the routes); the lookup keeps the health body honest
   * about which loops are actually running on THIS process.
   */
  jobsDelivery?: () => JobsDeliverySnapshot | null;
}

export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  // Fail the boot, not each request: a production portal without APP_PUBLIC_BASE
  // would hand every client — portal UI and `helix` alike — unreachable dev URLs.
  assertDeploymentConfig();
  // Likewise for the deploy size caps: a bad DEPLOY_MAX_*_MB should fail the
  // boot, not the first deploy that happens to hit the validator.
  assertBundleLimits();
  // The internal-JWT verify key is the same class of boot check: the
  // portal's internal routes have no degraded mode that still serves them, so a
  // portal missing the edge↔portal key must not start at all.
  assertInternalJwtSecrets();

  const app = Fastify({
    // The SPA's OIDC redirect URI is `/auth/callback?code=…` on this very
    // origin (routes/spa.ts serves it as a deep link), so the portal logs the
    // same shape of credential the edge does — same stdout, same Log Analytics
    // retention. Redact it (`@azx-pbc/shared/logging`).
    logger: loggerOption(undefined, { prefix: "PORTAL", mixin: traceContextMixin }),
    ...requestIdOptions(),
  });

  app.register(errorsPlugin);
  app.register(prismaPlugin, { client: opts.prisma });
  app.register(blobPlugin, { store: opts.blobStore });
  app.register(secretStorePlugin, { store: opts.secretStore });
  app.register(directoryPlugin, { provider: opts.directory });
  app.register(visitorsPlugin, { geo: opts.geo });
  app.register(authPlugin, opts.auth ?? {});
  // One bundle file per upload; cap the (compressed) upload size. Resolved once
  // at build time — this bounds what `spoolUpload` writes to the replica's temp
  // disk, so it is a capacity decision, not a per-request one.
  app.register(multipart, { limits: { files: 1, fileSize: resolveMaxTotalBytes() } });

  app.get("/health", async () => {
    // The delivery sender's supervision, when jobs is configured: the
    // platform's always-200 contract carries the backlog and loop-freshness
    // degradation in the body (ADR-0009). Absent — fully disabled jobs — the
    // portal reports liveness only, and no jobs dependency is implied.
    const deliverySnapshot = opts.jobsDelivery?.() ?? null;
    const checks = deliverySnapshot ? [jobsLifecycleDeliveryCheck(deliverySnapshot)] : [];
    return HealthStatusSchema.parse({
      status: worstHealthState(checks.map((c) => c.status)),
      service: SERVICE_NAME,
      uptime: process.uptime(),
      ...(checks.length > 0 ? { checks } : {}),
    });
  });

  app.register(appRoutes);
  app.register(secretRoutes);
  app.register(providerRoutes);
  app.register(devTokenRoutes);
  app.register(approvalRoutes);
  app.register(cspRoutes);
  app.register(versionRoutes);
  // Repo-backed deploys (ADR-0051): the binding, and the one route that accepts
  // a GitHub Actions token.
  app.register(repoBindingRoutes);
  app.register(ciVersionRoutes, opts.repoDeploy ?? {});
  app.register(usageRoutes);
  app.register(visitorRoutes);
  app.register(sessionRoutes);
  app.register(dataRoutes);
  app.register(authRoutes);
  app.register(configRoutes);
  app.register(platformSettingsRoutes);
  app.register(catalogueRoutes);
  app.register(directoryRoutes);
  // The internal edge→portal consent seam: consult + cancel,
  // authorized by the minted internal JWT — never bearer-token routes.
  app.register(connectionsInternalRoutes);
  // The popup's browser-facing consent pages under the `/connections/*` proxy
  // prefix: the dev journey's nonce entry, and the callback's completion pages.
  app.register(connectionsPageRoutes);
  // My Connections: the principal-scoped list + disconnect —
  // the one user-scoped portal surface, no owner/admin gate.
  app.register(myConnectionsRoutes);

  // The real dashboard when a built SPA is present; the M2 stopgap otherwise.
  const spaDist = opts.spaDist !== undefined ? opts.spaDist : resolveSpaDist();
  app.decorate("spaDist", spaDist);
  if (spaDist) {
    app.register(spaRoutes);
  } else {
    app.register(dashboardRoutes);
  }

  return app;
}
