import { describe, expect, test } from "vitest";

import {
  JOB_TYPE_CATALOGUE,
  JOB_TYPE_DIAGNOSTIC_CATALOGUE,
  JOBS_DIAGNOSTIC_QUALIFIED_TYPE,
  JOBS_FETCH_QUALIFIED_TYPE,
  isDiagnosticJobType,
} from "./jobs.js";
import {
  JobsCatalogueServersSchema,
  JobsDeploymentConfigSchema,
  JobsNonProductionCatalogueServersSchema,
  JobsServerEntrySchema,
  advertisedJobTypes,
  type JobsCatalogueServers,
} from "./jobsDeployment.js";

/**
 * The fail-closed posture of the non-production diagnostic type: the
 * production catalogue never carries it, production schemas refuse it, and
 * the diagnostic catalogue admits exactly one exact spelling.
 */

// The canonical base64 encodings of 32 bytes, distinct per direction — the
// same fixed public test literals `jobsDeployment.test.ts` uses.
const ROOT = {
  edgeToJobs: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
  jobsToEdge: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
  portalToJobs: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=",
} as const;

function servingEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    server: "jobs",
    endpoint: "https://jobs.internal.helix",
    state: "serving",
    accepting: true,
    types: [JOBS_FETCH_QUALIFIED_TYPE],
    databaseUrl: "postgresql://jobs@db.internal.helix/jobs",
    edgeProdCallbackUrl: "https://edge.internal.helix",
    edgeDevCallbackUrl: "https://edge.internal.helix/dev",
    roots: { ...ROOT },
    ...overrides,
  };
}

function projectionOf(servers: Record<string, unknown>): Record<string, unknown> {
  return { servers };
}

describe("the diagnostic catalogue", () => {
  test("the production catalogue does not carry the diagnostic type", () => {
    expect(JOB_TYPE_CATALOGUE.some((entry) => entry.id === JOBS_DIAGNOSTIC_QUALIFIED_TYPE)).toBe(
      false,
    );
  });

  test("the diagnostic catalogue is frozen and carries exactly jobs:diagnostic", () => {
    expect(Object.isFrozen(JOB_TYPE_DIAGNOSTIC_CATALOGUE)).toBe(true);
    expect([...JOB_TYPE_DIAGNOSTIC_CATALOGUE]).toEqual([
      { id: "jobs:diagnostic", displayName: "Diagnostic job (non-production)" },
    ]);
    expect(Object.isFrozen(JOB_TYPE_DIAGNOSTIC_CATALOGUE[0])).toBe(true);
  });

  test("the production catalogue's entries and array are frozen too", () => {
    expect(Object.isFrozen(JOB_TYPE_CATALOGUE)).toBe(true);
    for (const entry of JOB_TYPE_CATALOGUE) expect(Object.isFrozen(entry)).toBe(true);
  });
});

describe("isDiagnosticJobType", () => {
  test("true only for the exact qualified spelling", () => {
    expect(isDiagnosticJobType("jobs:diagnostic")).toBe(true);
  });

  test("every other spelling is false — no prefix, case or whitespace leniency", () => {
    for (const not of [
      "jobs:Diagnostic",
      " jobs:diagnostic",
      "jobs:diagnostic ",
      "jobs:diagnostics",
      "jobs:diagnostic-x",
      "other:diagnostic",
      "jobs:synthetic",
      "jobs:fetch",
      "diagnostic",
      "",
    ]) {
      expect(isDiagnosticJobType(not), JSON.stringify(not)).toBe(false);
    }
  });
});

describe("the production schemas refuse the diagnostic type", () => {
  test("JobsCatalogueServersSchema refuses a diagnostic installed type and guessed names", () => {
    for (const types of [
      ["jobs:fetch", "jobs:diagnostic"],
      ["jobs:synthetic"],
      ["jobs:diagnostics"],
      ["jobs:synthetic-actor"],
    ]) {
      expect(
        JobsCatalogueServersSchema.safeParse(projectionOf({ jobs: { state: "serving", types } }))
          .success,
        JSON.stringify(types),
      ).toBe(false);
    }
  });

  test("JobsDeploymentConfigSchema refuses a diagnostic installed type", () => {
    const verdict = JobsDeploymentConfigSchema.safeParse({
      servers: { jobs: servingEntry({ types: [JOBS_FETCH_QUALIFIED_TYPE, "jobs:diagnostic"] }) },
    });
    expect(verdict.success).toBe(false);
  });
});

