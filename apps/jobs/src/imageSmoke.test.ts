import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * `image-smoke.sh`'s contract, executed — the same shape of pin as
 * buildImages.test.ts, one step further down the pipeline: the script is what
 * CI's images job runs against the BUILT jobs image before it pushes, and
 * this suite runs that script the same way (bash, a controlled PATH) without
 * a container runtime or a network. The `docker` shim answers each
 * subcommand from a scenario file and records every invocation; the `curl`
 * shim answers `/health` from the same scenario. The pins that matter:
 *
 * - Every failing scenario fails FOR ITS REASON — a check that fails for the
 *   wrong reason, or a missing tool that skips silently, is a gate that
 *   lies — so each case asserts the exit status and the specific FAIL text.
 * - The healthy path runs the checks in order, passes the detached boot the
 *   image's own environment (no NODE_ENV — the image bakes it in — and the
 *   store DSN pointed at an unroutable port), stops and inspects the
 *   container, and ends with the all-passed line.
 * - The EXIT trap force-removes every container the script started, so a
 *   failed check never leaks one on the CI runner.
 */

const PACKAGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(PACKAGE_DIR, "scripts", "image-smoke.sh");

/** The real external commands the script reaches for, beyond its docker/curl shims. */
const SCRIPT_TOOLS = ["openssl", "timeout", "grep", "sed", "tail", "sleep", "mktemp", "rm"];

/** The scenario one shim pair serves — defaults are the healthy-shaped image. */
interface Scenario {
  /** Lines the `--entrypoint sh` hygiene run prints: user, NODE_ENV, first shipped test file. */
  hygieneLines: string[];
  hygieneCode: number;
  /** The attached boot with no environment at all. */
  noenvCode: number;
  noenvOutput: string;
  /** The attached boot with the smoke environment plus JOBS_DIAGNOSTICS=true. */
  diagnosticsCode: number;
  diagnosticsOutput: string;
  /** What `docker run -d` prints (a container id) — unused by the script. */
  detachId: string;
  /** What `docker port <name> 3003/tcp` prints — first line only. */
  portLine: string;
  /** What the `-w` format prints, and curl's own exit status. */
  healthCode: number;
  curlExit: number;
  /** Written to the `-o` file — the /health body. */
  healthBody: string;
  stopCode: number;
  /** What `docker inspect -f '{{.State.ExitCode}}'` prints. */
  exitCode: number;
  /** What `docker inspect -f '{{.State.Running}}'` prints. */
  running: string;
  /** What `docker logs` prints — the failure evidence the script surfaces. */
  logs: string;
}

/** The /health body the real service answers with a store it cannot reach (verified by hand). */
const HEALTHY_BODY = JSON.stringify({
  status: "error",
  service: "helix-jobs",
  uptime: 0.4,
  checks: [
    {
      name: "jobs_database",
      status: "error",
      detail: "storage is unavailable with no verdict recorded",
      metrics: { probes: 1 },
    },
  ],
});

function baseScenario(): Scenario {
  return {
    hygieneLines: ["node", "production"],
    hygieneCode: 0,
    noenvCode: 1,
    noenvOutput: "Error: JOBS_SERVER_ID is required — set it and restart",
    diagnosticsCode: 1,
    diagnosticsOutput: "Error: JOBS_DIAGNOSTICS cannot be enabled in production — remove the flag",
    detachId: "0123456789abcdef",
    portLine: "127.0.0.1:49999",
    healthCode: 200,
    curlExit: 0,
    healthBody: HEALTHY_BODY,
    stopCode: 0,
    exitCode: 0,
    running: "true",
    logs: "",
  };
}

const created: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "image-smoke-"));
  created.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Resolve one external command the way the script's own PATH will. */
function resolveTool(tool: string): string {
  const found = spawnSync("/bin/bash", ["-c", `command -v ${tool}`], { encoding: "utf8" });
  const resolved = found.stdout.trim();
  if (found.status !== 0 || resolved === "") {
    throw new Error(`the suite's host has no ${tool} for the smoke script to run with`);
  }
  return resolved;
}

