import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";

/**
 * A lazily discovered JWKS key resolver for an OIDC issuer. Shared by the
 * people verifier (`createOidcVerifier`) and the GitHub Actions verifier
 * (`createGithubOidcVerifier`), so both apply the same discovery rules.
 *
 * Discovery runs on first use. A failure leaves the resolver unset so the next
 * request retries, because the IdP may simply not be up yet in dev. The
 * discovery document feeds the trust chain: its `issuer` must be the configured
 * one, and the `jwks_uri` it points at must be https. A same-https issuer
 * redirecting key fetches to http is an attack.
 */
export function lazyIssuerJwks(
  issuer: string,
  opts: { allowInsecure?: boolean; getKey?: JWTVerifyGetKey } = {},
): () => Promise<JWTVerifyGetKey> {
  let getKey: JWTVerifyGetKey | null = opts.getKey ?? null;
  return async () => {
    if (getKey) return getKey;
    const res = await fetch(`${issuer}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
    const doc = (await res.json()) as { issuer?: string; jwks_uri?: string };
    if (doc.issuer !== issuer) {
      throw new Error(
        `OIDC discovery issuer mismatch: expected ${issuer}, got ${doc.issuer ?? "none"}`,
      );
    }
    if (!doc.jwks_uri) throw new Error("OIDC discovery document has no jwks_uri");
    const jwksUrl = new URL(doc.jwks_uri);
    if (jwksUrl.protocol !== "https:" && !opts.allowInsecure) {
      throw new Error(`OIDC discovery returned a non-https jwks_uri: ${doc.jwks_uri}`);
    }
    getKey = createRemoteJWKSet(jwksUrl);
    return getKey;
  };
}
