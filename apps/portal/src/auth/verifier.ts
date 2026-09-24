import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/**
 * Portal API authentication (M3): stateless Bearer-token verification. The
 * portal is a machine-consumed REST API, so there are no cookies or sessions
 * here — the CLI (and the v1 SPA) sends an IdP-minted JWT access token with
 * a stable audience, verified against the issuer's JWKS. The same shape an
 * Entra access token has (`aud` = App ID URI), so the Entra swap is env-only.
 *
 * Verifiers form a chain: each returns an {@link Actor} or null ("not mine /
 * not valid — try the next one"). OIDC first, then the demoted dev token.
 */

/**
 * Authenticated actor (ADR-0048). oid is the canonical principal used by
 * App.ownerId, ownsApp, and scope=mine, matching the edge's principal claim.
 * sub is the display/audit label (email ?? preferred_username ?? sub), stored
 * as AuditEvent.actor. Never use that label for identity joins or access checks.
 */
export interface Actor {
  /**
   * The canonical principal id — Entra's `oid` claim from the verified access
   * token (ADR-0048). Required: a token without it cannot produce an actor,
   * mirroring the edge's fail-closed login refusal. Never rendered.
   */
  oid: string;
  /**
   * The display/audit subject — `email ?? preferred_username ?? sub`,
   * human-readable. Audit attribution (`AuditEvent.actor` stores it) is this
   * field's job and is unchanged.
   */
  sub: string;
  /** How the actor was established: `oidc` or `dev-token`. */
  via: string;
  name?: string;
  email?: string;
  /**
   * IdP group/role ids from the token — the **union** of the `groups` and
   * `roles` claims, not one falling back to the other (see
   * {@link unionClaimArrays}). Drives admin gating for approvals
   * (docs/design/approvals.md §4); empty when the token carries neither claim.
   *
   * One flat array by design: every consumer is a membership test, so a mixed
   * bag of security-group ids and App Role values needs no discrimination. Note
   * that once a deployment emits security-group claims (ADR-0040) this holds
   * group ids *and* role values together, so anything that resolves entries as
   * groups against a directory must filter by id shape rather than assume.
   */
  groups: string[];
}

/**
 * Request-scoped context for a verification. `log` is the **request** logger
 * (`req.log`), so a refusal line lands with the `reqId` every other auth
 * denial in the request path already carries (docs/design/logging.md makes
 * `reqId` the correlation key) — the construction-time `log` option below is
 * the fallback, not the preferred channel.
 */
export interface VerifyContext {
  log?: { warn(obj: object, msg: string): void };
}

export interface TokenVerifier {
  verify(token: string, ctx?: VerifyContext): Promise<Actor | null>;
}

export interface OidcVerifierOptions {
  issuer: string;
  audience: string;
  /**
   * The access-token claim carrying the canonical principal id (ADR-0048, as
   * amended): `oid` by default, configurable for issuers whose stable id
   * lives elsewhere — most non-Entra issuers' `sub` is already stable across
   * clients, so it is the usual non-Entra value, and the caller
   * (`verifiersFromEnv`) gates it behind an explicit flag. **Must equal the
   * edge's `EDGE_OIDC_PRINCIPAL_CLAIM`** — the cross-plane correlation
   * assumes both planes read the same claim.
   */
  principalClaim?: string;
  /** Injectable key resolver (tests); defaults to the issuer's remote JWKS. */
  getKey?: JWTVerifyGetKey;
  /**
   * Where the missing-principal-claim refusal is reported when no request
   * logger was supplied (ADR-0048 decision 2 — the diagnosability posture of
   * the edge's `auth.oidc_missing_principal` line). The request path passes
   * `req.log` via {@link VerifyContext}; this is the fallback for callers
   * with no request in hand. Optional so tests and construction stay quiet
   * by default.
   */
  log?: { warn(obj: object, msg: string): void };
  /**
   * Permit an `http:` issuer/JWKS (the local dev IdP). Off by default: a
   * plaintext JWKS fetch would let a network attacker supply signing keys.
   */
  allowInsecure?: boolean;
}

