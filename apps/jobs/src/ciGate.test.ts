import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { REQUIRED_AMBIENT_KEYS } from "./test/realStack.js";

/**
 * The gate's CI wiring, pinned statically: GitHub Actions cannot run here, so
 * the only way a step can vanish from CI while the local gate still runs it —
 * or a real-stack prerequisite can go missing from the `test` job — is for a
 * test to read the workflow text and fail loudly. There is no YAML parser
 * dependency, so the extraction is plain string/regex over the files, the way
 * imagePackaging.test.ts does it.
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function readRepo(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

const WORKFLOW = readRepo(".github/workflows/ci.yml");
const DEV_COMPOSE = readRepo(".devcontainer/docker-compose.yml");
const GATE_SCRIPT = readRepo("check-and-lint.sh");

/**
 * The text of one job block: from `  <name>:` to the next two-space-indented
 * job key (every line inside a job block is deeper than that) or EOF.
 */
function jobBlock(name: string): string {
  const marker = `\n  ${name}:\n`;
  const start = WORKFLOW.indexOf(marker);
  expect(
    start === -1 ? undefined : start,
    `the ${name} job is missing from ci.yml — fix this extraction; the pins below are unverified until it reads`,
  ).toBeDefined();
  const bodyLines = WORKFLOW.slice(start + marker.length).split("\n");
  const end = bodyLines.findIndex((line) => /^ {2}[a-z][a-z0-9-]*:$/.test(line));
  return (end === -1 ? bodyLines : bodyLines.slice(0, end)).join("\n");
}

/** A job block's steps, split on the six-space list marker every step starts with. */
function steps(block: string): string[] {
  return block.split("\n      - ").slice(1);
}

describe("the two CI jobs together run the whole local gate", () => {
  // CI invokes ./check-and-lint.sh by step name, so the gate a developer runs
  // and the gate CI runs stay one script. The flip side: a step added to the
  // script but named in neither job runs locally and never in CI. This pin
  // makes that a red test instead of a silent gap, and refuses the soft-fail
  // forms (`|| true`, continue-on-error) that would green a failing gate step.
  it("runs every local step except test in static, and test sharded", () => {
    const all =
      GATE_SCRIPT.match(/ALL_STEPS=\(([^\n]*)\)/)?.[1]
        ?.trim()
        .split(/\s+/) ?? [];
    expect(
      all.length,
      "check-and-lint.sh's ALL_STEPS cannot be parsed — fix this extraction",
    ).toBeGreaterThan(0);

    const staticSteps = steps(jobBlock("static"));
    const staticRun = staticSteps.find((step) => step.includes("./check-and-lint.sh"));
    expect(staticRun, "the static job never runs ./check-and-lint.sh").toBeDefined();
    const staticNamed =
      (staticRun as string)
        .match(/^ {8}run: \.\/check-and-lint\.sh (.+)$/m)?.[1]
        ?.trim()
        .split(/\s+/) ?? [];
    expect(staticNamed).toEqual(all.filter((name) => name !== "test"));

    const testSteps = steps(jobBlock("test"));
    const testRun = testSteps.find((step) => step.includes("./check-and-lint.sh"));
    expect(testRun, "the test job never runs ./check-and-lint.sh").toBeDefined();
    expect(testRun).toContain("run: ./check-and-lint.sh test -- --shard=${{ matrix.shard }}");

    for (const runStep of [staticRun as string, testRun as string]) {
      expect(runStep).not.toContain("|| true");
      expect(runStep).not.toContain("continue-on-error");
    }
  });
});

describe("the shard matrix covers every shard exactly once", () => {
  // vitest's --shard=k/N skips files outside shard k: a duplicated or missing
  // k silently drops suites from the run while every job stays green.
  it("names k/N for k = 1..N with one N", () => {
    const raw = jobBlock("test").match(/shard: \[([^\]]*)\]/)?.[1];
    expect(raw, "the test job's shard matrix cannot be parsed — fix this extraction").toBeDefined();
    const shards = (raw as string).split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
    expect(
      shards.length,
      "the shard matrix parsed to nothing — fix this extraction",
    ).toBeGreaterThan(0);
    const denominators = new Set<string>();
    for (const shard of shards) {
      const parts = shard.match(/^(\d+)\/(\d+)$/);
      expect(parts, `shard "${shard}" is not of the form k/N`).not.toBeNull();
      denominators.add((parts as RegExpMatchArray)[2] as string);
    }
    expect(denominators.size, "the shard matrix mixes denominators").toBe(1);
    const n = Number([...denominators][0] as string);
    expect(n, "the shard matrix must have at least one shard").toBeGreaterThanOrEqual(1);
    expect(shards).toEqual(Array.from({ length: n }, (_, i) => `${i + 1}/${n}`));
  });
});

