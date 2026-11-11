import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { SecretStore } from "@azx-pbc/secret-store";
import { parseServiceOAuthCredential, type ServiceOAuthRecipe, type Env } from "@azx-pbc/shared";
import {
  ATTR_ENV,
  ATTR_OUTCOME,
  SPAN_SERVICE_OAUTH_RECOVERY,
  SPAN_SERVICE_OAUTH_EXCHANGE,
  SPAN_SERVICE_OAUTH_RETIRE,
  type ServiceOAuthOutcome,
} from "@azx-pbc/shared/telemetry";
import { withAdvisoryLock, serviceOAuthLockKey } from "./advisoryLock.js";
import { instruments, serviceOAuthSpan } from "./telemetry.js";
import {
  ServiceOAuthError,
  type ServiceTokenExchange,
  type IssuedServiceToken,
} from "./serviceOAuthTransport.js";

export interface ServiceOAuthTarget {
  id: string;
  env: Env;
  credentialGeneration: number;
  material: string;
  recipe: ServiceOAuthRecipe;
}
interface TokenRow {
  credentialGeneration: number;
  generation: number;
  access: string | null;
  refresh: string | null;
  expiresAt: Date | null;
  status: string;
  retryAfter: Date | null;
  attempt: string | null;
}
export interface ServiceOAuthAccess {
  value: string;
  generation: number;
  recovered: boolean;
}

/** Shared state is authoritative even on hits. A refresh attempt is marked before
 * dispatch, so a crashed owner can never cause a consumed refresh token to be replayed. */
