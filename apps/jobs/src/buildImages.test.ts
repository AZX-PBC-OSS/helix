import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * `build-images.sh`'s runtime contract, executed. There is no container
 * runtime in the environment the suite runs in, but the script's own
 * builder-less contract is exactly what must hold there, and it is
 * executable: bash runs the real script, the tool search is controlled by
 * PATH, and a shim `docker` on that PATH records each invocation and exits
 * with a chosen status. The pins hold:
 *
 * - Validation precedes the capability check: an unknown app name and a
 *   mapped app whose Dockerfile is missing fail on every host, builder or
 *   not — a builder-less host refuses the broken request instead of
 *   skipping over it (a skip that passes over a broken mapping is a gate
 *   failure that looks like a pass).
 * - The absence of docker skips loudly — exit 0 with a stderr banner naming
 *   the policy and CI's enforcing image job — while PUSH=1 never skips: an
 *   explicit push request must not degrade into doing nothing.
 * - A present-but-broken docker fails the run; only the tool's absence skips.
 * - The build loop is the mapping, executed: every requested app builds from
 *   its mapped Dockerfile into its mapped repo, tagged from REGISTRY and TAG
 *   on the default platform — and PUSH=1 pushes the image it built, only
 *   when a REGISTRY names the destination.
 */

const PACKAGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.join(PACKAGE_DIR, "../..");
const SCRIPT = readFileSync(path.join(REPO_ROOT, "build-images.sh"), "utf8");

const REGISTRY = "reg.example.invalid";
const TAG = "vtest";

const ALL_APPS = ["edge", "portal", "egress", "jobs"];

const created: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "build-images-"));
  created.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A room: the build context as the script's validation sees it — the
 * workspace marker, the app Dockerfiles it checks for, and the script
 * itself, copied fresh from the repo so every edit to it is what runs.
 */
