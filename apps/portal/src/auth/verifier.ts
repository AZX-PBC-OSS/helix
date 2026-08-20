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
 * The authenticated principal behind a mutating request. Same shape since M1
 * — audit attribution (`AuditEvent.actor` stores `sub`) is unchanged.
 */
export interface Actor {
  /** Authenticated subject — an email or principal id, human-readable. */
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

export interface TokenVerifier {
  verify(token: string): Promise<Actor | null>;
}

export interface OidcVerifierOptions {
  issuer: string;
  audience: string;
  /** Injectable key resolver (tests); defaults to the issuer's remote JWKS. */
  getKey?: JWTVerifyGetKey;
  /**
   * Permit an `http:` issuer/JWKS (the local dev IdP). Off by default: a
   * plaintext JWKS fetch would let a network attacker supply signing keys.
   */
  allowInsecure?: boolean;
}

function claimString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

  return {
    async verify(token: string): Promise<Actor | null> {
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
        const email = claimString(payload.email);
        const name = claimString(payload.name);
        const preferred = claimString(payload.preferred_username);
        const groups = unionClaimArrays(payload.groups, payload.roles);
        return { sub: email ?? preferred ?? sub, via: "oidc", name, email, groups };
      } catch {
        return null;
      }
    },
  };
}

/**
 * The M1 static dev token, demoted to one verifier in the chain. Kept for
 * CI/scripts (`AZX_TOKEN`); refuses to exist in production.
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
    async verify(token: string): Promise<Actor | null> {
      // Constant-time compare; the length check leaks only the length.
      const tokenBuf = Buffer.from(token);
      if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
        return null;
      }
      return { sub: actorSub, via: "dev-token", groups };
    },
  };
}
