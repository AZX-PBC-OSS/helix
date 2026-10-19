import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectBuildPlan,
  renderReusableWorkflow,
  renderStarterWorkflow,
  type BuildPlan,
} from "./workflow.js";

async function dir(files: Record<string, string>): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), "helix-ci-"));
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(d, name)), { recursive: true });
    await writeFile(path.join(d, name), body);
  }
  return d;
}

describe("detectBuildPlan", () => {
  it("reads the lockfile, the build script and pnpm's packageManager pin", async () => {
    const d = await dir({
      "pnpm-lock.yaml": "",
      "package.json": '{"packageManager":"pnpm@9.15.0","scripts":{"build":"vite build"}}',
    });
    expect(await detectBuildPlan(d, d)).toEqual({
      packageManager: "pnpm",
      hasLockfile: true,
      lockfilePath: "pnpm-lock.yaml",
      pnpmPackageJson: "package.json",
      buildScript: "build",
    });
  });

  it("records an app-local lockfile's path relative to the repo root", async () => {
    const root = await dir({ "apps/site/package-lock.json": "{}", "apps/site/package.json": "{}" });
    const plan = await detectBuildPlan(path.join(root, "apps/site"), root);
    expect(plan).toMatchObject({
      packageManager: "npm",
      lockfilePath: "apps/site/package-lock.json",
    });
  });

  it("finds a lockfile at the repo root for an app in a subdirectory", async () => {
    const root = await dir({ "yarn.lock": "", "apps/site/package.json": "{}" });
    const plan = await detectBuildPlan(path.join(root, "apps/site"), root);
    expect(plan).toMatchObject({ packageManager: "yarn", lockfilePath: "yarn.lock" });
  });

  it("leaves pnpm unpinned when no package.json names it", async () => {
    const d = await dir({ "pnpm-lock.yaml": "", "package.json": "{}" });
    expect((await detectBuildPlan(d, d)).pnpmPackageJson).toBeNull();
  });

  it("treats a directory with no package.json as prebuilt", async () => {
    const d = await dir({ "index.html": "<p>" });
    expect(await detectBuildPlan(d, d)).toEqual({
      packageManager: "npm",
      hasLockfile: false,
      lockfilePath: null,
      pnpmPackageJson: null,
      buildScript: null,
    });
  });
});

const npmPlan: BuildPlan = {
  packageManager: "npm",
  hasLockfile: true,
  lockfilePath: "package-lock.json",
  pnpmPackageJson: null,
  buildScript: "build",
};

/** The `jobs:` section of a rendered workflow, split per job. */
function job(yml: string, name: string): string {
  const start = yml.indexOf(`\n  ${name}:\n`);
  const next = yml.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
  return next === -1 ? yml.slice(start) : yml.slice(start, start + 1 + next);
}

