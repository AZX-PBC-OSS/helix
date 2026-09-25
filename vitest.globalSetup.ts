import { execSync } from "node:child_process";

/**
 * One-time setup for the whole test run: ensure a dedicated test database
 * exists and is migrated, so DB-backed tests never touch the dev database.
 * Runs in the dev container where Postgres + the prisma CLI are available.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

export default function setup(): void {
  const dbName = TEST_DATABASE_URL.split("/").pop();
  const adminUrl = TEST_DATABASE_URL.replace(/\/[^/]+$/, "/helix");

  // Create the test database if it doesn't exist yet (idempotent).
  execSync(
    `psql "${adminUrl}" -tc "SELECT 1 FROM pg_database WHERE datname='${dbName}'" | grep -q 1 || ` +
      `psql "${adminUrl}" -c "CREATE DATABASE ${dbName}"`,
    { stdio: "inherit" },
  );

  // Apply migrations to the test database.
  execSync("pnpm --filter @azx-pbc/portal exec prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });

  // Empty every table before the run. Tests are written against CI's
  // ephemeral databases: they seed their own rows with unique keys and never
  // read what an earlier run left. A long-lived local test database breaks
  // that assumption two ways once rows accumulate across runs — a paginated
  // admin list can push a test's freshly-seeded rows off its default page
  // (sessions: ~200 live rows re-accumulate in a dozen runs, and the test's
  // random userOid then sorts past the cut), and an unbounded IN-list can
  // cross Postgres's bind-parameter limit (GET /api/v1/apps?scope=all, P2029
  // at ~32k apps). Truncating between runs keeps every local run as
  // deterministic as CI's; within one run the few dozen seeded rows stay far
  // below both thresholds. Roles, grants, and RLS policies are not table
  // data, so role provisioning survives — and so does `_prisma_migrations`,
  // which is a ledger, not test data: wiping it makes the next run's
  // `migrate deploy` replay migration 1 against an existing schema and fail.
  execSync(
    `psql "${TEST_DATABASE_URL}" -c "DO \\$\\$ DECLARE r record; BEGIN ` +
      `FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public' ` +
      `AND tablename <> '_prisma_migrations') LOOP ` +
      `EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' CASCADE'; ` +
      `END LOOP; END \\$\\$;"`,
    { stdio: "inherit" },
  );
}
