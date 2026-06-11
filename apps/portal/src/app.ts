import Fastify, { type FastifyInstance } from "fastify";
import { HealthStatusSchema } from "@helix/shared";

/**
 * azx-portal — the control plane (architecture §3, §7). Privileged: registry
 * writes, deploy endpoint, capability approvals. Not routable from app
 * subdomains. Owns the Postgres schema and migrations (Prisma) — those arrive
 * in M1; M0 is boot + liveness only.
 */
const SERVICE_NAME = "azx-portal";

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
  });

  app.get("/health", async () => {
    return HealthStatusSchema.parse({
      status: "ok",
      service: SERVICE_NAME,
      uptime: process.uptime(),
    });
  });

  return app;
}
