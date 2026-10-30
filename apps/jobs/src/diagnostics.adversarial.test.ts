import { describe, expect, test } from "vitest";

import {
  JOB_TYPE_DIAGNOSTIC_CATALOGUE,
  JOBS_DIAGNOSTIC_QUALIFIED_TYPE,
  JOBS_FETCH_QUALIFIED_TYPE,
} from "@azx-pbc/shared";

import { loadJobsConfig } from "./config.js";
import {
  DiagnosticJobInputSchema,
  JOBS_DIAGNOSTIC_TYPE_POLICY,
  jobsInstalledTypePolicies,
} from "./diagnostics.js";
import { JobsHandlerRegistry } from "./execution.js";
import {
  JOBS_DEADLINE_SECONDS as PLATFORM_DEADLINE,
  JOBS_TYPE_POLICIES,
  type JobsTypePolicies,
  type JobsTypePolicy,
  jobTypePolicy,
  jobsAbsoluteDeadline,
  screenTypePolicies,
} from "./policy.js";

/**
 * The diagnostic type's fail-closed posture: the production policy set never
 * carries it, nothing but an explicitly composed non-production set can
 * register or dispatch it, guessed spellings stay unrepresentable, and the
 * config loader refuses to enable it in production.
 */

// The same complete valid env `config.test.ts` builds — rebuilt here because
// that helper is the file's own fixture.
const ROOT_EDGE = "uFEfLTTVeHJK0+P/dQEWv8ccOyFrkZw7InR0I52V4/0=";
const ROOT_PORTAL = "jUwQKa33JNljh0jULeithrh3JOL8dUmxPJknzGCjQBA=";
const ROOT_CALLBACK = "gDZ5bWRVuYC58CVmc4rXPjvCzEtuoQZ4Hn0v2UXPUaU=";

const VALID = {
  JOBS_SERVER_ID: "jobs",
  JOBS_DATABASE_URL: "postgresql://helix_jobs:pw@db:5432/helix_jobs",
  JOBS_ACCEPTING: "true",
  JOBS_EDGE_TO_JOBS_SECRET: ROOT_EDGE,
  JOBS_PORTAL_TO_JOBS_SECRET: ROOT_PORTAL,
  JOBS_JOBS_TO_EDGE_SECRET: ROOT_CALLBACK,
  JOBS_EDGE_PROD_URL: "https://edge.internal.helix",
  JOBS_EDGE_DEV_URL: "https://edge.dev.internal.helix/",
} as const;

describe("the installed policy sets", () => {
  test("the production set has no diagnostic key", () => {
    expect(JOBS_DIAGNOSTIC_QUALIFIED_TYPE in JOBS_TYPE_POLICIES).toBe(false);
    expect(Object.keys(JOBS_TYPE_POLICIES)).toEqual([JOBS_FETCH_QUALIFIED_TYPE]);
  });

  test("diagnostics off composes the production set itself", () => {
    expect(jobsInstalledTypePolicies({ diagnostics: false })).toBe(JOBS_TYPE_POLICIES);
  });

  test("diagnostics on adds exactly the diagnostic policy — never by mutating the production set", () => {
    const installed = jobsInstalledTypePolicies({ diagnostics: true });
    expect(Object.keys(installed)).toEqual([
      JOBS_FETCH_QUALIFIED_TYPE,
      JOBS_DIAGNOSTIC_QUALIFIED_TYPE,
    ]);
    const diagnostic = installed[JOBS_DIAGNOSTIC_QUALIFIED_TYPE];
    if (!diagnostic) throw new Error("the diagnostic policy is not installed");
    expect(diagnostic.retryLimit).toBe(2);
    expect(diagnostic.deadlineSeconds).toBe(300);
    expect(diagnostic.expireInSeconds).toBe(60);
    expect(diagnostic.inputSchema).toBe(DiagnosticJobInputSchema);
    // The production set is untouched.
    expect(JOBS_DIAGNOSTIC_QUALIFIED_TYPE in JOBS_TYPE_POLICIES).toBe(false);
  });

  test("the composed set and its policies refuse writes", () => {
    const installed = jobsInstalledTypePolicies({ diagnostics: true });
    expect(Object.isFrozen(installed)).toBe(true);
    expect(() => {
      (installed as Record<string, JobsTypePolicy>)["jobs:ghost"] = {
        retryLimit: 0,
        expireInSeconds: 1,
        deadlineSeconds: 1,
        inputSchema: DiagnosticJobInputSchema,
      };
    }).toThrow();
    const diagnostic = installed[JOBS_DIAGNOSTIC_QUALIFIED_TYPE];
    if (!diagnostic) throw new Error("the diagnostic policy is not installed");
    expect(Object.isFrozen(diagnostic)).toBe(true);
    expect(() => {
      (diagnostic as { retryLimit: number }).retryLimit = 99;
    }).toThrow();
    expect(installed[JOBS_DIAGNOSTIC_QUALIFIED_TYPE]?.retryLimit).toBe(2);
  });
});

