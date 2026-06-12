import fp from "fastify-plugin";
import { createPrismaClient, type PrismaClient } from "../db/client.js";

export interface PrismaPluginOptions {
  /** Inject a client (tests). When omitted, one is built from DATABASE_URL. */
  client?: PrismaClient;
}

/**
 * Decorates the app with a single PrismaClient. A client we construct is
 * disconnected on close; an injected one is owned by the caller (tests reuse
 * a shared client across the suite).
 */
export const prismaPlugin = fp<PrismaPluginOptions>(
  async (app, opts) => {
    const client = opts.client ?? createPrismaClient();
    app.decorate("prisma", client);

    if (!opts.client) {
      app.addHook("onClose", async () => {
        await client.$disconnect();
      });
    }
  },
  { name: "prisma" },
);
