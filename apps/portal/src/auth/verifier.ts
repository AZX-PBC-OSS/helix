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
}

export interface TokenVerifier {
  verify(token: string): Promise<Actor | null>;
}

export interface OidcVerifierOptions {
  issuer: string;
  audience: string;
  /** Injectable key resolver (tests); defaults to the issuer's remote JWKS. */
  getKey?: JWTVerifyGetKey;
}

function claimString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Validate an IdP-minted JWT access token: signature over JWKS, issuer,
 * audience, expiry, and an asymmetric-alg pin (HS256/none confusion dies
 * here). Only standard claims are required, so Entra tokens validate
 * unchanged; email/name enrich the actor when present.
 */
export function createOidcVerifier(opts: OidcVerifierOptions): TokenVerifier {
  let getKey: JWTVerifyGetKey | null = opts.getKey ?? null;

  async function resolveKey(): Promise<JWTVerifyGetKey> {
    if (getKey) return getKey;
    // Discover jwks_uri once; a failure here leaves getKey unset so the next
    // request retries (the IdP may simply not be up yet in dev).
    const res = await fetch(`${opts.issuer}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
    const doc = (await res.json()) as { jwks_uri?: string };
    if (!doc.jwks_uri) throw new Error("OIDC discovery document has no jwks_uri");
    getKey = createRemoteJWKSet(new URL(doc.jwks_uri));
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
        const sub = claimString(payload.sub);
        if (!sub) return null;
        const email = claimString(payload.email);
        const name = claimString(payload.name);
        const preferred = claimString(payload.preferred_username);
        return { sub: email ?? preferred ?? sub, via: "oidc", name, email };
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
export function createDevTokenVerifier(expected: string, actorSub: string): TokenVerifier {
  if (process.env.NODE_ENV === "production") {
    throw new Error("PORTAL_DEV_TOKEN is a dev/CI verifier and is refused in production");
  }
  return {
    async verify(token: string): Promise<Actor | null> {
      if (token !== expected) return null;
      return { sub: actorSub, via: "dev-token" };
    },
  };
}
