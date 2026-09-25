import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { Pool } from "pg";
import {
  ConnectionMaterialSchema,
  ConnectionProviderSchema,
  type ConnectionProvider,
  type Env,
  type FetchErrorCode,
  type FetchErrorProvider,
  type PrincipalKind,
  type UserConnection,
} from "@azx-pbc/shared";
import {
  ATTR_ENV,
  ATTR_OUTCOME,
  ATTR_PROVIDER_REF,
  SPAN_EGRESS_RESOLUTION,
  type EgressResolutionOutcome,
} from "@azx-pbc/shared/telemetry";
import type { SecretStore } from "@azx-pbc/secret-store";
import type { ProviderCacheReader } from "./providerCache.js";
import { egressSpanAttributes } from "./spanAttributes.js";
import { tracer } from "./telemetry.js";
import {
  userConnectionFromPg,
  type RenewalResult,
  type RenewalTarget,
  type UserConnectionRow,
} from "./renewal.js";

/**
 * The delegated-call resolution (I-02 T-0022): one verified instruction
 * carrying the `provider` sibling meets the CALLER'S connection row, and every
 * failure class spec.md §Delegated calls and renewal names is distinguished
 * here — before any vendor traffic. This is the mechanism-plane half of the
 * edge/egress split (architecture ADR-0004): the edge evaluated binding
 * APPROVAL (an unapproved origin never minted an instruction); egress alone
 * sees provider liveness, the row, and the token.
 *
 * The three-way distinction (design.md's error table is authoritative):
 *
 * - **403 `connection_required`** — no connection row, a dead/invalidated or
 *   reconnect-needed row, a caller kind that can never hold a connection
 *   (`anon`, `password` — criterion 21), or a renewal that ended
 *   `uncertain_rotation` / `reconnect_required`. Body carries the provider
 *   metadata `{ref, displayName}` so the app can offer Connect. Never falls
 *   back to another user's connection, a static secret, or an unauthenticated
 *   call (criterion 33).
 * - **503 `provider_unavailable`** — the provider was deleted, or the row's
 *   recorded revision is behind the cached current one (a sensitive edit's
 *   defense in depth behind the row's invalidated status, ADR-0004), or the
 *   target origin is not one of the provider's current API destinations.
 * - **502 `provider_misconfigured`** — the provider row is malformed, or
 *   renewal answered `admin_action`. Opaque: administrator action required,
 *   never vendor or credential content (criterion 34).
 *
 * A temporary renewal failure is NOT a consent problem: it fails the call as
 * the existing `upstream_error` class and preserves the connection (criterion
 * 37) — the caller (proxy.ts) maps that outcome.
 *
 * The fixed-string discipline holds on every path: no token value, no vendor
 * error text, no URL ever enters an outcome, a log field, or a span here.
 */

/** The caller identity the resolution discriminates on — exactly the fields
 * the edge stamps into the instruction (T-0023's mint half): `userOid` +
 * `userKind` (schema-mandatory on delegated instructions), the provider ref,
 * and the env tier the dev/prod split rides. */
export interface DelegatedCallIdentity {
  userOid: string;
  userKind: PrincipalKind;
  providerRef: string;
  env: Env;
}

/**
 * What resolution refused, with the exact status / code / ledger-outcome
 * triple design.md's error table fixes. `outcome` is the
 * `x-helix-egress-outcome` value — deliberately explicit, because `fail()`'s
 * status-derived default cannot express `connection_required` (T-0003's
 * note), and the two provider-shaped codes meter as `refusal` while the
 * existing upstream_error class meters as `error`. `spanOutcome` is the
 * resolution span's word ({@link EGRESS_RESOLUTION_OUTCOMES}) — finer than
 * the ledger label exactly where design.md's inventory asks for it.
 * `provider` metadata rides the codes design.md's table gives it.
 */
export interface DelegatedRefusal {
  ok: false;
  status: number;
  code: FetchErrorCode;
  outcome: string;
  spanOutcome: EgressResolutionOutcome;
  message: string;
  provider?: FetchErrorProvider;
}

export interface DelegatedCredentials {
  ok: true;
  /** The opened access token — plaintext, in-memory only, never logged or
   * spanned; injected once into the outbound request. */
  accessToken: string;
  provider: ConnectionProvider;
  /** The connection row's id — the criterion-40 flag's target. */
  connectionId: string;
  /** Whether the dispatched token came fresh off a renewal — the span's
   * `refreshed` vs `resolved` word. */
  renewed: boolean;
}

export type DelegatedResolution = DelegatedCredentials | DelegatedRefusal;

/** Fixed-string messages — no vendor content, no credential material, no
 * internal detail (criterion 34; the proxy's fail() convention). */
