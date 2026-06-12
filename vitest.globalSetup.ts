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
  execSync("pnpm --filter @helix/portal exec prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}
