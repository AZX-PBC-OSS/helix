import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

function adminUrl(): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = "/postgres";
  return url.toString();
}

function urlFor(database: string): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * A throwaway, fully-migrated copy of the portal database, for suites that
 * run delivery-sender passes: the sender's synchronization step reads the
 * whole `apps` table and enqueues outbox rows for every app it finds, so a
 * suite that runs passes must not share the cluster-wide test database with
 * suites that assert on their own outbox rows.
 *
 * Returns the scratch database's URL and a `drop()` for `afterAll`. The
 * migrations run through the same Prisma CLI command the vitest global setup
 * uses; their per-table grants are guarded by `IF EXISTS (pg_roles …)`, so no
 * role provisioning is needed for a database only the schema owner uses.
 */
export async function createScratchPortalDatabase(prefix: string): Promise<{
  url: string;
  drop(): Promise<void>;
}> {
  const name = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  // The name reaches SQL as a quoted identifier, so it must already be a bare
  // lowercase identifier — validated before anything runs.
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`the scratch portal database name is not a bare lowercase identifier: ${name}`);
  }
  const admin = new Client({ connectionString: adminUrl(), connectionTimeoutMillis: 10_000 });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const url = urlFor(name);
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  execFileSync("pnpm", ["--filter", "@azx-pbc/portal", "exec", "prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
    cwd: repoRoot,
  });
  return {
    url,
    async drop(): Promise<void> {
      const dropper = new Client({ connectionString: adminUrl(), connectionTimeoutMillis: 10_000 });
      await dropper.connect();
      try {
        await dropper.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await dropper.end();
      }
    },
  };
}
