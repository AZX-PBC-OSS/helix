import type { TokenProvider } from "@azx-pbc/secret-store";
import type { ManagedIdentityConnectionRule } from "./config.js";
import type { ResolvedConnection, SecretResolver } from "./secrets.js";

/**
 * The Entra audience for Azure AI Foundry data-plane calls — both endpoint
 * shapes (`<resource>.services.ai.azure.com/anthropic|/openai/v1`) take tokens
 * scoped `https://ai.azure.com/.default`, which the managed-identity endpoint
 * requests as the `resource` (no `/.default` suffix there). Keyless vendor auth
 * is covered by the `Cognitive Services User` role on the Foundry account
 * (ADR-0046). The default in code; `EGRESS_MANAGED_IDENTITY_RESOURCE` overrides
 * it — an escape hatch for the live spike and sovereign clouds, not a supported
 * second path.
 */
export const FOUNDRY_TOKEN_RESOURCE = "https://ai.azure.com";

/**
 * Keyless credential fallback for the `llm` capability (ADR-0046), wrapped
 * around the Postgres resolver.
 *
 * Order matters: **a stored row always wins**. That is what keeps local dev
 * (no managed identity in the dev container — a seeded API key under the same
 * connection name) and key-based BYO-Foundry deployments on one code path, and
 * it makes the fallback explicit-beats-ambient: an operator who seals a key
 * under `foundry` has said exactly what that connection presents.
 *
 * The fallback engages only when the row is absent, and even then refuses
 * unless all three hold:
 *
 *  - the capability is `llm`. A `fetch` instruction can never mint a token —
 *    same wall that keeps `fetch` from resolving a `platform` secret;
 *  - the connection name is allowlisted in `EGRESS_MANAGED_IDENTITY_CONNECTIONS`.
 *    Without the list, any instruction naming a never-seeded connection would
 *    draw a platform identity token;
 *  - the instruction's origin host matches the rule's suffix. The token rides
 *    a request egress itself dials to that origin, so without the pin a forged
 *    instruction (`connection=foundry`, `origin=https://attacker.example`)
 *    would exfiltrate a live Entra token to any host. The legitimate set is
 *    tiny and operator-known, so the pin is near-free.
 *
 * What egress injects is a ~24h cached token for its own user-assigned
 * identity, presented as `Authorization: Bearer` — the header shape both
 * Foundry endpoint families accept (Entra ID auth), so no per-vendor recipe is
 * needed. No `app_secrets` row exists for this path, so there is nothing to
 * stamp `lastUsedAt` on; the call still lands in the edge's ledger like any
 * other LLM call.
 *
 * The wrapped resolver is required, not optional: `server.ts` refuses to boot
 * with the allowlist set and no custody store, because a null inner would turn
 * every other secret-backed call's clear "502 store not configured" into a
 * misleading "403 connection not found".
 */
export class ManagedIdentityResolver implements SecretResolver {
  readonly #inner: SecretResolver;
  readonly #tokenProvider: TokenProvider;
  readonly #rules: ReadonlyMap<string, string>;

  constructor(
    inner: SecretResolver,
    tokenProvider: TokenProvider,
    rules: ManagedIdentityConnectionRule[],
  ) {
    this.#inner = inner;
    this.#tokenProvider = tokenProvider;
    this.#rules = new Map(rules.map((r) => [r.connection, r.hostSuffix]));
  }

  async resolve(
    ...args: Parameters<SecretResolver["resolve"]>
  ): Promise<ResolvedConnection | null> {
    const [appId, connection, capability, env, origin] = args;
    const stored = await this.#inner.resolve(appId, connection, capability, env, origin);
    if (stored) return stored;

    if (capability !== "llm") return null;
    const hostSuffix = this.#rules.get(connection);
    if (!hostSuffix) return null;
    let host: string;
    try {
      host = new URL(origin).hostname;
    } catch {
      return null;
    }
    if (host !== hostSuffix && !host.endsWith(`.${hostSuffix}`)) return null;

    const value = await this.#tokenProvider.getToken();
    return { value, injection: { kind: "header-bearer" }, source: "managed-identity" };
  }

  /** Owns the wrapped resolver: closing this closes it. */
  async close(): Promise<void> {
    await this.#inner.close();
  }
}
