import { Pool } from "pg";
import {
  type Env,
  type InjectionRecipe,
  StoredInjectionRecipeSchema,
  type InstructionCapability,
  validateMaterialForRecipe,
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
 *
 * `env` (dev-mode design §6) scopes **connection** (`fetch`) secrets to the tier
 * carried in the verified, signed attested instruction — a `dev` fetch injects
 * only a `dev` connection secret and can never resolve a `prod` one, and
 * vice-versa. The value comes from the attested claim, never app input.
 * `platform` (`llm`) secrets are the tier-agnostic vendor key and resolve by
 * name only, so a dev LLM call reuses the same platform key.
 */
export interface ResolvedConnection {
  value: string;
  injection: InjectionRecipe;
}

/**
 * The stored material does not fit its stored recipe (see the drift check in
 * `resolve`). Typed so the proxy can tell it apart from a genuine custody
 * failure: it is not a vault problem, and logging it beside `vaultStatus` /
 * `vaultCode` probes would point an operator at the wrong subsystem.
 *
 * The message is a fixed string and must stay one — the value that failed is a
 * credential.
 */
export class RecipeDriftError extends Error {
  constructor() {
    super("stored material does not fit its injection recipe");
    this.name = "RecipeDriftError";
  }
}

export interface SecretResolver {
  resolve(
    appId: string,
    connection: string,
    capability: InstructionCapability,
    env: Env,
  ): Promise<ResolvedConnection | null>;
  close(): Promise<void>;
}

export class PgSecretResolver implements SecretResolver {
  readonly #pool: Pool;
  readonly #store: SecretStore;

  constructor(
    databaseUrl: string,
    store: SecretStore,
    opts: { max?: number; onIdleError?: (err: unknown) => void } = {},
  ) {
    this.#pool = new Pool({ connectionString: databaseUrl, max: opts.max ?? 5 });
    // Without this listener an idle client dropping (DB restart/failover) is an
    // unhandled 'error' event on the Pool and kills the process — taking the
    // whole fetch-proxy down over a connection that would have been discarded
    // and reconnected on next use. In-flight queries reject on their own.
    this.#pool.on("error", (err) => opts.onIdleError?.(err));
    this.#store = store;
  }

  async resolve(
    appId: string,
    connection: string,
    capability: InstructionCapability,
    env: Env,
  ): Promise<ResolvedConnection | null> {
    const row =
      capability === "llm"
        ? // `llm`: a platform vendor secret, by name only (no app/grant/env scoping).
          // A platform secret is reachable from nowhere else — fetch never sees it —
          // and is tier-agnostic, so a dev LLM call reuses the same key.
          (
            await this.#pool.query<{ id: string; material: string; injection: unknown }>(
              `SELECT id, material, injection FROM app_secrets
                 WHERE scope = 'platform' AND name = $1 LIMIT 1`,
              [connection],
            )
          ).rows[0]
        : // `fetch`: app-scoped first, then a granted global — both pinned to the
          // instruction's env tier (§6), so a dev fetch never resolves a prod
          // connection secret. Two narrow queries rather than an OR so the
          // (appId, env, name) index is used and the intent is explicit.
          ((
            await this.#pool.query<{ id: string; material: string; injection: unknown }>(
              `SELECT id, material, injection FROM app_secrets
                 WHERE scope = 'app' AND "appId" = $1 AND env = $2 AND name = $3 LIMIT 1`,
              [appId, env, connection],
            )
          ).rows[0] ??
          (
            await this.#pool.query<{ id: string; material: string; injection: unknown }>(
              `SELECT s.id, s.material, s.injection FROM app_secrets s
                 JOIN app_secret_grants g ON g."secretId" = s.id AND g."appId" = $1
                WHERE s.scope = 'global' AND s.env = $2 AND s.name = $3 LIMIT 1`,
              [appId, env, connection],
            )
          ).rows[0]);

    if (!row) return null;

    const injection = StoredInjectionRecipeSchema.parse(row.injection);
    const value = await this.#store.open(row.material);
    // Defence in depth against recipe⇄material drift. The portal validates this
    // before sealing, but the recipe is fixed at create while the material is
    // rotatable, and rows written before that check existed are still out there.
    // Failing closed here matters most in the quiet direction: an hmac credential
    // blob under a *static* recipe would present verbatim, sending the private
    // half of the key pair to the third-party upstream in cleartext.
    //
    // This runs inside `resolve`, so the throw is caught by the proxy's *resolve*
    // guard — not the nothing-binding injection guard downstream. That guard logs
    // vault probes, so it is handed a typed error to branch on instead.
    try {
      validateMaterialForRecipe(injection, value);
    } catch {
      throw new RecipeDriftError();
    }
    // Stamp last-used (the only column egress may UPDATE). Fail-soft: a metering
    // hiccup must not break a working credential.
    await this.#pool
      .query(`UPDATE app_secrets SET "lastUsedAt" = now() WHERE id = $1`, [row.id])
      .catch(() => {});
    return { value, injection };
  }

  /**
   * How many rows hold material the configured custody backend cannot open — a count
   * only, never the material. Under Key Vault every row should be `kv:`; rows left over
   * from a dev-envelope run fail individually with an opaque 502, and without this the
   * operator has no way to see that the cause is *every row being under the other
   * backend* rather than corruption in one. Best-effort: a failed count is not a reason
   * to refuse to boot.
   */
  async countForeignMaterial(scheme: string): Promise<number | null> {
    return this.#pool
      .query<{ n: string }>(
        `SELECT count(*)::text AS n FROM app_secrets WHERE material NOT LIKE $1`,
        [`${scheme}:%`],
      )
      .then((r) => Number(r.rows[0]?.n ?? 0))
      .catch(() => null);
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