/** The controlled PATH: the real tools the script needs, plus the shims when asked for. */
function makeBin(withShims: boolean): string {
  const bin = tempDir();
  for (const tool of SCRIPT_TOOLS) symlinkSync(resolveTool(tool), path.join(bin, tool));
  if (withShims) {
    writeShim(bin, "docker", DOCKER_SHIM);
    writeShim(bin, "curl", CURL_SHIM);
  }
  return bin;
}

function writeShim(bin: string, name: string, source: string): void {
  // The absolute node interpreter in the shebang: the shim must not depend on
  // the controlled PATH it is itself found through.
  writeFileSync(path.join(bin, name), `#!${process.execPath}\n${source}`, { mode: 0o755 });
}

/** The shim `docker`: records every invocation, then answers per subcommand from the scenario. */
const DOCKER_SHIM = `
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.SMOKE_DOCKER_LOG, argv.join(" ") + "\\n");
const scenario = JSON.parse(fs.readFileSync(process.env.SMOKE_SCENARIO, "utf8"));
const fail = (message) => {
  process.stderr.write("docker shim: " + message + ": " + argv.join(" ") + "\\n");
  process.exit(1);
};
if (argv[0] === "run") {
  if (argv.includes("--entrypoint")) {
    process.stdout.write(scenario.hygieneLines.map((line) => line + "\\n").join(""));
    process.exit(scenario.hygieneCode);
  }
  if (argv.includes("-d")) {
    process.stdout.write(scenario.detachId + "\\n");
    process.exit(0);
  }
  if (argv.includes("JOBS_DIAGNOSTICS=true")) {
    process.stdout.write(scenario.diagnosticsOutput + "\\n");
    process.exit(scenario.diagnosticsCode);
  }
  process.stdout.write(scenario.noenvOutput + "\\n");
  process.exit(scenario.noenvCode);
}
if (argv[0] === "port") {
  process.stdout.write(scenario.portLine + "\\n");
  process.exit(0);
}
if (argv[0] === "stop") process.exit(scenario.stopCode);
if (argv[0] === "inspect") {
  const format = argv[argv.indexOf("-f") + 1] ?? "";
  if (format.includes("State.Running")) process.stdout.write(scenario.running + "\\n");
  else process.stdout.write(String(scenario.exitCode) + "\\n");
  process.exit(0);
}
if (argv[0] === "logs") {
  process.stdout.write(scenario.logs + "\\n");
  process.exit(0);
}
if (argv[0] === "rm") process.exit(0);
fail("unhandled subcommand");
`;

/** The shim `curl`: writes the scenario's health body to the `-o` file, prints the `-w` code. */
const CURL_SHIM = `
const fs = require("node:fs");
const argv = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(process.env.SMOKE_SCENARIO, "utf8"));
const bodyFile = argv[argv.indexOf("-o") + 1] ?? null;
if (bodyFile) fs.writeFileSync(bodyFile, scenario.healthBody);
// The only -w format the script asks for is %{http_code}; print it and go.
process.stdout.write(String(scenario.healthCode) + "\\n");
process.exit(scenario.curlExit);
`;

let scenarioCounter = 0;

function writeScenario(overrides: Partial<Scenario> = {}): string {
  scenarioCounter += 1;
  const file = path.join(tempDir(), `scenario-${scenarioCounter}.json`);
  writeFileSync(file, JSON.stringify({ ...baseScenario(), ...overrides }));
  return file;
}

function recordedCalls(log: string): string[] {
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
}

/** Run the script the way CI does, with only the controlled PATH and the case's scenario. */
function runSmoke(scenarioFile: string, bin: string, dockerLog: string): SpawnSyncReturns<string> {
  return spawnSync("/bin/bash", [SCRIPT, "helix-jobs:ci"], {
    encoding: "utf8",
    env: { PATH: bin, SMOKE_SCENARIO: scenarioFile, SMOKE_DOCKER_LOG: dockerLog },
  });
}

/** A world for one case: shimmed PATH, the case's scenario, a fresh invocation log. */
function makeWorld(overrides: Partial<Scenario> = {}): {
  run: SpawnSyncReturns<string>;
  log: string;
} {
  const bin = makeBin(true);
  const scenarioFile = writeScenario(overrides);
  const log = path.join(tempDir(), "invocations.log");
  return { run: runSmoke(scenarioFile, bin, log), log };
}

