import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "./generated/client.js";

export { PrismaClient, Prisma };
export type { App, Version, AuditEvent, ApprovalRequest } from "./generated/client.js";

/**
 * Resolve the DSN the portal *runtime* connects as. The portal runs as the
 * least-privilege `helix_portal` role (ADR-0002): full DML, but NOT the schema
 * owner — so a portal RCE can't `DROP TABLE` or bypass RLS as owner/superuser
 * (an owner ignores row-level policies even under FORCE). Migrations still run
 * as the owner (`DATABASE_URL`) through the Prisma CLI (`prisma.config.ts`), a
 * separate process — this only repoints the request-path pool.
 *
 * `PORTAL_DATABASE_URL` (the `helix_portal` DSN) is required in production: the
 * `DATABASE_URL` fallback is the schema owner and silently defeats the role
 * split. Outside production the owner-DSN fallback stays a convenience for
 * setups without the role split — the same prod-strict pattern the edge uses
 * (`apps/edge/src/config.ts`).
 */
export function resolvePortalRuntimeUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.PORTAL_DATABASE_URL ?? env.DATABASE_URL;
  if (!url) {
    throw new Error("PORTAL_DATABASE_URL or DATABASE_URL is not set");
  }
  if (!env.PORTAL_DATABASE_URL && env.NODE_ENV === "production") {
    throw new Error(
      "PORTAL_DATABASE_URL (the least-privilege helix_portal role) is required in production; " +
        "refusing the DATABASE_URL fallback, which connects as the schema owner and bypasses " +
        "RLS, defeating the role split (ADR-0002).",
    );
  }
  return url;
}

/**
 * Construct a PrismaClient backed by the pg driver adapter. Prisma 7 is
 * Rust-engine-free, so the connection string is supplied here rather than in
 * schema.prisma. `server.ts` relies on the resolved runtime DSN
 * (`PORTAL_DATABASE_URL`, owner fallback outside prod); tests pass an explicit
 * TEST_DATABASE_URL so they never touch the dev database.
 */
export function createPrismaClient(connectionString?: string): PrismaClient {
  const url = connectionString ?? resolvePortalRuntimeUrl();
  const adapter = new PrismaPg({ connectionString: url });
  return new PrismaClient({ adapter });
}
