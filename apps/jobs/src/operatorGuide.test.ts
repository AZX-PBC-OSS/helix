/**
 * The operator guide for background jobs (`apps/docs/src/deploy/jobs.md`) is
 * a set of procedures an operator runs verbatim against a live install. These
 * tests pin every name it hands the operator to the definitions that own it:
 * the Bicep parameters and resource names, the environment variables the
 * services read, the health checks, the log events, the capacity defaults,
 * the retention and deadline figures, the ports in the probe commands, and
 * the suites cited as evidence. A rename on either side fails here, naming
 * what moved.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  JOBS_CAPACITY_DEFAULTS,
  JOBS_HEALTH_CHECK_NAMES,
  JOBS_MAX_INPUT_BYTES,
  JOBS_MAX_RESULT_BYTES,
  JobsSubmissionOverridesSchema,
} from "@azx-pbc/shared";

import {
  JOBS_DEADLINE_SECONDS,
  JOBS_FETCH_DEADLINE_SECONDS,
  JOBS_RECORD_TTL_SECONDS,
  JOBS_REMOVAL_GRACE_SECONDS,
  JOBS_RESULT_TTL_SECONDS,
  jobsRuntimeBossOptions,
} from "./policy.js";
import { JOBS_LIFECYCLE_RECOVERY_OVERDUE_MS } from "./recovery.js";
import { appCall, readRepoFile } from "./test/bicep.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const GUIDE_PATH = "apps/docs/src/deploy/jobs.md";
const guide = readRepoFile(GUIDE_PATH);
const localGuide = readRepoFile("apps/docs/src/deploy/local-dev.md");
const MAIN = readRepoFile("infra/azure/main.bicep");
const ALERTS_JOBS = readRepoFile("infra/azure/modules/alerts-jobs.bicep");
const MIGRATE_JOB = readRepoFile("infra/azure/modules/jobs-migrate-job.bicep");
const CONTAINER_APP = readRepoFile("infra/azure/modules/containerapp.bicep");

/** The text of a `## <heading>` or `### <heading>` section, up to the next heading of the same or higher level. */
function section(markdown: string, heading: string): string {
  const level = heading.match(/^#+/)?.[0].length ?? 0;
  const start = markdown.indexOf(`\n${heading}\n`);
  expect(start, `${GUIDE_PATH} must have a "${heading}" section`).toBeGreaterThanOrEqual(0);
  const rest = markdown.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next === -1 ? rest : rest.slice(0, next);
}

/** The fenced code blocks of a document — the text an operator pastes. */
function codeBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]!);
}

/** Every non-test TypeScript source file under a repo-relative directory, recursively. */
function sourceFiles(relativeDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "test" && entry.name !== "node_modules") walk(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
        files.push(full);
      }
    }
  };
  walk(path.join(REPO_ROOT, relativeDir));
  return files;
}

/** Every `event: "jobs.…"` literal the services' production sources emit. */
const EMITTED_EVENTS = new Set(
  ["apps/jobs/src", "apps/jobs/scripts", "apps/portal/src", "apps/edge/src"].flatMap((dir) =>
    sourceFiles(dir).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/event: "(jobs\.[a-z_.]+)"/g)].map((m) => m[1]!),
    ),
  ),
);

/** A whole-number count as the guide spells it (`10,000`). */
const spelled = (n: number): string => n.toLocaleString("en-US");