/** Every failing case asserts the status AND its own reason — failing for the wrong reason passes nothing. */
function expectFail(run: SpawnSyncReturns<string>, reason: string | RegExp): void {
  expect(run.status).not.toBe(0);
  expect(run.stderr).toMatch(/^image-smoke: FAIL: /m);
  if (typeof reason === "string") expect(run.stderr).toContain(reason);
  else expect(run.stderr).toMatch(reason);
}

describe("image-smoke.sh against a healthy-shaped image", () => {
  it("passes every check in order and ends with the all-passed line", () => {
    const { run, log } = makeWorld();
    expect(run.status).toBe(0);
    expect(run.stdout.trimEnd().endsWith("image-smoke: all checks passed")).toBe(true);

    const calls = recordedCalls(log);
    expect(calls).toContainEqual(expect.stringMatching(/^stop /));
    expect(calls).toContainEqual(expect.stringMatching(/^inspect /));

    // The detached boot runs on the image's own environment: no NODE_ENV may
    // be passed for it (the image bakes it in), and the store DSN points at
    // the unroutable port the honest-error check depends on.
    const detach = calls.find((line) => /^run -d /.test(line));
    expect(detach, "the smoke check never ran the image detached").toBeDefined();
    expect(detach as string).toMatch(
      /JOBS_DATABASE_URL=postgresql:\/\/helix_jobs:smoke@127\.0\.0\.1:1\/helix_jobs/,
    );
    expect(detach as string).not.toMatch(/NODE_ENV/);
  });
});

describe("image-smoke.sh refuses an image that fails a check", () => {
  it("fails an image running as root, naming the user", () => {
    const { run } = makeWorld({ hygieneLines: ["root", "production"] });
    expectFail(run, /runs as 'root', not the unprivileged 'node' user/);
  });

  it("fails an image shipping a test file, naming it", () => {
    const shipped = "/app/apps/jobs/src/imageSmoke.test.ts";
    const { run } = makeWorld({ hygieneLines: ["node", "production", shipped] });
    expectFail(run, `ships a test file: ${shipped}`);
  });

  it("fails an image that boots with no configuration instead of refusing", () => {
    const { run } = makeWorld({ noenvCode: 0 });
    expectFail(run, /boots with no configuration/);
  });

  it("fails a diagnostics boot that exits without naming the refusal", () => {
    const { run } = makeWorld({
      diagnosticsCode: 1,
      diagnosticsOutput: "Error: something unrelated went wrong",
    });
    expectFail(run, /never named the refusal/);
  });

  it("fails a diagnostics boot that is still running at the timeout", () => {
    const { run } = makeWorld({ diagnosticsCode: 124 });
    expectFail(run, /still running after 60s/);
  });

  it("fails a /health body that reports ok while the store is unreachable", () => {
    const { run, log } = makeWorld({
      healthBody: JSON.stringify({
        status: "ok",
        service: "helix-jobs",
        uptime: 0.4,
        checks: [{ name: "jobs_database", status: "ok" }],
      }),
    });
    expectFail(run, /an unreachable store must never look healthy/);
    // The failed check must not leak the detached container: the trap's
    // force-remove is what the runner is left with.
    expect(recordedCalls(log)).toContainEqual(expect.stringMatching(/^rm -f /));
  });

  it("fails a /health answer that is not 200 — the contract always answers 200", () => {
    const { run } = makeWorld({ healthCode: 503 });
    expectFail(run, /the health contract always answers 200/);
  });

  it("fails a /health body whose jobs_database check reports ok", () => {
    const { run } = makeWorld({
      healthBody: JSON.stringify({
        status: "error",
        service: "helix-jobs",
        uptime: 0.4,
        checks: [{ name: "jobs_database", status: "ok" }],
      }),
    });
    expectFail(run, /does not report the jobs_database check as error/);
  });

  it("fails a container the runtime had to SIGKILL on stop, naming the kill", () => {
    const { run } = makeWorld({ exitCode: 137 });
    expectFail(run, /137.*SIGKILL/);
  });

  it("fails loudly when docker is absent from PATH, naming the tool", () => {
    const bin = makeBin(false);
    const scenarioFile = writeScenario();
    const log = path.join(tempDir(), "invocations.log");
    const run = runSmoke(scenarioFile, bin, log);
    expectFail(run, /docker is required but not on PATH/);
    expect(recordedCalls(log)).toEqual([]);
  });
});
