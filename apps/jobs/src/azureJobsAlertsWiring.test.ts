import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  JOBS_CAPACITY_CHECK,
  JOBS_CLEANUP_CHECK,
  JOBS_DATABASE_CHECK,
  JOBS_HEALTH_CHECK_NAMES,
  JOBS_INTAKE_CHECK,
  JOBS_LIFECYCLE_DELIVERY_CHECK,
  JOBS_LIFECYCLE_RECOVERY_CHECK,
  JOBS_SWEEPER_CHECK,
  JOBS_WORKER_CHECK,
} from "@azx-pbc/shared";

import {
  RELAY_CHECK_EVENT,
  RELAY_OBSERVED_EVENT,
  RELAY_OUTCOMES,
  RELAY_TARGET_KINDS,
  RELAY_TARGETS_ENV,
  RELAY_TIMEOUT_MS,
} from "../scripts/health-relay.js";

/**
 * The Azure jobs alerts are a chain nothing executes in CI: main.bicep builds
 * the relay's target list over the same `jobsServers` map the service wiring
 * projects, hands it gated to modules/alerts-jobs.bicep, which schedules
 * apps/jobs/scripts/health-relay.ts as a Container Apps Job and writes
 * log-alert rules over the stdout events that script emits. Azure-only means
 * no test deploys it, so this pins the chain statically over the files' text —
 * a re-gated module, a second URL literal, a credential on the relay, or an
 * HTTP-status read smuggled into the KQL fails here.
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function read(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

const MAIN = read("infra/azure/main.bicep");
const ALERTS = read("infra/azure/modules/alerts-jobs.bicep");

// ── Bicep-parsing helpers ────────────────────────────────────────────────────

/** The text of one `module <name> '<file>'` call in main.bicep, through its closing brace. */
function moduleCall(name: string, file: string): string {
  const call = MAIN.match(new RegExp(`module ${name} '${file}'[\\s\\S]*?\\n\\}`));
  expect(call, `main.bicep must declare the ${name} module`).not.toBeNull();
  return call![0];
}

/** The single `image:` expression of a module call — exactly one must exist. */
function imageOf(call: string, label: string): string {
  const lines = [...call.matchAll(/^\s*image: (.+)$/gm)].map((m) => m[1]!.trim());
  expect(lines, `${label} must declare exactly one container image`).toHaveLength(1);
  return lines[0]!;
}

/** The value of a single-quoted single-line `var <name> = '...'` in alerts-jobs.bicep. */
function alertsVar(name: string): string {
  const def = ALERTS.match(new RegExp(`^var ${name} = '(.*)'$`, "m"));
  expect(def, `alerts-jobs.bicep must define the var ${name}`).not.toBeNull();
  return def![1]!;
}

interface CheckRule {
  name: string;
  /** The severity expression — a Bicep param name, pinned to its default elsewhere. */
  severity: string;
  checks: string[];
}

