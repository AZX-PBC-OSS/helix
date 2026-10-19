import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectBuildPlan, renderReusableWorkflow, renderStarterWorkflow } from "./workflow.js";

async function dir(files: Record<string, string>): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), "helix-ci-"));
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(d, name), body);
  return d;
}

describe("detectBuildPlan", () => {
  it("reads the lockfile and the build script", async () => {
    const d = await dir({
      "pnpm-lock.yaml": "",
      "package.json": '{"scripts":{"build":"vite build"}}',
    });
    expect(await detectBuildPlan(d, d)).toEqual({
      packageManager: "pnpm",
      hasLockfile: true,
      buildScript: "build",
    });
  });

  it("finds a lockfile at the repo root for an app in a subdirectory", async () => {
    const root = await dir({ "yarn.lock": "" });
    const app = await dir({ "package.json": "{}" });
    expect((await detectBuildPlan(app, root)).packageManager).toBe("yarn");
  });

  it("treats a directory with no package.json as prebuilt", async () => {
    const d = await dir({ "index.html": "<p>" });
    expect(await detectBuildPlan(d, d)).toEqual({
      packageManager: "npm",
      hasLockfile: false,
      buildScript: null,
    });
  });
});

const npmPlan = { packageManager: "npm" as const, hasLockfile: true, buildScript: "build" };

describe("renderStarterWorkflow", () => {
  it("writes a push + dispatch workflow with id-token and no secret", () => {
    const yml = renderStarterWorkflow({
      branch: "main",
      workingDirectory: ".",
      plan: npmPlan,
      cliVersion: "0.5.0",
    });
    expect(yml).toMatchInlineSnapshot(`
      "# Deploys this app to Helix as a preview on every push to main.
      # Written by \`helix ci init\`. The job authenticates with its own GitHub OIDC
      # token (\`id-token: write\`), so the repo needs no secret. A preview goes live
      # only when someone promotes it, in the portal or with \`helix promote <n>\`.
      name: Deploy to Helix
      on:
        push:
          branches: ["main"]
        workflow_dispatch:
      permissions:
        contents: read
        id-token: write

      jobs:
        deploy:
          runs-on: ubuntu-latest
          steps:
            - uses: actions/checkout@v4
            - uses: actions/setup-node@v4
              with:
                node-version: 24
                cache: npm
            - run: npm ci
            - run: npm run build
            - run: npx --yes @azx-pbc/helix-cli@0.5.0 deploy
      "
    `);
    expect(yml).not.toMatch(/secrets\./);
  });

  it("sets the working directory and pnpm setup for a monorepo app", () => {
    const yml = renderStarterWorkflow({
      branch: "release/1",
      workingDirectory: "apps/site",
      plan: { packageManager: "pnpm", hasLockfile: true, buildScript: null },
      cliVersion: "0.5.0",
    });
    expect(yml).toContain('branches: ["release/1"]');
    expect(yml).toContain('working-directory: "apps/site"');
    expect(yml).toContain("pnpm/action-setup@v4");
    expect(yml).toContain("pnpm install --frozen-lockfile");
    expect(yml).not.toContain("run build");
  });
});

describe("renderReusableWorkflow", () => {
  it("calls the Helix reusable workflow at its tag", () => {
    const yml = renderReusableWorkflow({
      branch: "main",
      workingDirectory: ".",
      plan: npmPlan,
      cliVersion: "0.5.0",
    });
    expect(yml).toContain("uses: AZX-PBC-OSS/helix-actions/.github/workflows/deploy.yml@v1");
    expect(yml).toContain('cli-version: "0.5.0"');
    expect(yml).toContain("id-token: write");
  });
});
