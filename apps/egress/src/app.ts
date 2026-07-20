import Fastify, { type FastifyInstance } from "fastify";
import { HealthStatusSchema } from "@azx-pbc/shared";
import type { EgressConfig } from "./config.js";
import type { SecretResolver } from "./secrets.js";
import { makeProxyHandler } from "./proxy.js";

/**
 * azx-egress — the mechanism plane (architecture §3). Internal-only: it answers
 * the edge's `/proxy` calls, never app users. It is the one component that holds
 * plaintext secrets and a route to the public internet; everything else about it
 * is deliberately tiny.
 */
const SERVICE_NAME = "azx-egress";

export interface EgressDeps {
  config: EgressConfig;
  /** null ⇒ no secret store; keyless proxying works, secret-backed calls 502. */
  resolver: SecretResolver | null;
  /** HKDF-derived instruction-verify key (shared derivation with the edge). */
  instructionKey: Buffer;
}

export function buildApp(deps: EgressDeps): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  // The proxy re-streams arbitrary request bodies; never buffer/parse them.
  // `removeAllContentTypeParsers` is essential: Fastify's BUILT-IN
  // `application/json`/`text/plain` parsers would otherwise consume `req.raw`
  // before the handler forwards it (the catch-all `*` only covers types without
  // a parser). The LLM call is always `application/json`, so without this the
  // body reaches the upstream empty. After removing them, the passthrough leaves
  // `req.raw` readable for undici for every content type.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

  app.route({
    method: ["GET", "HEAD"],
    url: "/health",
    handler: async () =>
      HealthStatusSchema.parse({
        status: "ok",
        service: SERVICE_NAME,
        uptime: process.uptime(),
      }),
  });

  app.route({
    method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    url: "/proxy",
    handler: makeProxyHandler({
      instructionKey: deps.instructionKey,
      resolver: deps.resolver,
      limits: deps.config.limits,
      allowPrivate: deps.config.allowPrivate,
      allowInsecureConnection: deps.config.allowInsecureConnection,
    }),
  });

  return app;
}
