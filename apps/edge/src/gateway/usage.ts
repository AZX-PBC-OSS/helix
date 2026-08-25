import { type Pool } from "pg";

import { type Env } from "@azx-pbc/shared";

import { createEdgePool, type EdgePoolOpts } from "../db/pool.js";
import { withPartition } from "../db/partition.js";

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
 *
 * Every access runs through `withPartition` so the `gateway_calls_edge_partition`
 * RLS policy (ADR-0002) scopes it to the request's app: the per-app budget SUMs
 * and the metering INSERT can only ever see / write this app's rows, and a path
 * that forgot the `app.app_id` GUC matches zero rows / fails the WITH CHECK
 * (fail-closed) rather than crossing tenants. Metering is per-app, so only
 * `app.app_id` is set (no `app.user_oid`). The txn adds a round-trip to the
 * metering hot path — an accepted cost for the fail-closed backstop.
 */

export type GatewayOutcome = "ok" | "error" | "refusal" | "quota_blocked" | "conflict";

export interface GatewayCallRecord {
  appId: string;
  /** Partition tier (dev-mode design §5.1) — keeps budgets/usage per-env. */
  env: Env;
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

/** Max length of the `errorDetail` ledger string, before the ellipsis. */
const ERROR_DETAIL_MAX = 300;

/** How far up the `cause` chain to walk. Deep enough for undici's wrapping. */
const ERROR_CAUSE_DEPTH = 4;

/**
 * Render a thrown value for the `errorDetail` ledger column (internal-only, not
 * app-facing), following the `cause` chain.
 *
 * Recording `err.message` alone loses the only part that says *what went wrong
 * at the wire*. `EgressProviderError` is thrown as
 * `new EgressProviderError("egress request failed", { cause: err })`
 * (`egressProvider.ts`), so a DNS failure and a refused connection both land in
 * the ledger as the identical, undiagnosable string "egress request failed" —
 * the `ENOTFOUND` / `ECONNREFUSED` that distinguishes them sits one level down
 * in the cause and used to be dropped here. That cost a live incident four
 * diagnostic steps (an `az containerapp exec` into the running edge replica) to
 * recover a code the ledger already had in hand.
 *
 * So: walk the chain, and append each level's `code` when it carries one. A
 * transport failure now records as
 * `egress request failed: getaddrinfo ENOTFOUND <host> [ENOTFOUND]`.
 */
export function errorDetailOf(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;

  for (let depth = 0; depth < ERROR_CAUSE_DEPTH && cur != null; depth += 1) {
    if (!(cur instanceof Error)) {
      parts.push(String(cur));
      break;
    }
    // `code` is the Node/undici system-error discriminator (ENOTFOUND,
    // ECONNREFUSED, UND_ERR_*). Not on the Error type, hence the narrowing.
    const code = (cur as Error & { code?: unknown }).code;
    parts.push(typeof code === "string" ? `${cur.message} [${code}]` : cur.message);
    cur = cur.cause;
  }

  const detail = parts.join(": ");
  return detail.length > ERROR_DETAIL_MAX ? `${detail.slice(0, ERROR_DETAIL_MAX)}…` : detail;
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
  llmSpendMicroUsd(appId: string, env: Env): Promise<LlmSpend>;
  /**
   * Count of successful app-data **write** calls today (app-data design §7) —
   * the per-app `writesPerDay` budget window. Writes are the put/append verbs
   * (`user.put`, `collection.append`, `shared.put`); reads and quota-blocks
   * don't count.
   */
  dataWritesToday(appId: string, env: Env): Promise<number>;
  /**
   * Count of admitted fetch-proxy calls today (fetch-proxy design §7) — the
   * per-app `requestsPerDay` budget window. "Admitted" means everything we
   * recorded except the budget rejections themselves (`quota_blocked`), so a
   * flood of failing calls still counts against the cap.
   */
  fetchRequestsToday(appId: string, env: Env): Promise<number>;
  /** Append one call to the ledger. */
  record(call: GatewayCallRecord): Promise<void>;
  close(): Promise<void>;
}

/** The `model` values recorded for app-data write verbs (see dataWritesToday). */
export const DATA_WRITE_VERBS = ["user.put", "collection.append", "shared.put"] as const;

export class PgUsageStore implements UsageStore {
  #pool: Pool;

