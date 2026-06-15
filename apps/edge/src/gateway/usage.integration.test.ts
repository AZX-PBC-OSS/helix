import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgUsageStore } from "./usage.js";
import { TEST_DATABASE_URL } from "../test/seed.js";

/**
 * Real-Postgres coverage for the gateway ledger: the daily-budget SUM and the
 * per-call INSERT run against the actual `gateway_calls` table (quoted
 * camelCase columns — a typo only surfaces at runtime). Scoped to a fresh
 * appId per run so it's parallel-safe; rows are cleaned up after.
 */

let pool: Pool;
let store: PgUsageStore;
const appId = randomUUID();
const otherAppId = randomUUID();

beforeAll(() => {
  pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
  store = new PgUsageStore(TEST_DATABASE_URL, { max: 4 });
});

afterAll(async () => {
  await pool.query(`DELETE FROM gateway_calls WHERE "appId" = ANY($1::uuid[])`, [
    [appId, otherAppId],
  ]);
  await store.close();
  await pool.end();
});

describe("PgUsageStore", () => {
  it("starts at zero and sums today's input+output tokens for the app", async () => {
    expect(await store.tokensUsedToday(appId)).toBe(0);

    await store.record({
      appId,
      userOid: "oid-alice",
      capability: "llm",
      model: "claude-opus-4-8",
      inputTokens: 100,
      outputTokens: 50,
      outcome: "ok",
    });
    await store.record({
      appId,
      userOid: "oid-alice",
      capability: "llm",
      model: "claude-opus-4-8",
      inputTokens: 10,
      outputTokens: 5,
      outcome: "ok",
    });

    expect(await store.tokensUsedToday(appId)).toBe(165);
  });

  it("scopes the budget to one app", async () => {
    await store.record({
      appId: otherAppId,
      userOid: "oid-bob",
      capability: "llm",
      model: "claude-opus-4-8",
      inputTokens: 999,
      outputTokens: 999,
      outcome: "ok",
    });
    // The first app's total is unaffected by the other app's usage.
    expect(await store.tokensUsedToday(appId)).toBe(165);
  });

  it("records a blocked call with zero tokens (still audited)", async () => {
    await store.record({
      appId,
      userOid: "oid-alice",
      capability: "llm",
      model: "claude-opus-4-8",
      inputTokens: 0,
      outputTokens: 0,
      outcome: "quota_blocked",
    });
    const { rows } = await pool.query(
      `SELECT outcome FROM gateway_calls WHERE "appId" = $1 AND outcome = 'quota_blocked'`,
      [appId],
    );
    expect(rows).toHaveLength(1);
  });
});
