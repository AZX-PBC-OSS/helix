import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client.js";

export { PrismaClient };
export type { App, Version, AuditEvent } from "./generated/client.js";

/**
 * Construct a PrismaClient backed by the pg driver adapter. Prisma 7 is
 * Rust-engine-free, so the connection string is supplied here rather than in
 * schema.prisma. `server.ts` relies on DATABASE_URL; tests pass an explicit
 * TEST_DATABASE_URL so they never touch the dev database.
 */
export function createPrismaClient(connectionString?: string): PrismaClient {
  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  const adapter = new PrismaPg({ connectionString: url });
  return new PrismaClient({ adapter });
}
