import { access, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The GitHub Actions workflow `helix ci init` writes (ADR-0051 decision 9).
 * Two shapes: a self-contained starter, or a caller of the Helix reusable
 * workflow, which an owner can pin with the binding's workflow constraint.
 * Neither needs a secret: the deploy job's own OIDC token authenticates the
 * upload.
 *
 * Both split the work into two jobs. `build` runs the repo's own code (install
 * scripts, the build) with no `id-token` permission; `deploy` holds
 * `id-token: write` and runs only the pinned Helix CLI on the built output. So
 * code from the repo or its dependencies can never mint a deploy token, and a
 * workflow pin means what it says.
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
  /** The lockfile's path relative to the repo root, or null when there is none. */
  lockfilePath: string | null;
  /**
   * The repo-relative `package.json` whose `packageManager` field pins pnpm, or
   * null. Without one, `pnpm/action-setup` needs an explicit version.
   */
  pnpmPackageJson: string | null;
  /** The `package.json` script that builds the app, or null for a prebuilt dir. */
  buildScript: string | null;
}

/** pnpm major version used when no `packageManager` field pins one. */
export const DEFAULT_PNPM_VERSION = "10";

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

const LOCKFILES: [string, PackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

const posix = (p: string) => p.split(path.sep).join("/");

async function readPackageJson(
  file: string,
): Promise<{ scripts?: Record<string, unknown>; packageManager?: unknown } | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as {
      scripts?: Record<string, unknown>;
      packageManager?: unknown;
    };
  } catch {
    return null;
  }
}

/** Work out how the app installs and builds, from its lockfile and package.json. */
export async function detectBuildPlan(appDir: string, repoRoot: string): Promise<BuildPlan> {
  let packageManager: PackageManager = "npm";
  let lockfilePath: string | null = null;
  // The app's own directory wins over the repo root, matching how the package
  // managers themselves resolve a workspace.
  search: for (const dir of [appDir, repoRoot]) {
    for (const [name, pm] of LOCKFILES) {
      if (await exists(path.join(dir, name))) {
        packageManager = pm;
        lockfilePath = posix(path.relative(repoRoot, path.join(dir, name)));
        break search;
      }
    }
  }

  const appPkg = await readPackageJson(path.join(appDir, "package.json"));
  let pnpmPackageJson: string | null = null;
  if (packageManager === "pnpm") {
    for (const dir of [appDir, repoRoot]) {
      const pkg = dir === appDir ? appPkg : await readPackageJson(path.join(dir, "package.json"));
      if (typeof pkg?.packageManager === "string" && pkg.packageManager.startsWith("pnpm@")) {
        pnpmPackageJson = posix(path.relative(repoRoot, path.join(dir, "package.json")));
        break;
      }
    }
  }
  // No package.json: a prebuilt static directory, deployed as-is.
  const buildScript = typeof appPkg?.scripts?.build === "string" ? "build" : null;
  return {
    packageManager,
    hasLockfile: lockfilePath !== null,
    lockfilePath,
    pnpmPackageJson,
    buildScript,
  };
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
# Written by \`helix ci init\`. The repo needs no secret: the deploy job
# authenticates with its own GitHub OIDC token. The build job runs the repo's
# code without that permission. A preview goes live only when someone promotes
# it, in the portal or with \`helix promote <n>\`.
name: Deploy to Helix
on:
  push:
    branches: [${JSON.stringify(branch)}]
  workflow_dispatch:
# Each job asks for only what it needs.
permissions: {}
`;

/** `working-directory` joined onto a repo-relative path, for `uses:` steps. */
const inDir = (workingDirectory: string, rel: string) =>
  workingDirectory === "." ? rel : `${workingDirectory}/${rel}`;

/**
 * Find the CLI config file and the build output it names, for the artifact
 * upload. Read at run time, so a later edit to `dir` in helix.json still works.
 */
const FIND_OUTPUT = `if [ -f helix.json ]; then cfg=helix.json; elif [ -f azx.json ]; then cfg=azx.json; else echo "::error::no helix.json in this directory"; exit 1; fi
          echo "config=$cfg" >> "$GITHUB_OUTPUT"
          echo "dir=$(node -p "require('./' + process.argv[1]).dir || 'dist'" "$cfg")" >> "$GITHUB_OUTPUT"`;

/** The two-job starter: build without `id-token`, then deploy the artifact. */
export function renderStarterWorkflow(opts: WorkflowOptions): string {
  const { plan, workingDirectory: wd } = opts;
  const sub = wd !== ".";
  const install = plan.hasLockfile ? INSTALL[plan.packageManager] : "npm install";
  const pnpmSetup =
    plan.packageManager !== "pnpm"
      ? []
      : [
          "      - uses: pnpm/action-setup@v4",
          "        with:",
          plan.pnpmPackageJson
            ? `          package_json_file: ${plan.pnpmPackageJson}`
            : `          version: ${DEFAULT_PNPM_VERSION}`,
        ];
  const cache = plan.lockfilePath
    ? [
        `          cache: ${plan.packageManager}`,
        `          cache-dependency-path: ${plan.lockfilePath}`,
      ]
    : [];
  const lines = [
    HEADER(opts.branch),
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      contents: read",
    ...(sub
      ? ["    defaults:", "      run:", `        working-directory: ${JSON.stringify(wd)}`]
      : []),
    "    steps:",
    "      - uses: actions/checkout@v4",
    ...pnpmSetup,
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: 24",
    ...cache,
    `      - run: ${install}`,
    ...(plan.buildScript ? [`      - run: ${plan.packageManager} run ${plan.buildScript}`] : []),
    "      - id: output",
    "        run: |",
    `          ${FIND_OUTPUT}`,
    "      - uses: actions/upload-artifact@v4",
    "        with:",
    "          name: helix-bundle",
    "          path: |",
    `            ${inDir(wd, "${{ steps.output.outputs.config }}")}`,
    `            ${inDir(wd, "${{ steps.output.outputs.dir }}")}`,
    "          include-hidden-files: true",
    "          if-no-files-found: error",
    "  deploy:",
    "    needs: build",
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      id-token: write",
    "    steps:",
    "      - uses: actions/download-artifact@v4",
    "        with:",
    "          name: helix-bundle",
    `          path: ${JSON.stringify(wd)}`,
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: 24",
    `      - run: npx --yes @azx-pbc/helix-cli@${opts.cliVersion} deploy`,
    ...(sub ? [`        working-directory: ${JSON.stringify(wd)}`] : []),
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
    // A caller grants the reusable workflow at most these; its own jobs narrow
    // them per job.
    "    permissions:",
    "      contents: read",
    "      id-token: write",
    "    with:",
    `      package-manager: ${plan.packageManager}`,
    `      working-directory: ${JSON.stringify(opts.workingDirectory)}`,
    `      build-script: ${JSON.stringify(plan.buildScript ?? "")}`,
    ...(plan.packageManager === "pnpm" && !plan.pnpmPackageJson
      ? [`      pnpm-version: ${JSON.stringify(DEFAULT_PNPM_VERSION)}`]
      : []),
    `      cli-version: ${JSON.stringify(opts.cliVersion)}`,
    "",
  ];
  return lines.join("\n");
}
