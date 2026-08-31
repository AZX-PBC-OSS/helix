import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type Pool } from "pg";

import { createEdgePool, type EdgePoolOpts } from "../db/pool.js";
import { withPartition } from "../db/partition.js";
import type { PrincipalKind } from "@azx-pbc/shared";

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

/**
 * The kinds a *session* can hold. `anon` and `dev` are deliberately absent: a
 * public visitor never gets a session row, and a dev-token caller is resolved
 * per request from `app_dev_token` rather than from one. Narrowing here makes
 * those two unrepresentable rather than merely unused.
 */
export type SessionKind = Extract<PrincipalKind, "user" | "password">;

export interface SessionUser {
  /**
   * IdP subject — Entra's **pairwise** `sub`, not the directory object id the
   * field name suggests (see `OidcIdentity.oid`). The identity half: compared,
   * never rendered.
   */
  oid: string;
  /** Non-empty, for `GET /_api/me`; falls back to {@link oid}. */
  displayName: string;
  /**
   * The display half — captured claims, rendered but never compared. Stamped onto
   * the gateway ledger and collection rows so those stay attributable after this
   * session is swept. Null for password/anonymous principals, and whenever the
   * IdP sent no such claim.
   */
  name: string | null;
  email: string | null;
  /**
   * Which path minted this principal. **Null only for a session row written
   * before the column existed** — those are swept within ~32 h (8 h TTL + the
   * one-day sweep grace), so it self-heals. Null propagates all the way to the
   * ledger rather than defaulting to a kind: guessing here is the exact failure
   * this column was added to remove.
   */
  kind: SessionKind | null;
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

  constructor(databaseUrl: string, opts: EdgePoolOpts = {}) {
    // Spread, don't re-list: enumerating fields silently drops any hook the
    // caller passed (this is how `onClientError` went unreported for five stores).
    this.#pool = createEdgePool(databaseUrl, {
      ...opts,
      max: opts.max ?? 10,
      label: opts.label ?? "sessions",
    });
  }

  async createPending(session: Session): Promise<void> {
    // Wrapped in the RLS partition (ADR-0002): the sessions_edge_partition WITH
    // CHECK requires the row's appId to equal app.app_id, so a pending row can
    // only ever be minted in its own app's partition.
    await withPartition(this.#pool, session.appId, null, "prod", (client) =>
      client.query(
        `INSERT INTO sessions (id, "appId", "userOid", "displayName", "userName", "userEmail", "userKind", groups, "refreshDueAt", "expiresAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          session.id,
          session.appId,
          session.user.oid,
          session.user.displayName,
          session.user.name,
          session.user.email,
          session.user.kind,
          JSON.stringify(session.user.groups),
          session.refreshDueAt,
          session.expiresAt,
        ],
      ),
    );
  }

  async createActive(session: Session, tokenHash: string): Promise<void> {
    await withPartition(this.#pool, session.appId, null, "prod", (client) =>
      client.query(
        `INSERT INTO sessions (id, "tokenHash", "appId", "userOid", "displayName", "userName", "userEmail", "userKind", groups, "activatedAt", "refreshDueAt", "expiresAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10, $11)`,
        [
          session.id,
          tokenHash,
          session.appId,
          session.user.oid,
          session.user.displayName,
          session.user.name,
          session.user.email,
          session.user.kind,
          JSON.stringify(session.user.groups),
          session.refreshDueAt,
          session.expiresAt,
        ],
      ),
    );
  }

  async redeem(id: string, appId: string, tokenHash: string): Promise<boolean> {
    // Single statement, single use: only one concurrent redeem can observe
    // "tokenHash" IS NULL. The appId predicate is deliberate redundancy with
    // the handoff JWS `aud` check — either alone defeats audience confusion.
    // Under the RLS partition, the row is also only visible/updatable within
    // its own app (app.app_id), so a cross-app redeem can't even see the row.
    return withPartition(this.#pool, appId, null, "prod", async (client) => {
      const result = await client.query(
        `UPDATE sessions
       SET "tokenHash" = $1, "activatedAt" = now()
       WHERE id = $2 AND "appId" = $3 AND "tokenHash" IS NULL AND "expiresAt" > now()`,
        [tokenHash, id, appId],
      );
      return result.rowCount === 1;
    });
  }

  async lookup(tokenHash: string, appId: string): Promise<Session | null> {
    // The gate's hot path (runs per request on gated apps). Reads through the
    // SECURITY DEFINER `session_lookup` function (ADR-0002) rather than the raw
    // table: one round-trip, no partition transaction, and helix_edge cannot
    // enumerate the table directly (RLS scopes a bare SELECT to zero rows). The
    // function applies the same (tokenHash, appId, expiresAt > now()) filter.
    const result = await this.#pool.query(
      `SELECT id, "appId", "userOid", "displayName", "userName", "userEmail", "userKind", groups, "refreshDueAt", "expiresAt"
       FROM session_lookup($1, $2)`,
      [tokenHash, appId],
    );
    const row = result.rows[0] as
      | {
          id: string;
          appId: string;
          userOid: string;
          displayName: string;
          userName: string | null;
          userEmail: string | null;
          userKind: string | null;
          groups: unknown;
          refreshDueAt: Date;
          expiresAt: Date;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      appId: row.appId,
      user: {
        oid: row.userOid,
        displayName: row.displayName,
        // Read back as stored. Deliberately NOT derived from `displayName`:
        // that would resurrect "Guest" as a captured name on every
        // shared-password row.
        name: row.userName,
        email: row.userEmail,
        // Parsed, not cast: an unrecognised value is treated as "no kind
        // recorded" rather than smuggled through as one.
        kind: row.userKind === "user" || row.userKind === "password" ? row.userKind : null,
        groups: toGroups(row.groups),
      },
      refreshDueAt: row.refreshDueAt,
      expiresAt: row.expiresAt,
    };
  }

  async delete(tokenHash: string, appId: string): Promise<void> {
    // Logout is partition-scoped: the DELETE only sees this app's rows.
    await withPartition(this.#pool, appId, null, "prod", (client) =>
      client.query(`DELETE FROM sessions WHERE "tokenHash" = $1 AND "appId" = $2`, [
        tokenHash,
        appId,
      ]),
    );
  }

  async sweep(): Promise<number> {
    // GC across all apps — deliberately global, so it runs through the
    // SECURITY DEFINER `session_sweep` function (ADR-0002), which is owner-
    // exempt from RLS and holds the canonical GC predicate (expired rows linger
    // a day; never-redeemed pendings die after 10 min). Returns rows removed.
    const result = await this.#pool.query(`SELECT session_sweep() AS n`);
    const row = result.rows[0] as { n: string | number } | undefined;
    return row ? Number(row.n) : 0;
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
