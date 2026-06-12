import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { HealthStatusSchema } from "@helix/shared";
import type { PrismaClient } from "./db/client.js";
import type { BlobStore } from "./blob/store.js";
import { prismaPlugin } from "./plugins/prisma.js";
import { blobPlugin } from "./plugins/blob.js";
import { errorsPlugin } from "./plugins/errors.js";
import { MAX_TOTAL_BYTES } from "./deploy/limits.js";
import { appRoutes } from "./routes/apps.js";
import { versionRoutes } from "./routes/versions.js";

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
}

export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
  });

  app.register(errorsPlugin);
  app.register(prismaPlugin, { client: opts.prisma });
  app.register(blobPlugin, { store: opts.blobStore });
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

  return app;
}
