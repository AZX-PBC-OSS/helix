import { describe, expect, it } from "vitest";
import type { GithubClaims } from "../auth/githubOidc.js";
import { defaultGithubClaims } from "../test/githubTokens.js";
import { authorizeRepoDeploy, type BindingForAuthorize } from "./authorize.js";

/** ADR-0051 decisions 3–5, one rule per row. */

const claims = (over: Partial<GithubClaims> = {}): GithubClaims =>
  ({ ...defaultGithubClaims(), ...over }) as GithubClaims;

const unpinned: BindingForAuthorize = {
  repoFullName: "octo-org/octo-app",
  branch: "main",
  repositoryId: null,
  repositoryOwnerId: null,
  workflowRef: null,
  environment: null,
};
const pinned: BindingForAuthorize = {
  ...unpinned,
  repositoryId: "1001",
  repositoryOwnerId: "2002",
};

describe("authorizeRepoDeploy", () => {
  it("accepts the bound repo before pinning, and asks for a pin", () => {
    expect(authorizeRepoDeploy(claims(), unpinned)).toEqual({ ok: true, pinNeeded: true });
  });

  it("matches the unpinned name case-insensitively", () => {
    expect(authorizeRepoDeploy(claims({ repository: "Octo-Org/Octo-App" }), unpinned).ok).toBe(
      true,
    );
  });

  it("accepts a pinned repo after a rename", () => {
    expect(authorizeRepoDeploy(claims({ repository: "octo-org/renamed" }), pinned)).toEqual({
      ok: true,
      pinNeeded: false,
    });
  });

  it.each<[string, Partial<GithubClaims>, BindingForAuthorize | null, string, boolean]>([
    ["no binding", {}, null, "no_binding", false],
    ["another repo, unpinned", { repository: "evil/octo-app" }, unpinned, "repo_mismatch", false],
    ["another repo id", { repository_id: "9999" }, pinned, "repo_mismatch", false],
    [
      "a reclaimed name (same name, new ids)",
      { repository_id: "9999", repository_owner_id: "8888" },
      pinned,
      "repo_mismatch",
      false,
    ],
    [
      "a transferred repo (same id, new owner)",
      { repository_owner_id: "8888" },
      pinned,
      "repo_mismatch",
      false,
    ],
    ["another branch", { ref: "refs/heads/dev" }, pinned, "ref_mismatch", true],
    [
      "a pull_request merge ref",
      { ref: "refs/pull/1/merge", event_name: "pull_request" },
      pinned,
      "ref_mismatch",
      true,
    ],
    [
      "a tag with the branch's name",
      { ref: "refs/tags/main", ref_type: "tag" },
      pinned,
      "ref_mismatch",
      true,
    ],
    ["a branch ref claiming tag type", { ref_type: "tag" }, pinned, "ref_mismatch", true],
    ["pull_request_target", { event_name: "pull_request_target" }, pinned, "event_rejected", true],
    ["workflow_run", { event_name: "workflow_run" }, pinned, "event_rejected", true],
    ["issue_comment", { event_name: "issue_comment" }, pinned, "event_rejected", true],
    ["schedule", { event_name: "schedule" }, pinned, "event_rejected", true],
  ])("refuses %s", (_label, over, binding, reason, boundRepo) => {
    expect(authorizeRepoDeploy(claims(over), binding)).toEqual({ ok: false, reason, boundRepo });
  });

  it("accepts workflow_dispatch on the bound branch", () => {
    expect(authorizeRepoDeploy(claims({ event_name: "workflow_dispatch" }), pinned).ok).toBe(true);
  });

  it("enforces the workflow pin exactly", () => {
    const binding = {
      ...pinned,
      workflowRef: "helix/actions/.github/workflows/deploy.yml@refs/tags/v1",
    };
    expect(authorizeRepoDeploy(claims(), binding)).toEqual({
      ok: false,
      reason: "workflow_mismatch",
      boundRepo: true,
    });
    expect(authorizeRepoDeploy(claims({ job_workflow_ref: binding.workflowRef }), binding).ok).toBe(
      true,
    );
  });

  it("enforces the environment pin, case-insensitively, and refuses a token with none", () => {
    const binding = { ...pinned, environment: "production" };
    expect(authorizeRepoDeploy(claims(), binding)).toEqual({
      ok: false,
      reason: "environment_mismatch",
      boundRepo: true,
    });
    expect(authorizeRepoDeploy(claims({ environment: "staging" }), binding).ok).toBe(false);
    expect(authorizeRepoDeploy(claims({ environment: "Production" }), binding).ok).toBe(true);
  });
});