/** Each entry of the checkRules array, with its name, severity expression and checks list. */
function checkRules(): CheckRule[] {
  const block = ALERTS.match(/var checkRules = \[([\s\S]*?)\n\]/);
  expect(block, "alerts-jobs.bicep must define checkRules").not.toBeNull();
  const entries = block![1]!.split(/\n {2}\{/).slice(1);
  expect(entries, "checkRules must have exactly four entries").toHaveLength(4);
  return entries.map((entry) => {
    const name = entry.match(/name: '([a-z-]+)'/);
    const severity = entry.match(/severity: (\w+)/);
    const checks = entry.match(/checks: \[([\s\S]*?)\]/);
    expect(
      name && severity && checks,
      `a checkRules entry failed to parse: ${name?.[1]}`,
    ).not.toBeNull();
    return {
      name: name![1]!,
      severity: severity![1]!,
      checks: [...checks![1]!.matchAll(/'(\w+)'/g)].map((m) => m[1]!),
    };
  });
}

/** The relay job resource's full text. */
function relayResource(): string {
  const relay = ALERTS.match(/resource relay 'Microsoft\.App\/jobs@[0-9-]+' = \{[\s\S]*?\n\}/);
  expect(relay, "alerts-jobs.bicep must declare the relay job").not.toBeNull();
  return relay![0];
}

// `requests` and `AppRequests` are both listed: Azure's HTTP-failure tables go
// by several names, and a rule that reached any of them would be reading a
// status code, not a body.
const FORBIDDEN_KQL_TOKENS = [
  "ResultCode",
  "statusCode",
  "requests",
  "AppRequests",
  "availabilityResults",
  "capacity_refused",
  "rate_limited",
  "jobs.admission",
  "helix.jobs.submissions",
  "throttle",
];

describe("the jobs alerts module in main.bicep", () => {
  it("is declared exactly once, gated on alerts, apps and jobs together", () => {
    expect([...MAIN.matchAll(/module jobsAlerts 'modules\/alerts-jobs\.bicep'/g)]).toHaveLength(1);
    expect(MAIN).toMatch(
      /module jobsAlerts 'modules\/alerts-jobs\.bicep' = if \(deployAlerts && deployApps && deployJobs\) \{/,
    );
  });

  it("sends the relay the forwarded endpoints, the apps env, the action group and the jobs image", () => {
    const targetsVar = MAIN.match(/var jobsHealthTargets = concat\(([\s\S]*?)\n\)/);
    expect(targetsVar, "main.bicep must define jobsHealthTargets").not.toBeNull();
    const targets = targetsVar![0];

    // The jobs entries are built over the map the edge and the portal already
    // forward to — a second URL literal for the same app would let the relay
    // grade a `/health` no consumer is wired to.
    const jobsEntry = targets.match(/map\(items\(jobsServers\), e => \{([\s\S]*?)\}\)/);
    expect(
      jobsEntry,
      "the jobs targets must be built by iterating items(jobsServers)",
    ).not.toBeNull();
    expect(jobsEntry![1]).toContain("kind: 'jobs'");
    expect(jobsEntry![1]).toContain("target: e.key");
    expect(jobsEntry![1]).toContain("url: '${e.value.endpoint}/health'");
    expect(
      jobsEntry![1],
      "the jobs targets must reuse the forwarded endpoint, not a second URL literal",
    ).not.toContain("https://");

    expect(targets).toContain("kind: 'portal'");
    expect(targets).toContain("target: 'portal'");
    const urls = [...targets.matchAll(/url: (.*)/g)].map((m) => m[1]!.trim());
    expect(urls).toHaveLength(2);
    expect(
      urls[1],
      "the portal target's url must come from the portal app's fqdn output",
    ).toContain("portalApp.?outputs.fqdn");
    expect(urls[1]!.endsWith("/health'")).toBe(true);

    const call = moduleCall("jobsAlerts", "modules/alerts-jobs.bicep");
    expect(call).toContain("targets: jobsHealthTargets");
    expect(call).toContain("workspaceId: appsEnv.outputs.logAnalyticsWorkspaceId");
    expect(call).toContain("acaEnvId: appsEnv.outputs.environmentId");
    expect(call).toContain("actionGroupId: actionGroupId");
    // The relay validates bodies against the contract the service emits, so it
    // must run the very image the jobs app runs.
    expect(imageOf(call, "jobsAlerts")).toBe(
      imageOf(moduleCall("jobsApp", "modules/containerapp.bicep"), "jobsApp"),
    );
  });
});

describe("the relay job", () => {
  it("is a credential-free scheduled run of the relay script with exactly one env entry", () => {
    const text = relayResource();
    expect(text).toContain("triggerType: 'Schedule'");
    expect(text, "a failed run is not retried; the next run is the retry").toContain(
      "replicaRetryLimit: 0",
    );
    expect(text).toContain("parallelism: 1");
    // The replica must outlive the relay's own per-target bound, or a hung
    // target kills the run before it writes the other targets' lines.
    const replicaTimeoutSeconds = Number(text.match(/replicaTimeout: (\d+)/)![1]);
    expect(replicaTimeoutSeconds * 1000).toBeGreaterThan(RELAY_TIMEOUT_MS * 2);

    const command = text.match(/command: \[([^\]]*)\]/)![1]!;
    expect([...command.matchAll(/'([^']*)'/g)].map((m) => m[1]!)).toEqual([
      "node",
      "--import",
      "tsx",
      "scripts/health-relay.ts",
    ]);
    expect(existsSync(path.join(REPO_ROOT, "apps/jobs/scripts/health-relay.ts"))).toBe(true);

    for (const token of ["identity", "secrets", "registries", "secretRef"]) {
      expect(text, `the relay job must declare no ${token}`).not.toMatch(
        new RegExp(`\\b${token}\\b`),
      );
    }

    const envBody = text.match(/env: \[([\s\S]*?)\]/)![1]!;
    const entries = [...envBody.matchAll(/\{[^{}]*\}/g)].map((m) => m[0]!);
    expect(entries, "the relay's env must be exactly the one targets entry").toHaveLength(1);
    expect(entries[0], "the targets ride the var the script reads, as a plain value").toContain(
      "name: relayTargetsEnv",
    );
    expect(entries[0]!.match(/value: (.*)\}/)![1]!.trim()).toBe("string(targets)");
  });

  it("agrees with the script on the env var name and both event names", () => {
    expect(alertsVar("relayTargetsEnv")).toBe(RELAY_TARGETS_ENV);
    expect(alertsVar("checkEvent")).toBe(RELAY_CHECK_EVENT);
    expect(alertsVar("observedEvent")).toBe(RELAY_OBSERVED_EVENT);
  });
});

