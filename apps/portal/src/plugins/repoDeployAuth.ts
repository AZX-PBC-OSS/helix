import type { FastifyRequest } from "fastify";
import type { RepoDeployOutcome } from "@azx-pbc/shared/telemetry";
import type { GithubClaims, GithubOidcVerifier } from "../auth/githubOidc.js";
import { authorizeRepoDeploy, type BindingForAuthorize } from "../repoDeploy/authorize.js";
import { replayedTokenError } from "../deploy/upload.js";
import { AppError } from "./errors.js";

/**
 * Authentication for `POST /api/v1/apps/:slug/ci/versions`, the one route that
 * accepts a GitHub Actions token (ADR-0051 decision 6). It runs before the
 * handler reads the multipart body (decision 7), so a refused request never
 * spools a byte.
 *
 * The result is a workload principal, not an {@link Actor}: nothing here sets
 * `req.actor`, so no `requireActor` route can be reached with it.
 *
 * Refusals are deliberately uneven. A caller that is not the bound repo — a
 * token from another repo, an app with no binding, an unknown slug — gets one
 * uniform 403 and no audit row, because anyone with a GitHub repo can mint a
 * validly signed token with this portal's audience. The bound repo is told the
 * reason and gets an audit row, because those refusals are a real signal about
 * the bound repo's workflows.
 */

export interface RepoDeployPrincipal {
  appId: string;
  slug: string;
  repoFullName: string;
  claims: GithubClaims;
}

/** A refusal, carrying the outcome the route records before rethrowing. */
export class RepoDeployDenied extends Error {
  readonly outcome: Exclude<RepoDeployOutcome, "accepted">;
  readonly appId: string | undefined;
  readonly error: AppError;

  constructor(outcome: Exclude<RepoDeployOutcome, "accepted">, error: AppError, appId?: string) {
    super(error.message);
    this.name = "RepoDeployDenied";
    this.outcome = outcome;
    this.error = error;
    this.appId = appId;
  }
}

const FOREIGN_REFUSAL = "this token may not deploy to this app";

const BOUND_REFUSALS = {
  ref_mismatch: "the token's ref is not the bound branch",
  event_rejected: "only push and workflow_dispatch runs may deploy",
  workflow_mismatch: "the token's job_workflow_ref is not the pinned workflow",
  environment_mismatch: "the token's environment is not the pinned environment",
} as const;

export async function authenticateRepoDeploy(
  req: FastifyRequest,
  verifier: GithubOidcVerifier,
): Promise<RepoDeployPrincipal> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (!token) {
    throw new RepoDeployDenied("bad_token", new AppError("unauthorized", "missing bearer token"));
  }
  const verified = await verifier.verify(token);
  if (!verified.ok) {
    throw new RepoDeployDenied(
      verified.outcome,
      new AppError("unauthorized", "not a valid GitHub Actions token for this portal"),
    );
  }
  const { claims } = verified;
  const { slug } = req.params as { slug: string };
  const prisma = req.server.prisma;

  const appRow = await prisma.app.findUnique({
    where: { slug },
    select: { id: true, repoBinding: true },
  });
  // An unknown slug is refused exactly like an app with no binding.
  const foreign = (outcome: "no_binding" | "repo_mismatch") =>
    new RepoDeployDenied(outcome, new AppError("forbidden", FOREIGN_REFUSAL), appRow?.id);
  if (!appRow) throw foreign("no_binding");

  let binding = appRow.repoBinding;
  let decision = authorizeRepoDeploy(claims, binding);
  if (decision.ok && decision.pinNeeded && binding) {
    // Pin the numeric ids from this first accepted token (ADR-0051 decision 3).
    // Conditional on the binding still being unpinned and still naming the repo
    // just checked, so a concurrent first deploy or an owner edit can't be
    // overwritten. Whichever way the race goes, re-read and decide again.
    await prisma.repoBinding.updateMany({
      where: { id: binding.id, repositoryId: null, repoFullName: binding.repoFullName },
      data: {
        repositoryId: claims.repository_id,
        repositoryOwnerId: claims.repository_owner_id,
        pinnedAt: new Date(),
      },
    });
    binding = await prisma.repoBinding.findUnique({ where: { appId: appRow.id } });
    decision = authorizeRepoDeploy(claims, binding);
    if (decision.ok && decision.pinNeeded)
      decision = { ok: false, reason: "repo_mismatch", boundRepo: false };
  }

  if (!decision.ok) {
    if (!decision.boundRepo) throw foreign(decision.reason as "no_binding" | "repo_mismatch");
    const refusal = new AppError(
      "forbidden",
      BOUND_REFUSALS[decision.reason as keyof typeof BOUND_REFUSALS],
      {
        reason: decision.reason,
      },
    );
    await auditBoundDenial(req, appRow.id, binding, claims, decision.reason);
    throw new RepoDeployDenied(decision.reason, refusal, appRow.id);
  }

  const used = await prisma.version.findUnique({
    where: { sourceTokenJti: claims.jti },
    select: { id: true },
  });
  if (used) {
    await auditBoundDenial(req, appRow.id, binding, claims, "replayed");
    throw new RepoDeployDenied("replayed", replayedTokenError(), appRow.id);
  }

  return {
    appId: appRow.id,
    slug,
    // Non-null: an accepted decision needs a binding.
    repoFullName: binding!.repoFullName,
    claims,
  };
}

/**
 * The audit row for a refusal of the bound repo's own token. It records what
 * the owner needs to find the run, never the token.
 */
export async function auditBoundDenial(
  req: FastifyRequest,
  appId: string,
  binding: BindingForAuthorize | null,
  claims: GithubClaims,
  reason: string,
): Promise<void> {
  await req.server.prisma.auditEvent.create({
    data: {
      appId,
      actor: `github:${binding?.repoFullName ?? claims.repository}`,
      action: "app.repo-deploy.denied",
      metadata: {
        reason,
        repositoryId: claims.repository_id,
        ref: claims.ref,
        eventName: claims.event_name,
        sha: claims.sha,
        runId: claims.run_id,
        runAttempt: Number(claims.run_attempt),
        githubActor: claims.actor,
      },
    },
  });
}
