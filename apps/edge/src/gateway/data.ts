import { type Pool } from "pg";

import { type Env } from "@azx-pbc/shared";

import { createEdgePool, type EdgePoolOpts } from "../db/pool.js";
import { withPartition } from "../db/partition.js";

/**
 * App data storage (architecture §6.1, app-data design §3) — the gateway's
 * second capability after the LLM proxy. Lives in the portal-migrated `app_data`
 * and `app_collection_items` tables, accessed with hand-written SQL (no ORM in
 * the edge — project plan §1).
 *
 * The load-bearing property is structural: this store has **caller-scoped
 * methods only**. There is deliberately NO `listCollection` / `getCollection`
 * method — the §3.2 write-only collection invariant is carried into the type
 * system, not just the route table. The owner-facing drain is a portal-only
 * operation on the privileged DB role.
 *
 * Every `app_data` access runs in a transaction that sets the RLS partition GUCs
 * from the VERIFIED session via `set_config` (app-data design §2.1, Appendix
 * A.3) — `SET LOCAL`, never bare `SET`, so it resets on commit and is safe under
 * transaction-mode pgbouncer. The values are server-derived (registry entry +
 * session), and `set_config` parameterizes them, so there is no app input and no
 * string interpolation into SQL.
 */

export interface UserKeyMeta {
  key: string;
  updatedAt: string;
}

/** Server-stamped abuse-triage metadata for a collection append (never echoed). */
export interface CollectionMeta {
  /** Hashed client IP (coarse — see the handler). */
  ipHash?: string;
  /** Truncated User-Agent. */
  ua?: string;
}

export interface AppDataStore {
  /** Read one of the caller's own user-scoped keys; null if absent. */
  getUserKey(appId: string, userOid: string, key: string, env: Env): Promise<unknown>;
  /** Upsert one of the caller's own user-scoped keys; returns updatedAt. */
  putUserKey(
    appId: string,
    userOid: string,
    key: string,
    value: unknown,
    env: Env,
  ): Promise<string>;
  /** Delete one of the caller's own user-scoped keys; true if a row was removed. */
  deleteUserKey(appId: string, userOid: string, key: string, env: Env): Promise<boolean>;
  /** List the caller's own user-scoped keys (no values). */
  listUserKeys(appId: string, userOid: string, env: Env): Promise<UserKeyMeta[]>;
  /**
   * Append one item to a collection (§3.2). Write-only by construction — the
   * edge role has INSERT and no SELECT, so there is intentionally no method to
   * read or enumerate a collection here. `userOid` is null for anon visitors.
   */
  appendCollection(
    appId: string,
    collection: string,
    item: unknown,
    userOid: string | null,
    meta: CollectionMeta,
    env: Env,
  ): Promise<void>;
  /** Read an app-shared key (§3.3, userOid IS NULL); null if absent. */
  getShared(appId: string, key: string, env: Env): Promise<unknown>;
  /** Upsert an app-shared key (§3.3); returns updatedAt. */
  putShared(appId: string, key: string, value: unknown, env: Env): Promise<string>;
  close(): Promise<void>;
}

export class PgAppDataStore implements AppDataStore {
  #pool: Pool;