const MESSAGES = {
  connection_required: "connect the provider account to continue",
  provider_unavailable: "provider is currently unavailable",
  provider_misconfigured: "provider is misconfigured — administrator action required",
  upstream_error: "delegated credential unavailable",
} as const;

type RefusalWord = Extract<
  EgressResolutionOutcome,
  "connection_required" | "reconnect_required" | "provider_unavailable" | "provider_misconfigured"
>;

type RefusalCode = "connection_required" | "provider_unavailable" | "provider_misconfigured";

function refusal(
  spanOutcome: RefusalWord,
  status: number,
  code: RefusalCode,
  provider?: FetchErrorProvider,
): DelegatedRefusal {
  return {
    ok: false,
    status,
    code,
    // The ledger label rides the CODE (design decision 13's exact
    // granularity): every 403 connection_required-shaped refusal — including
    // a renewal's reconnect outcomes — meters as `connection_required`; the
    // provider-shaped 502/503 meter as the existing `refusal`. The finer
    // span word (`reconnect_required` vs `connection_required`) lives on the
    // resolution span only.
    outcome: code === "connection_required" ? "connection_required" : "refusal",
    spanOutcome,
    message: MESSAGES[code],
    ...(provider ? { provider } : {}),
  };
}

function upstreamError(): DelegatedRefusal {
  return {
    ok: false,
    status: 502,
    code: "upstream_error",
    outcome: "error",
    spanOutcome: "error",
    message: MESSAGES.upstream_error,
  };
}

/** The caller kinds that can never hold a delegated connection (Q9): the
 * anonymous sentinel on public apps, and shared-password pseudonyms. A
 * genuine signed-in principal of a password-visible app is kind `user` and
 * stays eligible — the refusal keys on the caller's kind, never on app
 * visibility, which is not in the instruction at all (criterion 21). */
const INELIGIBLE_KINDS: readonly PrincipalKind[] = ["anon", "password"];

export interface DelegatedResolverDeps {
  /** The `helix_egress` pool — row reads and the criterion-40 flag UPDATE. */
  pool: Pool;
  /** The revision-keyed provider cache (the exchange/renewal reader). */
  providers: ProviderCacheReader;
  /** Opens the row's sealed access token. In-memory for this call only. */
  delegatedStore: SecretStore;
  /** T-0021's renewer — invoked when the access token is expired or flagged. */
  renewer: { renew(target: RenewalTarget): Promise<RenewalResult> };
}

/**
 * The boot-level wiring (`EgressDeps.delegated`): the custody + cache +
 * pool ingredients the resolver and its renewer share. `app.ts` builds the
 * {@link DelegatedResolver} and the T-0021 {@link ConnectionRenewer} from
 * these against the proxy's shared dispatcher.
 */
export interface DelegatedWiring {
  pool: Pool;
  providers: ProviderCacheReader;
  /** Opens the provider row's sealed client credentials (kv-connections). */
  credentialStore: SecretStore;
  /** The delegated-custody store — opens/seals the row's token material. */
  delegatedStore: SecretStore;
  /** Bounds the vendor token-endpoint call (the request-timeout budget). */
  timeoutMs: number;
  /** Dev-only seam, as for the exchange: permits the http fixture vendor. */
  allowInsecureConnection: boolean;
  /** The renewal lock's bounded per-acquire wait (ADR-0007), if tuned. */
  lockAcquireTimeoutMs?: number;
}

