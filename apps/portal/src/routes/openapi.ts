import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { FastifyInstance } from "fastify";
import { portal } from "@azx-pbc/shared/contracts";
import { contractRoute } from "../plugins/contractRoute.js";

// The committed spec of this build (ADR-0054), read once at boot. Generated
// from the same contracts these routes register with, so it describes exactly
// the portal that serves it.
const require = createRequire(import.meta.url);
const SPEC = readFileSync(require.resolve("@azx-pbc/openapi/portal-api.json"), "utf8");

/** `GET /api/v1/openapi.json`: the portal API's OpenAPI document. Public. */
export async function openapiRoutes(app: FastifyInstance): Promise<void> {
  contractRoute(app, portal.getPortalOpenApi, async (_req, reply) => {
    return reply
      .header("content-type", "application/json; charset=utf-8")
      .header("cache-control", "public, max-age=300")
      .send(SPEC);
  });
}
