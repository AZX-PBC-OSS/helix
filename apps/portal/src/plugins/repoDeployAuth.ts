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
  /** The repository's name in this token: the name at deploy time, for provenance. */
  repoFullName: string;
  /** The binding's configured name: the stable audit actor (`github:<name>`). */
  bindingName: string;
  bindingId: string;
  /** The binding has no pinned ids yet; {@link pinBinding} pins them from this token. */
  pinNeeded: boolean;
  /** Archived apps are refused before anything about them is written. */
  archivedAt: Date | null;
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

/**
 * Verify the token, authorize it against the binding and refuse a spent `jti`.
 * Writes nothing except a refusal's audit row: pinning is {@link pinBinding},
 * which the route calls only once the app is known to accept a deploy.
 */
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
    select: { id: true, archivedAt: true, repoBinding: true },
  });
  // An unknown slug is refused exactly like an app with no binding.
  if (!appRow) throw foreignRefusal("no_binding");
  const binding = appRow.repoBinding;
  const decision = authorizeRepoDeploy(claims, binding);
  if (!decision.ok) await refuse(req, appRow.id, binding, claims, decision);

  const used = await prisma.version.findUnique({
    where: { sourceTokenJti: claims.jti },
    select: { id: true },
  });
  if (used) {
    await auditBoundDenial(req, appRow.id, binding, claims, "replayed");
    throw new RepoDeployDenied("replayed", replayedTokenError(), appRow.id);
  }

  // Non-null: an accepted decision needs a binding.
  const bound = binding!;
  return {
    appId: appRow.id,
    slug,
    repoFullName: claims.repository,
    bindingName: bound.repoFullName,
    bindingId: bound.id,
    pinNeeded: decision.ok && decision.pinNeeded,
    archivedAt: appRow.archivedAt,
    claims,
  };
}

/**
 * Pin the binding's numeric ids from this first accepted token (ADR-0051
 * decision 3). Conditional on the binding still being unpinned and still naming
 * the repo just checked, so a concurrent first deploy or an owner edit can't be
 * overwritten. Whichever way the race goes, re-read and decide again.
 */
export async function pinBinding(
  req: FastifyRequest,
  principal: RepoDeployPrincipal,
): Promise<void> {
  const prisma = req.server.prisma;
  const { claims } = principal;
  await prisma.repoBinding.updateMany({
    where: { id: principal.bindingId, repositoryId: null, repoFullName: principal.bindingName },
    data: {
      repositoryId: claims.repository_id,
      repositoryOwnerId: claims.repository_owner_id,
      pinnedAt: new Date(),
    },
  });
  const binding = await prisma.repoBinding.findUnique({ where: { appId: principal.appId } });
  const decision = authorizeRepoDeploy(claims, binding);
  if (!decision.ok) await refuse(req, principal.appId, binding, claims, decision);
  // Still unpinned: the owner renamed the binding between the check and the pin.
  if (decision.ok && decision.pinNeeded) throw foreignRefusal("repo_mismatch", principal.appId);
}

function foreignRefusal(outcome: "no_binding" | "repo_mismatch", appId?: string): RepoDeployDenied {
  return new RepoDeployDenied(outcome, new AppError("forbidden", FOREIGN_REFUSAL), appId);
}

/** Throw the refusal for a failed binding check, auditing it when it's the bound repo's. */
async function refuse(
  req: FastifyRequest,
  appId: string,
  binding: BindingForAuthorize | null,
  claims: GithubClaims,
  decision: Extract<ReturnType<typeof authorizeRepoDeploy>, { ok: false }>,
): Promise<never> {
  if (!decision.boundRepo) {
    throw foreignRefusal(decision.reason as "no_binding" | "repo_mismatch", appId);
  }
  const message = BOUND_REFUSALS[decision.reason as keyof typeof BOUND_REFUSALS];
  await auditBoundDenial(req, appId, binding, claims, decision.reason);
  throw new RepoDeployDenied(
    decision.reason,
    new AppError("forbidden", message, { reason: decision.reason }),
    appId,
  );
}

/**
 * The audit row for a refusal of the bound repo's own token. It records what
 * the owner needs to find the run, never the token.
 */
export async function auditBoundDenial(
  req: FastifyRequest,
  appId: string,
  binding: Pick<BindingForAuthorize, "repoFullName"> | null,
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
