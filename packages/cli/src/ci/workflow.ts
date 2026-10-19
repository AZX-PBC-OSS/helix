import { access, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The GitHub Actions workflow `helix ci init` writes (ADR-0051 decision 9).
 * Two shapes: a self-contained starter, or a caller of the Helix reusable
 * workflow, which an owner can pin with the binding's workflow constraint.
 * Neither needs a secret: the job's own OIDC token authenticates the upload.
 */

/** The public reusable workflow, and the ref `job_workflow_ref` reports for it. */
export const REUSABLE_WORKFLOW_PATH = "AZX-PBC-OSS/helix-actions/.github/workflows/deploy.yml";
export const REUSABLE_WORKFLOW_TAG = "v1";
export const REUSABLE_WORKFLOW_REF = `${REUSABLE_WORKFLOW_PATH}@refs/tags/${REUSABLE_WORKFLOW_TAG}`;

export const WORKFLOW_FILE = ".github/workflows/helix-deploy.yml";

export type PackageManager = "npm" | "pnpm" | "yarn";

export interface BuildPlan {
  packageManager: PackageManager;
  /** Whether the lockfile exists; without one npm installs with `npm install`. */
  hasLockfile: boolean;
  /** The `package.json` script that builds the app, or null for a prebuilt dir. */
  buildScript: string | null;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Work out how the app installs and builds, from its lockfile and package.json. */
export async function detectBuildPlan(appDir: string, repoRoot: string): Promise<BuildPlan> {
  const lockIn = async (name: string) =>
    (await exists(path.join(appDir, name))) || (await exists(path.join(repoRoot, name)));
  const packageManager: PackageManager = (await lockIn("pnpm-lock.yaml"))
    ? "pnpm"
    : (await lockIn("yarn.lock"))
      ? "yarn"
      : "npm";
  const hasLockfile = packageManager !== "npm" || (await lockIn("package-lock.json"));
  let buildScript: string | null = null;
  try {
    const pkg = JSON.parse(await readFile(path.join(appDir, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    if (typeof pkg.scripts?.build === "string") buildScript = "build";
  } catch {
    // No package.json: a prebuilt static directory, deployed as-is.
  }
  return { packageManager, hasLockfile, buildScript };
}

const INSTALL: Record<PackageManager, string> = {
  npm: "npm ci",
  pnpm: "pnpm install --frozen-lockfile",
  yarn: "yarn install --frozen-lockfile",
};

export interface WorkflowOptions {
  branch: string;
  /** The app directory relative to the repo root; "." for the root. */
  workingDirectory: string;
  plan: BuildPlan;
  cliVersion: string;
}

const HEADER = (
  branch: string,
) => `# Deploys this app to Helix as a preview on every push to ${branch}.
# Written by \`helix ci init\`. The job authenticates with its own GitHub OIDC
# token (\`id-token: write\`), so the repo needs no secret. A preview goes live
# only when someone promotes it, in the portal or with \`helix promote <n>\`.
name: Deploy to Helix
on:
  push:
    branches: [${JSON.stringify(branch)}]
  workflow_dispatch:
permissions:
  contents: read
  id-token: write
`;

/** A self-contained workflow: checkout, install, build, `helix deploy`. */
export function renderStarterWorkflow(opts: WorkflowOptions): string {
  const { plan, workingDirectory } = opts;
  const sub = workingDirectory !== ".";
  const install = plan.hasLockfile ? INSTALL[plan.packageManager] : "npm install";
  const lines = [
    HEADER(opts.branch),
    "jobs:",
    "  deploy:",
    "    runs-on: ubuntu-latest",
    ...(sub
      ? [
          "    defaults:",
          "      run:",
          `        working-directory: ${JSON.stringify(workingDirectory)}`,
        ]
      : []),
    "    steps:",
    "      - uses: actions/checkout@v4",
    ...(plan.packageManager === "pnpm" ? ["      - uses: pnpm/action-setup@v4"] : []),
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: 24",
    ...(plan.hasLockfile ? [`          cache: ${plan.packageManager}`] : []),
    `      - run: ${install}`,
    ...(plan.buildScript ? [`      - run: ${plan.packageManager} run ${plan.buildScript}`] : []),
    `      - run: npx --yes @azx-pbc/helix-cli@${opts.cliVersion} deploy`,
    "",
  ];
  return lines.join("\n");
}

/** A caller of the Helix reusable workflow, pinned at {@link REUSABLE_WORKFLOW_TAG}. */
export function renderReusableWorkflow(opts: WorkflowOptions): string {
  const { plan } = opts;
  const lines = [
    HEADER(opts.branch),
    "jobs:",
    "  deploy:",
    `    uses: ${REUSABLE_WORKFLOW_PATH}@${REUSABLE_WORKFLOW_TAG}`,
    "    with:",
    `      package-manager: ${plan.packageManager}`,
    `      working-directory: ${JSON.stringify(opts.workingDirectory)}`,
    `      build-script: ${JSON.stringify(plan.buildScript ?? "")}`,
    `      cli-version: ${JSON.stringify(opts.cliVersion)}`,
    "",
  ];
  return lines.join("\n");
}
