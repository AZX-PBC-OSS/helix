import { Pool } from "pg";
import {
  type InjectionRecipe,
  InjectionRecipeSchema,
  type InstructionCapability,
} from "@azx-pbc/shared";
import type { SecretStore } from "@azx-pbc/secret-store";

/**
 * Resolves a connection name to plaintext + injection recipe, for the one app
 * the attested instruction names (secrets design §4). Runs under the
 * `helix_egress` role — the ONLY role with SELECT on `app_secrets.material`. The
 * policy edge cannot do this; that asymmetry is the boundary.
 *
 * Resolution order encodes the scope rule, gated by the instruction capability:
 *  - `fetch`: an app-scoped secret owned by the app, else a `global` secret the
 *    app holds a grant for. The grant re-check here is belt-and-suspenders on top
 *    of the approval gate that authorized the binding. A `fetch` instruction can
 *    NEVER reach a `platform` secret — that's the control that stops an app from
 *    injecting the platform vendor key via a manifest fetch binding.
 *  - `llm`: a `platform`-scoped secret resolved by name (the LLM vendor key). The
 *    edge sets this connection from config, not from the app's manifest, and only
 *    after it has authorized the call (model allowlist + budget).
 */
export interface ResolvedConnection {
  value: string;
  injection: InjectionRecipe;
}

export interface SecretResolver {
  resolve(
    appId: string,
    connection: string,
    capability: InstructionCapability,
  ): Promise<ResolvedConnection | null>;
  close(): Promise<void>;
}

export class PgSecretResolver implements SecretResolver {
  readonly #pool: Pool;
  readonly #store: SecretStore;

  constructor(databaseUrl: string, store: SecretStore, opts: { max?: number } = {}) {
    this.#pool = new Pool({ connectionString: databaseUrl, max: opts.max ?? 5 });
    this.#store = store;
  }

  async resolve(
    appId: string,
    connection: string,
    capability: InstructionCapability,
  ): Promise<ResolvedConnection | null> {
    const row =
      capability === "llm"
        ? // `llm`: a platform vendor secret, by name only (no app/grant scoping).
          // A platform secret is reachable from nowhere else — fetch never sees it.
          (
            await this.#pool.query<{ id: string; material: string; injection: unknown }>(
              `SELECT id, material, injection FROM app_secrets
                 WHERE scope = 'platform' AND name = $1 LIMIT 1`,
              [connection],
            )
          ).rows[0]
        : // `fetch`: app-scoped first, then a granted global. Two narrow queries
          // rather than an OR so the index on (appId, name) is used and the
          // intent is explicit.
          ((
            await this.#pool.query<{ id: string; material: string; injection: unknown }>(
              `SELECT id, material, injection FROM app_secrets
                 WHERE scope = 'app' AND "appId" = $1 AND name = $2 LIMIT 1`,
              [appId, connection],
            )
          ).rows[0] ??
          (
            await this.#pool.query<{ id: string; material: string; injection: unknown }>(
              `SELECT s.id, s.material, s.injection FROM app_secrets s
                 JOIN app_secret_grants g ON g."secretId" = s.id AND g."appId" = $1
                WHERE s.scope = 'global' AND s.name = $2 LIMIT 1`,
              [appId, connection],
            )
          ).rows[0]);

    if (!row) return null;

    const injection = InjectionRecipeSchema.parse(row.injection);
    const value = await this.#store.open(row.material);
    // Stamp last-used (the only column egress may UPDATE). Fail-soft: a metering
    // hiccup must not break a working credential.
    await this.#pool
      .query(`UPDATE app_secrets SET "lastUsedAt" = now() WHERE id = $1`, [row.id])
      .catch(() => {});
    return { value, injection };
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