describe("renderStarterWorkflow", () => {
  it("builds without id-token and deploys the artifact in a separate job", () => {
    const yml = renderStarterWorkflow({
      branch: "main",
      workingDirectory: ".",
      plan: npmPlan,
      cliVersion: "0.5.0",
    });
    expect(yml).toMatchInlineSnapshot(`
      "# Deploys this app to Helix as a preview on every push to main.
      # Written by \`helix ci init\`. The repo needs no secret: the deploy job
      # authenticates with its own GitHub OIDC token. The build job runs the repo's
      # code without that permission. A preview goes live only when someone promotes
      # it, in the portal or with \`helix promote <n>\`.
      name: Deploy to Helix
      on:
        push:
          branches: ["main"]
        workflow_dispatch:
      # Each job asks for only what it needs.
      permissions: {}

      jobs:
        build:
          runs-on: ubuntu-latest
          permissions:
            contents: read
          steps:
            - uses: actions/checkout@v4
            - uses: actions/setup-node@v4
              with:
                node-version: 24
                cache: npm
                cache-dependency-path: package-lock.json
            - run: npm ci
            - run: npm run build
            - id: output
              run: |
                if [ -f helix.json ]; then cfg=helix.json; elif [ -f azx.json ]; then cfg=azx.json; else echo "::error::no helix.json in this directory"; exit 1; fi
                echo "config=$cfg" >> "$GITHUB_OUTPUT"
                echo "dir=$(node -p "require('./' + process.argv[1]).dir || 'dist'" "$cfg")" >> "$GITHUB_OUTPUT"
            - uses: actions/upload-artifact@v4
              with:
                name: helix-bundle
                path: |
                  \${{ steps.output.outputs.config }}
                  \${{ steps.output.outputs.dir }}
                include-hidden-files: true
                if-no-files-found: error
        deploy:
          needs: build
          runs-on: ubuntu-latest
          permissions:
            id-token: write
          steps:
            - uses: actions/download-artifact@v4
              with:
                name: helix-bundle
                path: "."
            - uses: actions/setup-node@v4
              with:
                node-version: 24
            - run: npx --yes @azx-pbc/helix-cli@0.5.0 deploy
      "
    `);
    expect(yml).not.toMatch(/secrets\./);
    // Only the job that runs no repo code can mint a token.
    expect(job(yml, "build")).not.toContain("id-token");
    expect(job(yml, "deploy")).toContain("id-token: write");
    expect(job(yml, "deploy")).not.toContain("checkout");
  });

  it("points caching at an app-local lockfile and scopes a monorepo app", () => {
    const yml = renderStarterWorkflow({
      branch: "release/1",
      workingDirectory: "apps/site",
      plan: { ...npmPlan, lockfilePath: "apps/site/package-lock.json" },
      cliVersion: "0.5.0",
    });
    expect(yml).toContain('branches: ["release/1"]');
    expect(yml).toContain("cache-dependency-path: apps/site/package-lock.json");
    expect(yml).toContain('working-directory: "apps/site"');
    expect(yml).toContain("apps/site/${{ steps.output.outputs.dir }}");
    expect(job(yml, "deploy")).toContain('path: "apps/site"');
  });

  it("pins pnpm from package.json when it can, and to a default version otherwise", () => {
    const pnpm: BuildPlan = {
      ...npmPlan,
      packageManager: "pnpm",
      lockfilePath: "pnpm-lock.yaml",
      buildScript: null,
    };
    const pinned = renderStarterWorkflow({
      branch: "main",
      workingDirectory: ".",
      plan: { ...pnpm, pnpmPackageJson: "package.json" },
      cliVersion: "0.5.0",
    });
    expect(pinned).toContain("package_json_file: package.json");
    expect(pinned).toContain("pnpm install --frozen-lockfile");
    expect(pinned).not.toContain("run build");
    const unpinned = renderStarterWorkflow({
      branch: "main",
      workingDirectory: ".",
      plan: pnpm,
      cliVersion: "0.5.0",
    });
    expect(unpinned).toMatch(/pnpm\/action-setup@v4\n\s+with:\n\s+version: 10/);
  });

  it("installs without a lockfile and skips caching", () => {
    const yml = renderStarterWorkflow({
      branch: "main",
      workingDirectory: ".",
      plan: { ...npmPlan, hasLockfile: false, lockfilePath: null },
      cliVersion: "0.5.0",
    });
    expect(yml).toContain("run: npm install");
    expect(yml).not.toContain("cache:");
  });
});

describe("renderReusableWorkflow", () => {
  it("calls the Helix reusable workflow at its tag and grants it id-token", () => {
    const yml = renderReusableWorkflow({
      branch: "main",
      workingDirectory: ".",
      plan: npmPlan,
      cliVersion: "0.5.0",
    });
    expect(yml).toContain("uses: AZX-PBC-OSS/helix-actions/.github/workflows/deploy.yml@v1");
    expect(yml).toContain('cli-version: "0.5.0"');
    expect(yml).toContain("id-token: write");
    expect(yml).not.toContain("pnpm-version");
  });

  it("passes a pnpm version only when package.json doesn't pin one", () => {
    const pnpm: BuildPlan = { ...npmPlan, packageManager: "pnpm", lockfilePath: "pnpm-lock.yaml" };
    const opts = { branch: "main", workingDirectory: ".", cliVersion: "0.5.0" };
    expect(renderReusableWorkflow({ ...opts, plan: pnpm })).toContain('pnpm-version: "10"');
    expect(
      renderReusableWorkflow({ ...opts, plan: { ...pnpm, pnpmPackageJson: "package.json" } }),
    ).not.toContain("pnpm-version");
  });
});
