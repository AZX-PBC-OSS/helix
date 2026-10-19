import type { RepoDeployOutcome } from "@azx-pbc/shared/telemetry";
import type { GithubClaims } from "../auth/githubOidc.js";

/**
 * Whether a verified GitHub Actions token may deploy to an app with this
 * binding (ADR-0051 decisions 3–5). Pure, so every rule is unit-tested without
 * a database. Replay (`jti`) is checked by the caller, which needs the database.
 */

/** The binding fields the decision reads. */
export interface BindingForAuthorize {
  repoFullName: string;
  branch: string;
  repositoryId: string | null;
  repositoryOwnerId: string | null;
  workflowRef: string | null;
  environment: string | null;
}

export type AuthorizeResult =
  | { ok: true; pinNeeded: boolean }
  | {
      ok: false;
      reason: Exclude<RepoDeployOutcome, "accepted" | "bad_token" | "bad_audience" | "replayed">;
      /**
       * The token came from the bound repository. Only then is the caller told
       * the reason and an audit row written; anyone else gets a uniform
       * refusal, so bindings can't be enumerated with a token from another repo.
       */
      boundRepo: boolean;
    };

/**
 * The events that may deploy. An allowlist because the dangerous events are
 * the ones that carry the base branch's `ref` on behalf of someone without
 * push access: `pull_request_target`, `workflow_run` and `issue_comment`.
 */
const ALLOWED_EVENTS: ReadonlySet<string> = new Set(["push", "workflow_dispatch"]);

export function authorizeRepoDeploy(
  claims: GithubClaims,
  binding: BindingForAuthorize | null,
): AuthorizeResult {
  if (!binding) return { ok: false, reason: "no_binding", boundRepo: false };

  // Before pinning, the configured name is the only identity there is. GitHub
  // names are case-insensitive. After pinning, both numeric ids must match and
  // the name is ignored: that is what survives a rename, and what stops a
  // transferred repo or a reclaimed name from deploying.
  const pinned = binding.repositoryId !== null && binding.repositoryOwnerId !== null;
  const repoMatches = pinned
    ? claims.repository_id === binding.repositoryId &&
      claims.repository_owner_id === binding.repositoryOwnerId
    : claims.repository.toLowerCase() === binding.repoFullName.toLowerCase();
  if (!repoMatches) return { ok: false, reason: "repo_mismatch", boundRepo: false };

  // A `pull_request` token carries `refs/pull/<n>/merge` and fails here.
  if (claims.ref_type !== "branch" || claims.ref !== `refs/heads/${binding.branch}`) {
    return { ok: false, reason: "ref_mismatch", boundRepo: true };
  }
  if (!ALLOWED_EVENTS.has(claims.event_name)) {
    return { ok: false, reason: "event_rejected", boundRepo: true };
  }
  if (binding.workflowRef !== null && claims.job_workflow_ref !== binding.workflowRef) {
    return { ok: false, reason: "workflow_mismatch", boundRepo: true };
  }
  // GitHub environment names are unique case-insensitively, so compare them that way.
  if (
    binding.environment !== null &&
    claims.environment?.toLowerCase() !== binding.environment.toLowerCase()
  ) {
    return { ok: false, reason: "environment_mismatch", boundRepo: true };
  }
  return { ok: true, pinNeeded: !pinned };
}
