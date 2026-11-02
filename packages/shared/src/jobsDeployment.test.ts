import { describe, expect, it } from "vitest";

import { deriveJobsInstructionKey } from "./jobsSigning.js";
import { JOBS_SIGNING_VECTOR_ROOTS } from "./jobsSigningVectors.js";
import { JOB_TYPE_CATALOGUE, JOBS_FETCH_QUALIFIED_TYPE, isValidJobsRootSecret } from "./jobs.js";
import {
  JobsServerEntrySchema,
  JOBS_SERVER_STATES,
  JOBS_ROOT_DIRECTIONS,
  JOBS_CAPACITY_DEFAULTS,
  JOBS_CAPACITY_LIMIT_MAX,
  JobsCapacityLimitsSchema,
  JobsSubmissionOverridesSchema,
  JobsDeploymentConfigSchema,
  JobsCatalogueServersSchema,
  type JobsCapacityOverrides,
  type JobsDeploymentConfig,
  type JobsCatalogueServers,
  isJobsFullyDisabled,
  jobsCatalogueTypes,
  jobsCatalogueServers,
  advertisedJobTypes,
  unavailableJobTypeAdds,
  resolveJobsCapacityLimits,
} from "./jobsDeployment.js";

// The canonical base64 encodings of 32 bytes, distinct per direction — fixed
// public test literals, never real credentials.
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

function configOf(
  servers: Record<string, unknown>,
  limits?: Record<string, unknown>,
): Record<string, unknown> {
  return limits === undefined ? { servers } : { servers, limits };
}

const INITIAL_CONFIG: JobsDeploymentConfig = {
  servers: { jobs: JobsServerEntrySchema.parse(servingEntry()) },
};

