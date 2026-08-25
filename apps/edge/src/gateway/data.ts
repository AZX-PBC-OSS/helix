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

/**
 * A stored value plus its opaque concurrency token (ADR-0041). `version` is a
 * BIGINT in Postgres and stays a STRING all the way out (pg returns BIGINT as
 * string): no Number precision question and no formatting step where the token
 * can lose fidelity — the bug class that disqualified `updatedAt`.
 */
export interface StoredValue {
  value: unknown;
  version: string;
}

/**
 * The concurrency precondition on a write (ADR-0041 decision 3). Each kind maps
 * to its own statement — never one clever upsert, because
 * `INSERT … ON CONFLICT DO UPDATE … WHERE version = $n` silently passes when no
 * row exists even though the client asserted there was a current value.
 */
export type WritePrecondition =
  /** No precondition — last-write-wins. Legal on `user` scope only. */
  | { kind: "none" }
  /** `If-Match: "<version>"` — write only if the current row is this version. */
  | { kind: "ifMatch"; version: string }
  /** `If-None-Match: *` — create-if-absent; how an app claims an unwritten key. */
  | { kind: "ifNoneMatch" };

/**
 * What a `shared` write may carry (ADR-0041 decision 4): preconditions are
 * mandatory there, so `none` is excluded at the type level — the handler 428s
 * before this call, and the type says so.
 */
export type SharedWritePrecondition = Exclude<WritePrecondition, { kind: "none" }>;

/**
 * The result of a conditional write. `conflict` maps to HTTP 412 — a stated
 * precondition did not hold (the row moved, or already existed for
 * create-if-absent). The loser is NOT metered (decision 7).
 */
export type PutResult = { kind: "ok"; version: string; updatedAt: string } | { kind: "conflict" };

/** Server-stamped abuse-triage metadata for a collection append (never echoed). */
export interface CollectionMeta {
  /** Hashed client IP (coarse — see the handler). */
  ipHash?: string;
  /** Truncated User-Agent. */
  ua?: string;
}

export interface AppDataStore {
  /** Read one of the caller's own user-scoped keys (value + version); null if absent. */
  getUserKey(appId: string, userOid: string, key: string, env: Env): Promise<StoredValue | null>;
  /**
   * Write one of the caller's own user-scoped keys under `precondition`
   * (ADR-0041): `{ kind: "none" }` is the scope's last-write-wins default; a
   * stated precondition is honored identically in both scopes (decision 4).
   */
  putUserKey(
    appId: string,
    userOid: string,
    key: string,
    value: unknown,
    env: Env,
    precondition: WritePrecondition,
  ): Promise<PutResult>;
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
  /** Read an app-shared key (§3.3, userOid IS NULL; value + version); null if absent. */
  getShared(appId: string, key: string, env: Env): Promise<StoredValue | null>;
  /**
   * Write an app-shared key (§3.3) under a MANDATORY precondition (ADR-0041
   * decision 4): the handler refuses precondition-less shared writes with 428,
   * and this signature makes that unrepresentable.
   */
  putShared(
    appId: string,
    key: string,
    value: unknown,
    env: Env,
    precondition: SharedWritePrecondition,
  ): Promise<PutResult>;
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

