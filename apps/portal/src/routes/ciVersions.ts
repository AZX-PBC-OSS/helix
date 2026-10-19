import type { FastifyInstance } from "fastify";
import type { JWTVerifyGetKey } from "jose";
import {
  ATTR_APP_ID,
  ATTR_OUTCOME,
  SPAN_DEPLOY_REPO,
  type RepoDeployOutcome,
} from "@azx-pbc/shared/telemetry";
import { createGithubOidcVerifier, type GithubOidcVerifier } from "../auth/githubOidc.js";
import { toVersion } from "../db/mappers.js";
import { resolveRepoDeployConfig } from "../deployment.js";
import { AppError } from "../plugins/errors.js";
import {
  auditBoundDenial,
  authenticateRepoDeploy,
  pinBinding,
  RepoDeployDenied,
} from "../plugins/repoDeployAuth.js";
import { instruments, withSpan } from "../telemetry.js";
import { deployUploadedBundle, rejectArchived } from "./versions.js";

export interface CiVersionRoutesOptions {
  /** Inject the GitHub key resolver (tests); defaults to the issuer's remote JWKS. */
  getKey?: JWTVerifyGetKey;
}

/**
 * The CI deploy route (ADR-0051): a GitHub Actions job on the app's bound repo
 * and branch uploads a bundle, authenticated by its own OIDC token. It can only
 * create a preview of that app. This is the only route that accepts a GitHub
 * token; the verifier is not in the `authenticate` chain.
 */
export async function ciVersionRoutes(
  app: FastifyInstance,
  opts: CiVersionRoutesOptions,
): Promise<void> {
  // One verifier per issuer and audience. Both are read per request so a test
  // can change the env, but in a running portal they never change.
  let cached: { key: string; verifier: GithubOidcVerifier } | null = null;
  const verifierFor = (issuer: string, audience: string): GithubOidcVerifier => {
    const key = `${issuer} ${audience}`;
    if (cached?.key !== key) {
      cached = {
        key,
        verifier: createGithubOidcVerifier({ issuer, audience, getKey: opts.getKey }),
      };
    }
    return cached.verifier;
  };

  app.post<{ Params: { slug: string } }>("/api/v1/apps/:slug/ci/versions", async (req, reply) => {
    const config = resolveRepoDeployConfig();
    if (!config.enabled) {
      throw new AppError("not_found", "repo-backed deploys are not enabled on this portal");
    }

    // Unset only if something failed before a decision (a database error);
    // the span records that, and the counter counts decisions.
    let outcome: RepoDeployOutcome | undefined;
    let appId: string | undefined;
    try {
      await withSpan(
        SPAN_DEPLOY_REPO,
        {},
        async (span) => {
          try {
            // Before `req.file()`: a refused request never reads the body.
            const principal = await authenticateRepoDeploy(
              req,
              verifierFor(config.issuer, config.audience),
            );
            appId = principal.appId;
            outcome = "accepted";
            span.setAttributes({ [ATTR_APP_ID]: appId, [ATTR_OUTCOME]: outcome });

            // An archived app is frozen: refuse before pinning anything on it.
            rejectArchived({ slug: principal.slug, archivedAt: principal.archivedAt });
            if (principal.pinNeeded) await pinBinding(req, principal);

            const { claims } = principal;
            const { version, warnings } = await deployUploadedBundle(app, req, {
              appId: principal.appId,
              actor: `github:${principal.bindingName}`,
              acceptReport: false,
              source: {
                provider: "github",
                repositoryId: claims.repository_id,
                repoFullName: principal.repoFullName,
                ref: claims.ref,
                commitSha: claims.sha,
                workflowRef: claims.job_workflow_ref,
                runId: claims.run_id,
                runAttempt: Number(claims.run_attempt),
                actor: claims.actor,
                tokenJti: claims.jti,
              },
            }).catch(async (err: unknown) => {
              // Two concurrent requests with one token: the loser's insert hit
              // the unique jti after both passed the pre-check.
              if (isReplay(err)) {
                outcome = "replayed";
                span.setAttribute(ATTR_OUTCOME, outcome);
                await auditBoundDenial(
                  req,
                  principal.appId,
                  { repoFullName: principal.bindingName },
                  claims,
                  "replayed",
                );
              }
              throw err;
            });
            reply.status(201).send({ version: toVersion(version), warnings });
          } catch (err) {
            if (err instanceof RepoDeployDenied) {
              outcome = err.outcome;
              appId = err.appId;
              span.setAttributes({
                ...(appId ? { [ATTR_APP_ID]: appId } : {}),
                [ATTR_OUTCOME]: outcome,
              });
              req.log.warn(
                { event: "repo_deploy.denied", reason: outcome, slug: req.params.slug },
                "CI deploy refused",
              );
              throw err.error;
            }
            throw err;
          }
        },
        (err) => !(err instanceof AppError) || err.statusCode >= 500,
      );
    } finally {
      if (outcome) {
        instruments().repoDeployRequests.add(1, {
          [ATTR_OUTCOME]: outcome,
          ...(appId ? { [ATTR_APP_ID]: appId } : {}),
        });
      }
    }
  });
}

function isReplay(err: unknown): boolean {
  return (
    err instanceof AppError &&
    err.code === "conflict" &&
    (err.details as { reason?: unknown } | undefined)?.reason === "replayed"
  );
}