function claimString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The principal claim as a bounded id: a string, trimmed, 1..64 characters
 * (an Entra `oid` is a 36-char GUID; no legitimate stable id is longer).
 * Whitespace-only and oversized values are garbage rather than absence, but
 * get the same fail-closed treatment — the value flows into `Actor.oid` and
 * from there into `App.ownerId`, which want a bounded id. Mirrors the edge's
 * `principalIdClaim` (`apps/edge/src/auth/oidc.ts`).
 */
function principalClaimString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 64 ? trimmed : undefined;
}

/** Read a string-array claim (`groups`/`roles`); tolerant of absence/garbage. */
function claimStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/**
 * Union several string-array claims, deduped, first-seen order preserved.
 *
 * **This is deliberately a union and must never become `a ?? b`.** It reads
 * `groups` and `roles` together because an Entra token can legitimately carry
 * both at once: a security-groups claim on the app registration fills `groups`
 * with group ids, while the platform-admin App Role rides `roles` (ADR-0040).
 * Coalescing let the mere *presence* of `groups` discard `roles` entirely, and
 * since the admin gate (`actorIsAdmin`, plugins/auth.ts) tests for one
 * configured value in this array, that locked every platform admin out of the
 * approvals queue — set off by an IdP-side config change, with no deploy to
 * correlate it against.
 *
 * `??` also fell through only on null/undefined, so a malformed `groups` claim
 * (a bare string, a number) was truthy enough to win the coalesce and then
 * filter down to nothing, taking a valid `roles` with it. Filtering per claim
 * and unioning the results makes garbage in one claim cost only that claim.
 */
function unionClaimArrays(...values: unknown[]): string[] {
  return [...new Set(values.flatMap(claimStringArray))];
}

/**
 * Validate an IdP-minted JWT access token: signature over JWKS, issuer,
 * audience, expiry, and an asymmetric-alg pin (HS256/none confusion dies
 * here). Only standard claims are required, so Entra tokens validate
 * unchanged; email/name enrich the actor when present.
 */
