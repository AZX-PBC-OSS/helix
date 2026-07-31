import { Pool } from "pg";
import { INSTRUCTION_BURN_RETENTION_SECONDS } from "@azx-pbc/shared";

/**
 * One-time-use burn for the attested instruction's `jti` (ADR-0013 Step 1,
 * issue #3). Egress trusts the edge's signature but the signature alone is a
 * *bearer* capability: without a burn, an on-path party can re-POST a captured
 * instruction to `/proxy` for the whole ~35s validity window, re-resolving the
 * connection secret and re-firing the upstream call, all invisible to the edge's
 * `gateway_calls` accounting. The burn makes each instruction single-use — the
 * mechanism-plane analogue of the handoff token's atomic redeem
 * (`apps/edge/src/auth/sessions.ts`).
 *
 * Runs under `helix_egress` (its first write grant — INSERT/DELETE on
 * `instruction_jti`, migration 20260721215912). Shared across replicas, so the
 * guarantee holds under autoscale (unlike a per-process set).
 */
export interface InstructionBurnStore {
  /**
   * Record the first use of `jti`. Returns `true` if it was fresh (proceed with
   * the call) and `false` if it was already spent (a replay — refuse).
   */
  burn(jti: string): Promise<boolean>;
  /** Drop expired rows so the table stays bounded (a stale jti can't verify anyway). */
  sweep(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Postgres-backed burn. The freshness test IS the insert: `ON CONFLICT DO
 * NOTHING` inserts one row for a fresh jti and zero for one already present, so
 * `rowCount === 1` means fresh and `0` means replay. Atomic in one statement, so
 * concurrent replays can't both win. Runs under `helix_egress`, which has
 * SELECT+INSERT+DELETE on this table (SELECT is needed for the ON CONFLICT
 * arbiter and the sweep WHERE — the jti set is opaque, so there's no
 * non-enumerability boundary to protect).
 */
export class PgBurnStore implements InstructionBurnStore {
  readonly #pool: Pool;

  constructor(
    databaseUrl: string,
    opts: { max?: number; onIdleError?: (err: unknown) => void } = {},
  ) {
    this.#pool = new Pool({ connectionString: databaseUrl, max: opts.max ?? 5 });
    // See the note in `secrets.ts`: no listener here means a dropped idle client
    // is an unhandled 'error' event that kills the egress process.
    this.#pool.on("error", (err) => opts.onIdleError?.(err));
  }

  async burn(jti: string): Promise<boolean> {
    const res = await this.#pool.query(
      `INSERT INTO instruction_jti (jti, "expiresAt")
         VALUES ($1, now() + ($2 || ' seconds')::interval)
       ON CONFLICT (jti) DO NOTHING`,
      [jti, INSTRUCTION_BURN_RETENTION_SECONDS],
    );
    return res.rowCount === 1;
  }

  async sweep(): Promise<void> {
    await this.#pool.query(`DELETE FROM instruction_jti WHERE "expiresAt" < now()`);
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

/**
 * In-memory burn for tests and single-process dev (no DB round-trip). NOT
 * multi-replica safe — the whole point of {@link PgBurnStore} is that the prod
 * fleet shares one set — so it's never wired in `server.ts`.
 */
export class InMemoryBurnStore implements InstructionBurnStore {
  readonly #seen = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async burn(jti: string): Promise<boolean> {
    const t = this.#now();
    const exp = this.#seen.get(jti);
    if (exp !== undefined && exp > t) return false;
    this.#seen.set(jti, t + INSTRUCTION_BURN_RETENTION_SECONDS * 1000);
    return true;
  }

  async sweep(): Promise<void> {
    const t = this.#now();
    for (const [jti, exp] of this.#seen) if (exp <= t) this.#seen.delete(jti);
  }

  async close(): Promise<void> {}
}