describe("capacity defaults", () => {
  it("carries design §4's initial values, verbatim", () => {
    expect(JOBS_CAPACITY_DEFAULTS).toEqual({
      submissionAttemptsPerAppEnv: 10,
      submissionAttemptsDeployment: 100,
      submissionWindowSeconds: 60,
      unfinishedPerAppEnv: 20,
      unfinishedPerServer: 200,
      retainedPerAppEnv: 1_000,
      retainedPerServer: 10_000,
      runningPerAppEnv: 2,
      runningPerWorker: 8,
    });
  });

  it("resolve without overrides returns the defaults", () => {
    expect(resolveJobsCapacityLimits()).toEqual(JOBS_CAPACITY_DEFAULTS);
    expect(resolveJobsCapacityLimits(undefined)).toEqual(JOBS_CAPACITY_DEFAULTS);
  });

  it("resolve applies only the supplied overrides over the defaults", () => {
    const resolved = resolveJobsCapacityLimits({ unfinishedPerAppEnv: 40 });
    expect(resolved.unfinishedPerAppEnv).toBe(40);
    expect(resolved.unfinishedPerServer).toBe(JOBS_CAPACITY_DEFAULTS.unfinishedPerServer);
    expect(resolved.retainedPerServer).toBe(JOBS_CAPACITY_DEFAULTS.retainedPerServer);
    expect(resolved.runningPerAppEnv).toBe(JOBS_CAPACITY_DEFAULTS.runningPerAppEnv);
  });

  it("the override's cargo is its OWN properties — ambient values are not tuning", () => {
    // The merge walks own property names, so an inherited or symbol-keyed
    // control is not read as an override and the defaults stand — the same
    // own-key boundary every raw-input screen in this contract family draws
    // (the wire is JSON; string keys only). This pin keeps the boundary
    // deliberate: a merge rewritten over for…in would read the inherited
    // zero and throw, turning an ambient value into a boot error.
    const inherited = Object.create({ unfinishedPerAppEnv: 0 }) as JobsCapacityOverrides;
    expect(resolveJobsCapacityLimits(inherited).unfinishedPerAppEnv).toBe(
      JOBS_CAPACITY_DEFAULTS.unfinishedPerAppEnv,
    );
    const symbolKeyed = {} as JobsCapacityOverrides & Record<symbol, number>;
    symbolKeyed[Symbol("unfinishedPerAppEnv")] = 0;
    expect(resolveJobsCapacityLimits(symbolKeyed).unfinishedPerAppEnv).toBe(
      JOBS_CAPACITY_DEFAULTS.unfinishedPerAppEnv,
    );
  });

  it("an explicitly-undefined control leaves its default in force — per control, not all or nothing", () => {
    // An unset control passed through as undefined means what absence means:
    // the setting was not made. One unset control must never clobber its
    // default nor disable the overrides beside it — a spread-merge plants
    // the undefined and makes this resolve throw.
    expect(
      resolveJobsCapacityLimits({ unfinishedPerAppEnv: undefined, runningPerWorker: 4 }),
    ).toEqual({ ...JOBS_CAPACITY_DEFAULTS, runningPerWorker: 4 });
  });

  it("resolve refuses a zero, negative, non-integer or non-finite override", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity, -Infinity]) {
      expect(() => resolveJobsCapacityLimits({ unfinishedPerAppEnv: bad }), String(bad)).toThrow();
    }
  });

  it("resolve refuses the pair no worker can satisfy — a per-group running allowance above the per-process total", () => {
    // The two running controls are validated independently by the schema;
    // the contradiction is only visible to a seam that sees the pair
    // together. The resolver is the earliest such seam — every consumer's
    // limit set passes through it — so an unsatisfiable JOBS_LIMITS or
    // deployment map is a boot-time refusal, never a runtime retry loop
    // that can never converge. Equal limits stay resolvable (the boundary
    // is strictly-above).
    expect(() => resolveJobsCapacityLimits({ runningPerWorker: 2, runningPerAppEnv: 4 })).toThrow(
      /runningPerAppEnv.*runningPerWorker/s,
    );
    expect(resolveJobsCapacityLimits({ runningPerWorker: 2, runningPerAppEnv: 2 })).toBeTruthy();
  });

  it("resolve refuses a hand-built override past the ceiling — an unbounded limit bounds nothing", () => {
    expect(JOBS_CAPACITY_LIMIT_MAX).toBe(1_000_000);
    expect(JobsCapacityLimitsSchema.safeParse({ ...JOBS_CAPACITY_DEFAULTS }).success).toBe(true);
    expect(
      JobsCapacityLimitsSchema.safeParse({
        ...JOBS_CAPACITY_DEFAULTS,
        unfinishedPerAppEnv: JOBS_CAPACITY_LIMIT_MAX,
      }).success,
    ).toBe(true);
    expect(
      JobsCapacityLimitsSchema.safeParse({
        ...JOBS_CAPACITY_DEFAULTS,
        unfinishedPerAppEnv: JOBS_CAPACITY_LIMIT_MAX + 1,
      }).success,
    ).toBe(false);
    expect(() =>
      resolveJobsCapacityLimits({ unfinishedPerAppEnv: JOBS_CAPACITY_LIMIT_MAX + 1 }),
    ).toThrow();
  });

  it("the limits schema refuses unknown controls — a typo must not leave the default silently in force", () => {
    expect(
      JobsCapacityLimitsSchema.safeParse({ ...JOBS_CAPACITY_DEFAULTS, jobsPerDay: 500 }).success,
    ).toBe(false);
  });

  it("every control is finite, positive and whole, bounded by the ceiling", () => {
    // Each field of the control set applies the same limit schema; a control
    // wired to a looser schema (a float, zero, or past the ceiling) would slip
    // past a check on one field alone. The ceiling itself stays acceptable on
    // every control — the bound is where "unbounded" becomes decidable, not a
    // value below it.
    for (const control of Object.keys(JOBS_CAPACITY_DEFAULTS)) {
      for (const bad of [
        0,
        -1,
        1.5,
        Number.NaN,
        Infinity,
        -Infinity,
        JOBS_CAPACITY_LIMIT_MAX + 1,
      ]) {
        const attempt: Record<string, number> = { ...JOBS_CAPACITY_DEFAULTS };
        attempt[control] = bad;
        expect(
          JobsCapacityLimitsSchema.safeParse(attempt).success,
          `${control}=${String(bad)}`,
        ).toBe(false);
      }
      const atCeiling: Record<string, number> = { ...JOBS_CAPACITY_DEFAULTS };
      atCeiling[control] = JOBS_CAPACITY_LIMIT_MAX;
      expect(JobsCapacityLimitsSchema.safeParse(atCeiling).success, control).toBe(true);
    }
  });

  it("resolve accepts the limits override of a validated deployment", () => {
    const parsed = JobsDeploymentConfigSchema.parse(
      configOf({ jobs: servingEntry() }, { unfinishedPerAppEnv: 40, runningPerWorker: 4 }),
    );
    expect(resolveJobsCapacityLimits(parsed.limits)).toEqual({
      ...JOBS_CAPACITY_DEFAULTS,
      unfinishedPerAppEnv: 40,
      runningPerWorker: 4,
    });
  });
});

