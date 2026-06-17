import { randomUUID } from "node:crypto";
import FormData from "form-data";
import type { FastifyInstance } from "fastify";
import { buildApp, type BuildAppOptions } from "../app.js";
import { createPrismaClient, type PrismaClient } from "../db/client.js";
import { InMemoryBlobStore } from "./memoryBlob.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

/** Deterministic dev token for tests; forced regardless of container env. */
export const TEST_TOKEN = "test-token";
process.env.PORTAL_DEV_TOKEN = TEST_TOKEN;

// Shared-password credential encryption key (apps/portal/src/access/password.ts).
// ≥32 bytes; only needs to exist for the access-password routes/crypto tests.
process.env.PORTAL_SECRET ??= "test-portal-secret-test-portal-secret-32b";

export interface TestApp {
  app: FastifyInstance;
  prisma: PrismaClient;
  blob: InMemoryBlobStore;
  /** Disconnect the injected client and close the app. */
  close(): Promise<void>;
}

/**
 * Build a portal app wired to the test database and an in-memory blob store.
 * The injected PrismaClient is owned here (the prisma plugin won't disconnect
 * it), so `close()` disposes it.
 */
export function buildTestApp(opts: Pick<BuildAppOptions, "auth" | "spaDist"> = {}): TestApp {
  const prisma = createPrismaClient(TEST_DATABASE_URL);
  const blob = new InMemoryBlobStore();
  // spaDist: null pins tests to the stopgap dashboard regardless of whether
  // the developer has built apps/portal-web (spa.test.ts opts back in).
  const app = buildApp({ prisma, blobStore: blob, spaDist: null, ...opts });
  return {
    app,
    prisma,
    blob,
    async close() {
      await app.close();
      await prisma.$disconnect();
    },
  };
}

/** A unique, valid DNS-label slug per call (parallel-safe across test files). */
export function uniqueSlug(prefix = "t"): string {
  return `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** Authorization header carrying the dev token. */
export function authHeader(token = TEST_TOKEN): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/** Build a multipart body (payload + headers) for a bundle upload. */
export function multipartBundle(
  buffer: Buffer,
  field = "bundle",
  filename = "bundle.zip",
): { payload: Buffer; headers: Record<string, string> } {
  const form = new FormData();
  form.append(field, buffer, { filename, contentType: "application/zip" });
  return { payload: form.getBuffer(), headers: form.getHeaders() };
}