describe("the test job provisions the real roles before the suite", () => {
  // The suites fail confusingly without the runtime roles; the provisioning
  // must also happen before the run step, not after (or alongside) the suite.
  it("applies the db-init SQL with ON_ERROR_STOP before Run checks (test)", () => {
    const testSteps = steps(jobBlock("test"));
    const roles = testSteps.findIndex(
      (step) => step.includes(".devcontainer/db-init/") && step.includes("ON_ERROR_STOP=1"),
    );
    expect(
      roles,
      "the test job never applies .devcontainer/db-init/*.sql with ON_ERROR_STOP=1",
    ).toBeGreaterThan(-1);
    const run = testSteps.findIndex((step) => step.includes("Run checks (test)"));
    expect(run, "the test job has no Run checks (test) step").toBeGreaterThan(-1);
    expect(roles, "the role provisioning must precede the test run").toBeLessThan(run);
  });
});

describe("the test job carries what the real-stack harness requires", () => {
  // startRealStack refuses to boot without its ambient keys, the portal/egress
  // boot paths read the dev KEK, and the child services reach each other
  // through the stack hostnames — which must resolve to loopback before any
  // of it starts. A key dropped from the job's env surfaces as a boot refusal
  // deep inside a shard log; the pin keeps the job honest instead.
  const testJob = jobBlock("test");
  const envBlock = testJob.slice(testJob.indexOf("    env:"), testJob.indexOf("    steps:"));
  const testSteps = steps(testJob);

  it("sets every REQUIRED_AMBIENT_KEYS key plus the KEK and the test DSN", () => {
    for (const key of REQUIRED_AMBIENT_KEYS) {
      expect(envBlock, `${key} is missing from the test job's env`).toMatch(
        new RegExp(`^ {6}${key}:`, "m"),
      );
    }
    expect(envBlock, "DEV_SECRETS_KEK_FILE is missing from the test job's env").toMatch(
      /^ {6}DEV_SECRETS_KEK_FILE:/m,
    );
    expect(envBlock, "TEST_DATABASE_URL is missing from the test job's env").toMatch(
      /^ {6}TEST_DATABASE_URL:/m,
    );
  });

  it("generates the dev KEK file", () => {
    const kek = testSteps.find((step) =>
      step.includes('openssl rand -hex 32 > "$DEV_SECRETS_KEK_FILE"'),
    );
    expect(kek, "no step generates $DEV_SECRETS_KEK_FILE").toBeDefined();
  });

  it("maps the stack hostnames to localhost before the run step", () => {
    const domain = envBlock.match(/^ {6}EDGE_BASE_DOMAIN: (\S+)$/m)?.[1];
    expect(
      domain,
      "the test job env does not name EDGE_BASE_DOMAIN — fix this extraction",
    ).toBeDefined();
    const hostsStep = testSteps.find((step) => step.includes("/etc/hosts"));
    expect(hostsStep, "no step maps the stack hostnames in /etc/hosts").toBeDefined();
    const runLine = (hostsStep as string).match(/^ {8}run: (.+)$/m)?.[1] ?? "";
    const mapped =
      runLine
        .match(/127\.0\.0\.1 ([^"]+)/)?.[1]
        ?.trim()
        .split(/\s+/) ?? [];
    expect(new Set(mapped)).toEqual(
      new Set(["db", "azurite", domain as string, `auth.${domain}`, `dev-api.${domain}`]),
    );
    const run = testSteps.findIndex((step) => step.includes("Run checks (test)"));
    expect(
      testSteps.indexOf(hostsStep as string),
      "the /etc/hosts mapping must precede the test run",
    ).toBeLessThan(run);
  });
});

describe("the test job's Postgres has the dev container's connection budget", () => {
  // The real-stack suites hold ~35 Postgres connections each and a shard can
  // run several at once, so the default 100 is not enough. A service container
  // cannot take a `command:`, so the job applies the dev container's budget
  // with ALTER SYSTEM + a restart — and must check the setting took, since a
  // silently unchanged budget fails suites at their connection peak, far from
  // the cause.
  it("raises max_connections to the dev value and verifies it took", () => {
    const dev = DEV_COMPOSE.match(/max_connections=(\d+)/)?.[1];
    expect(
      dev,
      "the dev container's max_connections cannot be parsed — fix this extraction",
    ).toBeDefined();
    const testSteps = steps(jobBlock("test"));
    const raise = testSteps.find((step) =>
      step.includes(`ALTER SYSTEM SET max_connections = ${dev}`),
    );
    expect(raise, `no step sets max_connections to the dev container's ${dev}`).toBeDefined();
    const step = raise as string;
    expect(step).toContain('docker restart "${{ job.services.db.id }}"');
    expect(step).toContain("SHOW max_connections");
    expect(step).toContain(`test "$actual" = "${dev}"`);
    const run = testSteps.findIndex((step) => step.includes("Run checks (test)"));
    expect(
      testSteps.indexOf(step),
      "the max_connections raise must precede the test run",
    ).toBeLessThan(run);
  });
});

describe("infrastructure validation stays in delivery", () => {
  // The Bicep templates are the deployed topology's source of truth, and the
  // publish path is where a broken template or a red lane must stop — the
  // image jobs wait on every gate so nothing ships past a failure.
  it("compiles the main template and its params in the bicep job", () => {
    const compile = steps(jobBlock("bicep")).find((step) => step.includes("az bicep build"));
    expect(compile, "the bicep job never compiles a template").toBeDefined();
    expect(compile).toContain("az bicep build --file infra/azure/main.bicep");
    expect(compile).toContain("az bicep build-params --file infra/azure/main.bicepparam");
  });

  it("has package and images wait on every gate job", () => {
    for (const name of ["package", "images"]) {
      expect(jobBlock(name), `the ${name} job does not wait on the whole gate`).toMatch(
        /^ {4}needs: \[static, test, browser-lane\]$/m,
      );
    }
  });
});

describe("the test job sizes vitest's workers for its runner", () => {
  // vitest.config.ts defaults to ten workers, sized for the dev container.
  // On the standard 4-vCPU runner that oversubscribes the CPU and timing-bound
  // tests fail for the host's reason, so the run step lowers the cap through
  // the variable the config reads.
  it("sets HELIX_TEST_MAX_WORKERS on the test run step, no higher than the runner's vCPUs", () => {
    const testRun = steps(jobBlock("test")).find((step) => step.includes("./check-and-lint.sh"));
    const workers = testRun?.match(/^ {10}HELIX_TEST_MAX_WORKERS: "(\d+)"$/m)?.[1];
    expect(workers, "the test run step does not set HELIX_TEST_MAX_WORKERS").toBeDefined();
    expect(Number(workers)).toBeGreaterThanOrEqual(1);
    expect(Number(workers)).toBeLessThanOrEqual(4);
    expect(readRepo("vitest.config.ts")).toContain("process.env.HELIX_TEST_MAX_WORKERS");
  });
});

describe("every job has a bound", () => {
  // A hung suite or image build otherwise burns the 6h runner default. The
  // test job's bound must also stay above its slowest shard: the real-stack
  // retention suite alone runs about ten minutes.
  it("declares timeout-minutes on every gate job, the test job's at least 30", () => {
    for (const name of ["static", "test", "browser-lane", "bicep", "package", "images"]) {
      expect(jobBlock(name), `the ${name} job declares no timeout-minutes`).toMatch(
        /^ {4}timeout-minutes: \d+$/m,
      );
    }
    const test = jobBlock("test").match(/^ {4}timeout-minutes: (\d+)$/m)?.[1];
    expect(
      Number(test),
      "the test job's timeout must stay above its slowest shard (~10 minutes of retention suite)",
    ).toBeGreaterThanOrEqual(30);
  });
});
