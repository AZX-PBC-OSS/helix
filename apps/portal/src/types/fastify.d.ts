import type { PrismaClient } from "../db/client.js";
import type { BlobStore } from "../blob/store.js";
import type { Actor } from "../plugins/auth.js";

/**
 * Decorators and per-request state added by the portal's plugins.
 * `actor` is set by the auth stub (src/plugins/auth.ts) on authenticated
 * (mutating) requests; M3 swaps the source of identity, not this shape.
 */
declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
    blobStore: BlobStore;
  }

  interface FastifyRequest {
    actor?: Actor;
  }
}