describe("the operator guide's Bicep names", () => {
  it("every parameter it sets is a main.bicep parameter, with a value the parameter allows", () => {
    const assignments = [...guide.matchAll(/`([a-zA-Z]+)=([a-z]+)`/g)].map((m) => ({
      param: m[1]!,
      value: m[2]!,
    }));
    expect(assignments.length, "the guide must set parameters").toBeGreaterThan(0);
    for (const { param, value } of assignments) {
      const declared = MAIN.match(
        new RegExp(`(@allowed\\(\\[([^\\]]*)\\]\\)\\s*\\n)?param ${param} (bool|string)`),
      );
      expect(declared, `main.bicep must declare the ${param} parameter`).not.toBeNull();
      if (declared![3] === "bool") {
        expect(["true", "false"], `${param} is a bool`).toContain(value);
      } else {
        const allowed = [...(declared![2] ?? "").matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
        expect(allowed, `${param} must allow '${value}'`).toContain(value);
      }
    }
    for (const param of ["deployJobs", "jobsServerState", "jobsIntakeOpen", "deployAlerts"]) {
      expect(
        assignments.some((a) => a.param === param) || guide.includes(`\`${param}\``),
        `the guide must name ${param}`,
      ).toBe(true);
    }
  });

  it("every <namePrefix>- resource it names is declared under that name", () => {
    const declared = new Map<string, boolean>([
      ["jobs", /var jobsAppName = '\$\{namePrefix\}-jobs'/.test(MAIN)],
      ["portal", /'\$\{namePrefix\}-portal'/.test(MAIN)],
      ["jobs-migrate", /name: '\$\{namePrefix\}-jobs-migrate'/.test(MIGRATE_JOB)],
      ["jobs-health-relay", /name: '\$\{namePrefix\}-jobs-health-relay'/.test(ALERTS_JOBS)],
    ]);
    const named = new Set([...guide.matchAll(/<namePrefix>-([a-z-]+[a-z])/g)].map((m) => m[1]!));
    expect(named.size, "the guide must name resources").toBeGreaterThan(0);
    for (const name of named) {
      expect(declared.get(name), `<namePrefix>-${name} must be declared in the templates`).toBe(
        true,
      );
    }
  });

  it("names exactly the five jobs alert rules the alerts module declares", () => {
    const checkRules = [...ALERTS_JOBS.matchAll(/name: '(jobs-[a-z]+)'/g)].map((m) => m[1]!);
    expect(checkRules.length, "alerts-jobs.bicep must declare its check rules").toBe(4);
    expect(ALERTS_JOBS).toContain("'${namePrefix}-alert-${rule.name}'");
    expect(ALERTS_JOBS).toContain("'${namePrefix}-alert-jobs-unobserved'");
    const declared = [...checkRules, "jobs-unobserved"].map((r) => `-alert-${r}`).sort();
    const named = [...new Set([...guide.matchAll(/`(-alert-jobs-[a-z]+)`/g)].map((m) => m[1]!))];
    expect(named.sort()).toEqual(declared);
  });

  it("the probe commands use the ports the container apps listen on", () => {
    expect(appCall("jobsApp")).toMatch(/targetPort: 3003\b/);
    expect(appCall("portalApp")).toMatch(/targetPort: 3001\b/);
    const blocks = codeBlocks(guide).join("\n");
    expect(blocks).toContain("-n <namePrefix>-jobs --command");
    expect(blocks).toContain("http://127.0.0.1:3003/health");
    expect(blocks).toContain("-n <namePrefix>-portal --command");
    expect(blocks).toContain("http://127.0.0.1:3001/health");
  });

  it("the dev gateway's replica ceiling is the one the guide multiplies by", () => {
    const devGateway = appCall("devGatewayApp");
    expect(devGateway, "the dev gateway must take the module's replica default").not.toMatch(
      /maxReplicas:/,
    );
    expect(CONTAINER_APP).toMatch(/param maxReplicas int = 3\b/);
    expect(section(guide, "### Tune capacity limits")).toContain("it can scale\n  to 3 replicas");
  });
});

describe("the operator guide's environment variables", () => {
  it("each limit variable is read by the service the guide sets it on, and neither is set by the template", () => {
    const jobsConfig = readRepoFile("apps/jobs/src/config.ts");
    const edgeConfig = readRepoFile("apps/edge/src/config.ts");
    expect(jobsConfig).toContain("env.JOBS_LIMITS");
    expect(jobsConfig).toContain("env.JOBS_ACCEPTING");
    expect(edgeConfig).toContain("EDGE_JOBS_LIMITS");
    for (const name of ["JOBS_LIMITS", "EDGE_JOBS_LIMITS"]) {
      expect(MAIN, `main.bicep must not set ${name} yet — the guide says it does not`).not.toMatch(
        new RegExp(`name: '${name}'`),
      );
    }
    expect(appCall("jobsApp")).toContain("{ name: 'JOBS_ACCEPTING'");
  });

  it("the limits table lists exactly each variable's own controls and their defaults", () => {
    const table = section(guide, "### Tune capacity limits");
    const row = (variable: string): string => {
      const line = table.split("\n").find((l) => l.startsWith(`| \`${variable}\``));
      expect(line, `the limits table must have a ${variable} row`).toBeDefined();
      return line!;
    };
    const submissionKeys = Object.keys(JobsSubmissionOverridesSchema.out.shape).sort();
    const jobsKeys = Object.keys(JOBS_CAPACITY_DEFAULTS)
      .filter((k) => !submissionKeys.includes(k))
      .sort();
    const keysIn = (line: string): string[] =>
      [...line.matchAll(/`([a-zA-Z]+)`/g)]
        .map((m) => m[1]!)
        .filter((k) => k in JOBS_CAPACITY_DEFAULTS)
        .sort();
    expect(keysIn(row("EDGE_JOBS_LIMITS"))).toEqual(submissionKeys);
    expect(keysIn(row("JOBS_LIMITS"))).toEqual(jobsKeys);

    const d = JOBS_CAPACITY_DEFAULTS;
    expect(row("EDGE_JOBS_LIMITS")).toContain(
      `${d.submissionAttemptsPerAppEnv} and ${d.submissionAttemptsDeployment} attempts per ${d.submissionWindowSeconds} s window`,
    );
    expect(row("JOBS_LIMITS")).toContain(
      [
        d.unfinishedPerAppEnv,
        d.unfinishedPerServer,
        d.retainedPerAppEnv,
        d.retainedPerServer,
        d.runningPerAppEnv,
        d.runningPerWorker,
      ]
        .map(spelled)
        .join(", "),
    );
  });

  it("the Bicep example names a control the jobs service accepts", () => {
    const example = codeBlocks(section(guide, "### Tune capacity limits")).join("\n");
    const value = example.match(/\{ name: 'JOBS_LIMITS', value: '(\{[^']*\})' \}/);
    expect(value, "the example must be a JOBS_LIMITS env entry").not.toBeNull();
    const keys = Object.keys(JSON.parse(value![1]!) as object);
    for (const key of keys) expect(Object.keys(JOBS_CAPACITY_DEFAULTS)).toContain(key);
  });

  it("the local guide's log-level variable is the jobs service's prefixed one", () => {
    expect(readRepoFile("apps/jobs/src/app.ts")).toContain('prefix: "JOBS"');
    expect(localGuide).toContain("JOBS_LOG_LEVEL");
  });
});

