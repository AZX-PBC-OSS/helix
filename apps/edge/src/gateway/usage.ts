import { Pool } from "pg";

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
  outcome: GatewayOutcome;
}

export interface UsageStore {
  /** Total input+output tokens charged to this app since UTC midnight. */
  tokensUsedToday(appId: string): Promise<number>;
  /**
   * Count of successful app-data **write** calls today (app-data design §7) —
   * the per-app `writesPerDay` budget window. Writes are the put/append verbs
   * (`user.put`, `collection.append`, `shared.put`); reads and quota-blocks
   * don't count.
   */
  dataWritesToday(appId: string): Promise<number>;
  /** Append one call to the ledger. */
  record(call: GatewayCallRecord): Promise<void>;
  close(): Promise<void>;
}

/** The `model` values recorded for app-data write verbs (see dataWritesToday). */
export const DATA_WRITE_VERBS = ["user.put", "collection.append", "shared.put"] as const;

export class PgUsageStore implements UsageStore {
  #pool: Pool;

  constructor(databaseUrl: string, opts: { max?: number } = {}) {
    this.#pool = new Pool({ connectionString: databaseUrl, max: opts.max ?? 10 });
  }

  async tokensUsedToday(appId: string): Promise<number> {
    // Day boundary is server-local-midnight via date_trunc on now(); the
    // budget is "tokens per calendar day" (architecture §6.3). Indexed by
    // (appId, createdAt).
    const result = await this.#pool.query(
      `SELECT COALESCE(SUM("inputTokens" + "outputTokens"), 0)::bigint AS total
       FROM gateway_calls
       WHERE "appId" = $1 AND "createdAt" >= date_trunc('day', now())`,
      [appId],
    );
    // SUM(::bigint) comes back as a string from pg; Number is safe well below
    // 2^53 for any realistic daily token total.
    const row = result.rows[0] as { total: string | number } | undefined;
    return row ? Number(row.total) : 0;
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

  async record(call: GatewayCallRecord): Promise<void> {
    await this.#pool.query(
      // Prisma's @default(uuid()) is client-side, so the raw INSERT supplies
      // the id itself (gen_random_uuid() — built into Postgres).
      `INSERT INTO gateway_calls
         (id, "appId", "userOid", capability, model, "inputTokens", "outputTokens", outcome)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`,
      [
        call.appId,
        call.userOid,
        call.capability,
        call.model,
        call.inputTokens,
        call.outputTokens,
        call.outcome,
      ],
    );
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
