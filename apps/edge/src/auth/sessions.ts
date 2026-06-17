import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";

/**
 * Server-side app-user sessions (architecture Appendix A.4), in the portal-
 * migrated `sessions` table, accessed with hand-written SQL (no ORM in the
 * edge — project plan §1). Server-side rather than a self-contained JWT so
 * revocation is real: deleting the row kills the session on the next request.
 *
 * Lifecycle: `/callback` inserts a *pending* row (`tokenHash` NULL, `id` =
 * the handoff jti) → `/_auth/complete` redeems it by atomically binding the
 * cookie-token hash → every request looks the row up by that hash. The
 * redeem UPDATE is the single-use guarantee of the whole handoff design.
 */

export interface SessionUser {
  /** IdP subject (Entra object id shaped). */
  oid: string;
  displayName: string;
  /** Group-id snapshot taken at login/refresh. */
  groups: string[];
}

export interface Session {
  id: string;
  appId: string;
  user: SessionUser;
  refreshDueAt: Date;
  expiresAt: Date;
}

export interface SessionStore {
  /** Insert the pending row at `/callback`; `id` doubles as the handoff jti. */
  createPending(session: Session): Promise<void>;
  /**
   * Insert an already-active row, binding the cookie-token hash up front. The
   * shared-password flow (`password` visibility) has no handoff to redeem — the
   * challenge is same-origin on the app host — so it skips the pending/redeem
   * dance and inserts the live session directly.
   */
  createActive(session: Session, tokenHash: string): Promise<void>;
  /**
   * Atomically redeem the pending row for this app, binding the cookie-token
   * hash. False — already redeemed (replay), expired, unknown id, or an
   * appId mismatch — must yield a 403 with no cookie.
   */
  redeem(id: string, appId: string, tokenHash: string): Promise<boolean>;
  /** Active-session lookup by cookie-token hash, scoped to the app. */
  lookup(tokenHash: string, appId: string): Promise<Session | null>;
  /** Logout: drop the row (no-op if absent). */
  delete(tokenHash: string, appId: string): Promise<void>;
  /** GC long-expired rows and never-redeemed pendings; returns rows removed. */
  sweep(): Promise<number>;
  close(): Promise<void>;
}

/** Fresh opaque cookie value — never the URL-borne handoff token. */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Stored form of the cookie value; a DB read-leak yields no usable cookies. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newSessionId(): string {
  return randomUUID();
}

function toGroups(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((g): g is string => typeof g === "string") : [];
}

export class PgSessionStore implements SessionStore {
  #pool: Pool;

  constructor(databaseUrl: string, opts: { max?: number } = {}) {
    this.#pool = new Pool({ connectionString: databaseUrl, max: opts.max ?? 10 });
  }

  async createPending(session: Session): Promise<void> {
    await this.#pool.query(
      `INSERT INTO sessions (id, "appId", "userOid", "displayName", groups, "refreshDueAt", "expiresAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        session.id,
        session.appId,
        session.user.oid,
        session.user.displayName,
        JSON.stringify(session.user.groups),
        session.refreshDueAt,
        session.expiresAt,
      ],
    );
  }

  async createActive(session: Session, tokenHash: string): Promise<void> {
    await this.#pool.query(
      `INSERT INTO sessions (id, "tokenHash", "appId", "userOid", "displayName", groups, "activatedAt", "refreshDueAt", "expiresAt")
       VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8)`,
      [
        session.id,
        tokenHash,
        session.appId,
        session.user.oid,
        session.user.displayName,
        JSON.stringify(session.user.groups),
        session.refreshDueAt,
        session.expiresAt,
      ],
    );
  }

  async redeem(id: string, appId: string, tokenHash: string): Promise<boolean> {
    // Single statement, single use: only one concurrent redeem can observe
    // "tokenHash" IS NULL. The appId predicate is deliberate redundancy with
    // the handoff JWS `aud` check — either alone defeats audience confusion.
    const result = await this.#pool.query(
      `UPDATE sessions
       SET "tokenHash" = $1, "activatedAt" = now()
       WHERE id = $2 AND "appId" = $3 AND "tokenHash" IS NULL AND "expiresAt" > now()`,
      [tokenHash, id, appId],
    );
    return result.rowCount === 1;
  }

  async lookup(tokenHash: string, appId: string): Promise<Session | null> {
    const result = await this.#pool.query(
      `SELECT id, "appId", "userOid", "displayName", groups, "refreshDueAt", "expiresAt"
       FROM sessions
       WHERE "tokenHash" = $1 AND "appId" = $2 AND "expiresAt" > now()`,
      [tokenHash, appId],
    );
    const row = result.rows[0] as
      | {
          id: string;
          appId: string;
          userOid: string;
          displayName: string;
          groups: unknown;
          refreshDueAt: Date;
          expiresAt: Date;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      appId: row.appId,
      user: { oid: row.userOid, displayName: row.displayName, groups: toGroups(row.groups) },
      refreshDueAt: row.refreshDueAt,
      expiresAt: row.expiresAt,
    };
  }

  async delete(tokenHash: string, appId: string): Promise<void> {
    await this.#pool.query(`DELETE FROM sessions WHERE "tokenHash" = $1 AND "appId" = $2`, [
      tokenHash,
      appId,
    ]);
  }

  async sweep(): Promise<number> {
    // Expired rows linger a day for debuggability; pendings die fast — a
    // handoff is 30 s, so a 10-minute-old pending row is necessarily junk.
    const result = await this.#pool.query(
      `DELETE FROM sessions
       WHERE ("expiresAt" < now() - interval '1 day')
          OR ("tokenHash" IS NULL AND "createdAt" < now() - interval '10 minutes')`,
    );
    return result.rowCount ?? 0;
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

export interface SweeperLogger {
  info(msg: string): void;
  warn(obj: object, msg: string): void;
}

/** Periodic GC; unref'd so it never holds the process open. */
export function startSessionSweeper(
  store: SessionStore,
  opts: { intervalMs?: number; log: SweeperLogger },
): { stop(): void } {
  const interval = setInterval(
    () => {
      store
        .sweep()
        .then((removed) => {
          if (removed > 0) opts.log.info(`session sweep removed ${removed} rows`);
        })
        .catch((err: unknown) => opts.log.warn({ err }, "session sweep failed"));
    },
    opts.intervalMs ?? 15 * 60 * 1000,
  );
  interval.unref();
  return { stop: () => clearInterval(interval) };
}
