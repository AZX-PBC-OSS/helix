import { jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { lazyIssuerJwks } from "./jwks.js";

/**
 * GitHub Actions OIDC token verification for the CI deploy route (ADR-0051
 * decisions 4 and 6).
 *
 * **This is not a {@link TokenVerifier} and must never join the
 * `tokenVerifiers` chain behind `authenticate`.** A GitHub-signed token is a
 * workload credential that can create a preview of one bound app and do nothing
 * else; in the chain it would pass every route that only checks sign-in. The CI
 * route's own preHandler (`plugins/repoDeployAuth.ts`) is its only caller.
 *
 * This module answers "is this a GitHub-issued token for this portal, and what
 * does it say?". Whether those claims may deploy to a given app is
 * `repoDeploy/authorize.ts`.
 */

/** GitHub sends numeric ids as decimal strings. */
const NumericId = z.string().regex(/^[0-9]{1,20}$/);

/** The claims the binding check reads. A token missing any of them is refused. */
const GithubClaimsSchema = z.object({
  jti: z.string().min(1).max(128),
  repository: z.string().min(1).max(140),
  repository_id: NumericId,
  repository_owner_id: NumericId,
  ref: z.string().min(1).max(512),
  ref_type: z.string().min(1).max(32),
  sha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
  event_name: z.string().min(1).max(64),
  workflow_ref: z.string().min(1).max(512),
  // GitHub documents this as "for jobs using a reusable workflow". Absent, the
  // job's own workflow is the one that ran, so `workflow_ref` stands in.
  job_workflow_ref: z.string().min(1).max(512).optional(),
  environment: z.string().min(1).max(255).optional(),
  run_id: NumericId,
  run_attempt: NumericId,
  actor: z.string().min(1).max(64),
});
/** The verified claims, with `job_workflow_ref` always set (see the schema). */
export type GithubClaims = z.infer<typeof GithubClaimsSchema> & { job_workflow_ref: string };

export type GithubVerifyResult =
  | { ok: true; claims: GithubClaims }
  | { ok: false; outcome: "bad_token" | "bad_audience" };

export interface GithubOidcVerifier {
  verify(token: string): Promise<GithubVerifyResult>;
}

export interface GithubOidcVerifierOptions {
  /** `https://token.actions.githubusercontent.com` unless the tenant customizes it. */
  issuer: string;
  /** This portal's public origin, compared exactly. */
  audience: string;
  /** Injectable key resolver (tests); defaults to the issuer's remote JWKS. */
  getKey?: JWTVerifyGetKey;
}

export function createGithubOidcVerifier(opts: GithubOidcVerifierOptions): GithubOidcVerifier {
  if (new URL(opts.issuer).protocol !== "https:") {
    throw new Error("the GitHub Actions OIDC issuer must be https");
  }
  const resolveKey = lazyIssuerJwks(opts.issuer, { getKey: opts.getKey });

  return {
    async verify(token: string): Promise<GithubVerifyResult> {
      if (token.split(".").length !== 3) return { ok: false, outcome: "bad_token" };
      let payload: Record<string, unknown>;
      try {
        // The audience is checked below rather than by jose, so a refusal can
        // say whether the token was GitHub-signed for someone else. Both are
        // refusals; the distinction only feeds the counter.
        ({ payload } = await jwtVerify(token, await resolveKey(), {
          issuer: opts.issuer,
          algorithms: ["RS256"],
          clockTolerance: 5,
          requiredClaims: ["exp", "iat", "jti"],
        }));
      } catch {
        return { ok: false, outcome: "bad_token" };
      }
      // A single string, compared exactly. GitHub's default audience
      // (`https://github.com/<owner>`) and any array form are refused, so a token
      // minted for another service can't be replayed here.
      if (payload.aud !== opts.audience) return { ok: false, outcome: "bad_audience" };
      const parsed = GithubClaimsSchema.safeParse(payload);
      if (!parsed.success) return { ok: false, outcome: "bad_token" };
      const claims = parsed.data;
      return {
        ok: true,
        claims: { ...claims, job_workflow_ref: claims.job_workflow_ref ?? claims.workflow_ref },
      };
    },
  };
}
