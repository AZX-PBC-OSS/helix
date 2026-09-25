import { describe, expect, it } from "vitest";
import { Pool } from "pg";

const OWNER_URL = process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

/**
 * The root test setup truncates every public table between runs so a
 * long-lived local test database stays as deterministic as CI's ephemeral
 * one — every table except `_prisma_migrations`, which is a ledger of applied
 * migrations, not test data. Wiping it does not fail the current run: the
 * schema is already in place, so every test passes. It fails the *next* run,
 * whose `migrate deploy` replays migration 1 against an existing schema — a
 * delayed, cryptic failure that reads as a Prisma defect rather than the
 * truncate regression it is. This observes the state the setup actually
 * leaves behind, so removing the exception goes red in the same run that
 * introduced it.
 */
describe("the between-runs table truncate", () => {
  it("spares the Prisma migrations ledger", async () => {
    const pool = new Pool({ connectionString: OWNER_URL, max: 1 });
    try {
      const result = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM _prisma_migrations",
      );
      expect(Number(result.rows[0]?.count)).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });
});
