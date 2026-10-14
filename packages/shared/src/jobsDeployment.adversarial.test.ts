/**
 * Adversarial probes of the deployment configuration aimed at what the fixture
 * corpus cannot express: an own `__proto__` key at each site this contract
 * composes the raw-input key screen (the corpus pins the map's top level
 * only), hostile documents whose parse must return a refusal verdict
 * rather than escape `safeParse` as a thrown TypeError, the agreement between
 * a validating parse and `resolveJobsCapacityLimits`, invariants the exported
 * entry schema must carry on its own, and the exported surfaces a consumer can
 * reach. Each test targets one named way the configuration could fail open or
 * crash instead of refusing.
 */

import { describe, expect, it } from "vitest";

import { JOBS_FETCH_QUALIFIED_TYPE } from "./jobs.js";
import {
  JOBS_CAPACITY_DEFAULTS,
  JobsCapacityOverridesSchema,
  JobsDeploymentConfigSchema,
  JobsServerEntrySchema,
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

describe("the raw-input key screen at the deployment's own composition sites", () => {
  it("an own __proto__ key in the limits override fails the parse instead of being shed", () => {
    // The limits and overrides schemas compose the screen directly around a
    // strict object — a refactor that drops that pipe sheds the key exactly
    // where the helper-built schemas' pins elsewhere stay green, and a shed
    // key here reads as untuned limits. Each body below is otherwise legal,
    // so the refusal is attributable to the screen.
    expect(JobsCapacityOverridesSchema.safeParse({ unfinishedPerAppEnv: 40 }).success).toBe(true);
    const override = JSON.parse('{"unfinishedPerAppEnv":40,"__proto__":{"polluted":true}}');
    expect(JobsCapacityOverridesSchema.safeParse(override).success).toBe(false);

    const document = {
      servers: { jobs: JobsServerEntrySchema.parse(servingEntry()) },
      limits: JSON.parse('{"__proto__":{"polluted":true}}'),
    };
    expect(JobsDeploymentConfigSchema.safeParse(document).success).toBe(false);
  });

  it("an own __proto__ key in a server entry and in its nested roots fails the parse too", () => {
    // Both objects build their own strict pipe: inlining either as a plain
    // z.strictObject sheds the key there — zod's strict check never sees it —
    // while every other pin stays green. Each body is otherwise valid, so the
    // refusal is attributable to the screen at that depth.
    const entry = JSON.parse(
      `{"__proto__":{"polluted":true},${JSON.stringify(servingEntry()).slice(1)}`,
    );
    expect(Object.getOwnPropertyNames(entry).includes("__proto__")).toBe(true);
    expect(JobsServerEntrySchema.safeParse(entry).success).toBe(false);

    const roots = {
      ...JSON.parse('{"__proto__":{"polluted":true}}'),
      ...ROOT,
    };
    expect(Object.getOwnPropertyNames(roots).includes("__proto__")).toBe(true);
    expect(JobsServerEntrySchema.safeParse(servingEntry({ roots })).success).toBe(false);
  });
});

describe("a hostile document draws a verdict, never a thrown error", () => {
  it("safeParse refuses every partially-parsed shape the map's cross-entry checks refine", () => {
    // The map's cross-entry checks run against whatever a failed parse hands
    // them, and a jobs deployment is parsed at boot: a TypeError escaping
    // safeParse would crash the boot instead of naming the misconfiguration.
    // Every hostile shape here must draw a verdict with success === false.
    const validSecondServer = servingEntry({
      server: "ml-jobs",
      types: [],
      databaseUrl: "postgresql://jobs@db.internal.helix/ml_jobs",
      roots: {
        edgeToJobs: "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=",
        jobsToEdge: "BQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
        portalToJobs: "BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY=",
      },
    });
    const entryWithoutRoots = servingEntry();
    delete entryWithoutRoots.roots;

    const hostileDocuments: ReadonlyArray<readonly [string, unknown]> = [
      [
        "an entry that is a string",
        { servers: { jobs: "https://jobs.internal.helix", "ml-jobs": validSecondServer } },
      ],
      ["an entry that is null", { servers: { jobs: null, "ml-jobs": validSecondServer } }],
      [
        "an entry missing its roots",
        { servers: { jobs: entryWithoutRoots, "ml-jobs": validSecondServer } },
      ],
      ["an entry whose roots are a string", { servers: { jobs: servingEntry({ roots: "nope" }) } }],
      ["a document that is null", null],
      ["a document that is a string", "not a configuration"],
      ["a document that is an array", [{ servers: {} }]],
      ["a document that is undefined", undefined],
      ["a map that is an array", { servers: [servingEntry()] }],
      ["a map that is a string", { servers: "jobs" }],
      ["a map that is a number", { servers: 42 }],
      ["a map that is null", { servers: null }],
      ["a limits field that is a number", { servers: { jobs: servingEntry() }, limits: 42 }],
      ["a limits field that is null", { servers: { jobs: servingEntry() }, limits: null }],
    ];
    for (const [name, document] of hostileDocuments) {
      let verdict: { success: boolean } | undefined;
      expect(() => {
        verdict = JobsDeploymentConfigSchema.safeParse(document);
      }, name).not.toThrow();
      expect(verdict?.success, name).toBe(false);
    }
  });

  it("the entry's own checks are total over its partial shapes too", () => {
    // The entry's relationship checks (types belong to this server, intake
    // stays closed on retirement) run against the partial output of an
    // already-failing parse as well — a partial entry must draw a refusal
    // verdict, never a TypeError from reading a field the parse never filled.
    const partialEntries: ReadonlyArray<readonly [string, unknown]> = [
      ["an empty object", {}],
      ["only the server id", { server: "jobs" }],
      ["only the installed types", { types: [] }],
      ["a non-string server id", { server: 42, types: [] }],
      ["a non-array types list", { server: "jobs", types: "jobs:fetch" }],
      // An array whose CONTENT fails the element schema is the shape the
      // types walk refines: if a zod upgrade ever ran refinements against
      // partial output, a non-string element reaching
      // `qualifiedTypeMatchesServer` would throw (`42.startsWith`) — the
      // verdict, not the guard, is what is pinned here.
      ["an array with a non-string element", { server: "jobs", types: [42] }],
      ["an array with valid and invalid elements", { server: "jobs", types: ["jobs:fetch", 42] }],
      ["null", null],
      ["a string", "jobs"],
      ["a number", 7],
    ];
    for (const [name, partial] of partialEntries) {
      let verdict: { success: boolean } | undefined;
      expect(() => {
        verdict = JobsServerEntrySchema.safeParse(partial);
      }, name).not.toThrow();
      expect(verdict?.success, name).toBe(false);
    }
  });
});

describe("the parse verdict and resolve agree", () => {
  it("an explicitly-undefined control parses clean and must not make resolve throw", () => {
    // The overrides schema keeps an explicitly-undefined control in its output
    // (the partial output preserves the key), so this document validates —
    // and resolve's contract is to accept the limits field of any validated
    // document. The merge must not turn that acceptance into a throw: either
    // the parse refuses the explicit undefined or resolve resolves to the
    // defaults. A document that parses while its own limits field crashes
    // resolve is the one forbidden split.
    const verdict = JobsDeploymentConfigSchema.safeParse({
      servers: {},
      limits: { unfinishedPerAppEnv: undefined },
    });
    if (verdict.success) {
      expect(resolveJobsCapacityLimits(verdict.data.limits)).toEqual(JOBS_CAPACITY_DEFAULTS);
    } else {
      expect(verdict.error.issues.length).toBeGreaterThan(0);
    }
  });

  it("an explicitly-null control is refused outright", () => {
    expect(JobsCapacityOverridesSchema.safeParse({ unfinishedPerAppEnv: null }).success).toBe(
      false,
    );
  });

  it("a hand-built override carrying an own __proto__ key throws instead of silently resolving", () => {
    // A merge written as a plain bracket write invokes the prototype setter
    // for the key "__proto__" instead of defining the key — the screen
    // downstream checks own names, so the hostile spelling would sail past
    // both the merge and the re-parse and resolve "successfully" on an input
    // whose every other spelling throws. The guard's promise is total:
    // whatever bypasses validation meets the complete schema here.
    const hostile = JSON.parse('{"unfinishedPerAppEnv":40,"__proto__":{"polluted":true}}');
    expect(Object.getOwnPropertyNames(hostile).includes("__proto__")).toBe(true);
    expect(() => resolveJobsCapacityLimits(hostile)).toThrow();
  });

  it("a hand-built override whose __proto__ key carries a primitive value throws too", () => {
    // The prototype setter silently ignores primitive values: no prototype
    // change, no own key, nothing for the re-parse to refuse. Under a
    // bracket-write merge the object-valued spelling would be caught only by
    // the accident that the setter installs inherited keys the parser then
    // reports as unrecognized — a primitive installs nothing. An own
    // __proto__ key is an unknown key whatever it carries, and an unknown key
    // throws.
    const hostile = JSON.parse('{"unfinishedPerAppEnv":40,"__proto__":40}');
    expect(Object.getOwnPropertyNames(hostile).includes("__proto__")).toBe(true);
    expect(() => resolveJobsCapacityLimits(hostile)).toThrow();
  });

  it("a hand-built override carrying a non-enumerable zero throws too", () => {
    // A merge iterating Object.entries sees own enumerable keys only, so a
    // non-enumerable own control would never reach the re-parse at all — the
    // zero is shed and the default silently stays in force. The guard's
    // promise is about what the override carries, not about how the property
    // is flagged: a zero in any spelling throws, never resolves.
    const hostile: Record<string, number> = {};
    Object.defineProperty(hostile, "unfinishedPerAppEnv", { value: 0, enumerable: false });
    expect(Object.getOwnPropertyNames(hostile)).toEqual(["unfinishedPerAppEnv"]);
    expect(() => resolveJobsCapacityLimits(hostile)).toThrow();
  });
});

describe("the entry's own custody of its roots", () => {
  it("an entry parsed standalone refuses a root shared between two of its own directions", () => {
    // The map's cross-entry walk refuses this shape in a full document (the
    // corpus pins it there), but the entry schema is exported for consumers
    // that validate one entry — a jobs service loading its own three roots —
    // and the roots' contract is "never shared". The refusal must not depend
    // on the entry traveling inside a whole-map parse.
    const entry = servingEntry({
      roots: {
        edgeToJobs: ROOT.edgeToJobs,
        jobsToEdge: ROOT.edgeToJobs,
        portalToJobs: ROOT.portalToJobs,
      },
    });
    expect(JobsServerEntrySchema.safeParse(entry).success).toBe(false);
  });
});

describe("the destination shape", () => {
  it("a private destination carrying embedded credentials is refused", () => {
    // The documented destination shape is scheme, host, optional port and path
    // prefix — no userinfo part. An operator pasting a credentialed URL must
    // draw a boot-time refusal, not a routing constant with a secret embedded
    // that every consumer then logs.
    for (const field of ["endpoint", "edgeProdCallbackUrl", "edgeDevCallbackUrl"] as const) {
      expect(
        JobsServerEntrySchema.safeParse(
          servingEntry({ [field]: "https://jobs:secret@internal.helix" }),
        ).success,
        field,
      ).toBe(false);
    }
  });
});

describe("the exported defaults are not a mutable shared", () => {
  it("a stray write to JOBS_CAPACITY_DEFAULTS cannot change what resolve returns", () => {
    // Any consumer reaches the exported object, and resolve reads it on every
    // call: one stray write — a test helper's shortcut, an import side effect
    // — must not silently retune the platform's capacity posture (a zero
    // write makes resolve throw outright). Freezing the object passes this
    // test too: the strict-mode write then refuses loudly and the defaults
    // stand.
    const design = { ...JOBS_CAPACITY_DEFAULTS };
    const saved = JOBS_CAPACITY_DEFAULTS.runningPerWorker;
    let written = false;
    try {
      (JOBS_CAPACITY_DEFAULTS as { runningPerWorker: number }).runningPerWorker = 0;
      written = true;
    } catch {
      // a frozen default refuses the write — the safe state this test pins
    }
    try {
      expect(resolveJobsCapacityLimits()).toEqual(design);
    } finally {
      if (written) {
        try {
          (JOBS_CAPACITY_DEFAULTS as { runningPerWorker: number }).runningPerWorker = saved;
        } catch {
          // frozen — nothing was changed, nothing to restore
        }
      }
    }
  });
});

describe("the merge guard is total over the override's shape", () => {
  it("a hand-built override that is an array or a string throws — its indices and length are not controls", () => {
    // A non-object override carries no tuning, but neither may it sail
    // through: the guard walks whatever the caller hands it, and an array's
    // indices and length, or a string's characters, must land where the
    // re-parse reports them as unknown keys — never dissolve into a
    // default-valued resolution that looks like "no tuning was asked for".
    expect(() => resolveJobsCapacityLimits([40] as never)).toThrow();
    expect(() => resolveJobsCapacityLimits("jobs" as never)).toThrow();
  });

  it("a zero hidden behind a getter is read and refused", () => {
    // The guard reads each control's VALUE per name; an accessor property is
    // one more way to carry a zero, and the refusal must not depend on the
    // zero sitting in a plain data property.
    const hostile = Object.create(null, {
      unfinishedPerAppEnv: { get: () => 0, enumerable: true },
    });
    expect(() => resolveJobsCapacityLimits(hostile as never)).toThrow();
  });

  it("the hostile-key refusal is the screen's verdict, not a crash", () => {
    // Any throw satisfies a .toThrow() pin, but the contract is a refusal
    // verdict naming the refused key — not a TypeError escaping from
    // somewhere downstream of the guard. The screen's message is the proof
    // the refusal came from the parse.
    expect(() => resolveJobsCapacityLimits(JSON.parse('{"__proto__":40}'))).toThrow(
      /own __proto__ key is rejected/,
    );
  });
});