export function createOidcVerifier(opts: OidcVerifierOptions): TokenVerifier {
  // Same posture as the edge (config.ts): the JWKS is the root of trust for
  // every portal mutation, so plaintext transport to it is a boot error, not
  // a runtime surprise — and the dev escape hatch refuses to exist in prod.
  if (opts.allowInsecure && process.env.NODE_ENV === "production") {
    throw new Error("PORTAL_OIDC_ALLOW_INSECURE is a dev flag and is refused in production");
  }
  if (new URL(opts.issuer).protocol !== "https:" && !opts.allowInsecure) {
    throw new Error(
      "PORTAL_OIDC_ISSUER must be https (or set PORTAL_OIDC_ALLOW_INSECURE=true in dev)",
    );
  }
  let getKey: JWTVerifyGetKey | null = opts.getKey ?? null;

  async function resolveKey(): Promise<JWTVerifyGetKey> {
    if (getKey) return getKey;
    // Discover jwks_uri once; a failure here leaves getKey unset so the next
    // request retries (the IdP may simply not be up yet in dev).
    const res = await fetch(`${opts.issuer}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
    const doc = (await res.json()) as { issuer?: string; jwks_uri?: string };
    // The discovery document feeds the trust chain: its issuer must be the
    // one we were configured for, and the JWKS it points at must be https
    // (a same-https issuer redirecting key fetches to http is an attack).
    if (doc.issuer !== opts.issuer) {
      throw new Error(
        `OIDC discovery issuer mismatch: expected ${opts.issuer}, got ${doc.issuer ?? "none"}`,
      );
    }
    if (!doc.jwks_uri) throw new Error("OIDC discovery document has no jwks_uri");
    const jwksUrl = new URL(doc.jwks_uri);
    if (jwksUrl.protocol !== "https:" && !opts.allowInsecure) {
      throw new Error(`OIDC discovery returned a non-https jwks_uri: ${doc.jwks_uri}`);
    }
    getKey = createRemoteJWKSet(jwksUrl);
    return getKey;
  }

  // One refusal line per verifier instance (review finding 5): the condition
  // is static issuer misconfiguration, not a per-caller event — a token
  // without the principal claim will lack it on every request — so an
  // unthrottled line would emit one warn per API call indefinitely. The 401s
  // are the per-request signal; this line is the one that names the cause.
  let warnedMissingPrincipal = false;

  return {
    async verify(token: string, ctx?: VerifyContext): Promise<Actor | null> {
      // Three dot-separated parts or it isn't a JWT — lets the chain fall
      // through to the dev-token verifier without a JWKS round-trip.
      if (token.split(".").length !== 3) return null;
      try {
        const { payload } = await jwtVerify(token, await resolveKey(), {
          issuer: opts.issuer,
          audience: opts.audience,
          algorithms: ["RS256", "ES256"],
          clockTolerance: 5,
        });
        // jose only *enforces* exp/iat when present — a token without them
        // would never expire. Absence must fail (same rule as the edge's
        // handoff verifier).
        if (typeof payload.exp !== "number" || typeof payload.iat !== "number") return null;
        const sub = claimString(payload.sub);
        if (!sub) return null;
        const principalClaim = opts.principalClaim ?? "oid";
        const oid = principalClaimString(payload[principalClaim]);
        if (!oid) {
          // ADR-0048 decision 2: the configured principal claim is the
          // canonical principal id — no fallback. Entra emits `oid`
          // unconditionally in access tokens, so absence is a misconfigured
          // issuer, and the token cannot produce an actor (401, not a
          // silently wrong one — falling back to `sub` would reintroduce the
          // exact pairwise bug the re-base exists to kill). One specific
          // line, so an operator is pointed at the claim and not at a
          // signature hunt; the same diagnosability posture as the edge's
          // login refusal.
          const log = ctx?.log ?? opts.log;
          if (log && !warnedMissingPrincipal) {
            warnedMissingPrincipal = true;
            log.warn(
              { event: "auth.token_missing_principal", sub, claim: principalClaim },
              `access token has no usable ${principalClaim} claim — refusing it: the ` +
                "canonical principal id (ADR-0048) is not optional and has no fallback",
            );
          }
          return null;
        }
        const email = claimString(payload.email);
        const name = claimString(payload.name);
        const preferred = claimString(payload.preferred_username);
        const groups = unionClaimArrays(payload.groups, payload.roles);
        return { oid, sub: email ?? preferred ?? sub, via: "oidc", name, email, groups };
      } catch {
        return null;
      }
    },
  };
}

/**
 * The M1 static dev token, demoted to one verifier in the chain. Kept for
 * CI/scripts (`AZX_TOKEN`); refuses to exist in production.
 *
 * The dev-token actor's `oid` is {@link DEV_TOKEN_ACTOR_OID} — a fixed
 * synthetic value (ADR-0048 decision 1), deliberately *not* shaped like a
 * directory object id: it can never be mistaken for one, never matches an
 * `App.ownerId` written by a real login (so a dev-token actor owns only what
 * it created itself), and is stable so CI fixtures and `scope=mine` behave
 * deterministically.
 */
export function createDevTokenVerifier(
  expected: string,
  actorSub: string,
  groups: string[] = [],
): TokenVerifier {
  if (process.env.NODE_ENV === "production") {
    throw new Error("PORTAL_DEV_TOKEN is a dev/CI verifier and is refused in production");
  }
  const expectedBuf = Buffer.from(expected);
  return {
    async verify(token: string, ctx?: VerifyContext): Promise<Actor | null> {
      // A static token has no issuer to complain about, so there is nothing
      // to log — but the signature is the chain's, so `authenticate` passes
      // the request context uniformly.
      void ctx;
      // Constant-time compare; the length check leaks only the length.
      const tokenBuf = Buffer.from(token);
      if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
        return null;
      }
      return { oid: DEV_TOKEN_ACTOR_OID, sub: actorSub, via: "dev-token", groups };
    },
  };
}

/** The dev-token actor's fixed synthetic `oid` — see `createDevTokenVerifier`. */
export const DEV_TOKEN_ACTOR_OID = "dev-token-actor";