  constructor(databaseUrl: string, opts: EdgePoolOpts = {}) {
    // Spread, don't re-list — see the note in auth/sessions.ts.
    this.#pool = createEdgePool(databaseUrl, {
      ...opts,
      max: opts.max ?? 10,
      label: opts.label ?? "usage",
    });
  }

  async llmSpendMicroUsd(appId: string, env: Env): Promise<LlmSpend> {
    // One index scan over (appId, env, createdAt), two FILTERed sums. The outer
    // filter is day-start minus an hour so the rolling-hour window stays
    // correct across the midnight boundary (its rows can predate today). Day
    // boundary is server-local-midnight via date_trunc on now() (architecture
    // §6.3). costMicroUsd is non-null (DEFAULT 0). The env predicate is redundant
    // with the env-literal RLS policy (which already scopes the role to one tier)
    // but is kept explicit so the query rides the (appId, env, createdAt) index.
    return withPartition(this.#pool, appId, null, env, async (client) => {
      const result = await client.query(
        `SELECT
           COALESCE(SUM("costMicroUsd") FILTER (WHERE "createdAt" >= date_trunc('day', now())), 0)::bigint AS today,
           COALESCE(SUM("costMicroUsd") FILTER (WHERE "createdAt" >= now() - interval '1 hour'), 0)::bigint AS hour
         FROM gateway_calls
         WHERE "appId" = $1 AND env = $2 AND capability = 'llm'
           AND "createdAt" >= date_trunc('day', now()) - interval '1 hour'`,
        [appId, env],
      );
      // SUM(::bigint) comes back as a string from pg; Number is safe well below
      // 2^53 for any realistic daily micro-USD total (1e6 = $1).
      const row = result.rows[0] as { today: string | number; hour: string | number } | undefined;
      return { todayMicro: row ? Number(row.today) : 0, hourMicro: row ? Number(row.hour) : 0 };
    });
  }

  async dataWritesToday(appId: string, env: Env): Promise<number> {
    return withPartition(this.#pool, appId, null, env, async (client) => {
      const result = await client.query(
        `SELECT COUNT(*)::int AS n
         FROM gateway_calls
         WHERE "appId" = $1 AND env = $2 AND capability = 'data' AND outcome = 'ok'
           AND model = ANY($3) AND "createdAt" >= date_trunc('day', now())`,
        [appId, env, DATA_WRITE_VERBS],
      );
      const row = result.rows[0] as { n: string | number } | undefined;
      return row ? Number(row.n) : 0;
    });
  }

  async fetchRequestsToday(appId: string, env: Env): Promise<number> {
    return withPartition(this.#pool, appId, null, env, async (client) => {
      const result = await client.query(
        `SELECT COUNT(*)::int AS n
         FROM gateway_calls
         WHERE "appId" = $1 AND env = $2 AND capability = 'fetch' AND outcome <> 'quota_blocked'
           AND "createdAt" >= date_trunc('day', now())`,
        [appId, env],
      );
      const row = result.rows[0] as { n: string | number } | undefined;
      return row ? Number(row.n) : 0;
    });
  }

  async record(call: GatewayCallRecord): Promise<void> {
    await withPartition(this.#pool, call.appId, null, call.env, async (client) => {
      await client.query(
        // Prisma's @default(uuid()) is client-side, so the raw INSERT supplies
        // the id itself (gen_random_uuid() — built into Postgres). `env` is set
        // explicitly (not left to the column default) so a `dev` row satisfies the
        // helix_dev WITH CHECK (env='dev') — the default 'prod' would fail it.
        // Optional metering columns fall back to their column defaults / NULL.
        `INSERT INTO gateway_calls
           (id, "appId", env, "userOid", capability, model, "inputTokens", "outputTokens",
            "cacheReadInputTokens", "cacheCreationInputTokens", "costMicroUsd", outcome,
            "durationMs", "statusCode", "stopReason", "errorDetail")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          call.appId,
          call.env,
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
    });
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
