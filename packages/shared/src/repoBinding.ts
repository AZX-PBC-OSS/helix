import { z } from "zod";

/**
 * Repo-backed apps (ADR-0051): an app's single GitHub binding, which lets a
 * GitHub Actions job on that repo and branch upload a preview version with its
 * own OIDC token. The binding is owner-set app config; the portal pins the
 * numeric repository and owner ids from the first token that deploys, and the
 * name is display only after that.
 */

/** Any C0 control character or DEL. */
function hasControlChar(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * `owner/name`, with GitHub's character rules: an owner is 1–39 alphanumerics
 * or hyphens, not starting with one; a repository name is 1–100 of
 * `[A-Za-z0-9._-]` and is never `.` or `..`.
 */
export const RepoFullNameSchema = z
  .string()
  .max(140)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/,
    "must be owner/name, as in the repository's GitHub URL",
  )
  .refine((v) => !/\/\.{1,2}$/.test(v), "must be owner/name, as in the repository's GitHub URL");

/**
 * A branch name, without `refs/heads/`. A subset of git's ref-name rules that
 * covers every name a person would type: no whitespace or control characters,
 * none of `~^:?*[\`, no `..` or `@{`, and no leading `-` or `/`, trailing `/`
 * or `.lock`.
 */
export const BranchNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (v) =>
      !v.startsWith("refs/") &&
      !hasControlChar(v) &&
      !/[\s~^:?*[\\]/.test(v) &&
      !v.includes("..") &&
      !v.includes("@{") &&
      !v.includes("//") &&
      !/^[-/]/.test(v) &&
      !/(\/|\.lock|\.)$/.test(v),
    "must be a branch name such as main, without refs/heads/",
  );

/**
 * A `job_workflow_ref` value: `owner/repo/.github/workflows/<file>.yml@<ref>`.
 * Compared exactly, so the Repository tab and `helix ci init` show the form a
 * token carries.
 */
export const WorkflowRefSchema = z
  .string()
  .max(512)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}\/\.github\/workflows\/[^@\s]+\.ya?ml@\S+$/,
    "must look like owner/repo/.github/workflows/deploy.yml@refs/heads/main",
  );

/** A GitHub environment name. GitHub caps it at 255 characters. */
export const EnvironmentNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((v) => !hasControlChar(v) && v.trim() === v, "must be an environment name");

/**
 * `PUT /api/v1/apps/:slug/repo-binding`: a full replace. Leaving out
 * `workflowRef` or `environment` clears that constraint. Changing
 * `repoFullName` clears the pinned ids, so the next deploy pins afresh.
 */
export const SetRepoBindingRequestSchema = z.object({
  repoFullName: RepoFullNameSchema,
  branch: BranchNameSchema,
  workflowRef: WorkflowRefSchema.optional(),
  environment: EnvironmentNameSchema.optional(),
});
export type SetRepoBindingRequest = z.infer<typeof SetRepoBindingRequestSchema>;

export const REPO_PROVIDERS = ["github"] as const;

/** The binding as the API returns it. Absent optional fields are unset. */
export const RepoBindingSchema = z.object({
  provider: z.enum(REPO_PROVIDERS),
  repoFullName: z.string(),
  branch: z.string(),
  workflowRef: z.string().optional(),
  environment: z.string().optional(),
  /** Pinned from the first accepted token; absent until then. */
  repositoryId: z.string().optional(),
  repositoryOwnerId: z.string().optional(),
  pinnedAt: z.iso.datetime().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type RepoBinding = z.infer<typeof RepoBindingSchema>;

/** `POST /api/v1/apps/:slug/ci/versions` refusals that the bound repo is told about. */
export const REPO_DEPLOY_BOUND_REASONS = [
  "ref_mismatch",
  "event_rejected",
  "workflow_mismatch",
  "environment_mismatch",
  "replayed",
] as const;
export type RepoDeployBoundReason = (typeof REPO_DEPLOY_BOUND_REASONS)[number];
