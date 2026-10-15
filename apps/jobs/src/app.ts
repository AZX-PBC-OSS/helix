import Fastify, { type FastifyInstance } from "fastify";
import { HealthStatusSchema, jobRequestError, worstHealthState } from "@azx-pbc/shared";
import { traceContextMixin } from "@azx-pbc/telemetry/correlation";
import { loggerOption, requestIdOptions } from "@azx-pbc/shared/logging";

import { jobsDatabaseCheck } from "./health.js";
import { SERVICE_NAME } from "./serviceName.js";
import type { JobsStorage } from "./storage.js";

export { SERVICE_NAME };

/**
 * helix-jobs — the background-jobs service (ADR-0045). This composition owns
 * the listener's health contract; the signed job operations and the worker
 * register their own routes and resources as they land, from here, and their
 * deps join {@link JobsDeps} when they have readers.
 *
 * The health contract is the platform's always-200 three-state roll-up: a
 * service that can answer HTTP but cannot execute work reports the
 * degradation in the body, never in the status code (spec criterion 55) —
 * a non-200 would let a liveness probe restart a replica whose store is
 * merely unreachable.
 */
export interface JobsDeps {
  /** The storage lifecycle; `/health` reads its snapshot, never a live probe. */
  storage: JobsStorage;
}

export function buildApp(deps: JobsDeps): FastifyInstance {
  const app = Fastify({
    logger: loggerOption(undefined, { prefix: "JOBS", mixin: traceContextMixin }),
    // The same fail-closed id rule as every other service: unauthenticated
    // metadata never carries authority. The signed-instruction verification
    // is what authenticates a jobs caller; the request id stays self-minted.
    ...requestIdOptions({ trustInbound: false }),
  });

  app.route({
    method: ["GET", "HEAD"],
    url: "/health",
    handler: async (_req, reply) => {
      // The snapshot, never a live probe: a health request must not wait on a
      // store that is down, and the probes' cadence is the loop's business.
      const checks = [jobsDatabaseCheck(deps.storage.snapshot())];
      reply.header("cache-control", "no-store"); // a degraded body must not be cached
      return HealthStatusSchema.parse({
        status: worstHealthState(checks.map((c) => c.status)),
        service: SERVICE_NAME,
        uptime: process.uptime(),
        checks,
      });
    },
  });

  // Until the signed job operations register (their tickets), everything
  // unmatched IS the job-operation surface — so an unmatched request while the
  // store is unusable answers the protocol's unavailable error (503), and one
  // on a ready service answers Fastify's stock 404 (a routing mistake, not an
  // availability statement). A later registered route takes precedence over
  // this handler automatically and owns its own readiness answer.
  app.setNotFoundHandler(async (req, reply) => {
    if (deps.storage.snapshot().state !== "ready") {
      reply.header("cache-control", "no-store");
      await reply.code(503).send(jobRequestError("jobs_unavailable"));
      return;
    }
    await reply.code(404).send({
      message: `Route ${req.method}:${req.url} not found`,
      error: "Not Found",
      statusCode: 404,
    });
  });

  return app;
}