describe("the handler registry's screening", () => {
  const handler = async () => null;

  test("the default (production) registry refuses the diagnostic type", () => {
    const handlers = new JobsHandlerRegistry();
    expect(() => handlers.register(JOBS_DIAGNOSTIC_QUALIFIED_TYPE, handler)).toThrow(
      /no execution policy is installed/,
    );
    expect(handlers.handler(JOBS_DIAGNOSTIC_QUALIFIED_TYPE)).toBeUndefined();
  });

  test("even the diagnostic registry refuses every guessed spelling", () => {
    const handlers = new JobsHandlerRegistry(jobsInstalledTypePolicies({ diagnostics: true }));
    for (const guess of [
      "jobs:synthetic",
      "jobs:diagnostics",
      "jobs:Diagnostic",
      "jobs:diagnostic ",
    ]) {
      expect(() => handlers.register(guess, handler), JSON.stringify(guess)).toThrow(
        /no execution policy is installed/,
      );
      expect(handlers.handler(guess)).toBeUndefined();
    }
  });

  test("the diagnostic registry registers the exact type and dispatch resolves it", () => {
    const handlers = new JobsHandlerRegistry(jobsInstalledTypePolicies({ diagnostics: true }));
    handlers.register(JOBS_DIAGNOSTIC_QUALIFIED_TYPE, handler);
    expect(handlers.handler(JOBS_DIAGNOSTIC_QUALIFIED_TYPE)).toBe(handler);
  });
});

describe("the policy lookups under the default set", () => {
  test("jobTypePolicy refuses the diagnostic type; jobsAbsoluteDeadline falls back to the platform default", () => {
    expect(() => jobTypePolicy(JOBS_DIAGNOSTIC_QUALIFIED_TYPE)).toThrow(
      `no execution policy is installed for job type "${JOBS_DIAGNOSTIC_QUALIFIED_TYPE}"`,
    );
    expect(jobsAbsoluteDeadline(JOBS_DIAGNOSTIC_QUALIFIED_TYPE)).toBe(PLATFORM_DEADLINE);
  });

  test("with the diagnostic set, the deadline is the diagnostic policy's", () => {
    const installed = jobsInstalledTypePolicies({ diagnostics: true });
    expect(jobsAbsoluteDeadline(JOBS_DIAGNOSTIC_QUALIFIED_TYPE, installed)).toBe(300);
    expect(jobsAbsoluteDeadline(JOBS_FETCH_QUALIFIED_TYPE, installed)).toBe(300);
  });

  test("the production catalogue's screen refuses a diagnostic policy", () => {
    expect(() =>
      screenTypePolicies({
        [JOBS_FETCH_QUALIFIED_TYPE]: JOBS_TYPE_POLICIES[
          JOBS_FETCH_QUALIFIED_TYPE
        ] as JobsTypePolicy,
        [JOBS_DIAGNOSTIC_QUALIFIED_TYPE]: JOBS_DIAGNOSTIC_TYPE_POLICY,
      }),
    ).toThrow(
      `an execution policy is installed for non-catalogue type "${JOBS_DIAGNOSTIC_QUALIFIED_TYPE}"`,
    );
  });
});

describe("the config knob's production refusal", () => {
  test("JOBS_DIAGNOSTICS=true in production is a boot error naming the key and production", () => {
    expect(() =>
      loadJobsConfig({ ...VALID, NODE_ENV: "production", JOBS_DIAGNOSTICS: "true" }),
    ).toThrow(/JOBS_DIAGNOSTICS cannot be enabled in production/);
  });

  test("production without the knob resolves diagnostics off", () => {
    expect(loadJobsConfig({ ...VALID, NODE_ENV: "production" }).diagnostics).toBe(false);
    expect(
      loadJobsConfig({ ...VALID, NODE_ENV: "production", JOBS_DIAGNOSTICS: "false" }).diagnostics,
    ).toBe(false);
  });
});

describe("the diagnostic catalogue is the only non-production extension", () => {
  test("the installed-policy screen accepts exactly the union catalogue", () => {
    // The composed screen runs against production + diagnostic; the diagnostic
    // policy passes it, and nothing else does.
    const installed = jobsInstalledTypePolicies({ diagnostics: true });
    expect(Object.keys(installed).sort()).toEqual(
      [JOBS_FETCH_QUALIFIED_TYPE, JOBS_DIAGNOSTIC_QUALIFIED_TYPE].sort(),
    );
    expect(JOB_TYPE_DIAGNOSTIC_CATALOGUE.map((entry) => entry.id)).toEqual([
      JOBS_DIAGNOSTIC_QUALIFIED_TYPE,
    ]);
  });

  test("the composed set's type guard agrees — the deadline lookup and the policy lookup answer together", () => {
    const installed: JobsTypePolicies = jobsInstalledTypePolicies({ diagnostics: true });
    expect(jobTypePolicy(JOBS_DIAGNOSTIC_QUALIFIED_TYPE, installed).expireInSeconds).toBe(60);
    expect(PLATFORM_DEADLINE).toBe(3_600);
  });
});
