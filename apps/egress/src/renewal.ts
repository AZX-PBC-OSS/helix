import { createHash } from "node:crypto";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { ResponseBodyError, WWWAuthenticateChallengeError, refreshTokenGrant } from "openid-client";
import type { Agent } from "undici";
import type { Pool, PoolClient } from "pg";
import {
  ConnectionMaterialSchema,
  type ConnectionMaterial,
  type ConnectionProvider,
  type Env,
  type UserConnection,
  UserConnectionSchema,
} from "@azx-pbc/shared";
import {
  ATTR_ENV,
  ATTR_OUTCOME,
  ATTR_PROVIDER_REF,
  EGRESS_RENEWAL_OUTCOMES,
  SPAN_EGRESS_RENEWAL,
  type EgressRenewalOutcome,
} from "@azx-pbc/shared/telemetry";
import type { SecretStore } from "@azx-pbc/secret-store";
import type { ProviderCacheReader } from "./providerCache.js";
import { withPooledClient } from "./pool.js";
import { egressSpanAttributes } from "./spanAttributes.js";
import { buildDelegatedClientConfiguration } from "./providerClient.js";
import { instruments, tracer } from "./telemetry.js";

/**
 * Token renewal (I-02 T-0021, architecture ADR-0007): when a connection's
 * access token has expired, the delegated call renews it before dispatch —
 * single-flight **across running instances** via a session-level Postgres
 * advisory lock keyed `(userOid, providerId, env)`, because rotating refresh
 * tokens make a double exchange fatal to the grant (spec criterion 36).
 *
 * The mechanism, in ADR-0007 §Decision's order:
 *
 * 1. **Fast path** — read the row; when it is live and nothing is due, there
 *    is nothing to renew: open its access token and answer `refreshed`.
 * 2. **Acquire** the advisory lock on a dedicated checked-out client, with a
 *    bounded per-acquire wait (`lock_timeout` — a per-acquire knob, never the
 *    pool's statement timeout, tuned below the vendor timeout).
 * 3. **Re-read after acquire** — a winner may have renewed already; proceed
 *    with the fresh token and no vendor call. A bounded-block loser (acquire
 *    timed out) re-reads once too, then fails temporarily.
 * 4. **Renew** via openid-client's refresh grant over the pinned transport,
 *    against the provider's cached revision. A replacement refresh token is
 *    stored when the response supplies one; the existing one is retained when
 *    the response omits one (RFC 6749 §6).
 * 5. **Store** the swapped material with a compare-and-swap (`WHERE material
 *    = <as-read>`), the rotation's retirement-ledger entry written in the
 *    SAME UPDATE (ADR-0008's rule). A CAS loss retires the freshly-sealed
 *    material and answers per the design's lost-race rule (criterion 32).
 * 6. **Release** the lock on every exit path — success, vendor failure, CAS
 *    loss, timeout — explicitly, on the same checked-out client: releasing
 *    the client alone would return a lock-holding SESSION to the pool, and a
 *    session-level lock outlives any one query.
 *
 * Failure taxonomy (criteria 35, 37–39; spec decision 29) —
 * {@link EGRESS_RENEWAL_OUTCOMES}: `refreshed`; `temporary_failure`
 * (outage/rate-limit/timeout with no certain token consumption — the row is
 * untouched and no vendor retry fires within the call); `uncertain_rotation`
 * (the refresh token may have been consumed with no usable replacement
 * saved — the row moves to reconnect-needed and the old token is never
 * re-presented; takes precedence over temporary failure); `reconnect_required`
 * (explicit permission loss); `admin_action` (malformed credentials or a
 * missing usable lifetime — the provider_misconfigured class). Unknown vendor
 * rotation behavior is never treated as evidence the old token is reusable.
 *
 * The fixed-string discipline (ADR-0009) holds on every path: a vendor error
 * body can echo client credentials, so no token value and no vendor error
 * text is ever logged, spanned, or stringified here — the bounded outcome
 * word is the entire diagnostic.
 */