describe("JobsNonProductionCatalogueServersSchema", () => {
  test("accepts the diagnostic type alongside the production one", () => {
    const document = projectionOf({
      jobs: { state: "serving", types: [JOBS_FETCH_QUALIFIED_TYPE, "jobs:diagnostic"] },
    });
    expect(JobsNonProductionCatalogueServersSchema.parse(document)).toEqual(document);
  });

  test("still refuses guessed names", () => {
    for (const types of [["jobs:synthetic"], ["jobs:diagnostics"], ["jobs:synthetic-actor"]]) {
      expect(
        JobsNonProductionCatalogueServersSchema.safeParse(
          projectionOf({ jobs: { state: "serving", types } }),
        ).success,
        JSON.stringify(types),
      ).toBe(false);
    }
  });

  test("refuses the diagnostic spelling qualified for another server", () => {
    expect(
      JobsNonProductionCatalogueServersSchema.safeParse(
        projectionOf({ other: { state: "serving", types: ["other:diagnostic"] } }),
      ).success,
    ).toBe(false);
  });

  test("refuses duplicates, of the production type and of the diagnostic type", () => {
    for (const types of [
      ["jobs:fetch", "jobs:fetch"],
      ["jobs:diagnostic", "jobs:diagnostic"],
    ]) {
      expect(
        JobsNonProductionCatalogueServersSchema.safeParse(
          projectionOf({ jobs: { state: "serving", types } }),
        ).success,
        JSON.stringify(types),
      ).toBe(false);
    }
  });
});

describe("advertisedJobTypes", () => {
  test("without the option, a hand-built document carrying the diagnostic type throws", () => {
    const forged = {
      servers: { jobs: { state: "serving", types: ["jobs:diagnostic"] } },
    } as unknown as JobsCatalogueServers;
    expect(() => advertisedJobTypes(forged)).toThrow(/not in the production catalogue/);
  });

  test("with diagnostics, both installed types advertise with their display names", () => {
    const document: JobsCatalogueServers = {
      servers: {
        jobs: { state: "serving", types: [JOBS_FETCH_QUALIFIED_TYPE, "jobs:diagnostic"] },
      },
    };
    expect(advertisedJobTypes(document, { diagnostics: true })).toEqual([
      { id: JOBS_FETCH_QUALIFIED_TYPE, displayName: JOB_TYPE_CATALOGUE[0]?.displayName },
      { id: "jobs:diagnostic", displayName: "Diagnostic job (non-production)" },
    ]);
  });

  test("a retiring server advertises nothing, diagnostics or not", () => {
    const retiring: JobsCatalogueServers = {
      servers: { jobs: { state: "retiring", types: ["jobs:diagnostic"] } },
    };
    expect(JobsNonProductionCatalogueServersSchema.parse(retiring)).toEqual(retiring);
    expect(advertisedJobTypes(retiring, { diagnostics: true })).toEqual([]);
  });

  test("with diagnostics, a hand-built unknown type still throws", () => {
    const forged = {
      servers: { jobs: { state: "serving", types: ["jobs:synthetic"] } },
    } as unknown as JobsCatalogueServers;
    expect(() => advertisedJobTypes(forged, { diagnostics: true })).toThrow(
      /not in the production catalogue/,
    );
  });
});

describe("the diagnostic type is a well-formed qualified type", () => {
  test("the full entry schema accepts a server entry installing it only under the non-production rule", () => {
    // The FULL map schema always screens against the production catalogue —
    // only the credential-free non-production projection accepts the type.
    expect(
      JobsServerEntrySchema.safeParse(servingEntry({ types: ["jobs:diagnostic"] })).success,
    ).toBe(false);
  });
});