  constructor(databaseUrl: string, opts: EdgePoolOpts = {}) {
    // Spread, don't re-list — see the note in auth/sessions.ts.
    this.#pool = createEdgePool(databaseUrl, {
      ...opts,
      max: opts.max ?? 10,
      label: opts.label ?? "app-data",
    });
  }

  async getUserKey(appId: string, userOid: string, key: string, env: Env): Promise<unknown> {
    return withPartition(this.#pool, appId, userOid, env, async (client) => {
      const r = await client.query(
        `SELECT value FROM app_data WHERE "appId" = $1 AND env = $2 AND "userOid" = $3 AND key = $4`,
        [appId, env, userOid, key],
      );
      return (r.rows[0] as { value: unknown } | undefined)?.value ?? null;
    });
  }

  async putUserKey(
    appId: string,
    userOid: string,
    key: string,
    value: unknown,
    env: Env,
  ): Promise<string> {
    return withPartition(this.#pool, appId, userOid, env, async (client) => {
      // JSON.stringify + ::jsonb so every JSON type (string, number, object,
      // array) round-trips uniformly; a bare string param would not cast.
      const r = await client.query(
        `INSERT INTO app_data (id, "appId", env, "userOid", key, value, "updatedAt")
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, now())
         ON CONFLICT ("appId", env, "userOid", key)
           DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()
         RETURNING "updatedAt"`,
        [appId, env, userOid, key, JSON.stringify(value)],
      );
      return (r.rows[0] as { updatedAt: Date }).updatedAt.toISOString();
    });
  }

  async deleteUserKey(appId: string, userOid: string, key: string, env: Env): Promise<boolean> {
    return withPartition(this.#pool, appId, userOid, env, async (client) => {
      const r = await client.query(
        `DELETE FROM app_data WHERE "appId" = $1 AND env = $2 AND "userOid" = $3 AND key = $4`,
        [appId, env, userOid, key],
      );
      return (r.rowCount ?? 0) > 0;
    });
  }

  async listUserKeys(appId: string, userOid: string, env: Env): Promise<UserKeyMeta[]> {
    return withPartition(this.#pool, appId, userOid, env, async (client) => {
      const r = await client.query(
        `SELECT key, "updatedAt" FROM app_data
         WHERE "appId" = $1 AND env = $2 AND "userOid" = $3 ORDER BY key`,
        [appId, env, userOid],
      );
      return (r.rows as { key: string; updatedAt: Date }[]).map((row) => ({
        key: row.key,
        updatedAt: row.updatedAt.toISOString(),
      }));
    });
  }

  async getShared(appId: string, key: string, env: Env): Promise<unknown> {
    // Shared rows have userOid IS NULL; the RLS policy admits them regardless of
    // the user_oid GUC, so any empty user partition value is fine — only app_id
    // and env must match. Still run inside the partition transaction for consistency.
    return withPartition(this.#pool, appId, "", env, async (client) => {
      const r = await client.query(
        `SELECT value FROM app_data WHERE "appId" = $1 AND env = $2 AND "userOid" IS NULL AND key = $3`,
        [appId, env, key],
      );
      return (r.rows[0] as { value: unknown } | undefined)?.value ?? null;
    });
  }

  async putShared(appId: string, key: string, value: unknown, env: Env): Promise<string> {
    return withPartition(this.#pool, appId, "", env, async (client) => {
      const r = await client.query(
        `INSERT INTO app_data (id, "appId", env, "userOid", key, value, "updatedAt")
           VALUES (gen_random_uuid(), $1, $2, NULL, $3, $4::jsonb, now())
         ON CONFLICT ("appId", env, key) WHERE "userOid" IS NULL
           DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()
         RETURNING "updatedAt"`,
        [appId, env, key, JSON.stringify(value)],
      );
      return (r.rows[0] as { updatedAt: Date }).updatedAt.toISOString();
    });
  }

  async appendCollection(
    appId: string,
    collection: string,
    item: unknown,
    userOid: string | null,
    meta: CollectionMeta,
    env: Env,
  ): Promise<void> {
    // INSERT-only for the edge role — the absence of SELECT/DELETE is the §3.2
    // write-only containment. On top of that, RLS partitions the write: the
    // `app_collection_items_edge_partition` policy's WITH CHECK requires the row
    // to land in the app named by the `app.app_id` GUC, so an appId-confusion
    // bug (or a no-GUC path) can't pollute another app's collection — it fails
    // closed. The collection is app-scoped (no per-user read), so no user_oid
    // GUC; the row's own `userOid` column still records the submitter.
    await withPartition(this.#pool, appId, null, env, async (client) => {
      await client.query(
        `INSERT INTO app_collection_items (id, "appId", env, collection, "userOid", item, meta)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [appId, env, collection, userOid, JSON.stringify(item), JSON.stringify(meta)],
      );
    });
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