/** The renewal target — the connection's key, exactly the advisory-lock scope. */
export interface RenewalTarget {
  userOid: string;
  providerId: string;
  env: Env;
}

/**
 * The advisory-lock key for ONE `(userOid, providerId, env)` — the composition
 * defined ONCE, here (ADR-0007 §Shared ground): the SHA-256 of the three
 * components, truncated into the signed 64-bit range `pg_advisory_lock`'s
 * single-bigint form takes (returned as its decimal string; pg binds it
 * through the `$1::bigint` cast). A hash collision merely serializes two
 * unrelated renewals briefly — the store's CAS still arbitrates correctness.
 * Tests import this; nothing re-derives the key.
 */
export function renewalLockKey(target: RenewalTarget): string {
  const digest = createHash("sha256")
    .update(`${target.userOid}\u0000${target.providerId}\u0000${target.env}`, "utf8")
    .digest("hex");
  const unsigned = BigInt(`0x${digest.slice(0, 16)}`);
  const signed = unsigned >= 1n << 63n ? unsigned - (1n << 64n) : unsigned;
  return signed.toString();
}

/** Why a renewal ended — one of the five bounded outcome words. */
export type RenewalOutcome = EgressRenewalOutcome;
export const RENEWAL_OUTCOMES = EGRESS_RENEWAL_OUTCOMES;

/** What a renewal answered. `accessToken` is present on `refreshed` only: the
 * opened access token, ready for injection into the delegated call. */
export interface RenewalResult {
  outcome: RenewalOutcome;
  accessToken?: string;
}

/** Bounded, fixed-string logging seam (the provider listener's shape). */
export interface RenewalLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface RenewalDeps {
  /** The `helix_egress` pool. Renewal checks a dedicated client out of it for
   * the lock's lifetime — the session-level lock dies with that session. */
  pool: Pool;
  /** The revision-keyed provider cache (the same reader the exchange uses). */
  providers: ProviderCacheReader;
  /** Opens the provider row's sealed client credentials. */
  credentialStore: SecretStore;
  /** The delegated-custody store: opens the row's material, seals renewed material. */
  delegatedStore: SecretStore;
  /** The pinned transport (the proxy's shared dispatcher, as for the exchange). */
  dispatcher: Agent;
  /** Bounds the vendor token-endpoint call (the request-timeout budget). */
  timeoutMs: number;
  /** Dev-only seam, as for the exchange: permits the http fixture vendor. */
  allowInsecureConnection: boolean;
  /**
   * The losers' bounded-block per-acquire timeout (ADR-0007). Tuned BELOW the
   * vendor timeout by default (half of `timeoutMs`): the holder is bounded by
   * the vendor call, so a loser that waits half that long either finds the
   * winner's fresh row or gives up temporarily — it never out-waits a healthy
   * holder by much.
   */
  lockAcquireTimeoutMs?: number;
  log?: RenewalLogger;
}