  async getUserKey(
    appId: string,
    userOid: string,
    key: string,
    env: Env,
  ): Promise<StoredValue | null> {
    return withPartition(this.#pool, appId, userOid, env, async (client) => {
      const r = await client.query(
        `SELECT value, version FROM app_data WHERE "appId" = $1 AND env = $2 AND "userOid" = $3 AND key = $4`,
        [appId, env, userOid, key],
      );
      const row = r.rows[0] as { value: unknown; version: string } | undefined;
      // BIGINT arrives as a string from pg and stays one — the ETag round-trips
      // with no Number conversion anywhere (ADR-0041 decision 1).
      return row ? { value: row.value, version: row.version } : null;
    });
  }

  async putUserKey(
    appId: string,
    userOid: string,
    key: string,
    value: unknown,
    env: Env,
    precondition: WritePrecondition,
  ): Promise<PutResult> {
    return withPartition(this.#pool, appId, userOid, env, async (client) => {
      // JSON.stringify + ::jsonb so every JSON type (string, number, object,
      // array) round-trips uniformly; a bare string param would not cast.
      const json = JSON.stringify(value);
      // ADR-0041 decision 3: each precondition kind is its OWN statement. The
      // tempting single upsert (`ON CONFLICT DO UPDATE … WHERE version = $n`)
      // is wrong — it inserts when no row exists even though the client
      // asserted a current version, passing the exact failure CAS exists to
      // catch. Zero rows back from a conditional statement ⇒ conflict (412).
      const row = await (async (): Promise<{ version: string; updatedAt: Date } | undefined> => {
        switch (precondition.kind) {
          case "none":
            // user scope's last-write-wins default (decision 4).
            return (
              await client.query(
                `INSERT INTO app_data (id, "appId", env, "userOid", key, value, "updatedAt")
                   VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, now())
                 ON CONFLICT ("appId", env, "userOid", key)
                   DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now(),
                                 version = app_data.version + 1
                 RETURNING version, "updatedAt"`,
                [appId, env, userOid, key, json],
              )
            ).rows[0];
          case "ifMatch":
            // The version read is part of the WHERE: under READ COMMITTED,
            // Postgres re-evaluates it after waiting on the row lock, so
            // exactly one of two writers on the same base version matches —
            // the guarantee casPolicyWrite relies on, control-plane side.
            return (
              await client.query(
                `UPDATE app_data
                    SET value = $5::jsonb, "updatedAt" = now(), version = version + 1
                  WHERE "appId" = $1 AND env = $2 AND "userOid" = $3 AND key = $4
                    AND version = $6
                  RETURNING version, "updatedAt"`,
                [appId, env, userOid, key, json, precondition.version],
              )
            ).rows[0];
          case "ifNoneMatch":
            // Create-if-absent: how an app claims a key it believes unwritten.
            return (
              await client.query(
                `INSERT INTO app_data (id, "appId", env, "userOid", key, value, "updatedAt")
                   VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, now())
                 ON CONFLICT ("appId", env, "userOid", key) DO NOTHING
                 RETURNING version, "updatedAt"`,
                [appId, env, userOid, key, json],
              )
            ).rows[0];
        }
      })();
      if (!row) return { kind: "conflict" };
      return { kind: "ok", version: row.version, updatedAt: row.updatedAt.toISOString() };
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

  async getShared(appId: string, key: string, env: Env): Promise<StoredValue | null> {
    // Shared rows have userOid IS NULL; the RLS policy admits them regardless of
    // the user_oid GUC, so any empty user partition value is fine — only app_id
    // and env must match. Still run inside the partition transaction for consistency.
    return withPartition(this.#pool, appId, "", env, async (client) => {
      const r = await client.query(
        `SELECT value, version FROM app_data WHERE "appId" = $1 AND env = $2 AND "userOid" IS NULL AND key = $3`,
        [appId, env, key],
      );
      const row = r.rows[0] as { value: unknown; version: string } | undefined;
      return row ? { value: row.value, version: row.version } : null;
    });
  }

  async putShared(
    appId: string,
    key: string,
    value: unknown,
    env: Env,
    precondition: SharedWritePrecondition,
  ): Promise<PutResult> {
    return withPartition(this.#pool, appId, "", env, async (client) => {
      const json = JSON.stringify(value);
      // Same three-statement shape as putUserKey (ADR-0041 decision 3) on the
      // shared partition's partial unique index — minus the `none` form, which
      // this scope forbids (decision 4; the type above carries that).
      const row = await (async (): Promise<{ version: string; updatedAt: Date } | undefined> => {
        switch (precondition.kind) {
          case "ifMatch":
            return (
              await client.query(
                `UPDATE app_data
                    SET value = $4::jsonb, "updatedAt" = now(), version = version + 1
                  WHERE "appId" = $1 AND env = $2 AND "userOid" IS NULL AND key = $3
                    AND version = $5
                  RETURNING version, "updatedAt"`,
                [appId, env, key, json, precondition.version],
              )
            ).rows[0];
          case "ifNoneMatch":
            return (
              await client.query(
                `INSERT INTO app_data (id, "appId", env, "userOid", key, value, "updatedAt")
                   VALUES (gen_random_uuid(), $1, $2, NULL, $3, $4::jsonb, now())
                 ON CONFLICT ("appId", env, key) WHERE "userOid" IS NULL DO NOTHING
                 RETURNING version, "updatedAt"`,
                [appId, env, key, json],
              )
            ).rows[0];
        }
      })();
      if (!row) return { kind: "conflict" };
      return { kind: "ok", version: row.version, updatedAt: row.updatedAt.toISOString() };
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