describe("the check rules", () => {
  it("partition exactly the relay's expected checks, one family each", () => {
    const rules = checkRules();
    expect(rules.map((r) => r.name)).toEqual([
      "jobs-execution",
      "jobs-capacity",
      "jobs-cleanup",
      "jobs-lifecycle",
    ]);
    expect(rules.find((r) => r.name === "jobs-execution")!.checks).toEqual([
      JOBS_DATABASE_CHECK,
      JOBS_WORKER_CHECK,
      JOBS_INTAKE_CHECK,
    ]);
    expect(rules.find((r) => r.name === "jobs-capacity")!.checks).toEqual([JOBS_CAPACITY_CHECK]);
    expect(rules.find((r) => r.name === "jobs-cleanup")!.checks).toEqual([JOBS_CLEANUP_CHECK]);
    expect(rules.find((r) => r.name === "jobs-lifecycle")!.checks).toEqual([
      JOBS_LIFECYCLE_DELIVERY_CHECK,
      JOBS_LIFECYCLE_RECOVERY_CHECK,
      JOBS_SWEEPER_CHECK,
    ]);

    const allChecks = rules.flatMap((r) => r.checks);
    for (const check of allChecks) {
      expect(
        (JOBS_HEALTH_CHECK_NAMES as readonly string[]).includes(check),
        `a rule names the unknown check ${check}`,
      ).toBe(true);
    }
    const universe = [
      ...RELAY_TARGET_KINDS.jobs.checks,
      ...RELAY_TARGET_KINDS.portal.checks,
    ].sort();
    expect([...allChecks].sort()).toEqual(universe);
    expect(new Set(allChecks).size, "no check may belong to two rules").toBe(allChecks.length);
  });

  it("grade execution and missing evidence as errors, the slipping bounds as warnings", () => {
    const rules = checkRules();
    expect(rules.find((r) => r.name === "jobs-execution")!.severity).toBe("executionSeverity");
    for (const name of ["jobs-capacity", "jobs-cleanup", "jobs-lifecycle"]) {
      expect(rules.find((r) => r.name === name)!.severity).toBe("degradedSeverity");
    }
    expect(ALERTS).toMatch(/^param executionSeverity int = 1$/m);
    expect(ALERTS).toMatch(/^param unobservedSeverity int = 1$/m);
    expect(ALERTS).toMatch(/^param degradedSeverity int = 2$/m);
  });
});

