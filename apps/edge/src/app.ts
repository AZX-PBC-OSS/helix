import Fastify, { type FastifyInstance } from "fastify";
import { HealthStatusSchema } from "@helix/shared";

/**
 * azx-edge — the data plane (architecture §3). Stateless; terminates all
 * `*.azx-labs.com` traffic. **Hard rule: dependency-minimal** — every npm
 * package here is code inside the trusted path, so additions need review
 * (project plan §6). Today: just Fastify.
 *
 * Routing, sessions/OIDC, CSP injection, asset serving and the `/_api/*`
 * gateway all arrive in later milestones (M2–M4). M0 is boot + liveness only.
 */
const SERVICE_NAME = "azx-edge";

export function buildApp(): FastifyInstance {
  const app = Fastify({
    // Quiet during tests; structured JSON logs otherwise.
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
