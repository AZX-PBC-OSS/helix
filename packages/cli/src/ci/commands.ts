import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { RepoBinding } from "@azx-pbc/shared";
import { CliError, type PortalClient } from "../client.js";
import { CONFIG_FILENAMES, type ResolvedConfig } from "../config.js";
import { CLI_VERSION } from "../version.js";
import { parseGithubRemote } from "./remote.js";
import {
  detectBuildPlan,
  renderReusableWorkflow,
  renderStarterWorkflow,
  REUSABLE_WORKFLOW_REF,
  WORKFLOW_FILE,
} from "./workflow.js";

/**
 * `helix ci init | show | remove` — connect an app to a GitHub repo so pushes
 * to a branch land previews (ADR-0051). `init` is run once, signed in, from the
 * app directory inside the repo's checkout.
 */

/** Runs `git <args>` in `cwd` and returns trimmed stdout. Injectable for tests. */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

const run = promisify(execFile);
export const defaultGit: GitRunner = async (args, cwd) =>
  (await run("git", args, { cwd })).stdout.trim();

function requireSlug(config: ResolvedConfig): string {
  if (!config.slug) throw new CliError("no app slug; set it in helix.json or pass --slug");
  return config.slug;
}

export interface CiInitOptions {
  repo?: string;
  branch?: string;
  reusable?: boolean;
  force?: boolean;
}

