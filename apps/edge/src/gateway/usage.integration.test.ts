import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgUsageStore } from "./usage.js";
import { TEST_DATABASE_URL } from "../test/seed.js";

/**
 * Real-Postgres coverage for the gateway ledger: the windowed spend SUM and the
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
  it("starts at zero and sums today's frozen cost for the app (day + rolling hour)", async () => {
    expect(await store.llmSpendMicroUsd(appId, "prod")).toEqual({ todayMicro: 0, hourMicro: 0 });

    await store.record({
      appId,
      env: "prod",
      userOid: "oid-alice",
      capability: "llm",
      model: "claude-opus-4-8",
      inputTokens: 100,
      outputTokens: 50,
      costMicroUsd: 150_000,
      outcome: "ok",
    });
    await store.record({
      appId,
      env: "prod",
      userOid: "oid-alice",
      capability: "llm",
      model: "claude-opus-4-8",
      inputTokens: 10,
      outputTokens: 5,
      costMicroUsd: 15_000,
      outcome: "ok",
    });

    // Both rows are within the trailing hour (just inserted), so both windows match.
    expect(await store.llmSpendMicroUsd(appId, "prod")).toEqual({
      todayMicro: 165_000,
      hourMicro: 165_000,
    });
  });

  it("scopes the budget to one app", async () => {
    await store.record({
      appId: otherAppId,
      env: "prod",
      userOid: "oid-bob",
      capability: "llm",
      model: "claude-opus-4-8",
      inputTokens: 999,
      outputTokens: 999,
      costMicroUsd: 9_999_999,
      outcome: "ok",
    });
    // The first app's total is unaffected by the other app's usage.
    expect(await store.llmSpendMicroUsd(appId, "prod")).toEqual({
      todayMicro: 165_000,
      hourMicro: 165_000,
    });
  });

  it("records a blocked call with zero cost (still audited)", async () => {
    await store.record({
      appId,
      env: "prod",
      userOid: "oid-alice",
      capability: "llm",
      model: "claude-opus-4-8",
      inputTokens: 0,
      outputTokens: 0,
      costMicroUsd: 0,
      outcome: "quota_blocked",
    });
    const { rows } = await pool.query(
      `SELECT outcome FROM gateway_calls WHERE "appId" = $1 AND outcome = 'quota_blocked'`,
      [appId],
    );
    expect(rows).toHaveLength(1);
  });

  it("round-trips the metering columns (latency, cache, status, stop reason, error)", async () => {
    const meteredAppId = randomUUID();
    try {
      await store.record({
        appId: meteredAppId,
        env: "prod",
        userOid: "oid-alice",
        capability: "llm",
        model: "claude-opus-4-8",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 10,
        costMicroUsd: 87_654,
        outcome: "ok",
        durationMs: 1234,
        statusCode: null,
        stopReason: "end_turn",
        errorDetail: null,
      });
      const { rows } = await pool.query(
        `SELECT "cacheReadInputTokens", "cacheCreationInputTokens", "costMicroUsd"::int AS "costMicroUsd",
                "durationMs", "statusCode", "stopReason", "errorDetail"
         FROM gateway_calls WHERE "appId" = $1`,
        [meteredAppId],
      );
      expect(rows[0]).toEqual({
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 10,
        costMicroUsd: 87_654,
        durationMs: 1234,
        statusCode: null,
        stopReason: "end_turn",
        errorDetail: null,
      });
    } finally {
      await pool.query(`DELETE FROM gateway_calls WHERE "appId" = $1`, [meteredAppId]);
    }
  });

  it("defaults the optional metering columns when a caller omits them", async () => {
    const defaultsAppId = randomUUID();
    try {
      // A minimal record (e.g. the data/quota paths) — new columns fall back.
      await store.record({
        appId: defaultsAppId,
        env: "prod",
        userOid: "oid-bob",
        capability: "data",
        model: "user.put",
        inputTokens: 0,
        outputTokens: 0,
        outcome: "ok",
      });
      const { rows } = await pool.query(
        `SELECT "cacheReadInputTokens", "costMicroUsd"::int AS "costMicroUsd",
                "durationMs", "statusCode", "stopReason"
         FROM gateway_calls WHERE "appId" = $1`,
        [defaultsAppId],
      );
      expect(rows[0]).toEqual({
        cacheReadInputTokens: 0,
        costMicroUsd: 0,
        durationMs: 0,
        statusCode: null,
        stopReason: null,
      });
    } finally {
      await pool.query(`DELETE FROM gateway_calls WHERE "appId" = $1`, [defaultsAppId]);
    }
  });
});
