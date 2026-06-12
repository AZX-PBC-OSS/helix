import Fastify, { type FastifyInstance } from "fastify";
import { HealthStatusSchema } from "@helix/shared";
import type { EdgeConfig } from "./config.js";
import type { BlobReader } from "./blob/client.js";
import type { RegistryReader } from "./registry/projection.js";
import { classifyHost, type HostClass } from "./routing/hosts.js";
import { makeAssetHandler } from "./serving/assets.js";
import { sendMethodNotAllowed, sendNotFound } from "./errors.js";

/**
 * azx-edge — the data plane (architecture §3). Stateless; terminates all
 * `*.azx-labs.com` traffic. **Hard rule: dependency-minimal** — every npm
 * package here is code inside the trusted path, so additions need review
 * (project plan §6).
 *
 * M2: host routing, registry projection, asset streaming, baseline CSP.
 * Sessions/OIDC (M3) and the `/_api/*` gateway (M4) come later.
 */
const SERVICE_NAME = "azx-edge";

export interface EdgeDeps {
  config: EdgeConfig;
  registry: RegistryReader;
  blob: BlobReader;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set once per request by the host-classification hook. */
    hostClass: HostClass;
  }
}

export function buildApp(deps: EdgeDeps): FastifyInstance {
  const { config } = deps;
  const app = Fastify({
    // Quiet during tests; structured JSON logs otherwise.
    logger: process.env.NODE_ENV !== "test",
  });

  const serveAsset = makeAssetHandler(deps);

  // The two-router discipline (architecture §3, decision 12): every request
  // is classified by hostname exactly once, and the two worlds never mix —
  // platform handlers are unreachable on app hosts and vice versa. Explicit
  // dispatch instead of find-my-way host constraints: the fallback semantics
  // between constrained and unconstrained routes are non-obvious, and this
  // way the boundary is one readable hook.
  app.decorateRequest("hostClass");
  app.addHook("onRequest", async (req) => {
    req.hostClass = classifyHost(req.headers.host, config.baseDomain);
  });

  app.route({
    method: ["GET", "HEAD"],
    url: "/health",
    handler: async (req, reply) => {
      if (req.hostClass.kind === "app") {
        // App hosts serve only app content — a deployed file named /health
        // (or the SPA fallback) answers, never the platform health JSON.
        await serveAsset(req, reply, req.hostClass.slug);
        return;
      }
      return HealthStatusSchema.parse({
        status: "ok",
        service: SERVICE_NAME,
        uptime: process.uptime(),
      });
    },
  });

  app.route({
    method: ["GET", "HEAD"],
    url: "/*",
    handler: async (req, reply) => {
      if (req.hostClass.kind === "app") {
        await serveAsset(req, reply, req.hostClass.slug);
        return;
      }
      sendNotFound(reply);
    },
  });

  // Unmatched methods (POST/PUT/… have no routes above) land here.
  app.setNotFoundHandler((req, reply) => {
    if (req.hostClass.kind === "app" && req.method !== "GET" && req.method !== "HEAD") {
      sendMethodNotAllowed(reply);
      return;
    }
    sendNotFound(reply);
  });

  return app;
}