describe("JobsSubmissionOverridesSchema", () => {
  it("accepts each of the three controls the edge's submission throttle enforces", () => {
    expect(JobsSubmissionOverridesSchema.safeParse({}).success).toBe(true);
    expect(
      JobsSubmissionOverridesSchema.safeParse({ submissionAttemptsPerAppEnv: 5 }).success,
    ).toBe(true);
    expect(
      JobsSubmissionOverridesSchema.safeParse({ submissionAttemptsDeployment: 7 }).success,
    ).toBe(true);
    expect(JobsSubmissionOverridesSchema.safeParse({ submissionWindowSeconds: 30 }).success).toBe(
      true,
    );
  });

  it("refuses a jobs-owned control, an unknown key, and a hostile __proto__ key", () => {
    // The jobs service's own controls are tuned by JOBS_LIMITS on that service;
    // an override document naming one here is a mistake that must be visible.
    expect(JobsSubmissionOverridesSchema.safeParse({ unfinishedPerAppEnv: 40 }).success).toBe(
      false,
    );
    expect(JobsSubmissionOverridesSchema.safeParse({ jobsPerDay: 500 }).success).toBe(false);
    expect(JobsSubmissionOverridesSchema.safeParse(JSON.parse('{"__proto__":5}')).success).toBe(
      false,
    );
  });

  it("refuses zero, negative, non-integer, a string, and a value above the ceiling", () => {
    for (const bad of [0, -1, 1.5, "10"]) {
      expect(
        JobsSubmissionOverridesSchema.safeParse({ submissionAttemptsPerAppEnv: bad }).success,
        String(bad),
      ).toBe(false);
    }
    expect(
      JobsSubmissionOverridesSchema.safeParse({
        submissionAttemptsDeployment: JOBS_CAPACITY_LIMIT_MAX + 1,
      }).success,
    ).toBe(false);
    // The ceiling itself stays acceptable — the bound is where "unbounded"
    // becomes decidable, not a value below it.
    expect(
      JobsSubmissionOverridesSchema.safeParse({
        submissionAttemptsDeployment: JOBS_CAPACITY_LIMIT_MAX,
      }).success,
    ).toBe(true);
  });
});