describe("the operator guide's health and log vocabulary", () => {
  it("the health table lists every jobs check, once", () => {
    const table = section(guide, "## Reading health");
    const rows = [...table.matchAll(/^\| `(jobs_[a-z_]+)` \|/gm)].map((m) => m[1]!);
    expect(rows.sort()).toEqual([...JOBS_HEALTH_CHECK_NAMES].sort());
  });

  it("every check it names anywhere is a real check", () => {
    for (const docText of [guide, localGuide]) {
      for (const m of docText.matchAll(/`(jobs_[a-z_]+)`/g)) {
        expect(JOBS_HEALTH_CHECK_NAMES as readonly string[]).toContain(m[1]!);
      }
    }
  });

  it("every log event it names is emitted by a service", () => {
    expect(EMITTED_EVENTS.size, "the source scan must find the emitted events").toBeGreaterThan(20);
    const named = [...guide.matchAll(/`(jobs\.[a-z_]+\.[a-z_.*]+)`/g)]
      .map((m) => m[1]!)
      .filter((e) => !e.endsWith(".*"));
    expect(named.length).toBeGreaterThan(10);
    for (const event of named) {
      expect(EMITTED_EVENTS.has(event), `"${event}" must be emitted by a service`).toBe(true);
    }
    for (const m of guide.matchAll(/`(jobs\.[a-z]+)\.\*`/g)) {
      const prefix = `${m[1]!}.`;
      expect(
        [...EMITTED_EVENTS].some((e) => e.startsWith(prefix)),
        `some event must start with ${prefix}`,
      ).toBe(true);
    }
  });
});

