import { Pool, type PoolClient } from "pg";

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
  getUserKey(appId: string, userOid: string, key: string): Promise<unknown>;
  /** Upsert one of the caller's own user-scoped keys; returns updatedAt. */
  putUserKey(appId: string, userOid: string, key: string, value: unknown): Promise<string>;
  /** Delete one of the caller's own user-scoped keys; true if a row was removed. */
  deleteUserKey(appId: string, userOid: string, key: string): Promise<boolean>;
  /** List the caller's own user-scoped keys (no values). */
  listUserKeys(appId: string, userOid: string): Promise<UserKeyMeta[]>;
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
  ): Promise<void>;
  /** Read an app-shared key (§3.3, userOid IS NULL); null if absent. */
  getShared(appId: string, key: string): Promise<unknown>;
  /** Upsert an app-shared key (§3.3); returns updatedAt. */
  putShared(appId: string, key: string, value: unknown): Promise<string>;
  close(): Promise<void>;
}

export class PgAppDataStore implements AppDataStore {
  #pool: Pool;

  constructor(databaseUrl: string, opts: { max?: number } = {}) {
    this.#pool = new Pool({ connectionString: databaseUrl, max: opts.max ?? 10 });
  }

  /**
   * Run `fn` in a transaction with the RLS partition GUCs set from the verified
   * session. `set_config(name, value, true)` is the parameterized, is_local
   * form of `SET LOCAL` — transaction-scoped, pgbouncer-safe, no interpolation.
   */
  async #withPartition<T>(
    appId: string,
    userOid: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.app_id', $1, true), set_config('app.user_oid', $2, true)",
        [appId, userOid],
      );
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

  async getUserKey(appId: string, userOid: string, key: string): Promise<unknown> {
    return this.#withPartition(appId, userOid, async (client) => {
      const r = await client.query(
        `SELECT value FROM app_data WHERE "appId" = $1 AND "userOid" = $2 AND key = $3`,
        [appId, userOid, key],
      );
      return (r.rows[0] as { value: unknown } | undefined)?.value ?? null;
    });
  }

  async putUserKey(appId: string, userOid: string, key: string, value: unknown): Promise<string> {
    return this.#withPartition(appId, userOid, async (client) => {
      // JSON.stringify + ::jsonb so every JSON type (string, number, object,
      // array) round-trips uniformly; a bare string param would not cast.
      const r = await client.query(
        `INSERT INTO app_data (id, "appId", "userOid", key, value, "updatedAt")
           VALUES (gen_random_uuid(), $1, $2, $3, $4::jsonb, now())
         ON CONFLICT ("appId", "userOid", key)
           DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()
         RETURNING "updatedAt"`,
        [appId, userOid, key, JSON.stringify(value)],
      );
      return (r.rows[0] as { updatedAt: Date }).updatedAt.toISOString();
    });
  }

  async deleteUserKey(appId: string, userOid: string, key: string): Promise<boolean> {
    return this.#withPartition(appId, userOid, async (client) => {
      const r = await client.query(
        `DELETE FROM app_data WHERE "appId" = $1 AND "userOid" = $2 AND key = $3`,
        [appId, userOid, key],
      );
      return (r.rowCount ?? 0) > 0;
    });
  }

  async listUserKeys(appId: string, userOid: string): Promise<UserKeyMeta[]> {
    return this.#withPartition(appId, userOid, async (client) => {
      const r = await client.query(
        `SELECT key, "updatedAt" FROM app_data
         WHERE "appId" = $1 AND "userOid" = $2 ORDER BY key`,
        [appId, userOid],
      );
      return (r.rows as { key: string; updatedAt: Date }[]).map((row) => ({
        key: row.key,
        updatedAt: row.updatedAt.toISOString(),
      }));
    });
  }

  async getShared(appId: string, key: string): Promise<unknown> {
    // Shared rows have userOid IS NULL; the RLS policy admits them regardless of
    // the user_oid GUC, so any empty user partition value is fine — only app_id
    // must match. Still run inside the partition transaction for consistency.
    return this.#withPartition(appId, "", async (client) => {
      const r = await client.query(
        `SELECT value FROM app_data WHERE "appId" = $1 AND "userOid" IS NULL AND key = $2`,
        [appId, key],
      );
      return (r.rows[0] as { value: unknown } | undefined)?.value ?? null;
    });
  }

  async putShared(appId: string, key: string, value: unknown): Promise<string> {
    return this.#withPartition(appId, "", async (client) => {
      const r = await client.query(
        `INSERT INTO app_data (id, "appId", "userOid", key, value, "updatedAt")
           VALUES (gen_random_uuid(), $1, NULL, $2, $3::jsonb, now())
         ON CONFLICT ("appId", key) WHERE "userOid" IS NULL
           DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()
         RETURNING "updatedAt"`,
        [appId, key, JSON.stringify(value)],
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
  ): Promise<void> {
    // Plain INSERT — no transaction or RLS: the edge role has INSERT-only on
    // this table, which IS the containment. There is no read to scope.
    await this.#pool.query(
      `INSERT INTO app_collection_items (id, "appId", collection, "userOid", item, meta)
         VALUES (gen_random_uuid(), $1, $2, $3, $4::jsonb, $5::jsonb)`,
      [appId, collection, userOid, JSON.stringify(item), JSON.stringify(meta)],
    );
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
