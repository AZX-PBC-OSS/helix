import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PgUsageStore } from "./usage.js";
import { TEST_DATABASE_URL } from "../test/seed.js";

/**
 * The gateway ledger against real Postgres, connecting as the least-privilege
 * `helix_edge` role — so this exercises the actual `gateway_calls_edge_partition`
 * RLS policy (ADR-0002 ISSUE-12), not just the hand-written `WHERE "appId"`.
 * The plain `usage.integration.test.ts` runs as the superuser owner (bypasses
 * RLS) and covers the store's column/round-trip logic; this file is the
 * isolation half. Skips when the runtime role isn't provisioned (CI without
 * db-init), same as the other role-split suites.
 */

function edgeUrl(): string {
  const u = new URL(TEST_DATABASE_URL);
  u.username = "helix_edge";
  u.password = "helix_edge";
  return u.toString();
}

async function edgeRoleAvailable(): Promise<boolean> {
  const pool = new Pool({ connectionString: edgeUrl(), max: 1 });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

const APP = randomUUID();
const OTHER_APP = randomUUID();
let store: PgUsageStore | null = null;

afterAll(async () => {
  await store?.close();
  // Clean as the superuser owner — FORCE RLS would otherwise scope a bare delete.
  const owner = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  try {
    await owner.query(`DELETE FROM gateway_calls WHERE "appId" = ANY($1::uuid[])`, [
      [APP, OTHER_APP],
    ]);
  } finally {
    await owner.end();
  }
});

describe("PgUsageStore as helix_edge (RLS-backed)", () => {
  it("records and sums within the app's partition, isolated from other apps", async () => {
    if (!(await edgeRoleAvailable())) return;
    store = new PgUsageStore(edgeUrl(), { max: 2 });

    // The INSERT lands only because withPartition sets app.app_id to the row's
    // own appId (the WITH CHECK) — a mismatch would be rejected (see below).
    await store.record({
      appId: APP,
      env: "prod",
      userOid: "oid-alice",
      capability: "llm",
      model: "claude-opus-4-8",
      inputTokens: 100,
      outputTokens: 50,
      costMicroUsd: 150_000,
      outcome: "ok",
    });
    // A different app's usage is written under its own partition…
    await store.record({
      appId: OTHER_APP,
      env: "prod",
      userOid: "oid-bob",
      capability: "llm",
      model: "claude-opus-4-8",
      inputTokens: 999,
      outputTokens: 999,
      costMicroUsd: 9_999_999,
      outcome: "ok",
    });

    // …and the budget SUM for APP sees only APP's rows, never OTHER_APP's —
    // enforced by RLS, not just the WHERE clause.
    expect(await store.llmSpendMicroUsd(APP, "prod")).toEqual({
      todayMicro: 150_000,
      hourMicro: 150_000,
    });
  });

  it("fails closed: a bare read with no partition GUC sees nothing", async () => {
    if (!(await edgeRoleAvailable())) return;
    // Seed a row so a leak would be observable.
    const s = store ?? new PgUsageStore(edgeUrl(), { max: 1 });
    store = s;
    await s.record({
      appId: APP,
      env: "prod",
      userOid: "oid-alice",
      capability: "data",
      model: "user.put",
      inputTokens: 0,
      outputTokens: 0,
      outcome: "ok",
    });

    const pool = new Pool({ connectionString: edgeUrl(), max: 1 });
    try {
      // No set_config — the policy predicate is NULL → matches zero rows.
      const r = await pool.query(`SELECT count(*)::int AS n FROM gateway_calls`);
      expect((r.rows[0] as { n: number }).n).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it("rejects a metering INSERT that targets another app's partition (WITH CHECK)", async () => {
    if (!(await edgeRoleAvailable())) return;
    const pool = new Pool({ connectionString: edgeUrl(), max: 1 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // GUC says APP, but the row says OTHER_APP — the WITH CHECK must reject it,
      // so a confused appId can't forge another app's metering.
      await client.query("SELECT set_config('app.app_id', $1, true)", [APP]);
      await expect(
        client.query(
          `INSERT INTO gateway_calls (id, "appId", "userOid", capability, model, outcome)
             VALUES (gen_random_uuid(), $1, 'x', 'llm', 'm', 'ok')`,
          [OTHER_APP],
        ),
      ).rejects.toThrow(/row-level security/i);
      await client.query("ROLLBACK");
    } finally {
      client.release();
      await pool.end();
    }
  });
});