describe("the operator guide's figures", () => {
  it("the retention, deadline and backlog figures are the platform's own", () => {
    expect(JOBS_RESULT_TTL_SECONDS / 86_400).toBe(7);
    expect(JOBS_RECORD_TTL_SECONDS / 86_400).toBe(30);
    expect(JOBS_REMOVAL_GRACE_SECONDS / 3_600).toBe(48);
    expect(JOBS_DEADLINE_SECONDS / 60).toBe(60);
    expect(JOBS_FETCH_DEADLINE_SECONDS / 60).toBe(5);
    expect(JOBS_LIFECYCLE_RECOVERY_OVERDUE_MS).toBe(60_000);
    expect(readRepoFile("apps/portal/src/jobs/delivery.ts")).toContain(
      "export const JOBS_DELIVERY_OVERDUE_MS = 60_000;",
    );
    const expiry = section(guide, "### Expiry and cleanup");
    expect(expiry).toContain("readable for 7 days");
    expect(expiry).toContain("readable for 30 days");
    expect(expiry).toContain("within 48 hours");
    expect(guide).toContain("60-minute absolute deadline (5 minutes for\n  `jobs:fetch`)");
    expect(section(guide, "### Delivery backlog and cancellation backlog")).toContain("after 60 s");
  });

  it("the enforced limits are the platform defaults", () => {
    const enforced = section(guide, "### What is enforced");
    const d = JOBS_CAPACITY_DEFAULTS;
    expect(enforced).toContain(
      `${d.submissionAttemptsPerAppEnv} per app and environment, and ${d.submissionAttemptsDeployment} across the\n  deployment, per ${d.submissionWindowSeconds}-second fixed window`,
    );
    expect(enforced).toContain(
      `${spelled(d.unfinishedPerAppEnv)} per app and environment, ${spelled(d.unfinishedPerServer)} per server`,
    );
    expect(enforced).toContain(
      `${spelled(d.retainedPerAppEnv)} per app and environment, ${spelled(d.retainedPerServer)} per server`,
    );
    expect(enforced).toContain(
      `${d.runningPerAppEnv} per app and environment and ${d.runningPerWorker} in total per worker process`,
    );
    expect(JOBS_MAX_INPUT_BYTES).toBe(JOBS_MAX_RESULT_BYTES);
    expect(enforced).toContain(`at most ${spelled(JOBS_MAX_INPUT_BYTES)} bytes each`);
  });

  it("the per-process connection ceiling is the sum of the service's configured pools", () => {
    // Every store the service composes builds one bounded pool; pg-boss adds
    // its own, at the pg driver's default of 10 because no `max` is passed.
    const pooled = sourceFiles("apps/jobs/src")
      .map((file) => readFileSync(file, "utf8").match(/^const POOL_MAX = (\d+);$/m))
      .filter((m): m is RegExpMatchArray => m !== null)
      .reduce((sum, m) => sum + Number(m[1]), 0);
    expect(pooled).toBe(19);
    expect(Object.keys(jobsRuntimeBossOptions())).not.toContain("max");
    const runner = readRepoFile("apps/jobs/src/runner.ts");
    const buildBoss = runner.slice(runner.indexOf("private buildBoss()"));
    expect(buildBoss.slice(0, buildBoss.indexOf("return boss;"))).not.toMatch(/\bmax:/);
    expect(section(guide, "### Sizing a deployment")).toContain(
      "19 connections\nacross its stores and 10 for the pg-boss runner, so 29 per process at most,\nand 58 while two revisions overlap",
    );
  });
});

describe("the operator guide's commands and evidence", () => {
  it("every suite it cites exists", () => {
    const cited = new Set(
      [
        ...`${guide}\n${localGuide}`.matchAll(
          /`((?:apps|packages)\/[a-z-]+\/src\/[A-Za-z.]+\.test\.ts)`/g,
        ),
      ].map((m) => m[1]!),
    );
    const bare = [...guide.matchAll(/`([A-Za-z]+\.integration\.test\.ts)`/g)].map(
      (m) => `apps/jobs/src/${m[1]!}`,
    );
    for (const file of [...cited, ...bare]) {
      expect(existsSync(path.join(REPO_ROOT, file)), `${file} must exist`).toBe(true);
    }
    expect(cited.size).toBeGreaterThan(10);
  });

  it("the local commands name real scripts and flags", () => {
    const rootPackage = JSON.parse(readRepoFile("package.json")) as {
      scripts: Record<string, string>;
    };
    expect(rootPackage.scripts["dev:jobs"]).toBeDefined();
    const stackEnv = readRepoFile("scripts/stack-env.mjs");
    expect(stackEnv).toContain('"--offset"');
    expect(stackEnv).toContain('argv.includes("--env")');
    expect(stackEnv).toContain("HELIX_JOBS_DIAGNOSTICS");
    expect(existsSync(path.join(REPO_ROOT, "scripts/ensure-db.mjs"))).toBe(true);
    expect(readRepoFile("scripts/ensure-db.mjs")).toContain(
      "Usage: node scripts/ensure-db.mjs <owner-dsn> [jobs-runtime-dsn]",
    );
    const blocks = codeBlocks(localGuide).join("\n");
    expect(blocks).toContain("env $(node scripts/stack-env.mjs --env --offset 1000) pnpm dev:jobs");
    expect(readRepoFile("apps/jobs/src/server.ts")).toContain('["JOBS_PORT", "PORT"], 3003');
  });

  it("the guide is reachable from the docs sidebar", () => {
    expect(readRepoFile("apps/docs/.vitepress/config.ts")).toContain(
      '{ text: "Operating background jobs", link: "/deploy/jobs" }',
    );
  });
});