export class ServiceOAuthManager {
  readonly #inflight = new Map<string, Promise<ServiceOAuthAccess>>();
  readonly #shutdown = new AbortController();
  #timer: NodeJS.Timeout | undefined;
  #sweep: Promise<void> | undefined;
  constructor(
    readonly pool: Pool,
    readonly credentialStore: SecretStore,
    readonly tokenStore: SecretStore,
    readonly exchange: ServiceTokenExchange,
    readonly lockPool: Pool = pool,
  ) {}

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      if (!this.#sweep)
        this.#sweep = this.sweep().finally(() => {
          this.#sweep = undefined;
        });
    }, 60_000);
    this.#timer.unref();
  }
  async close(): Promise<void> {
    clearInterval(this.#timer);
    this.#shutdown.abort();
    await Promise.allSettled([...this.#inflight.values()]);
    await this.#sweep;
  }

  async #read(db: Pool | PoolClient, target: ServiceOAuthTarget): Promise<TokenRow | undefined> {
    return (
      await db.query<TokenRow>(
        `SELECT t.* FROM service_oauth_tokens t JOIN app_secrets s ON s.id = t."secretId"
      WHERE s.id = $1 AND s."credentialGeneration" = $2 AND t."credentialGeneration" = $2`,
        [target.id, target.credentialGeneration],
      )
    ).rows[0];
  }
  #usable(row: TokenRow | undefined, rejected?: number): row is TokenRow & { access: string } {
    return (
      !!row?.access &&
      row.status === "ready" &&
      row.generation !== rejected &&
      !!row.expiresAt &&
      row.expiresAt.getTime() > Date.now() + 5_000
    );
  }
  async #open(row: TokenRow & { access: string }, recovered: boolean): Promise<ServiceOAuthAccess> {
    return { value: await this.tokenStore.open(row.access), generation: row.generation, recovered };
  }

  async resolve(target: ServiceOAuthTarget, rejected?: number): Promise<ServiceOAuthAccess> {
    try {
      const row = await this.#read(this.pool, target);
      if (this.#usable(row, rejected)) return await this.#open(row, false);
      const key = `${target.id}:${target.credentialGeneration}:${rejected ?? "expired"}`;
      const existing = this.#inflight.get(key);
      if (existing) return await existing;
      const pending = this.#recover(target, rejected).finally(() => {
        this.#inflight.delete(key);
      });
      this.#inflight.set(key, pending);
      return await pending;
    } catch (error) {
      if (error instanceof ServiceOAuthError) throw error;
      throw new ServiceOAuthError("temporary_failure");
    }
  }

  /** Only the dispatched generation is invalidated; a late 401 cannot kill a newer token. */
  async reject(target: ServiceOAuthTarget, generation: number, exhausted = false): Promise<void> {
    await this.pool.query(
      `UPDATE service_oauth_tokens SET "expiresAt" = now(),
        status = CASE WHEN $4 THEN 'temporary_failure' ELSE status END,
        "retryAfter" = CASE WHEN $4 THEN now() + interval '30 seconds' ELSE "retryAfter" END
      WHERE "secretId" = $1 AND "credentialGeneration" = $2 AND generation = $3 AND status = 'ready'`,
      [target.id, target.credentialGeneration, generation, exhausted],
    );
  }

  async #recover(target: ServiceOAuthTarget, rejected?: number): Promise<ServiceOAuthAccess> {
    const started = performance.now();
    const signal = AbortSignal.any([AbortSignal.timeout(20_000), this.#shutdown.signal]);
    return serviceOAuthSpan(SPAN_SERVICE_OAUTH_RECOVERY, target.env, async (outcome) => {
      try {
        return await withAdvisoryLock(
          this.lockPool,
          serviceOAuthLockKey(target.id, target.env),
          async (client, alive) => {
            instruments().serviceOAuthLockWait.record(performance.now() - started, {
              [ATTR_ENV]: target.env,
            });
            signal.throwIfAborted();
            await client.query(
              `INSERT INTO service_oauth_tokens ("secretId", "credentialGeneration")
            SELECT id, "credentialGeneration" FROM app_secrets WHERE id = $1 AND "credentialGeneration" = $2
            ON CONFLICT DO NOTHING`,
              [target.id, target.credentialGeneration],
            );
            const row = await this.#read(client, target);
            if (!row) throw new ServiceOAuthError("not_authorized");
            if (this.#usable(row, rejected)) {
              outcome("cached");
              return this.#open(row, false);
            }
            if (row.status === "needs_attention") throw new ServiceOAuthError("needs_attention");
            if (row.retryAfter && row.retryAfter.getTime() > Date.now())
              throw new ServiceOAuthError("temporary_failure");
            const attempt = randomUUID();
            const claim = await client.query(
              `UPDATE service_oauth_tokens SET status = 'recovering', attempt = $4
            WHERE "secretId" = $1 AND "credentialGeneration" = $2 AND generation = $3`,
              [target.id, target.credentialGeneration, row.generation, attempt],
            );
            if (claim.rowCount !== 1) throw new ServiceOAuthError("not_authorized");
            const sealed: string[] = [];
            try {
              const credential = parseServiceOAuthCredential(
                target.recipe,
                await this.credentialStore.open(target.material),
              );
              let token: IssuedServiceToken | undefined;
              let refreshed = false;
              let fallback = row.status === "recovering";
              // A recovering row belonged to a crashed attempt; never reuse its refresh token.
              if (row.refresh && row.status !== "recovering") {
                try {
                  token = await this.#exchange(
                    target,
                    credential,
                    await this.tokenStore.open(row.refresh),
                    signal,
                    "refreshed",
                  );
                  refreshed = true;
                } catch (error) {
                  // Rate limits/outages impose their cooldown before another endpoint request.
                  if (error instanceof ServiceOAuthError && !error.allowFallback) throw error;
                  fallback = true;
                }
              }
              if (!token) {
                signal.throwIfAborted();
                // Recheck rotation/deletion before spending stored credentials on fallback.
                if (!alive() || !(await this.#read(client, target)))
                  throw new ServiceOAuthError("not_authorized");
                token = await this.#exchange(
                  target,
                  credential,
                  undefined,
                  signal,
                  fallback ? "fallback" : "acquired",
                );
              }
              signal.throwIfAborted();
              if (!alive()) throw new ServiceOAuthError("temporary_failure");
              const access = await this.tokenStore.seal(token.access);
              sealed.push(access);
              let refresh = refreshed ? row.refresh : null;
              if (token.refresh) {
                refresh = await this.tokenStore.seal(token.refresh);
                sealed.push(refresh);
              }
              signal.throwIfAborted();
              if (!alive()) throw new ServiceOAuthError("temporary_failure");
              const saved = await client.query(
                `UPDATE service_oauth_tokens SET access = $5, refresh = $6,
              "expiresAt" = $7, generation = generation + 1, status = 'ready', "retryAfter" = NULL, attempt = NULL
              WHERE "secretId" = $1 AND "credentialGeneration" = $2 AND generation = $3 AND attempt = $4
              RETURNING generation`,
                [
                  target.id,
                  target.credentialGeneration,
                  row.generation,
                  attempt,
                  access,
                  refresh,
                  token.expiresAt,
                ],
              );
              if (saved.rowCount !== 1) throw new ServiceOAuthError("not_authorized");
              sealed.length = 0;
              outcome(refreshed ? "refreshed" : fallback ? "fallback" : "acquired");
              return {
                value: token.access,
                generation: saved.rows[0].generation as number,
                recovered: true,
              };
            } catch (error) {
              const failure =
                error instanceof ServiceOAuthError
                  ? error
                  : new ServiceOAuthError("temporary_failure");
              // Preserve a refresh token only after a definite throttle/outage response.
              // Uncertain or rejected tokens are retired by the update trigger.
              await client.query(
                `UPDATE service_oauth_tokens SET status = $5, "retryAfter" = $6,
              refresh = CASE WHEN $7 THEN refresh ELSE NULL END, access = NULL, attempt = NULL
              WHERE "secretId" = $1 AND "credentialGeneration" = $2 AND generation = $3 AND attempt = $4`,
                [
                  target.id,
                  target.credentialGeneration,
                  row.generation,
                  attempt,
                  failure.outcome === "needs_attention" ? "needs_attention" : "temporary_failure",
                  new Date(Date.now() + failure.retryMs),
                  failure.outcome === "temporary_failure" && !failure.allowFallback,
                ],
              );
              throw failure;
            } finally {
              for (const material of sealed) await this.#retire(client, material, target.env);
            }
          },
        );
      } catch (error) {
        outcome(error instanceof ServiceOAuthError ? error.outcome : "temporary_failure");
        throw error;
      } finally {
        instruments().serviceOAuthDuration.record(performance.now() - started, {
          [ATTR_ENV]: target.env,
        });
      }
    });
  }

  async #exchange(
    target: ServiceOAuthTarget,
    credential: Parameters<ServiceTokenExchange>[1],
    refresh: string | undefined,
    signal: AbortSignal,
    success: "acquired" | "refreshed" | "fallback",
  ) {
    return serviceOAuthSpan(SPAN_SERVICE_OAUTH_EXCHANGE, target.env, async (outcome) => {
      let result: ServiceOAuthOutcome = "temporary_failure";
      try {
        const token = await this.exchange(target.recipe, credential, refresh, signal);
        result = success;
        return token;
      } catch (error) {
        result = error instanceof ServiceOAuthError ? error.outcome : "temporary_failure";
        throw error;
      } finally {
        outcome(result);
        instruments().serviceOAuthExchanges.add(1, {
          [ATTR_ENV]: target.env,
          [ATTR_OUTCOME]: result,
        });
      }
    });
  }

  async #retire(client: PoolClient, material: string, env: Env): Promise<void> {
    // A vault success followed by DB loss has the documented seal→ledger crash residual.
    try {
      await client.query(
        `INSERT INTO service_oauth_retirements("materialHash", material)
        SELECT sha256(convert_to($1, 'UTF8')), $1 WHERE NOT EXISTS (SELECT 1 FROM service_oauth_tokens WHERE access = $1 OR refresh = $1)
        ON CONFLICT DO NOTHING`,
        [material],
      );
    } catch {
      // Publication may have committed before the session failed. Never destroy
      // on an ambiguous DB outcome; the seal→ledger residual requires operator cleanup.
      await serviceOAuthSpan(SPAN_SERVICE_OAUTH_RETIRE, env, async (outcome) => {
        outcome("temporary_failure");
      });
    }
  }

  async sweep(): Promise<void> {
    await serviceOAuthSpan(SPAN_SERVICE_OAUTH_RETIRE, undefined, async (outcome) => {
      try {
        const rows = await this.pool.query<{ materialHash: Buffer; material: string }>(
          'SELECT "materialHash", material FROM service_oauth_retirements ORDER BY "createdAt" LIMIT 64',
        );
        for (const row of rows.rows) {
          // Destroy is idempotent. Keep the durable mark until it succeeds, even across a crash.
          await this.tokenStore.destroy(row.material);
          await this.pool.query('DELETE FROM service_oauth_retirements WHERE "materialHash" = $1', [
            row.materialHash,
          ]);
        }
        outcome("retired");
      } catch {
        outcome("temporary_failure");
      }
    });
  }
}
