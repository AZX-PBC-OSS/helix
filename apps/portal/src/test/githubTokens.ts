import { randomUUID } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";

/**
 * GitHub Actions OIDC tokens for tests (ADR-0051). One fixture issuer key and
 * one stranger key per suite; `mint` produces a token shaped like GitHub's,
 * with every claim the CI route reads, and any of them overridable or removable.
 */

export const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";

export type SignKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

export interface GithubTokenFixture {
  getKey: JWTVerifyGetKey;
  /** A key GitHub's JWKS doesn't list. */
  strangerKey: SignKey;
  mint(opts?: MintGithubOptions): Promise<string>;
}

export interface MintGithubOptions {
  audience?: string | string[];
  issuer?: string;
  /** Claims to set; `undefined` removes a default claim. */
  claims?: Record<string, unknown>;
  expiresIn?: string;
  /** Unix seconds; past values make an already-expired token. */
  exp?: number;
  nbf?: number;
  key?: SignKey;
}

/** The default claims: a push to `main` on repo 1001 owned by 2002. */
export function defaultGithubClaims(): Record<string, unknown> {
  return {
    jti: randomUUID(),
    repository: "octo-org/octo-app",
    repository_id: "1001",
    repository_owner: "octo-org",
    repository_owner_id: "2002",
    ref: "refs/heads/main",
    ref_type: "branch",
    sha: "0123456789abcdef0123456789abcdef01234567",
    event_name: "push",
    workflow_ref: "octo-org/octo-app/.github/workflows/helix-deploy.yml@refs/heads/main",
    job_workflow_ref: "octo-org/octo-app/.github/workflows/helix-deploy.yml@refs/heads/main",
    run_id: "777",
    run_attempt: "1",
    actor: "octocat",
    sub: "repo:octo-org/octo-app:ref:refs/heads/main",
  };
}

export async function githubTokenFixture(defaultAudience: string): Promise<GithubTokenFixture> {
  const github = await generateKeyPair("RS256");
  const stranger = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(github.publicKey)), alg: "RS256", use: "sig", kid: "gh-1" };
  return {
    getKey: createLocalJWKSet({ keys: [jwk] }),
    strangerKey: stranger.privateKey,
    async mint(opts: MintGithubOptions = {}) {
      const claims = { ...defaultGithubClaims(), ...opts.claims };
      for (const [k, v] of Object.entries(claims)) if (v === undefined) delete claims[k];
      let jwt = new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "gh-1" })
        .setIssuer(opts.issuer ?? GITHUB_ISSUER)
        .setAudience(opts.audience ?? defaultAudience)
        .setIssuedAt();
      jwt =
        opts.exp !== undefined
          ? jwt.setExpirationTime(opts.exp)
          : jwt.setExpirationTime(opts.expiresIn ?? "5m");
      if (opts.nbf !== undefined) jwt = jwt.setNotBefore(opts.nbf);
      return jwt.sign(opts.key ?? github.privateKey);
    },
  };
}