function makeRoom(appsWithDockerfiles: string[]): string {
  const room = tempDir();
  writeFileSync(path.join(room, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
  for (const app of appsWithDockerfiles) {
    mkdirSync(path.join(room, "apps", app), { recursive: true });
    writeFileSync(path.join(room, "apps", app, "Dockerfile"), "FROM node:24-bookworm-slim\n");
  }
  writeFileSync(path.join(room, "build-images.sh"), SCRIPT);
  return room;
}

/**
 * The tool directory the builder-less legs run with: `dirname` — the one
 * external command the script needs before the docker check — and nothing
 * else. No git (the tag falls back to `latest`) and no docker, whatever the
 * host running the suite actually has.
 */
function makeToollessBin(): string {
  const bin = tempDir();
  linkDirname(bin);
  return bin;
}

function linkDirname(bin: string): void {
  const dirname = ["/usr/bin/dirname", "/bin/dirname"].find((p) => existsSync(p));
  if (dirname === undefined) {
    throw new Error("the suite's host has no dirname to run the script with");
  }
  symlinkSync(dirname, path.join(bin, "dirname"));
}

/**
 * A shim `docker` that records one line per invocation and exits with a
 * chosen status, next to the same `dirname` the builder-less legs get. The
 * script's `cd "$(dirname "$0")"` runs before anything else, so a PATH
 * without dirname is not the operator's environment: bash 5.2 happens to
 * treat the resulting `cd ""` as a no-op, while bash 5.3 (GitHub's Ubuntu
 * 26.04 runners) refuses it and the script exits before docker is reached.
 */
function makeFakeDocker(exitCode: number): { bin: string; log: string } {
  const bin = tempDir();
  linkDirname(bin);
  const log = path.join(tempDir(), "invocations.log");
  writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
  return { bin, log };
}

function recordedCalls(fake: { log: string }): string[] {
  return existsSync(fake.log) ? readFileSync(fake.log, "utf8").split("\n").filter(Boolean) : [];
}

/** Run the script the way an operator does, with only the controlled PATH and the case's own variables. */
function runBuildImages(
  room: string,
  bin: string,
  args: string[],
  env: Record<string, string> = {},
): SpawnSyncReturns<string> {
  const run = spawnSync("/bin/bash", [path.join(room, "build-images.sh"), ...args], {
    cwd: room,
    encoding: "utf8",
    env: { PATH: bin, ...env },
  });
  // A tool the controlled PATH lacks would fail the run for the harness's
  // reason rather than the script's, so it fails the case on every bash.
  expect(run.stderr).not.toMatch(/line \d+: [^:\n]+: command not found/);
  return run;
}

describe("build-images.sh without a builder on the host", () => {
  it("skips loudly: exit 0 with a stderr banner naming the policy and CI's image job", () => {
    const run = runBuildImages(makeRoom(ALL_APPS), makeToollessBin(), ["jobs"]);
    expect(run.status).toBe(0);
    expect(run.stderr).toMatch(/skipping image builds: no docker on this host/);
    expect(run.stderr).toMatch(/CI's image job/);
    expect(run.stdout).not.toMatch(/==> building/);
  });

  it("fails an explicit push instead of skipping it", () => {
    const run = runBuildImages(makeRoom(ALL_APPS), makeToollessBin(), ["jobs"], { PUSH: "1" });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/PUSH=1 needs docker/);
  });

  it("fails a mapped app whose Dockerfile is missing instead of skipping over it", () => {
    // The room holds the other three apps' Dockerfiles but not jobs', and the
    // host holds no builder — so the only outcomes are the skip (exit 0 over a
    // broken mapping) or this refusal. The exit status is the pin: validation
    // runs before the capability check, so the broken request fails on a host
    // that cannot build anything either.
    const room = makeRoom(["edge", "portal", "egress"]);
    const run = runBuildImages(room, makeToollessBin(), ["jobs"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/jobs's Dockerfile is missing: apps\/jobs\/Dockerfile/);
    expect(run.stderr).not.toMatch(/skipping image builds/);
  });

  it("fails an unknown app name, naming the expected set", () => {
    const run = runBuildImages(makeRoom(ALL_APPS), makeToollessBin(), ["jobsx"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/unknown app 'jobsx' \(expected edge\|portal\|egress\|jobs\)/);
  });
});

describe("build-images.sh with a builder on the host", () => {
  it("fails the run when the builder is present but broken — only the tool's absence skips", () => {
    const fake = makeFakeDocker(1);
    const run = runBuildImages(makeRoom(ALL_APPS), fake.bin, ["jobs"], { REGISTRY, TAG });
    expect(run.status).toBe(1);
    expect(recordedCalls(fake)).toHaveLength(1);
  });

  it("builds every app by default, each from its mapped Dockerfile into its mapped repo", () => {
    const fake = makeFakeDocker(0);
    const run = runBuildImages(makeRoom(ALL_APPS), fake.bin, [], { REGISTRY, TAG });
    expect(run.status).toBe(0);
    expect(recordedCalls(fake)).toEqual([
      `build --platform linux/amd64 -f apps/edge/Dockerfile -t ${REGISTRY}/helix-edge:${TAG} .`,
      `build --platform linux/amd64 -f apps/portal/Dockerfile -t ${REGISTRY}/helix-portal:${TAG} .`,
      `build --platform linux/amd64 -f apps/egress/Dockerfile -t ${REGISTRY}/helix-egress:${TAG} .`,
      `build --platform linux/amd64 -f apps/jobs/Dockerfile -t ${REGISTRY}/helix-jobs:${TAG} .`,
    ]);
  });

  it("pushes the image it built when PUSH=1 and a REGISTRY names the destination", () => {
    const fake = makeFakeDocker(0);
    const run = runBuildImages(makeRoom(ALL_APPS), fake.bin, ["jobs"], {
      REGISTRY,
      TAG,
      PUSH: "1",
    });
    expect(run.status).toBe(0);
    expect(recordedCalls(fake)).toEqual([
      `build --platform linux/amd64 -f apps/jobs/Dockerfile -t ${REGISTRY}/helix-jobs:${TAG} .`,
      `push ${REGISTRY}/helix-jobs:${TAG}`,
    ]);
  });

  it("refuses PUSH=1 without a REGISTRY after building", () => {
    const fake = makeFakeDocker(0);
    const run = runBuildImages(makeRoom(ALL_APPS), fake.bin, ["jobs"], { PUSH: "1", TAG });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/PUSH=1 needs REGISTRY set/);
    expect(recordedCalls(fake)).toEqual([
      `build --platform linux/amd64 -f apps/jobs/Dockerfile -t helix-jobs:${TAG} .`,
    ]);
  });
});
