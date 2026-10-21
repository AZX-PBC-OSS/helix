import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { checkJobsStorageCompatibility, PGBOSS_SCHEMA_VERSION } from "./compat.js";
import { JOBS_RUNTIME_ROLE } from "./policy.js";
import { applyRolesProvisioning } from "../../portal/src/test/provisionDatabases.js";

/**
 * The migration command's process entry point — the command an operator and
 * CI actually run (`pnpm --filter @azx-pbc/jobs db:migrate`). The storage legs
 * live in `migrate.integration.test.ts`; this file holds the command's own
 * contract: its exit codes, its structured start/outcome/duration events, and
 * the rule that a DSN's password never reaches the output.
 *
 * The real script runs as a subprocess against its own scratch database,
 * provisioned through the platform's role file like the storage legs — no
 * test superuser, the real role split.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

const PACKAGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCRATCH_DB = `helix_jobs_cli_${randomUUID().replaceAll("-", "")}`;

function urlFor(database: string, role?: string): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  if (role) {
    url.username = role;
    url.password = role;
  }
  return url.toString();
}

const MIGRATE_DSN = urlFor(SCRATCH_DB, "helix_jobs_migrate");

/** Run the command exactly as the package's `db:migrate` script does. */
function runMigrateCli(dsn?: string): SpawnSyncReturns<string> {
  const env = { ...process.env };
  delete env.JOBS_MIGRATE_DATABASE_URL;
  if (dsn !== undefined) {
    env.JOBS_MIGRATE_DATABASE_URL = dsn;
  }
  return spawnSync("node", ["--import", "tsx", "src/migrate.ts"], {
    cwd: PACKAGE_DIR,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
}

/** The structured events a run printed, parsed defensively from its output. */
function eventNamed(output: string, name: string): Record<string, unknown> | undefined {
  return output
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .find((parsed) => parsed?.event === name);
}

beforeAll(async () => {
  // The scratch store is created by the provisioning itself (the file's
  // create-if-missing), inside the serialized application.
  await applyRolesProvisioning(SCRATCH_DB);
}, 30_000);

afterAll(async () => {
  const pool = new Pool({ connectionString: urlFor("postgres"), max: 1 });
  await pool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
  await pool.end();
}, 30_000);

describe("the migration command's process entry", () => {
  const slow = { timeout: 60_000 };

  test("a successful run exits 0 and reports start, outcome and duration", slow, async () => {
    const run = runMigrateCli(MIGRATE_DSN);
    expect(run.status, run.stderr).toBe(0);

    const started = eventNamed(run.stdout, "jobs_storage_migration_started");
    expect(started).toMatchObject({ store: `helix_jobs_migrate@db:5432/${SCRATCH_DB}` });

    const applied = eventNamed(run.stdout, "jobs_storage_migration_applied");
    expect(applied).toMatchObject({
      schemaVersionBefore: null,
      schemaVersion: PGBOSS_SCHEMA_VERSION,
      queueExisted: false,
      queuePolicyRepairs: [],
    });
    expect(typeof applied?.durationMs).toBe("number");

    // The command's outcome is the store a runtime can rely on.
    const pool = new Pool({ connectionString: urlFor(SCRATCH_DB, JOBS_RUNTIME_ROLE), max: 1 });
    try {
      await expect(checkJobsStorageCompatibility(pool)).resolves.toEqual({
        kind: "compatible",
        schemaVersion: PGBOSS_SCHEMA_VERSION,
      });
    } finally {
      await pool.end();
    }
  });

  test("a run without its DSN variable fails, naming it, and starts nothing", slow, () => {
    const run = runMigrateCli();
    expect(run.status, run.stderr).toBe(1);

    const output = `${run.stdout}${run.stderr}`;
    const failed = eventNamed(output, "jobs_storage_migration_failed");
    expect(failed?.error).toMatch(/JOBS_MIGRATE_DATABASE_URL is required/);
    // Nothing ran: no start event, so no half-described store either.
    expect(eventNamed(output, "jobs_storage_migration_started")).toBeUndefined();
  });

  test("the DSN's password never reaches the command's output", slow, () => {
    // The store rejects the wrong password — the failure path is where a
    // password would most plausibly leak, so the marked DSN drives the run
    // to exactly there.
    const password = "leaked-pw-marker-9f2a7b";
    const marked = new URL(MIGRATE_DSN);
    marked.password = password;

    const run = runMigrateCli(marked.toString());
    expect(run.status, run.stderr).toBe(1);

    const output = `${run.stdout}${run.stderr}`;
    const started = eventNamed(output, "jobs_storage_migration_started");
    expect(started).toMatchObject({ store: `helix_jobs_migrate@db:5432/${SCRATCH_DB}` });
    expect(eventNamed(output, "jobs_storage_migration_failed")).toBeDefined();
    expect(output).not.toContain(password);
  });
});
