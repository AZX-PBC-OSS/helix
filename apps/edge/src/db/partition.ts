import { type Pool, type PoolClient } from "pg";

import { type Env } from "@azx-pbc/shared";

/**
 * Run `fn` in a transaction with the RLS partition GUCs set from the VERIFIED
 * session (app-data design §2.1, Appendix A.3 / ADR-0002; dev-mode design §5.2).
 * This is the one place the edge sets `app.app_id`, `app.env`, and (when scoped)
 * `app.user_oid`, so every RLS-guarded table the edge touches — `app_data`,
 * `gateway_calls`, `app_collection_items` — is scoped the same way.
 *
 * `set_config(name, value, true)` is the parameterized, is_local form of
 * `SET LOCAL`: transaction-scoped (resets on commit, so a pooled connection
 * never leaks one request's tenant context into the next), pgbouncer-safe, and
 * with no string interpolation into SQL. The values are server-derived (registry
 * entry + session), never app input.
 *
 * `env` ('prod' | 'dev') is the dev-mode partition dimension: it is set here from
 * the resolved `Caller` (`prod` on every production path today; only the dev
 * surfaces set `dev`). The GUC is convenience / defense-in-depth — each runtime
 * role's RLS policy hardcodes its env literal (`helix_edge` → 'prod',
 * `helix_dev` → 'dev'), so the boundary holds even if this GUC were wrong (§5.3).
 *
 * `app.user_oid` is set only when `userOid` is non-null. `gateway_calls`'
 * partition is `appId`-only, so its callers pass `null`; `app_data`'s policy also
 * reads `app.user_oid`, so its callers pass the caller's oid (or `""` for the
 * shared partition, whose rows have `userOid IS NULL` and match regardless).
 * A missing GUC resolves to NULL via `current_setting(..., true)`, so any path
 * that forgets to set it matches zero rows / fails the WITH CHECK — fail-closed.
 */
export async function withPartition<T>(
  pool: Pool,
  appId: string,
  userOid: string | null,
  env: Env,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (userOid === null) {
      await client.query(
        "SELECT set_config('app.app_id', $1, true), set_config('app.env', $2, true)",
        [appId, env],
      );
    } else {
      await client.query(
        "SELECT set_config('app.app_id', $1, true), set_config('app.env', $2, true), set_config('app.user_oid', $3, true)",
        [appId, env, userOid],
      );
    }
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