describe("the KQL", () => {
  it("is body-aware only: it reads the stdout table, filters on a relay event, and never an HTTP signal", () => {
    // Every single-quoted var whose value has a KQL pipe — today exactly the
    // shared base and the two queries over it; a fourth fails here until this
    // test covers it.
    const kqlVars = [...ALERTS.matchAll(/^var (\w+) = '([^']*)'$/gm)]
      .filter(([, , value]) => value!.includes("|"))
      .map(([, name, value]) => ({ name: name!, value: value! }));
    expect(kqlVars.map((v) => v.name).sort()).toEqual([
      "latestChecks",
      "relayLines",
      "unobservedQuery",
    ]);

    // `${relayLines}` is the module's one shared base query, and the event
    // names ride their own vars: resolve both so each query is graded on the
    // text it will actually run.
    const base = kqlVars.find((v) => v.name === "relayLines")!.value;
    const resolve = (value: string): string =>
      value
        .replace("${relayLines}", base)
        .replace("${checkEvent}", RELAY_CHECK_EVENT)
        .replace("${observedEvent}", RELAY_OBSERVED_EVENT);

    for (const { name, value } of kqlVars) {
      const resolved = resolve(value);
      expect(resolved, `${name} must read the relay's stdout table`).toContain(
        "ContainerAppConsoleLogs_CL",
      );
      for (const token of FORBIDDEN_KQL_TOKENS) {
        expect(resolved, `${name} must not mention ${token}`).not.toMatch(new RegExp(token, "i"));
      }
    }

    // The base scopes to the relay's own container: the table holds every
    // platform container's JSON, and a line forged elsewhere with an `ok`
    // status must never become a reading.
    expect(base).toContain('ContainerName_s == "${relayContainerName}"');
    expect(
      relayResource(),
      "the KQL's container name must be the relay container's own name",
    ).toContain("name: relayContainerName");

    // The two rule queries each filter on exactly one of the relay's events.
    expect(resolve(alertsVar("latestChecks"))).toContain(
      `tostring(p.event) == "${RELAY_CHECK_EVENT}"`,
    );
    expect(resolve(alertsVar("unobservedQuery"))).toContain(
      `tostring(p.event) == "${RELAY_OBSERVED_EVENT}"`,
    );

    // The check rule composes the one base query — never a second copy of it.
    // `(.*)` captures to the line's last quote: the query embeds quoted check
    // names in its join(), so `[^']` would stop at the first one.
    const inlineQueries = [...ALERTS.matchAll(/query: '(.*)'/g)].map((m) => m[1]!);
    expect(inlineQueries, "only the check rules carry an inline query literal").toHaveLength(1);
    expect(inlineQueries[0]!.startsWith("${latestChecks} |")).toBe(true);
    for (const token of FORBIDDEN_KQL_TOKENS) {
      expect(inlineQueries[0], `the check query must not mention ${token}`).not.toMatch(
        new RegExp(token, "i"),
      );
    }
  });

  it("grades the latest reading per server and check, on anything but ok", () => {
    // arg_max by kind, target, check: the latest reading wins, so a check that
    // recovers inside the window stops matching on the next evaluation.
    expect(alertsVar("latestChecks")).toMatch(
      /arg_max\(TimeGenerated[^)]*\) by kind, target, check/,
    );

    const inlineQuery = ALERTS.match(/query: '(.*)'/)![1]!;
    expect(inlineQuery).toContain('| where status != "ok"');
    expect(inlineQuery, "the check filter must come from the rule's own checks list").toMatch(
      /where check in \(\$\{join\(map\(rule\.checks/,
    );
  });
});

describe("the missing-evidence rule", () => {
  it("reads an absent target as a row, and fires on any non-observed outcome or a missing check", () => {
    const query = alertsVar("unobservedQuery");
    expect(query).toContain("join kind=leftouter");

    const expectedTargets = ALERTS.match(/^var expectedTargets = (.*)$/m)![1]!;
    expect(expectedTargets, "the expected rows must come from the deployment's targets").toContain(
      "map(targets",
    );
    expect(expectedTargets).toContain('"${t.kind}", "${t.target}"');
    expect(query).toContain("datatable(kind: string, target: string) [${expectedTargets}]");

    expect(query).toContain('iff(isempty(outcome), "no_observation", outcome)');
    expect(query).toContain('where outcome != "observed" or missing != "[]"');
  });

  it("names every non-observed outcome in its description", () => {
    const block = ALERTS.match(
      /resource unobservedAlert 'Microsoft\.Insights\/scheduledQueryRules@[0-9-]+' = \{[\s\S]*?\n\}/,
    );
    expect(block, "alerts-jobs.bicep must declare the unobserved rule").not.toBeNull();
    const description = block![0]!.match(/description: '((?:[^'\\]|\\.)*)'/)![1]!;
    for (const word of [
      ...RELAY_OUTCOMES.filter((outcome) => outcome !== "observed"),
      "no_observation",
      "missing",
    ]) {
      expect(description, `the unobserved rule's description must name ${word}`).toContain(word);
    }
  });
});

describe("per-server alerts", () => {
  it("split every rule on target (and the check rules on check), with mitigation and notification wired", () => {
    const resources = [
      ...ALERTS.matchAll(
        /resource \w+ 'Microsoft\.Insights\/scheduledQueryRules@[0-9-]+' = [{[][\s\S]*?\n[\]}]/g,
      ),
    ].map((m) => m[0]!);
    expect(resources, "the module must have exactly the loop and the unobserved rule").toHaveLength(
      2,
    );
    const checkAlerts = resources.find((r) => r.startsWith("resource checkAlerts"))!;
    const unobserved = resources.find((r) => r.startsWith("resource unobservedAlert"))!;
    expect(checkAlerts, "the check rules must be one loop over checkRules").toMatch(
      /= \[\s*for rule in checkRules:/,
    );
    for (const resource of [checkAlerts, unobserved]) {
      expect(resource).toContain("{ name: 'target', operator: 'Include', values: ['*'] }");
      expect(resource).toContain("autoMitigate: true");
      expect(resource).toContain("actionGroups: actionGroupIds");
    }
    expect(checkAlerts).toContain("{ name: 'check', operator: 'Include', values: ['*'] }");
  });
});

describe("the docs inventory the alerts", () => {
  it("both docs list every rule, the module and the relay's two events", () => {
    const docs: Array<[string, string]> = [
      [read("docs/features/observability.md"), "docs/features/observability.md"],
      [read("infra/azure/README.md"), "infra/azure/README.md"],
    ];
    for (const [text, label] of docs) {
      for (const rule of [
        "jobs-execution",
        "jobs-capacity",
        "jobs-cleanup",
        "jobs-lifecycle",
        "jobs-unobserved",
      ]) {
        expect(text, `${label} must inventory the ${rule} rule`).toContain(rule);
      }
      expect(text, `${label} must inventory alerts-jobs.bicep`).toContain("alerts-jobs.bicep");
      expect(text, `${label} must document the relay's check event`).toContain(RELAY_CHECK_EVENT);
      expect(text, `${label} must document the relay's observed event`).toContain(
        RELAY_OBSERVED_EVENT,
      );
    }
  });
});
