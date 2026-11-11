import type { Agent } from "undici";
import { ServiceOAuthManager, type ServiceOAuthTarget } from "./serviceOAuth.js";
import { serviceTokenExchange, ServiceOAuthError } from "./serviceOAuthTransport.js";
import { Pool } from "pg";
import {
  type Env,
  type InjectionRecipe,
  StoredInjectionRecipeSchema,
  type InstructionCapability,
  validateMaterialForRecipe,
} from "@azx-pbc/shared";
import type { SecretStore } from "@azx-pbc/secret-store";

import { createEgressPool, type EgressPoolOpts } from "./pool.js";

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
  /**
   * Where the credential came from: `secret` (a sealed `app_secrets` row) or
   * `managed-identity` (an Entra token minted at call time, ADR-0046). A span
   * dimension only — bounded to those two values.
   */
  source?: "secret" | "managed-identity";
  oauth?: {
    generation: number;
    recovered: boolean;
    replaySafePostPaths: string[];
    recover(): Promise<ResolvedConnection | null>;
    reject(): Promise<void>;
  };
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
  configureTransport?(dispatcher: Agent): void;
  /**
   * `origin` is the instruction's edge-signed target origin. The Postgres
   * resolver checks approval bindings; the managed-identity wrapper (ADR-0046) checks it
   * against the rule's host suffix before minting a token, so a connection
   * name alone can never draw a token onto a foreign origin.
   */
  resolve(
    appId: string,
    connection: string,
    capability: InstructionCapability,
    env: Env,
    origin: string,
    transport?: { dispatcher: Agent },
  ): Promise<ResolvedConnection | null>;
  close(): Promise<void>;
}

export class PgSecretResolver implements SecretResolver {
  readonly #pool: Pool;
  readonly #store: SecretStore;
  readonly #tokenStore: SecretStore | null;
  readonly #oauthPool: Pool;
  #oauth: ServiceOAuthManager | undefined;

  constructor(
    databaseUrl: string,
    store: SecretStore,
    opts: EgressPoolOpts & { tokenStore?: SecretStore | null } = {},
  ) {
    this.#pool = createEgressPool(databaseUrl, { ...opts, max: opts.max ?? 5 });
    this.#store = store;
    this.#tokenStore = opts.tokenStore ?? null;
    this.#oauthPool = createEgressPool(databaseUrl, { ...opts, max: 2, label: "service-oauth" });
  }

  configureTransport(dispatcher: Agent): void {
    if (!this.#tokenStore) return;
    this.#oauth ??= new ServiceOAuthManager(
      this.#pool,
      this.#store,
      this.#tokenStore,
      serviceTokenExchange(dispatcher),
      this.#oauthPool,
    );
    this.#oauth.start();
  }

  async resolve(
    appId: string,
    connection: string,
    capability: InstructionCapability,
    env: Env,
    origin = "",
    transport?: { dispatcher: Agent; rejectedGeneration?: number },
  ): Promise<ResolvedConnection | null> {
    const row =
      capability === "llm"
        ? // `llm`: a platform vendor secret, by name only (no app/grant/env scoping).
          // A platform secret is reachable from nowhere else — fetch never sees it —
          // and is tier-agnostic, so a dev LLM call reuses the same key.
          (
            await this.#pool.query<{
              id: string;
              material: string;
              injection: unknown;
              credentialGeneration: number;
            }>(
              `SELECT id, material, injection, "credentialGeneration" FROM app_secrets
                 WHERE scope = 'platform' AND name = $1 LIMIT 1`,
              [connection],
            )
          ).rows[0]
        : // `fetch`: app-scoped first, then a granted global — both pinned to the
          // instruction's env tier (§6), so a dev fetch never resolves a prod
          // connection secret. Two narrow queries rather than an OR so the
          // (appId, env, name) index is used and the intent is explicit.
          ((
            await this.#pool.query<{
              id: string;
              material: string;
              injection: unknown;
              credentialGeneration: number;
            }>(
              `SELECT id, material, injection, "credentialGeneration" FROM app_secrets
                 WHERE scope = 'app' AND "appId" = $1 AND env = $2 AND name = $3 LIMIT 1`,
              [appId, env, connection],
            )
          ).rows[0] ??
          (
            await this.#pool.query<{
              id: string;
              material: string;
              injection: unknown;
              credentialGeneration: number;
            }>(
              `SELECT s.id, s.material, s.injection, s."credentialGeneration" FROM app_secrets s
                 JOIN app_secret_grants g ON g."secretId" = s.id AND g."appId" = $1
                WHERE s.scope = 'global' AND s.env = $2 AND s.name = $3 LIMIT 1`,
              [appId, env, connection],
            )
          ).rows[0]);

    if (!row) return null;

    const injection = StoredInjectionRecipeSchema.parse(row.injection);
    if (capability === "fetch") {
      const bindings = await this.#pool.query<{ secretId: string }>(
        `SELECT "secretId" FROM secret_connection_bindings WHERE "appId" = $1 AND origin = $2 AND name = $3 AND env = $4`,
        [appId, origin, connection, env],
      );
      if (
        (injection.kind === "oauth-service-account" || bindings.rows.length > 0) &&
        bindings.rows[0]?.secretId !== row.id
      )
        return null;
    }
    if (injection.kind === "oauth-service-account") {
      if (capability !== "fetch" || !transport) return null;
      if (!this.#tokenStore) throw new ServiceOAuthError("temporary_failure");
      this.configureTransport(transport.dispatcher);
      const target: ServiceOAuthTarget = { ...row, env, recipe: injection };
      const token = await this.#oauth!.resolve(target, transport.rejectedGeneration);
      // Every hit and every completed recovery rechecks current identity, generation and grant.
      const authorized = await this.#pool.query(
        `SELECT 1 FROM app_secrets s
        JOIN secret_connection_bindings b ON b."secretId" = s.id AND b."appId" = $2 AND b.origin = $3 AND b.env = $4 AND b.name = s.name
        WHERE s.id = $1 AND s."credentialGeneration" = $5 AND
          ((s.scope = 'app' AND s."appId" = $2) OR (s.scope = 'global' AND
           EXISTS (SELECT 1 FROM app_secret_grants g WHERE g."secretId" = s.id AND g."appId" = $2) AND
           NOT EXISTS (SELECT 1 FROM app_secrets a WHERE a.scope = 'app' AND a."appId" = $2 AND a.env = $4 AND a.name = s.name)))`,
        [row.id, appId, origin, env, row.credentialGeneration],
      );
      if (authorized.rowCount !== 1) throw new ServiceOAuthError("not_authorized");
      await this.#pool
        .query(`UPDATE app_secrets SET "lastUsedAt" = now() WHERE id = $1`, [row.id])
        .catch(() => {});
      return {
        value: token.value,
        injection: { kind: "header-bearer" },
        source: "secret",
        oauth: {
          ...token,
          replaySafePostPaths: injection.replaySafePostPaths,
          recover: () =>
            this.resolve(appId, connection, capability, env, origin, {
              ...transport,
              rejectedGeneration: token.generation,
            }),
          reject: () => this.#oauth!.reject(target, token.generation, token.recovered),
        },
      };
    }
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
    return { value, injection, source: "secret" };
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
    await this.#oauth?.close();
    await Promise.all([this.#pool.end(), this.#oauthPool.end()]);
  }
}