/** The raw row shape the column-list SELECT hands back, before the parse. */
export interface UserConnectionRow {
  id: string;
  userOid: string;
  providerId: string;
  providerRevision: number;
  env: string;
  status: string;
  material: string;
  grantedScopes: unknown;
  grantedAt: unknown;
  expiresAt: unknown;
  renewBeforeNext: boolean;
  pendingRetire: string | null;
  lastRenewedAt: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

/** pg hands `TIMESTAMP(3)` columns back as `Date`; the schema wants ISO text. */
function isoValue(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Parse one `user_connections` row through THE stored-row contract
 * (`UserConnectionSchema` — ADR-0006 §Shared ground). Exported because the
 * delegated resolution (T-0022) and the retirement sweep (T-0025) read the
 * same row the same way; none re-derives the shape.
 */
export function userConnectionFromPg(row: UserConnectionRow): UserConnection {
  return UserConnectionSchema.parse({
    ...row,
    grantedAt: isoValue(row.grantedAt),
    expiresAt: isoValue(row.expiresAt),
    lastRenewedAt: isoValue(row.lastRenewedAt),
    createdAt: isoValue(row.createdAt),
    updatedAt: isoValue(row.updatedAt),
  });
}

/** Renewal is due when the access token is past its recorded expiry, or
 * criterion 40's pre-expiry-401 flag says renew before the next call. */
function isRenewalDue(row: UserConnection): boolean {
  return Date.parse(row.expiresAt) <= Date.now() || row.renewBeforeNext;
}

const READ_COLUMNS = `id, "userOid", "providerId", "providerRevision", env, status, material,
  "grantedScopes", "grantedAt", "expiresAt", "renewBeforeNext", "pendingRetire",
  "lastRenewedAt", "createdAt", "updatedAt"`;

/**
 * Why a vendor token-endpoint failure classifies as it does. The error's OAuth
 * code is READ here — it is the vendor's only signal — and never recorded: the
 * mapping's output is a bounded platform word (the fixed-string discipline).
 *
 * - `invalid_grant` → `uncertain_rotation`: the presented refresh token was
 *   rejected. Whether the cause is rotation consumption, reuse detection, or
 *   revocation, the same rule follows (criterion 39): the token may have been
 *   consumed and nothing usable was received, so the connection requires
 *   reconnection and the old token is never re-presented.
 * - `insufficient_scope` → `reconnect_required`: an explicit loss of required
 *   permissions (criterion 35).
 * - `invalid_client` → `admin_action`: the provider row's credentials are
 *   wrong — an administrator fixes the provider (criterion 38).
 * - `invalid_request`, `unsupported_grant_type`, `unauthorized_client` →
 *   `admin_action`: the configured provider cannot be refreshed as configured.
 * - A 401 challenge response → the same words in their other encoding
 *   (`insufficient_scope` → reconnect, anything else is a client
 *   authentication failure → admin action).
 * - Anything else — a server-side status, a rate limit, a timeout, an
 *   unparseable body, a dropped socket — → `temporary_failure`: no response
 *   said the grant is gone, so the connection stands and a later request may
 *   try again (criterion 37). An unrecognized OAuth error code is likewise
 *   temporary: unknown vendor behavior is not evidence the old token is
 *   unusable either.
 */
function classifyVendorFailure(err: unknown): RenewalOutcome {
  if (err instanceof ResponseBodyError) {
    const code = typeof err.error === "string" ? err.error : undefined;
    if (code === "invalid_grant") return "uncertain_rotation";
    if (code === "insufficient_scope") return "reconnect_required";
    if (
      code === "invalid_client" ||
      code === "invalid_request" ||
      code === "unsupported_grant_type" ||
      code === "unauthorized_client"
    ) {
      return "admin_action";
    }
    return "temporary_failure";
  }
  if (err instanceof WWWAuthenticateChallengeError) {
    if (err.cause?.[0]?.parameters?.error === "insufficient_scope") {
      return "reconnect_required";
    }
    return "admin_action";
  }
  return "temporary_failure";
}

/**
 * The renewal operation. One instance per egress process (per pool + custody
 * wiring); safe to call concurrently — same-key callers in this process
 * coalesce onto one attempt, and the advisory lock arbitrates across
 * instances. Consumed by the delegated-call resolution (T-0022), which calls
 * it inside its own resolution span when the access token is expired.
 */
export class ConnectionRenewer {
  readonly #pool: Pool;
  readonly #providers: ProviderCacheReader;
  readonly #credentialStore: SecretStore;
  readonly #delegatedStore: SecretStore;
  readonly #dispatcher: Agent;
  readonly #timeoutMs: number;
  readonly #allowInsecureConnection: boolean;
  readonly #lockAcquireTimeoutMs: number;
  readonly #log: RenewalLogger;
  /** The cheap local coalescer BENEATH the lock (ADR-0007 §Implementation
   * Notes): same-key callers in THIS process share one attempt's promise. */
  readonly #inFlight = new Map<string, Promise<RenewalResult>>();

  constructor(deps: RenewalDeps) {
    this.#pool = deps.pool;
    this.#providers = deps.providers;
    this.#credentialStore = deps.credentialStore;
    this.#delegatedStore = deps.delegatedStore;
    this.#dispatcher = deps.dispatcher;
    this.#timeoutMs = deps.timeoutMs;
    this.#allowInsecureConnection = deps.allowInsecureConnection;
    this.#lockAcquireTimeoutMs =
      deps.lockAcquireTimeoutMs ?? Math.max(1_000, Math.floor(deps.timeoutMs / 2));
    this.#log = deps.log ?? { info() {}, warn() {} };
  }

  /** Renew (or find already-renewed) the connection at `(userOid, providerId, env)`. */
  renew(target: RenewalTarget): Promise<RenewalResult> {
    const key = renewalLockKey(target);
    const existing = this.#inFlight.get(key);
    if (existing) return existing;
    const attempt = this.#runRenewal(target).finally(() => {
      if (this.#inFlight.get(key) === attempt) this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, attempt);
    return attempt;
  }

  /** The span + counter wrapper: one per physical attempt, never per waiter. */
  async #runRenewal(target: RenewalTarget): Promise<RenewalResult> {
    const span = tracer.startSpan(SPAN_EGRESS_RENEWAL, { kind: SpanKind.INTERNAL });
    // Outcome + providerRef ride a record the flow mutates, finalized in
    // `finally` — the exchange handler's shape.
    const record: { outcome: RenewalOutcome; providerRef?: string } = {
      outcome: "temporary_failure",
    };
    record.providerRef = this.#providers.get(target.providerId)?.ref;
    try {
      const result = await this.#renew(target);
      record.outcome = result.outcome;
      return result;
    } catch {
      // Nothing escapes renewal: a thrown unlock (the force-destroy path), a
      // dead session, a pool checkout failure — all custody/infrastructure
      // failures that leave the row untouched. The fixed word is the answer.
      this.#log.warn(
        { event: "egress.renewal.failed", reason: "unexpected_error" },
        "renewal failed unexpectedly",
      );
      return { outcome: record.outcome };
    } finally {
      span.setAttributes(
        egressSpanAttributes({
          [ATTR_OUTCOME]: record.outcome,
          [ATTR_ENV]: target.env,
          [ATTR_PROVIDER_REF]: record.providerRef,
        }),
      );
      if (record.outcome === "temporary_failure" || record.outcome === "admin_action") {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      instruments().renewals.add(1, {
        [ATTR_OUTCOME]: record.outcome,
        [ATTR_ENV]: target.env,
      });
      span.end();
    }
  }

  async #renew(target: RenewalTarget): Promise<RenewalResult> {
    // Fast path — no lock, no vendor call, when nothing is due. The row being
    // expired (or flagged by criterion 40) is the only reason to take a lock.
    const initial = await this.#readRow(null, target).catch(() => null);
    if (initial === null || initial.status !== "live") {
      return { outcome: "reconnect_required" };
    }
    if (!isRenewalDue(initial)) {
      return this.#proceedWithRow(initial);
    }
    return this.#renewUnderLock(target);
  }

  /**
   * The advisory-lock bracket (ADR-0007). The lock is SESSION-level on a
   * dedicated checked-out client — the `withPooledClient` lifecycle precedent:
   * checked out once, released exactly once, on every exit path.
   */
  async #renewUnderLock(target: RenewalTarget): Promise<RenewalResult> {
    const key = renewalLockKey(target);
    return withPooledClient(this.#pool, async (client) => {
      // The bounded acquire: `lock_timeout`, set as text via `set_config` (SET
      // takes no bind parameters). The acquire either returns having the lock
      // or throws — it never half-acquires.
      await client
        .query(`SELECT set_config('lock_timeout', $1, false)`, [String(this.#lockAcquireTimeoutMs)])
        .catch(() => null);
      try {
        await client.query(`SELECT pg_advisory_lock($1::bigint)`, [key]);
      } catch {
        // The bounded block expired (a loser's exit — ADR-0007): re-read once,
        // proceed if a winner renewed already, otherwise fail temporarily.
        // Nothing was acquired, so there is nothing to unlock and the client
        // is returned cleanly.
        const after = await this.#readRow(client, target).catch(() => null);
        if (after !== null && after.status === "live" && !isRenewalDue(after)) {
          return this.#proceedWithRow(after);
        }
        return { outcome: "temporary_failure" };
      }
      try {
        return await this.#criticalSection(client, target);
      } finally {
        // Release on EVERY exit path — success, vendor failure, CAS loss,
        // timeout — on the same checked-out client. An unlock failure
        // rethrows so `withPooledClient` releases the client WITH an error
        // and pg-pool destroys the session: the lock dies with it rather
        // than the pool inheriting a lock-holder.
        await client.query(`SELECT pg_advisory_unlock($1::bigint)`, [key]);
      }
    });
  }

  /**
   * Holding the lock: re-read (a winner may have renewed already — ADR-0007's
   * re-read-after-acquire), then either proceed on the fresh row or take the
   * vendor round-trip and store the result under the CAS. Every branch
   * answers an outcome; nothing rethrows (the unlock in the caller's finally
   * still runs).
   */
  async #criticalSection(client: PoolClient, target: RenewalTarget): Promise<RenewalResult> {
    const row = await this.#readRow(client, target).catch(() => null);
    if (row === null || row.status !== "live") {
      return { outcome: "reconnect_required" };
    }
    if (!isRenewalDue(row)) {
      return this.#proceedWithRow(row);
    }

    const provider = this.#providers.get(row.providerId);
    if (!provider || provider.revision !== row.providerRevision || provider.env !== row.env) {
      // The delegated-call resolver normally answers provider_unavailable
      // before renewal is ever reached; the renewal vocabulary has no such
      // word, and a provider that vanished or moved revisions mid-renewal
      // cannot be fixed from here — the provider_misconfigured class is the
      // nearest bounded word. The row is untouched either way.
      return { outcome: "admin_action" };
    }

    let envelope: ConnectionMaterial;
    try {
      envelope = ConnectionMaterialSchema.parse(JSON.parse(row.material));
    } catch {
      // A row that fails its own envelope parse is a bug surfaced as a parse
      // failure (the stored-row contract's strictness) — not usable, not
      // renewable; dead in the only sense that matters.
      return { outcome: "reconnect_required" };
    }

    let config: Awaited<ReturnType<typeof buildDelegatedClientConfiguration>>;
    let oldRefreshToken: string;
    try {
      [config, oldRefreshToken] = await Promise.all([
        buildDelegatedClientConfiguration(provider, this.#credentialStore, {
          allowInsecureConnection: this.#allowInsecureConnection,
          timeoutMs: this.#timeoutMs,
          dispatcher: this.#dispatcher,
        }),
        this.#delegatedStore.open(envelope.refresh),
      ]);
    } catch {
      // Custody failure (the row's material or the provider's client
      // credentials could not be opened) — not a vendor outcome at all.
      return { outcome: "temporary_failure" };
    }

    // The vendor round-trip. NO retry within this attempt (criterion 37): a
    // retry would re-present the refresh token this call may have consumed.
    try {
      const token = await refreshTokenGrant(config, oldRefreshToken);
      return await this.#storeRenewed(client, row, provider, envelope, token);
    } catch (err) {
      const outcome = classifyVendorFailure(err);
      if (outcome === "uncertain_rotation") {
        await this.#requireReconnection(client, row, "egress.renewal.uncertain_rotation");
        return { outcome: "uncertain_rotation" };
      }
      if (outcome === "reconnect_required") {
        await this.#requireReconnection(client, row, "egress.renewal.permissions_lost");
        return { outcome: "reconnect_required" };
      }
      return { outcome };
    }
  }