/** pg hands `TIMESTAMP(3)` columns back as `Date`; the schema wants ISO text. */
function isoValue(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

/** The resolution's own SELECT for the caller's row — the same columns the
 * renewal reads (the one stored-row contract, ADR-0006 §Shared ground). */
const ROW_COLUMNS = `id, "userOid", "providerId", "providerRevision", env, status, material,
  "grantedScopes", "grantedAt", "expiresAt", "renewBeforeNext", "pendingRetire",
  "lastRenewedAt", "createdAt", "updatedAt"`;

export class DelegatedResolver {
  readonly #pool: Pool;
  readonly #providers: ProviderCacheReader;
  readonly #delegatedStore: SecretStore;
  readonly #renewer: DelegatedResolverDeps["renewer"];

  constructor(deps: DelegatedResolverDeps) {
    this.#pool = deps.pool;
    this.#providers = deps.providers;
    this.#delegatedStore = deps.delegatedStore;
    this.#renewer = deps.renewer;
  }

  /**
   * Resolve the caller's connection for the instruction's
   * `(userOid, providerRef, env)`. The refusal answers never touch the
   * vendor; nothing here falls back to any other credential source.
   */
  async resolve(
    identity: DelegatedCallIdentity,
    targetOrigin: string,
  ): Promise<DelegatedResolution> {
    const span = tracer.startSpan(SPAN_EGRESS_RESOLUTION, { kind: SpanKind.INTERNAL });
    const record: { outcome: EgressResolutionOutcome } = { outcome: "error" };
    try {
      const result = await this.#resolve(identity, targetOrigin);
      record.outcome = result.ok ? (result.renewed ? "refreshed" : "resolved") : result.spanOutcome;
      return result;
    } finally {
      span.setAttributes(
        egressSpanAttributes({
          [ATTR_OUTCOME]: record.outcome,
          [ATTR_ENV]: identity.env,
          [ATTR_PROVIDER_REF]: identity.providerRef,
        }),
      );
      if (record.outcome === "error") span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    }
  }

  /**
   * Criterion 40's flag: the vendor answered 401 before the recorded expiry,
   * so the NEXT request must renew before dispatch. Fire-and-forget by the
   * caller (the response streams first); the UPDATE is column-scoped to
   * `renewBeforeNext` (the ADR-0006 grant block) and status-CAS'd to `live` —
   * a disconnected or invalidated row gains nothing, and no late write can
   * resurrect one (criterion 41).
   */
  flagRenewBeforeNext(connectionId: string): void {
    void this.#pool
      .query(
        `UPDATE user_connections SET "renewBeforeNext" = true
          WHERE id = $1::uuid AND status = 'live'`,
        [connectionId],
      )
      .catch(() => {});
  }

  async #resolve(
    identity: DelegatedCallIdentity,
    targetOrigin: string,
  ): Promise<DelegatedResolution> {
    // 1. The caller-kind gate, before anything else: an identity that can
    // never hold a connection gets the consent-shaped refusal regardless of
    // provider state (Q9's call-time refusal; the answer does not depend on
    // provider liveness, so no provider state leaks through it either).
    if (INELIGIBLE_KINDS.includes(identity.userKind)) {
      const provider = this.#providers.getByRef(identity.providerRef, identity.env);
      return refusal(
        "connection_required",
        403,
        "connection_required",
        provider ? { ref: provider.ref, displayName: provider.displayName } : undefined,
      );
    }

    // 2. The provider, from the revision-keyed cache. A miss is a deletion —
    // or a row the cache dropped as unparseable, or reconcile lag — and the
    // three are separated by one fail-closed read of the row itself (#probe).
    let provider = this.#providers.getByRef(identity.providerRef, identity.env);
    if (!provider) {
      const probed = await this.#probe(identity.providerRef, identity.env);
      if (probed.verdict !== "cached") {
        return refusal(
          probed.verdict,
          probed.verdict === "provider_misconfigured" ? 502 : 503,
          probed.verdict === "provider_misconfigured"
            ? "provider_misconfigured"
            : "provider_unavailable",
          // design.md's table: `provider_unavailable` carries `{ref}` (there
          // is no row to name it by); `provider_misconfigured` is opaque —
          // no metadata at all.
          probed.verdict === "provider_unavailable" ? { ref: identity.providerRef } : undefined,
        );
      }
      provider = probed.provider;
    }

    // 3. The caller's own row — keyed (userOid, providerId, env). No row, an
    // unparseable row, or a non-live row is `connection_required` (criterion
    // 33: before the API operation is sent to the vendor).
    const row = await this.#readRow(identity, provider.id);
    if (row === null || row.status !== "live") {
      return refusal("connection_required", 403, "connection_required", {
        ref: provider.ref,
        displayName: provider.displayName,
      });
    }

    // 4. Defense in depth (ADR-0004 §Consequences): the row was stamped at
    // consent; a cached revision different from it means a sensitive edit or
    // a delete+recreate happened and the row should already be invalidated —
    // the revision check answers `provider_unavailable` even when the
    // invalidation write has not landed. Either direction of drift refuses.
    if (row.providerRevision !== provider.revision) {
      return refusal("provider_unavailable", 503, "provider_unavailable", { ref: provider.ref });
    }

    // 5. The token rides ONLY to the provider's approved API destinations.
    // The edge authorizes the origin from the manifest and the binding was
    // approved against this list; re-checking here means a provider whose
    // destinations have changed since can never receive the token on a stale
    // binding (the "binding blocked by a sensitive edit" class).
    if (!provider.apiOrigins.includes(targetOrigin)) {
      return refusal("provider_unavailable", 503, "provider_unavailable", { ref: provider.ref });
    }

    // 6. Expiry-driven renewal (criterion 35) — T-0021's operation, with the
    // advisory lock's single-flight and CAS discipline inside it. The
    // renew-before-next flag short-circuits the expiry comparison on the row
    // read inside the renewer.
    if (Date.parse(row.expiresAt) <= Date.now() || row.renewBeforeNext) {
      const renewed = await this.#renewer.renew({
        userOid: identity.userOid,
        providerId: provider.id,
        env: identity.env,
      });
      switch (renewed.outcome) {
        case "refreshed": {
          if (renewed.accessToken === undefined) break; // cannot happen; fail closed below
          // Criterion 41: a renewal result cannot resurrect credentials. The
          // row was live when the lock was taken; re-check it after the vendor
          // round-trip — a disconnect, invalidation, or sensitive edit that
          // landed mid-flight behaves as dead, and the fresh token is never
          // injected onto it.
          const current = await this.#readRow(identity, provider.id);
          if (current === null || current.status !== "live") {
            return refusal("connection_required", 403, "connection_required", {
              ref: provider.ref,
              displayName: provider.displayName,
            });
          }
          return {
            ok: true,
            accessToken: renewed.accessToken,
            provider,
            connectionId: row.id,
            renewed: true,
          };
        }
        case "temporary_failure":
          // Criterion 37: fails the current call as temporarily unavailable;
          // the connection is preserved. The existing upstream_error class —
          // NOT a consent outcome.
          return upstreamError();
        case "uncertain_rotation":
        case "reconnect_required":
          // Criteria 38/39: an uncertain rotation or an explicit permission
          // loss requires reconnection — the caller must Connect (the
          // renewer has already flipped the row).
          return refusal("reconnect_required", 403, "connection_required", {
            ref: provider.ref,
            displayName: provider.displayName,
          });
        case "admin_action":
          // Criterion 38: provider incompatibility — administrator action,
          // opaque (the row is not the problem and is left untouched).
          return refusal("provider_misconfigured", 502, "provider_misconfigured");
      }
      // A future outcome word must not serve a call it does not describe.
      return upstreamError();
    }

    // 7. Not due: open the row's sealed access token — plaintext in-memory
    // only, for this injection. A row that will not parse or open is dead for
    // use (the same fail-closed read the renewal takes) and answers as a
    // custody/infrastructure failure, not a consent one.
    try {
      const envelope = ConnectionMaterialSchema.parse(JSON.parse(row.material));
      const accessToken = await this.#delegatedStore.open(envelope.access);
      return { ok: true, accessToken, provider, connectionId: row.id, renewed: false };
    } catch {
      return upstreamError();
    }
  }

  /**
   * The cache-miss probe (a cache miss is deletion, a dropped unparseable
   * row, or reconcile lag — indistinguishable from the cache alone). One
   * fail-closed SELECT as `helix_egress`: a row that is THERE and parses is
   * reconcile lag (`provider_unavailable` — it self-heals at the next
   * reconcile, and the call is not served on config this process has not
   * loaded); a row that is THERE but fails the stored-row schema is malformed
   * configuration (`provider_misconfigured` — an administrator fixes it); no
   * row is a deletion (`provider_unavailable`).
   */
  async #probe(
    ref: string,
    env: Env,
  ): Promise<
    | { verdict: "cached"; provider: ConnectionProvider }
    | { verdict: "provider_unavailable" | "provider_misconfigured" }
  > {
    let raw: Record<string, unknown> | undefined;
    try {
      const { rows } = await this.#pool.query<Record<string, unknown>>(
        `SELECT id, ref, kind, "displayName", "authorizeEndpoint", "tokenEndpoint",
              "requestedScopes", "apiOrigins", "tokenPlacement", env,
              "clientIdMaterial", "clientSecretMaterial", revision, "createdAt", "updatedAt"
         FROM connection_providers WHERE ref = $1 AND env = $2`,
        [ref, env],
      );
      raw = rows[0];
    } catch {
      // The probe itself failed (pool/timeout) — answer unavailable rather
      // than guess; the cache reconcile is the recovery path.
      return { verdict: "provider_unavailable" };
    }
    if (raw === undefined) return { verdict: "provider_unavailable" };
    const parsed = ConnectionProviderSchema.safeParse({
      ...raw,
      createdAt: isoValue(raw.createdAt),
      updatedAt: isoValue(raw.updatedAt),
    });
    if (!parsed.success) return { verdict: "provider_misconfigured" };
    return { verdict: "cached", provider: parsed.data };
  }

  /** Read the caller's connection row; unparseable reads as absent (fail
   * closed, exactly the renewal's stance). */
  async #readRow(
    identity: DelegatedCallIdentity,
    providerId: string,
  ): Promise<UserConnection | null> {
    try {
      const { rows } = await this.#pool.query<UserConnectionRow>(
        `SELECT ${ROW_COLUMNS} FROM user_connections
          WHERE "userOid" = $1 AND "providerId" = $2::uuid AND env = $3`,
        [identity.userOid, providerId, identity.env],
      );
      const raw = rows[0];
      if (raw === undefined) return null;
      return userConnectionFromPg(raw);
    } catch {
      return null;
    }
  }
}
