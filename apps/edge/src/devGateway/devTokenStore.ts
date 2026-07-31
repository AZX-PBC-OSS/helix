import { type Pool } from "pg";

import { createEdgePool, type EdgePoolOpts } from "../db/pool.js";

/**
 * Reads the portal-owned `app_dev_token` table (dev-mode design §4, Appendix A.3)
 * as the least-privilege `helix_dev` role — the dev-gateway's SELECT-only view of
 * the credential it verifies. Plain `pool.query` (no `withPartition`): the table
 * has no RLS and is not in the ADR-0002 partitioned-table lint set, so raw SQL is
 * allowed here. Never reads `material`/secrets; the row carries only the hash-keyed
 * binding (app, developer, origins, lifetime).
 */

export interface DevTokenRow {
  appId: string;
  developerOid: string;
  origins: string[];
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface DevTokenStore {
  /** Look up a token by its SHA-256 hash (the unique key); null if unknown. */
  resolve(tokenHash: string): Promise<DevTokenRow | null>;
  /**
   * Whether `origin` is registered on any live (non-revoked, non-expired) token
   * for `appId` — the credential-less check the CORS preflight needs (a preflight
   * carries no Authorization).
   */
  originAllowed(appId: string, origin: string): Promise<boolean>;
  close(): Promise<void>;
}

export class PgDevTokenStore implements DevTokenStore {
  #pool: Pool;

  constructor(databaseUrl: string, opts: EdgePoolOpts = {}) {
    // Spread, don't re-list — see the note in auth/sessions.ts.
    this.#pool = createEdgePool(databaseUrl, {
      ...opts,
      max: opts.max ?? 5,
      label: opts.label ?? "dev-tokens",
    });
  }

  async resolve(tokenHash: string): Promise<DevTokenRow | null> {
    const r = await this.#pool.query(
      `SELECT "appId", "developerOid", origins, "expiresAt", "revokedAt"
         FROM app_dev_token WHERE "tokenHash" = $1`,
      [tokenHash],
    );
    return (r.rows[0] as DevTokenRow | undefined) ?? null;
  }

  async originAllowed(appId: string, origin: string): Promise<boolean> {
    const r = await this.#pool.query(
      `SELECT 1 FROM app_dev_token
        WHERE "appId" = $1 AND "revokedAt" IS NULL AND "expiresAt" > now()
          AND $2 = ANY(origins)
        LIMIT 1`,
      [appId, origin],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