  /**
   * The gate + CAS store. The swap is ONE UPDATE: material, expiry, granted
   * scopes, `lastRenewedAt`, and — for a rotating response — the old material
   * ledger-marked in the same statement (ADR-0008's rule). The CAS predicate
   * (`material` as-read, status still live) makes a concurrent disconnect,
   * invalidation, or reconnect-upsert a LOSS rather than a clobber.
   */
  async #storeRenewed(
    client: PoolClient,
    row: UserConnection,
    provider: ConnectionProvider,
    envelope: ConnectionMaterial,
    token: Awaited<ReturnType<typeof refreshTokenGrant>>,
  ): Promise<RenewalResult> {
    // A usable positive lifetime (criterion 35): `expires_in` may be absent
    // per RFC 6749 §4.2.2's MAY — criterion 35 does not tolerate it.
    if (
      typeof token.expires_in !== "number" ||
      !Number.isFinite(token.expires_in) ||
      token.expires_in <= 0
    ) {
      return { outcome: "admin_action" };
    }
    // RFC 6749 §6: a successful response may omit `refresh_token` — the
    // existing one remains valid. Both rotation modes land here.
    const replacement =
      typeof token.refresh_token === "string" && token.refresh_token.length > 0
        ? token.refresh_token
        : undefined;
    // A response that names its granted scopes must still cover every
    // configured permission — an omitted field changes nothing (the same
    // omitted-means-granted rule the exchange's gate applies). A narrowed set
    // is an explicit loss of required permissions (criterion 35).
    const grantedScopes =
      typeof token.scope === "string"
        ? token.scope.split(" ").filter((s) => s.length > 0)
        : row.grantedScopes;
    if (
      typeof token.scope === "string" &&
      provider.requestedScopes.some((scope) => !grantedScopes.includes(scope))
    ) {
      return await this.#requireReconnection(client, row, "egress.renewal.permissions_lost");
    }

    const expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();
    const rotating = replacement !== undefined;

    let newMaterial: string;
    try {
      const newAccess = await this.#delegatedStore.seal(token.access_token);
      const newRefresh =
        replacement === undefined ? envelope.refresh : await this.#delegatedStore.seal(replacement);
      newMaterial = JSON.stringify(
        ConnectionMaterialSchema.parse({ access: newAccess, refresh: newRefresh }),
      );
    } catch {
      // A seal (custody) failure AFTER the vendor answered. With a replacement
      // received, the presented refresh token was consumed by the rotation and
      // nothing usable was SAVED — criterion 39's uncertain rotation, whatever
      // the vendor's rotation habit. Without one, the old refresh token stands
      // unharmed — the row is preserved and a later attempt may try again.
      if (rotating) {
        await this.#requireReconnection(client, row, "egress.renewal.seal_failed_after_rotation");
        return { outcome: "uncertain_rotation" };
      }
      return { outcome: "temporary_failure" };
    }

    const { rowCount } = await client.query(
      rotating
        ? `UPDATE user_connections
             SET "material" = $2, "expiresAt" = $3, "grantedScopes" = $4::jsonb,
                 status = 'live', "lastRenewedAt" = now(), "renewBeforeNext" = false,
                 "pendingRetire" = $5
           WHERE id = $1 AND "material" = $6 AND status = 'live'`
        : `UPDATE user_connections
             SET "material" = $2, "expiresAt" = $3, "grantedScopes" = $4::jsonb,
                 status = 'live', "lastRenewedAt" = now(), "renewBeforeNext" = false
           WHERE id = $1 AND "material" = $5 AND status = 'live'`,
      rotating
        ? [
            row.id,
            newMaterial,
            expiresAt,
            JSON.stringify(grantedScopes),
            row.material,
            row.material,
          ]
        : [row.id, newMaterial, expiresAt, JSON.stringify(grantedScopes), row.material],
    );
    if (rowCount === 1) {
      return { outcome: "refreshed", accessToken: token.access_token };
    }

    // CAS LOSS: the row changed under us — a disconnect, invalidation, or
    // reconnect upsert won the row while the vendor call ran. The material
    // just sealed is orphaned (no row references it). In the rotating case
    // both sealed references are live, unreferenced, and ours alone —
    // ledger-mark them for the sweep's destroy (T-0025), the portal's
    // lost-race compensation pattern (completion.ts). In the non-rotating
    // case the new envelope would carry the RETAINED old refresh material,
    // which the row (or its replacement) may still reference — criterion 48
    // forbids retiring a current connection's material — so only the new
    // access reference is abandoned, expiring uselessly: ADR-0008's accepted
    // residual class, not a new failure mode.
    if (rotating) {
      await client
        .query(`UPDATE user_connections SET "pendingRetire" = $2 WHERE id = $1`, [
          row.id,
          newMaterial,
        ])
        .catch(() => null);
    }
    return await this.#afterCasLoss(client, {
      userOid: row.userOid,
      providerId: row.providerId,
      env: row.env,
    });
  }

  /**
   * A lost race, per the design (criterion 32): an older renewal cannot
   * replace a newer connection or reverse a disconnection. Re-read once: a
   * live, fresh row means fresh usable material exists — proceed on it;
   * anything else means the connection as-was is gone.
   */
  async #afterCasLoss(client: PoolClient, target: RenewalTarget): Promise<RenewalResult> {
    const current = await this.#readRow(client, target).catch(() => null);
    if (current !== null && current.status === "live" && !isRenewalDue(current)) {
      return this.#proceedWithRow(current);
    }
    return { outcome: "reconnect_required" };
  }

  /**
   * The row flip both `uncertain_rotation` and an explicit permission loss
   * share: status → reconnect-needed and the abandoned material ledger-marked
   * in the SAME UPDATE (the invalidation writer ADR-0008 names). CAS-guarded —
   * a row that moved on under us has its own fate; the outcome stands either
   * way, because what was observed governs whether the OLD token may ever be
   * re-presented (it may not).
   */
  async #requireReconnection(
    client: PoolClient,
    row: UserConnection,
    event: string,
  ): Promise<RenewalResult> {
    await client
      .query(
        `UPDATE user_connections
            SET status = 'reconnect-needed', "pendingRetire" = $2
          WHERE id = $1 AND "material" = $3 AND status = 'live'`,
        [row.id, row.material, row.material],
      )
      .catch(() => null);
    this.#log.warn(
      { event, providerRef: this.#providers.get(row.providerId)?.ref },
      "connection requires reconnection after renewal",
    );
    return { outcome: "reconnect_required" };
  }

  /** Open the row's current access token — `refreshed`'s usable material. */
  async #proceedWithRow(row: UserConnection): Promise<RenewalResult> {
    try {
      const envelope = ConnectionMaterialSchema.parse(JSON.parse(row.material));
      const accessToken = await this.#delegatedStore.open(envelope.access);
      return { outcome: "refreshed", accessToken };
    } catch {
      // Custody failure on an otherwise-fresh row: the row is fine, the vault
      // is not. Nothing was renewed; the caller's request fails temporarily.
      return { outcome: "temporary_failure" };
    }
  }

  /**
   * Read the connection row — on the held client when given (the critical
   * section's authoritative read) or the pool (the fast path). A row that
   * fails the stored-row parse reads as absent: fail closed, never renew
   * against a row this process cannot parse.
   */
  async #readRow(client: PoolClient | null, target: RenewalTarget): Promise<UserConnection | null> {
    const runner = client ?? this.#pool;
    const { rows } = await runner.query<UserConnectionRow>(
      `SELECT ${READ_COLUMNS} FROM user_connections
        WHERE "userOid" = $1 AND "providerId" = $2::uuid AND env = $3`,
      [target.userOid, target.providerId, target.env],
    );
    const raw = rows[0];
    if (raw === undefined) return null;
    try {
      return userConnectionFromPg(raw);
    } catch {
      this.#log.warn(
        { event: "egress.renewal.row_unparseable" },
        "user_connections row failed the stored-row schema parse",
      );
      return null;
    }
  }
}
