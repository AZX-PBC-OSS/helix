import { type Pool } from "pg";

import { createEdgePool, type EdgePoolOpts } from "../db/pool.js";

/**
 * The gateway call ledger (architecture §6.1/§6.3, §8) — metering + audit and
 * the source of truth for per-app daily token budgets. Lives in the portal-
 * migrated `gateway_calls` table, accessed with hand-written SQL (no ORM in the
 * edge — project plan §1).
 *
 * This is the one place the edge **writes** product data. The widening from the
 * edge's otherwise read-only posture is deliberate and narrow: INSERT a row per
 * call, and SUM today's tokens to admit or block the next one. No secrets, no
 * registry writes.
 */

export type GatewayOutcome = "ok" | "error" | "refusal" | "quota_blocked";

export interface GatewayCallRecord {
  appId: string;
  userOid: string;
  /** Capability invoked — `llm` in M4. */
  capability: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Cache-aware input accounting; defaults to 0 (caching not enabled yet). */
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** Frozen as-charged cost in micro-USD (1e-6 USD); defaults to 0. */
  costMicroUsd?: number;
  outcome: GatewayOutcome;
  /** Upstream round-trip latency in ms; defaults to 0 when not measured. */
  durationMs?: number;
  /** Upstream/egress HTTP status (fetch); null/omitted for streamed llm. */
  statusCode?: number | null;
  /** LLM stop reason; null/omitted for non-LLM. */
  stopReason?: string | null;
  /** Short upstream error string; null/omitted on success. */
  errorDetail?: string | null;
}

/** The two LLM spend windows the gate checks, in micro-USD (1e-6 USD). */
export interface LlmSpend {
  /** Spend since local-midnight — the daily cost cap. */
  todayMicro: number;
  /** Spend in the trailing rolling hour — the burst/availability cap. */
  hourMicro: number;
}

export interface UsageStore {
  /**
   * Frozen LLM spend (micro-USD) for this app in the day + rolling-hour windows,
   * summed from the `costMicroUsd` ledger column. Backs the per-app USD budget
   * gate (`llm.ts`).
   */
  llmSpendMicroUsd(appId: string): Promise<LlmSpend>;
  /**
   * Count of successful app-data **write** calls today (app-data design §7) —
   * the per-app `writesPerDay` budget window. Writes are the put/append verbs
   * (`user.put`, `collection.append`, `shared.put`); reads and quota-blocks
   * don't count.
   */
  dataWritesToday(appId: string): Promise<number>;
  /**
   * Count of admitted fetch-proxy calls today (fetch-proxy design §7) — the
   * per-app `requestsPerDay` budget window. "Admitted" means everything we
   * recorded except the budget rejections themselves (`quota_blocked`), so a
   * flood of failing calls still counts against the cap.
   */
  fetchRequestsToday(appId: string): Promise<number>;
  /** Append one call to the ledger. */
  record(call: GatewayCallRecord): Promise<void>;
  close(): Promise<void>;
}

/** The `model` values recorded for app-data write verbs (see dataWritesToday). */
export const DATA_WRITE_VERBS = ["user.put", "collection.append", "shared.put"] as const;

export class PgUsageStore implements UsageStore {
  #pool: Pool;

  constructor(databaseUrl: string, opts: EdgePoolOpts = {}) {
    this.#pool = createEdgePool(databaseUrl, {
      max: opts.max ?? 10,
      statementTimeoutMs: opts.statementTimeoutMs,
    });
  }

  async llmSpendMicroUsd(appId: string): Promise<LlmSpend> {
    // One index scan over (appId, createdAt), two FILTERed sums. The outer
    // filter is day-start minus an hour so the rolling-hour window stays
    // correct across the midnight boundary (its rows can predate today). Day
    // boundary is server-local-midnight via date_trunc on now() (architecture
    // §6.3). costMicroUsd is non-null (DEFAULT 0).
    const result = await this.#pool.query(
      `SELECT
         COALESCE(SUM("costMicroUsd") FILTER (WHERE "createdAt" >= date_trunc('day', now())), 0)::bigint AS today,
         COALESCE(SUM("costMicroUsd") FILTER (WHERE "createdAt" >= now() - interval '1 hour'), 0)::bigint AS hour
       FROM gateway_calls
       WHERE "appId" = $1 AND capability = 'llm'
         AND "createdAt" >= date_trunc('day', now()) - interval '1 hour'`,
      [appId],
    );
    // SUM(::bigint) comes back as a string from pg; Number is safe well below
    // 2^53 for any realistic daily micro-USD total (1e6 = $1).
    const row = result.rows[0] as { today: string | number; hour: string | number } | undefined;
    return { todayMicro: row ? Number(row.today) : 0, hourMicro: row ? Number(row.hour) : 0 };
  }

  async dataWritesToday(appId: string): Promise<number> {
    const result = await this.#pool.query(
      `SELECT COUNT(*)::int AS n
       FROM gateway_calls
       WHERE "appId" = $1 AND capability = 'data' AND outcome = 'ok'
         AND model = ANY($2) AND "createdAt" >= date_trunc('day', now())`,
      [appId, DATA_WRITE_VERBS],
    );
    const row = result.rows[0] as { n: string | number } | undefined;
    return row ? Number(row.n) : 0;
  }

  async fetchRequestsToday(appId: string): Promise<number> {
    const result = await this.#pool.query(
      `SELECT COUNT(*)::int AS n
       FROM gateway_calls
       WHERE "appId" = $1 AND capability = 'fetch' AND outcome <> 'quota_blocked'
         AND "createdAt" >= date_trunc('day', now())`,
      [appId],
    );
    const row = result.rows[0] as { n: string | number } | undefined;
    return row ? Number(row.n) : 0;
  }

  async record(call: GatewayCallRecord): Promise<void> {
    await this.#pool.query(
      // Prisma's @default(uuid()) is client-side, so the raw INSERT supplies
      // the id itself (gen_random_uuid() — built into Postgres). Optional
      // metering columns fall back to their column defaults / NULL.
      `INSERT INTO gateway_calls
         (id, "appId", "userOid", capability, model, "inputTokens", "outputTokens",
          "cacheReadInputTokens", "cacheCreationInputTokens", "costMicroUsd", outcome,
          "durationMs", "statusCode", "stopReason", "errorDetail")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        call.appId,
        call.userOid,
        call.capability,
        call.model,
        call.inputTokens,
        call.outputTokens,
        call.cacheReadInputTokens ?? 0,
        call.cacheCreationInputTokens ?? 0,
        call.costMicroUsd ?? 0,
        call.outcome,
        call.durationMs ?? 0,
        call.statusCode ?? null,
        call.stopReason ?? null,
        call.errorDetail ?? null,
      ],
    );
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