export async function ciInitCommand(
  client: PortalClient,
  config: ResolvedConfig,
  opts: CiInitOptions,
  deps: { cwd?: string; git?: GitRunner; log?: (line: string) => void } = {},
): Promise<void> {
  const cwd = deps.cwd ?? process.cwd();
  const git = deps.git ?? defaultGit;
  const log = deps.log ?? console.log;
  const slug = requireSlug(config);

  const deployment = await client.getDeploymentConfig();
  if (!deployment.repoDeploy?.enabled) {
    throw new CliError("this portal does not accept repo-backed deploys (ask its operator)");
  }
  const githubHost = new URL(deployment.repoDeploy.serverUrl).hostname;

  let repoRoot: string;
  try {
    repoRoot = await git(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    throw new CliError("not inside a git checkout; run this from the app's directory in its repo");
  }
  const repo = opts.repo ?? parseGithubRemote(await originUrl(git, cwd), githubHost);
  if (!repo) {
    throw new CliError(
      `couldn't read a ${githubHost} repo from the origin remote; pass --repo owner/name`,
    );
  }
  const branch = opts.branch ?? (await defaultBranch(git, cwd));
  if (!branch || branch === "HEAD") {
    throw new CliError("couldn't tell which branch to deploy from; pass --branch <name>");
  }

  const workflowPath = path.join(repoRoot, WORKFLOW_FILE);
  if (!opts.force && (await fileExists(workflowPath))) {
    throw new CliError(`${WORKFLOW_FILE} already exists; pass --force to replace it`);
  }

  const workingDirectory = path.relative(repoRoot, cwd).split(path.sep).join("/") || ".";
  const plan = await detectBuildPlan(cwd, repoRoot);
  const render = opts.reusable ? renderReusableWorkflow : renderStarterWorkflow;
  const workflow = render({ branch, workingDirectory, plan, cliVersion: CLI_VERSION });

  // `PUT` replaces the whole binding, so limits the owner set elsewhere (the
  // Repository tab) would silently disappear. Keep them, and refuse to drop one
  // without --force.
  const existing = await client.getRepoBinding(slug);
  const workflowRef = opts.reusable ? REUSABLE_WORKFLOW_REF : existing?.workflowRef;
  const environment = existing?.environment;
  if (existing?.workflowRef && workflowRef !== existing.workflowRef && !opts.force) {
    throw new CliError(
      `the binding pins deploys to workflow ${existing.workflowRef}; --reusable would replace ` +
        "that pin. Pass --force to replace it.",
    );
  }

  // The binding first: if the owner check refuses, nothing is written to disk.
  const binding = await client.putRepoBinding(slug, {
    repoFullName: repo,
    branch,
    ...(workflowRef ? { workflowRef } : {}),
    ...(environment ? { environment } : {}),
  });

  const configFile = await writeHelixJson(cwd, {
    slug,
    portalUrl: config.portalUrl,
    dir: config.dir,
  });
  await mkdir(path.dirname(workflowPath), { recursive: true });
  await writeFile(workflowPath, workflow, "utf8");

  log(`Connected "${slug}" to ${repo}.`);
  log(`Branch: ${branch}${opts.branch ? "" : " (use --branch to change)"}`);
  printBinding(binding, log);
  log(`Wrote ${path.relative(cwd, workflowPath) || WORKFLOW_FILE} and ${configFile}.`);
  if (isLocalPortal(config.portalUrl)) {
    log(`warning: helix.json points CI at ${config.portalUrl}, which a GitHub runner can't reach.`);
  }
  log("Commit both files and push; each push lands a preview to promote.");
}

export async function ciShowCommand(
  client: PortalClient,
  config: ResolvedConfig,
  log: (line: string) => void = console.log,
): Promise<void> {
  const slug = requireSlug(config);
  const binding = await client.getRepoBinding(slug);
  if (!binding) {
    log(`"${slug}" is not connected to a repo. Run: helix ci init`);
    return;
  }
  printBinding(binding, log);
}

export async function ciRemoveCommand(
  client: PortalClient,
  config: ResolvedConfig,
  log: (line: string) => void = console.log,
): Promise<void> {
  const slug = requireSlug(config);
  await client.deleteRepoBinding(slug);
  log(`Disconnected "${slug}" from its repo. CI deploys to it are now refused.`);
}

function printBinding(b: RepoBinding, log: (line: string) => void): void {
  log(`  repo:        ${b.repoFullName}`);
  log(`  branch:      ${b.branch}`);
  if (b.workflowRef) log(`  workflow:    ${b.workflowRef}`);
  if (b.environment) log(`  environment: ${b.environment}`);
  log(
    b.repositoryId
      ? `  pinned:      repo id ${b.repositoryId}, owner id ${b.repositoryOwnerId ?? "?"}`
      : "  pinned:      not yet (the first deploy pins the repo's ids)",
  );
}

async function originUrl(git: GitRunner, cwd: string): Promise<string> {
  try {
    return await git(["remote", "get-url", "origin"], cwd);
  } catch {
    return "";
  }
}

/**
 * The branch pushes deploy from: the remote's default branch, which is what a
 * team deploys, rather than the feature branch `ci init` is often run on.
 */
async function defaultBranch(git: GitRunner, cwd: string): Promise<string> {
  try {
    const remoteHead = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
    if (remoteHead.startsWith("origin/")) return remoteHead.slice("origin/".length);
  } catch {
    // No remote HEAD recorded (e.g. a repo that was never cloned); fall through.
  }
  return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Merge the CI-relevant keys into the config file the CLI already reads
 * (`helix.json`, or a legacy `azx.json`), keeping whatever else it holds.
 * Creating a `helix.json` next to an `azx.json` would hide the older file's
 * other keys. Returns the file's name.
 */
async function writeHelixJson(
  cwd: string,
  values: { slug: string; portalUrl: string; dir: string },
): Promise<string> {
  for (const name of CONFIG_FILENAMES) {
    const file = path.join(cwd, name);
    let existing: Record<string, unknown>;
    try {
      existing = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    await writeFile(file, `${JSON.stringify({ ...existing, ...values }, null, 2)}\n`, "utf8");
    return name;
  }
  const name = CONFIG_FILENAMES[0];
  await writeFile(path.join(cwd, name), `${JSON.stringify(values, null, 2)}\n`, "utf8");
  return name;
}

function isLocalPortal(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host.endsWith(".local") || host === "::1";
}