describe("JobsServerEntrySchema", () => {
  it("parses the initial serving entry", () => {
    const entry = servingEntry();
    expect(JobsServerEntrySchema.parse(entry)).toEqual(entry);
  });

  it("every field is required — a partial entry is a boot error, never a defaulted one", () => {
    const entry = servingEntry();
    for (const key of Object.keys(entry)) {
      const absent = { ...entry };
      delete absent[key];
      expect(JobsServerEntrySchema.safeParse(absent).success, key).toBe(false);
    }
    for (const direction of JOBS_ROOT_DIRECTIONS) {
      const roots: Record<string, string> = { ...ROOT };
      delete roots[direction];
      expect(JobsServerEntrySchema.safeParse(servingEntry({ roots })).success, direction).toBe(
        false,
      );
    }
  });

  it("a serving entry may close intake without changing state", () => {
    expect(JobsServerEntrySchema.safeParse(servingEntry({ accepting: false })).success).toBe(true);
  });

  it("intake is a boolean — a string or number form is refused, never coerced", () => {
    // The field is wired to z.boolean(), and the refusal is the wiring: under
    // a coercing schema the string spelling would parse as `true`
    // (Boolean("false") is true), silently reopening the intake of a
    // temporarily throttled server — the same per-field wiring pin the state
    // vocabulary, the destinations and the roots each carry.
    for (const bad of ["false", "true", 1, 0, null]) {
      expect(
        JobsServerEntrySchema.safeParse(servingEntry({ accepting: bad })).success,
        String(bad),
      ).toBe(false);
    }
  });

  it("an entry refuses fields it does not carry — at its own level and inside roots", () => {
    // `strictWireObject` is the raw-input screen plus the strict catchall; the
    // screen's half is pinned adversarially, this holds the strict half at the
    // two nesting depths a hand-rolled rewrite could loosen. A shed field — an
    // operator's note, a fourth direction — is silent corruption of the
    // operator's intent, never a tolerated extension.
    expect(
      JobsServerEntrySchema.safeParse({ ...servingEntry(), operatorNotes: "hello" }).success,
    ).toBe(false);
    expect(
      JobsServerEntrySchema.safeParse(
        servingEntry({ roots: { ...ROOT, auditToJobs: ROOT.edgeToJobs } }),
      ).success,
    ).toBe(false);
  });

  it("retirement keeps routing data while intake is closed", () => {
    const retiring = servingEntry({ state: "retiring", accepting: false, types: [] });
    expect(JobsServerEntrySchema.parse(retiring)).toEqual(retiring);
  });

  it("a retiring server never admits new work", () => {
    expect(JobsServerEntrySchema.safeParse(servingEntry({ state: "retiring" })).success).toBe(
      false,
    );
  });

  it("an installed type must be qualified for this server", () => {
    expect(
      JobsServerEntrySchema.safeParse(servingEntry({ types: ["ml-jobs:generate-report"] })).success,
    ).toBe(false);
    expect(JobsServerEntrySchema.safeParse(servingEntry({ types: ["fetch"] })).success).toBe(false);
  });

  it("an installed type must be a production catalogue type — configuration cannot install synthetic actors", () => {
    expect(
      JobsServerEntrySchema.safeParse(servingEntry({ types: ["jobs:synthetic-actor"] })).success,
    ).toBe(false);
    expect(JOB_TYPE_CATALOGUE.some((t) => t.id === "jobs:synthetic-actor")).toBe(false);
  });

  it("the installed list is a set", () => {
    expect(
      JobsServerEntrySchema.safeParse(servingEntry({ types: ["jobs:fetch", "jobs:fetch"] }))
        .success,
    ).toBe(false);
  });

  it("an empty installed list is representable — a server can advertise nothing", () => {
    expect(JobsServerEntrySchema.safeParse(servingEntry({ types: [] })).success).toBe(true);
  });

  it("every private destination is an http(s) base URL without query or fragment — per field", () => {
    // The three destinations share one URL schema but are wired as separate
    // entry fields, so a loosening of one field's wiring passes a refusal
    // pinned on another field alone. Each field accepts its valid spelling
    // and refuses every non-base form.
    for (const field of ["endpoint", "edgeProdCallbackUrl", "edgeDevCallbackUrl"] as const) {
      const host = field === "endpoint" ? "jobs.internal.helix" : "edge.internal.helix";
      const valid = field === "endpoint" ? "http://localhost:8080" : `https://${host}`;
      expect(JobsServerEntrySchema.safeParse(servingEntry({ [field]: valid })).success, field).toBe(
        true,
      );
      for (const bad of [`ftp://${host}`, `https://${host}/?tls=1`, `https://${host}/#callback`]) {
        expect(
          JobsServerEntrySchema.safeParse(servingEntry({ [field]: bad })).success,
          `${field}=${bad}`,
        ).toBe(false);
      }
    }
  });

  it("an unparseable destination is refused by safeParse, never thrown out of it", () => {
    // zod runs every check in the chain even after its own URL check fails,
    // so a refine that parsed the raw value would throw out of `safeParse`
    // — a schema contract violation (parse refusals are verdicts, not
    // exceptions), and a boot error message that names nothing.
    for (const bad of ["not a url", "", "http://"]) {
      let verdict: ReturnType<typeof JobsServerEntrySchema.safeParse> | null = null;
      let threw: unknown = null;
      try {
        verdict = JobsServerEntrySchema.safeParse(servingEntry({ endpoint: bad }));
      } catch (error) {
        threw = error;
      }
      expect(threw, `endpoint=${JSON.stringify(bad)}`).toBeNull();
      expect(verdict?.success, `endpoint=${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("the private database is Postgres", () => {
    expect(
      JobsServerEntrySchema.safeParse(
        servingEntry({ databaseUrl: "postgres://jobs@db.internal/jobs" }),
      ).success,
    ).toBe(true);
    // Credentials are the database field's normal business — the destinations'
    // no-userinfo rule is about routing constants every consumer logs, not
    // the store URL the driver consumes. Refusing it here would break every
    // realistic deployment document.
    expect(
      JobsServerEntrySchema.safeParse(
        servingEntry({ databaseUrl: "postgresql://jobs:secret@db.internal.helix/jobs" }),
      ).success,
    ).toBe(true);
    // A query string is the driver's business (sslmode, pool sizing) — the
    // destinations' no-query rule must not be folded onto this field, or every
    // realistic database URL breaks.
    expect(
      JobsServerEntrySchema.safeParse(
        servingEntry({
          databaseUrl: "postgresql://jobs@db.internal.helix/jobs?sslmode=require",
        }),
      ).success,
    ).toBe(true);
    expect(
      JobsServerEntrySchema.safeParse(
        servingEntry({ databaseUrl: "mysql://jobs@db.internal/jobs" }),
      ).success,
    ).toBe(false);
  });

  it("a root must be the canonical base64 of 32 bytes — per direction", () => {
    // The three roots are wired as separate fields of the entry, so a root
    // the wrong shape must fail the parse whatever the other two hold — a
    // malformed root is a boot error, never a weaker key.
    for (const direction of JOBS_ROOT_DIRECTIONS) {
      const wrongLength: Record<string, string> = { ...ROOT, [direction]: "AQEBAQEBAQEBAQ==" };
      expect(
        JobsServerEntrySchema.safeParse(servingEntry({ roots: wrongLength })).success,
        direction,
      ).toBe(false);
    }
  });
});

describe("JobsDeploymentConfigSchema", () => {
  it("parses the initial deployment", () => {
    const config = configOf({ jobs: servingEntry() });
    expect(JobsDeploymentConfigSchema.parse(config)).toEqual(config);
  });

  it("an empty map is a valid fully disabled installation and carries no credentials", () => {
    const verdict = JobsDeploymentConfigSchema.safeParse({ servers: {} });
    expect(verdict.success).toBe(true);
    if (verdict.success) {
      expect(verdict.data.servers).toEqual({});
      expect(verdict.data.limits).toBeUndefined();
    }
  });

  it("the servers key is required — a malformed document is not a disabled installation", () => {
    // An absent map would read as fully disabled if the key were defaulted,
    // silently refusing every jobs operation for a typo'd operator document.
    // Fully disabled is the explicit `{ servers: {} }`, never an absent one.
    expect(JobsDeploymentConfigSchema.safeParse({}).success).toBe(false);
    expect(JobsDeploymentConfigSchema.safeParse({ limits: {} }).success).toBe(false);
  });

  it("an entry must agree with its map key", () => {
    expect(
      JobsDeploymentConfigSchema.safeParse(
        configOf({ jobs: servingEntry({ server: "ml-jobs", types: [] }) }),
      ).success,
    ).toBe(false);
  });

  it("no root repeats across servers", () => {
    const sharedAcrossServers = configOf({
      jobs: servingEntry(),
      "ml-jobs": servingEntry({
        server: "ml-jobs",
        types: [],
        databaseUrl: "postgresql://jobs@db.internal.helix/ml_jobs",
        roots: { ...ROOT },
      }),
    });
    expect(JobsDeploymentConfigSchema.safeParse(sharedAcrossServers).success).toBe(false);
    // The cross-server walk is keyed by the root's value, not its direction: a
    // root doing duty as one server's edge→jobs root and another's
    // jobs→edge root violates the same independently-generated custody, and
    // the entry-level check cannot catch it (each entry's own three roots are
    // distinct).
    const secondServer = servingEntry({
      server: "ml-jobs",
      types: [],
      databaseUrl: "postgresql://jobs@db.internal.helix/ml_jobs",
      roots: {
        edgeToJobs: "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=",
        jobsToEdge: ROOT.edgeToJobs,
        portalToJobs: "BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY=",
      },
    });
    expect(
      JobsDeploymentConfigSchema.safeParse(
        configOf({ jobs: servingEntry(), "ml-jobs": secondServer }),
      ).success,
    ).toBe(false);
    // The refusal is the shared root and nothing else: the same document with
    // an independent middle root is the valid two-server deployment.
    const independent = servingEntry({
      server: "ml-jobs",
      types: [],
      databaseUrl: "postgresql://jobs@db.internal.helix/ml_jobs",
      roots: {
        edgeToJobs: "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=",
        jobsToEdge: "BQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
        portalToJobs: "BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY=",
      },
    });
    expect(
      JobsDeploymentConfigSchema.safeParse(
        configOf({ jobs: servingEntry(), "ml-jobs": independent }),
      ).success,
    ).toBe(true);
  });

  it("no two servers share a private database", () => {
    const sharedDatabase = configOf({
      jobs: servingEntry(),
      "ml-jobs": servingEntry({
        server: "ml-jobs",
        types: [],
        roots: {
          edgeToJobs: "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=",
          jobsToEdge: "BQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
          portalToJobs: "BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY=",
        },
      }),
    });
    expect(JobsDeploymentConfigSchema.safeParse(sharedDatabase).success).toBe(false);
  });

  it("two servers with fully independent roots and databases parse", () => {
    const twoServers = configOf({
      jobs: servingEntry(),
      "ml-jobs": servingEntry({
        server: "ml-jobs",
        types: [],
        databaseUrl: "postgresql://jobs@db.internal.helix/ml_jobs",
        roots: {
          edgeToJobs: "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=",
          jobsToEdge: "BQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
          portalToJobs: "BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY=",
        },
      }),
    });
    expect(JobsDeploymentConfigSchema.parse(twoServers)).toEqual(twoServers);
  });

  it("the limits override is validated when present", () => {
    expect(
      JobsDeploymentConfigSchema.safeParse(
        configOf({ jobs: servingEntry() }, { unfinishedPerAppEnv: 0 }),
      ).success,
    ).toBe(false);
    expect(
      JobsDeploymentConfigSchema.safeParse(configOf({ jobs: servingEntry() }, { jobsPerDay: 500 }))
        .success,
    ).toBe(false);
    const tuned = JobsDeploymentConfigSchema.parse(
      configOf({ jobs: servingEntry() }, { unfinishedPerAppEnv: 40 }),
    );
    expect(tuned.limits).toEqual({ unfinishedPerAppEnv: 40 });
  });

  it("the map refuses unknown top-level fields and an own __proto__ key", () => {
    expect(
      JobsDeploymentConfigSchema.safeParse({ ...configOf({}), discoveryUrl: "https://x" }).success,
    ).toBe(false);
    expect(
      JobsDeploymentConfigSchema.safeParse(JSON.parse('{"servers":{"__proto__":{}}}')).success,
    ).toBe(false);
  });

  it("an invalid map key is a malformed map, not a server name to repair", () => {
    expect(
      JobsDeploymentConfigSchema.safeParse(configOf({ "My Jobs": servingEntry() })).success,
    ).toBe(false);
  });
});

describe("installation state", () => {
  it("the state vocabulary is serving and retiring — removal is what disabled is", () => {
    expect(JOBS_SERVER_STATES).toEqual(["serving", "retiring"]);
  });

  it("an out-of-vocabulary state fails the parse — a typo never parses clean", () => {
    // The vocabulary constant above pins the list; this pins the schema's
    // refusal of anything outside it. A state that parsed despite the typo
    // would silently withdraw a routable server from public discovery.
    // "disabled" is refused too — removing the entry is what disabled is.
    for (const state of ["servng", "disabled", "Serving", ""]) {
      expect(JobsServerEntrySchema.safeParse(servingEntry({ state })).success, state).toBe(false);
    }
  });

  it("fully disabled is exactly the empty map", () => {
    expect(isJobsFullyDisabled({ servers: {} })).toBe(true);
    expect(isJobsFullyDisabled(INITIAL_CONFIG)).toBe(false);
    const allRetiring: JobsDeploymentConfig = {
      servers: {
        jobs: JobsServerEntrySchema.parse(
          servingEntry({ state: "retiring", accepting: false, types: [] }),
        ),
      },
    };
    expect(isJobsFullyDisabled(allRetiring)).toBe(false);
  });
});

describe("public catalogue derivation", () => {
  it("advertises serving types with the catalogue's display names", () => {
    expect(jobsCatalogueTypes(INITIAL_CONFIG)).toEqual([
      { id: JOBS_FETCH_QUALIFIED_TYPE, displayName: JOB_TYPE_CATALOGUE[0]?.displayName },
    ]);
  });

  it("retiring types are withdrawn from discovery, saved grants aside", () => {
    const mixed: JobsDeploymentConfig = {
      servers: {
        jobs: JobsServerEntrySchema.parse(servingEntry({ state: "retiring", accepting: false })),
      },
    };
    expect(jobsCatalogueTypes(mixed)).toEqual([]);
  });

  it("a fully disabled installation advertises nothing at all", () => {
    expect(jobsCatalogueTypes({ servers: {} })).toEqual([]);
  });

  it("a serving server with intake closed stays in discovery — state governs, not intake", () => {
    // Closing intake throttles submissions only; discovery withdrawing the
    // type is retirement's act. A filter on `accepting` here would make a
    // temporarily throttled server invisible to new apps.
    const closedIntake: JobsDeploymentConfig = {
      servers: { jobs: JobsServerEntrySchema.parse(servingEntry({ accepting: false })) },
    };
    expect(jobsCatalogueTypes(closedIntake)).toEqual([
      { id: JOBS_FETCH_QUALIFIED_TYPE, displayName: JOB_TYPE_CATALOGUE[0]?.displayName },
    ]);
  });

  it("a map mid-retirement advertises the serving server and withdraws the retiring one", () => {
    // Withdrawal is per entry, not per map: one retiring server must not
    // blank the catalogue the serving ones still advertise.
    const mixed = JobsDeploymentConfigSchema.parse(
      configOf({
        jobs: servingEntry(),
        "ml-jobs": servingEntry({
          server: "ml-jobs",
          state: "retiring",
          accepting: false,
          types: [],
          databaseUrl: "postgresql://jobs@db.internal.helix/ml_jobs",
          roots: {
            edgeToJobs: "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=",
            jobsToEdge: "BQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
            portalToJobs: "BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY=",
          },
        }),
      }),
    );
    expect(jobsCatalogueTypes(mixed)).toEqual([
      { id: JOBS_FETCH_QUALIFIED_TYPE, displayName: JOB_TYPE_CATALOGUE[0]?.displayName },
    ]);
  });

  it("the public surface is the qualified id and display name only — never a destination or secret", () => {
    for (const entry of jobsCatalogueTypes(INITIAL_CONFIG)) {
      expect(Object.keys(entry).sort()).toEqual(["displayName", "id"]);
    }
  });

  it("a hand-built config bypassing the schema fails loudly instead of advertising an unimplemented type", () => {
    const forged = {
      servers: {
        jobs: { ...servingEntry(), types: ["jobs:synthetic-actor"] },
      },
    } as unknown as JobsDeploymentConfig;
    expect(() => jobsCatalogueTypes(forged)).toThrow(/not in the production catalogue/);
  });
});

describe("the credential-free catalogue projection", () => {
  /** One projection entry, overridable for the negative cases. */
  const projectionEntry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    state: "serving",
    types: [JOBS_FETCH_QUALIFIED_TYPE],
    ...overrides,
  });

  it("parses the serving deployment's projection and the empty (fully disabled) one", () => {
    const serving = { servers: { jobs: projectionEntry() } };
    expect(JobsCatalogueServersSchema.parse(serving)).toEqual(serving);
    expect(JobsCatalogueServersSchema.parse({ servers: {} })).toEqual({ servers: {} });
  });

  it("derives the projection from a full config — the public facts, credentials dropped", () => {
    const projected = jobsCatalogueServers(INITIAL_CONFIG);
    expect(projected).toEqual({
      servers: { jobs: { state: "serving", types: [JOBS_FETCH_QUALIFIED_TYPE] } },
    });
    // The derivation is the custody line: nothing credential-bearing survives it.
    const raw = JSON.stringify(projected);
    for (const credential of [
      "endpoint",
      "databaseUrl",
      "edgeProdCallbackUrl",
      "edgeDevCallbackUrl",
      "roots",
      "accepting",
    ]) {
      expect(raw).not.toContain(credential);
    }
  });

  it("the projection and the full map agree through the shared advertised derivation", () => {
    // The same type list whichever document the derivation runs from — the
    // one-derivation property that keeps a deployment's two documents from
    // drifting apart.
    expect(jobsCatalogueTypes(INITIAL_CONFIG)).toEqual(
      advertisedJobTypes(jobsCatalogueServers(INITIAL_CONFIG)),
    );
  });

  it("fully disabled is the same empty-map question for the projection", () => {
    expect(isJobsFullyDisabled({ servers: {} })).toBe(true);
    expect(isJobsFullyDisabled(jobsCatalogueServers(INITIAL_CONFIG))).toBe(false);
  });

  it("the projection refuses what the full map refuses for installed types", () => {
    for (const types of [
      ["jobs:synthetic-actor"], // outside the production catalogue
      ["ml-jobs:generate-report"], // another server's prefix
      ["jobs:fetch", "jobs:fetch"], // a repeated type
      ["fetch"], // bare — refused by the field schema
    ]) {
      expect(
        JobsCatalogueServersSchema.safeParse({ servers: { jobs: projectionEntry({ types }) } })
          .success,
        JSON.stringify(types),
      ).toBe(false);
    }
    // The refusal names the entry it landed on — the map key, then the type
    // list (the cross-server prefix case, whose document is otherwise valid).
    const verdict = JobsCatalogueServersSchema.safeParse({
      servers: { jobs: projectionEntry({ types: ["ml-jobs:generate-report"] }) },
    });
    expect(verdict.success).toBe(false);
    if (!verdict.success) {
      expect(verdict.error.issues[0]?.path).toEqual(["servers", "jobs", "types", 0]);
    }
  });

  it("the projection refuses credential fields — the strict parse is the custody line", () => {
    for (const leak of [
      { endpoint: "https://jobs.internal.helix" },
      { databaseUrl: "postgresql://jobs@db.internal.helix/jobs" },
      { roots: { ...ROOT } },
      { accepting: true },
      { server: "jobs" },
    ]) {
      expect(
        JobsCatalogueServersSchema.safeParse({ servers: { jobs: projectionEntry(leak) } }).success,
        Object.keys(leak).join(","),
      ).toBe(false);
    }
  });

  it("the projection refuses an own __proto__ key and unknown top-level fields", () => {
    expect(
      JobsCatalogueServersSchema.safeParse(JSON.parse('{"servers":{"__proto__":{}}}')).success,
    ).toBe(false);
    expect(
      JobsCatalogueServersSchema.safeParse({ servers: {}, discoveryUrl: "https://x" }).success,
    ).toBe(false);
  });

  it("an invalid map key is malformed, not a server name to repair", () => {
    expect(
      JobsCatalogueServersSchema.safeParse({ servers: { "My Jobs": projectionEntry() } }).success,
    ).toBe(false);
  });

  it("an out-of-vocabulary state fails the projection parse too", () => {
    expect(
      JobsCatalogueServersSchema.safeParse({
        servers: { jobs: projectionEntry({ state: "disabled" }) },
      }).success,
    ).toBe(false);
  });

  it("a hand-built projection bypassing the schema fails loudly instead of advertising an unimplemented type", () => {
    const forged = {
      servers: { jobs: { state: "serving", types: ["jobs:synthetic-actor"] } },
    } as unknown as JobsCatalogueServers;
    expect(() => advertisedJobTypes(forged)).toThrow(/not in the production catalogue/);
  });

  it("a retiring projection entry keeps its list but advertises nothing", () => {
    const retiring: JobsCatalogueServers = {
      servers: { jobs: { state: "retiring", types: [JOBS_FETCH_QUALIFIED_TYPE] } },
    };
    expect(JobsCatalogueServersSchema.parse(retiring)).toEqual(retiring);
    expect(advertisedJobTypes(retiring)).toEqual([]);
  });

  it("a projection parsed from a hostile raw shape still yields a typed map", () => {
    // `strictWireRecord` makes the safe form the available form: the parse of
    // a document whose keys arrive through the record boundary carries the
    // entries under their validated keys, and the advertised derivation reads
    // them from there.
    const parsed = JobsCatalogueServersSchema.parse({
      servers: { jobs: { state: "serving", types: [JOBS_FETCH_QUALIFIED_TYPE] } },
    });
    expect(advertisedJobTypes(parsed)).toEqual([
      { id: JOBS_FETCH_QUALIFIED_TYPE, displayName: JOB_TYPE_CATALOGUE[0]?.displayName },
    ]);
  });
});

describe("unavailableJobTypeAdds", () => {
  const advertised = ["jobs:fetch"];

  it("names a new type the deployment does not offer", () => {
    expect(
      unavailableJobTypeAdds({
        effectiveTypes: [],
        requestedTypes: ["jobs:fetch", "legacy:thing"],
        advertisedTypes: advertised,
      }),
    ).toEqual(["legacy:thing"]);
  });

  it("a saved withdrawn type is kept, not added — no violation, and it stays removable", () => {
    const effective = ["jobs:fetch", "legacy:thing"];
    // Surviving an unrelated save (requested still carries it):
    expect(
      unavailableJobTypeAdds({
        effectiveTypes: effective,
        requestedTypes: effective,
        advertisedTypes: advertised,
      }),
    ).toEqual([]);
    // Being removed (requested no longer carries it) is never a violation:
    expect(
      unavailableJobTypeAdds({
        effectiveTypes: effective,
        requestedTypes: ["jobs:fetch"],
        advertisedTypes: advertised,
      }),
    ).toEqual([]);
  });

  it("a withdrawn type may not be re-added after its removal", () => {
    expect(
      unavailableJobTypeAdds({
        effectiveTypes: ["jobs:fetch"],
        requestedTypes: ["jobs:fetch", "legacy:thing"],
        advertisedTypes: advertised,
      }),
    ).toEqual(["legacy:thing"]);
  });

  it("a fully disabled deployment offers nothing — every add is a violation", () => {
    expect(
      unavailableJobTypeAdds({
        effectiveTypes: [],
        requestedTypes: ["jobs:fetch"],
        advertisedTypes: [],
      }),
    ).toEqual(["jobs:fetch"]);
  });

  it("a repeated violation is reported once", () => {
    expect(
      unavailableJobTypeAdds({
        effectiveTypes: [],
        requestedTypes: ["legacy:thing", "legacy:thing"],
        advertisedTypes: advertised,
      }),
    ).toEqual(["legacy:thing"]);
  });
});

describe("the root-secret syntax is one rule", () => {
  it("the direction keys match the signing domains", async () => {
    const { JobsSigningDomains } = await import("./jobsSigning.js");
    expect([...JOBS_ROOT_DIRECTIONS]).toEqual(Object.keys(JobsSigningDomains));
  });

  it("an entry's roots carry exactly the shared directions — the cross-entry dedup sees every root", () => {
    // The map's no-repeat check walks `JOBS_ROOT_DIRECTIONS`; a root key the
    // entry schema carries but that list does not would be invisible to the
    // dedup and free to repeat across servers.
    const entry = JobsServerEntrySchema.parse(servingEntry());
    expect(Object.keys(entry.roots).sort()).toEqual([...JOBS_ROOT_DIRECTIONS].sort());
  });

  it("the predicate and the key derivation accept and refuse the same roots", () => {
    const vectorRoot = JOBS_SIGNING_VECTOR_ROOTS["edge-to-jobs.jobs"]?.root;
    if (!vectorRoot) throw new Error("the edge-to-jobs.jobs vector root is missing");
    const cases = [
      vectorRoot,
      ROOT.edgeToJobs,
      // 31 and 33 bytes
      Buffer.from(new Uint8Array(31).fill(1)).toString("base64"),
      Buffer.from(new Uint8Array(33).fill(1)).toString("base64"),
      // base64url is a different alphabet
      Buffer.from(new Uint8Array(32).fill(9)).toString("base64url"),
      // canonical bytes, whitespace-padded spelling
      `${ROOT.jobsToEdge.slice(0, 10)} ${ROOT.jobsToEdge.slice(11)}`,
      "",
      "not base64!!",
    ];
    for (const value of cases) {
      let derivationThrew = false;
      try {
        deriveJobsInstructionKey(value, "edgeToJobs");
      } catch {
        derivationThrew = true;
      }
      expect(isValidJobsRootSecret(value), value).toBe(!derivationThrew);
    }
  });

  it("accepts the canonical form and refuses non-canonical spellings of the same bytes", () => {
    expect(isValidJobsRootSecret(ROOT.portalToJobs)).toBe(true);
    // Unpadded and padded-differently spellings decode to the same bytes but
    // are not the one wire form.
    expect(isValidJobsRootSecret(ROOT.portalToJobs.replace(/=$/, ""))).toBe(false);
  });
});
