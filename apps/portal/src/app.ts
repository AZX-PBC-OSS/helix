import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { HealthStatusSchema } from "@helix/shared";
import type { PrismaClient } from "./db/client.js";
import type { BlobStore } from "./blob/store.js";
import { prismaPlugin } from "./plugins/prisma.js";
import { blobPlugin } from "./plugins/blob.js";
import { errorsPlugin } from "./plugins/errors.js";
import { authPlugin, type AuthPluginOptions } from "./plugins/auth.js";
import { MAX_TOTAL_BYTES } from "./deploy/limits.js";
import { appRoutes } from "./routes/apps.js";
import { versionRoutes } from "./routes/versions.js";
import { usageRoutes } from "./routes/usage.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { authRoutes } from "./routes/auth.js";
import { resolveSpaDist, spaRoutes } from "./routes/spa.js";

/**
 * azx-portal — the control plane (architecture §3, §7). Privileged: registry
 * writes, deploy endpoint, capability approvals. Not routable from app
 * subdomains. Owns the Postgres schema and migrations (Prisma).
 */
const SERVICE_NAME = "azx-portal";

export interface BuildAppOptions {
  /** Inject a PrismaClient and BlobStore (tests). Defaults build real ones. */
  prisma?: PrismaClient;
  blobStore?: BlobStore;
  /** Inject the auth verifier chain / public config (tests). */
  auth?: AuthPluginOptions;
  /**
   * Built-SPA directory; null forces the stopgap dashboard (tests),
   * undefined auto-detects ($PORTAL_WEB_DIST or apps/portal-web/dist).
   */
  spaDist?: string | null;
}

export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
  });

  app.register(errorsPlugin);
  app.register(prismaPlugin, { client: opts.prisma });
  app.register(blobPlugin, { store: opts.blobStore });
  app.register(authPlugin, opts.auth ?? {});
  // One bundle file per upload; cap the (compressed) upload size.
  app.register(multipart, { limits: { files: 1, fileSize: MAX_TOTAL_BYTES } });

  app.get("/health", async () => {
    return HealthStatusSchema.parse({
      status: "ok",
      service: SERVICE_NAME,
      uptime: process.uptime(),
    });
  });

  app.register(appRoutes);
  app.register(versionRoutes);
  app.register(usageRoutes);
  app.register(authRoutes);

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
