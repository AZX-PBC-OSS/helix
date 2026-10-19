import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortalClient } from "../client.js";
import type { ResolvedConfig } from "../config.js";
import { ciInitCommand, ciShowCommand, type GitRunner } from "./commands.js";

const CONFIG = {
  repoDeploy: {
    enabled: true,
    audience: "https://portal.example.com",
    serverUrl: "https://github.com",
  },
  appPublicBase: "https://example.com",
};
const BINDING = {
  provider: "github",
  repoFullName: "octo-org/octo-app",
  branch: "main",
  createdAt: "2026-10-19T00:00:00.000Z",
  updatedAt: "2026-10-19T00:00:00.000Z",
};

/** Answers the config and binding routes; records every request. */
function stubPortal(opts: { config?: unknown; putStatus?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url.endsWith("/api/v1/config")) return Response.json(opts.config ?? CONFIG);
    if (init?.method === "PUT" && (opts.putStatus ?? 200) !== 200) {
      return Response.json(
        { error: { code: "forbidden", message: "you do not own this app" } },
        { status: opts.putStatus },
      );
    }
    return Response.json(BINDING);
  });
  return calls;
}

async function checkout(sub = "") {
  const root = await mkdtemp(path.join(os.tmpdir(), "helix-ci-init-"));
  const cwd = path.join(root, sub);
  await mkdir(cwd, { recursive: true });
  await writeFile(path.join(cwd, "package.json"), '{"scripts":{"build":"vite build"}}');
  await writeFile(path.join(root, "package-lock.json"), "{}");
  const git: GitRunner = async (args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return root;
    if (args[0] === "rev-parse") return "main";
    if (args[0] === "remote") return "git@github.com:octo-org/octo-app.git";
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  return { root, cwd, git };
}

const config = (over: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
  portalUrl: "https://portal.example.com",
  slug: "demo",
  dir: "dist",
  ...over,
});
const client = () => new PortalClient("https://portal.example.com", "tok");
const quiet = () => {};

afterEach(() => vi.restoreAllMocks());

describe("helix ci init", () => {
  it("binds the repo, then writes the workflow and helix.json", async () => {
    const calls = stubPortal();
    const { root, cwd, git } = await checkout("apps/site");
    await writeFile(path.join(cwd, "helix.json"), '{"description":"kept"}');

    await ciInitCommand(client(), config(), {}, { cwd, git, log: quiet });

    const put = calls.find((c) => c.init.method === "PUT")!;
    expect(put.url).toBe("https://portal.example.com/api/v1/apps/demo/repo-binding");
    expect(JSON.parse(String(put.init.body))).toEqual({
      repoFullName: "octo-org/octo-app",
      branch: "main",
    });

    const workflow = await readFile(path.join(root, ".github/workflows/helix-deploy.yml"), "utf8");
    expect(workflow).toContain('working-directory: "apps/site"');
    expect(workflow).toContain("npm run build");
    expect(JSON.parse(await readFile(path.join(cwd, "helix.json"), "utf8"))).toEqual({
      description: "kept",
      slug: "demo",
      portalUrl: "https://portal.example.com",
      dir: "dist",
    });
  });

  it("pins the reusable workflow on the binding with --reusable", async () => {
    const calls = stubPortal();
    const { cwd, git } = await checkout();
    await ciInitCommand(
      client(),
      config(),
      { reusable: true, branch: "prod" },
      { cwd, git, log: quiet },
    );
    const body = JSON.parse(String(calls.find((c) => c.init.method === "PUT")!.init.body));
    expect(body).toEqual({
      repoFullName: "octo-org/octo-app",
      branch: "prod",
      workflowRef: "AZX-PBC-OSS/helix-actions/.github/workflows/deploy.yml@refs/tags/v1",
    });
  });

  it("refuses to overwrite an existing workflow without --force", async () => {
    stubPortal();
    const { root, cwd, git } = await checkout();
    await mkdir(path.join(root, ".github/workflows"), { recursive: true });
    await writeFile(path.join(root, ".github/workflows/helix-deploy.yml"), "mine");
    await expect(ciInitCommand(client(), config(), {}, { cwd, git, log: quiet })).rejects.toThrow(
      /--force/,
    );
    expect(await readFile(path.join(root, ".github/workflows/helix-deploy.yml"), "utf8")).toBe(
      "mine",
    );
    await ciInitCommand(client(), config(), { force: true }, { cwd, git, log: quiet });
    expect(await readFile(path.join(root, ".github/workflows/helix-deploy.yml"), "utf8")).not.toBe(
      "mine",
    );
  });

  it("writes nothing when the portal refuses the binding", async () => {
    stubPortal({ putStatus: 403 });
    const { root, cwd, git } = await checkout();
    await expect(ciInitCommand(client(), config(), {}, { cwd, git, log: quiet })).rejects.toThrow(
      /do not own/,
    );
    await expect(readFile(path.join(root, ".github/workflows/helix-deploy.yml"))).rejects.toThrow();
    await expect(readFile(path.join(cwd, "helix.json"))).rejects.toThrow();
  });

  it("stops on a portal with repo deploys turned off", async () => {
    stubPortal({ config: { ...CONFIG, repoDeploy: { ...CONFIG.repoDeploy, enabled: false } } });
    const { cwd, git } = await checkout();
    await expect(ciInitCommand(client(), config(), {}, { cwd, git, log: quiet })).rejects.toThrow(
      /does not accept/,
    );
  });

  it("asks for --repo when origin isn't a GitHub remote", async () => {
    stubPortal();
    const { cwd, git } = await checkout();
    const gitlab: GitRunner = async (args, c) =>
      args[0] === "remote" ? "git@gitlab.com:a/b.git" : git(args, c);
    await expect(
      ciInitCommand(client(), config(), {}, { cwd, git: gitlab, log: quiet }),
    ).rejects.toThrow(/--repo/);
  });
});

describe("helix ci show", () => {
  it("reports an unconnected app", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        {
          error: {
            code: "not_found",
            message: "this app has no repo binding",
            details: { reason: "no_binding" },
          },
        },
        { status: 404 },
      ),
    );
    const lines: string[] = [];
    await ciShowCommand(client(), config(), (l) => lines.push(l));
    expect(lines.join("\n")).toMatch(/not connected/);
  });

  it("surfaces any other 404, like an unknown app", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        { error: { code: "not_found", message: 'app "demo" not found' } },
        { status: 404 },
      ),
    );
    await expect(ciShowCommand(client(), config(), quiet)).rejects.toThrow(/not found/);
  });
});
