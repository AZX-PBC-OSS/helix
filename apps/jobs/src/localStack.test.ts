import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  JobsDeploymentConfigSchema,
  JOBS_CAPACITY_DEFAULTS,
  JOBS_DIAGNOSTIC_QUALIFIED_TYPE,
  advertisedJobTypes,
  jobsCatalogueServers,
} from "@azx-pbc/shared";

import { loadEdgeJobsConfig } from "../../edge/src/config.js";
import {
  assertDeliveryTargetsMatch,
  assertDeploymentConfig,
  resolveJobsCatalogueServers,
  resolvePortalJobsDeliveryConfig,
} from "../../portal/src/deployment.js";
import { loadJobsConfig } from "./config.js";

/**
 * The local stack's jobs configuration propagation, against the real artifacts.
 *
 * `scripts/stack-env.mjs` is what a developer (and the run-helix smoke driver)
 * actually runs to resolve a stack; the per-service documents it mints are this
 * repo's jobs deployment map for local work. The suites that pin each loader's
 * refusals live beside the loaders; what nothing else proves is the composition:
 * that the script's actual `--env` output — parsed the way a shell exports it —
 * boots every consumer's REAL config loader, carries only each consumer's
 * permitted subset (the custody matrix), agrees on the derived keys across
 * services, and moves the jobs port and private database with the stack.
 */

const STACK_ENV_SCRIPT = fileURLToPath(new URL("../../../scripts/stack-env.mjs", import.meta.url));

/** The base-domain URL the minted roots sign against (the resolved stack's edge base). */
const BASE_DOMAIN = "local.helix.azxlabs.io";
const OFFSET = 1000;
const SUFFIX = "stacktest";

/**
 * A scrubbed child environment: only what the script's resolution may read.
 * Every jobs key, the stack selectors and the base domain are pinned here so an
 * ambient developer setting (a HELIX_STACK_SUFFIX, a developer's
 * JOBS_DATABASE_URL, a non-default EDGE_BASE_DOMAIN) cannot silently satisfy or
 * skew a leg's premise — the same hermeticity discipline the boot suites use.
 */
const CHILD_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  DATABASE_URL: "postgresql://helix:helix@db:5432/helix",
  EDGE_BASE_DOMAIN: BASE_DOMAIN,
};

/** Run the real script the way a shell does and split its `KEY=value` output. */
function stackEnv(args: string[], env: NodeJS.ProcessEnv = CHILD_ENV): Record<string, string> {
  const stdout = execFileSync(process.execPath, [STACK_ENV_SCRIPT, ...args], {
    encoding: "utf8",
    env,
  });
  const parsed: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const eq = line.indexOf("=");
    // A JSON document value carries `=` inside itself; the key ends at the first.
    parsed[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return parsed;
}

const JOBS_KEYS = [
  "JOBS_PORT",
  "JOBS_DATABASE_URL",
  "JOBS_SERVER_ID",
  "JOBS_ACCEPTING",
  "JOBS_EDGE_TO_JOBS_SECRET",
  "JOBS_PORTAL_TO_JOBS_SECRET",
  "JOBS_JOBS_TO_EDGE_SECRET",
  "JOBS_EDGE_PROD_URL",
  "JOBS_EDGE_DEV_URL",
  "EDGE_JOBS_CONFIG",
  "PORTAL_JOBS_CONFIG",
  "PORTAL_JOBS_CATALOGUE",
];

describe("the local stack's jobs plane (scripts/stack-env.mjs)", () => {
  const minted = stackEnv(["--env", "--offset", String(OFFSET), "--suffix", SUFFIX]);
  const edgeDoc = JSON.parse(minted.EDGE_JOBS_CONFIG ?? "null") as {
    servers: Record<string, { endpoint: string; edgeToJobsRoot: string; jobsToEdgeRoot: string }>;
  };
  const portalDoc = JSON.parse(minted.PORTAL_JOBS_CONFIG ?? "null") as {
    servers: Record<string, { endpoint: string; portalToJobsRoot: string }>;
  };
  const catalogueDoc = JSON.parse(minted.PORTAL_JOBS_CATALOGUE ?? "null") as {
    servers: Record<string, { state: string; types: string[] }>;
  };

  it("boots every consumer's real configuration loader", () => {
    // The edge's (and the dev-gateway's) forwarding config parses whole —
    // endpoint shape, both roots canonical, keys derived at load.
    const edge = loadEdgeJobsConfig(minted);
    expect(Object.keys(edge.servers)).toEqual(["jobs"]);
    expect(edge.servers.jobs?.endpoint).toBe(`http://localhost:${3003 + OFFSET}`);

    // The portal's delivery config parses whole and matches its catalogue.
    const delivery = resolvePortalJobsDeliveryConfig(minted);
    const catalogue = resolveJobsCatalogueServers(minted);
    expect(delivery?.get("jobs")?.endpoint).toBe(`http://localhost:${3003 + OFFSET}`);
    assertDeliveryTargetsMatch(catalogue, delivery ?? null);

    // The portal's full deployment boot check passes on the minted stack env —
    // the projection and the delivery document name the same server set.
    expect(() => assertDeploymentConfig(minted)).not.toThrow();

    // The jobs service's own boot accepts its env — identity, private store,
    // three roots, both callback destinations.
    const jobs = loadJobsConfig(minted);
    expect(jobs.serverId).toBe("jobs");
    expect(jobs.accepting).toBe(true);
    expect(new URL(jobs.databaseUrl).pathname).toBe(`/helix_jobs_${SUFFIX}`);
    expect(jobs.edgeProdCallbackUrl).toBe(`https://${BASE_DOMAIN}:${8080 + OFFSET}`);
    expect(jobs.edgeDevCallbackUrl).toBe(`https://${BASE_DOMAIN}:${8082 + OFFSET}`);
  });

  it("derives the same key on both ends of every signed hop", () => {
    const edge = loadEdgeJobsConfig(minted);
    const portalDelivery = resolvePortalJobsDeliveryConfig(minted);
    const jobs = loadJobsConfig(minted);

    // edge→jobs: the edge mints forwards with the key the jobs service verifies.
    expect(edge.servers.jobs?.edgeToJobsKey).toEqual(jobs.edgeToJobsKey);
    // jobs→edge: the service mints its fetch callbacks with the key the edge verifies.
    expect(edge.servers.jobs?.jobsToEdgeKey).toEqual(jobs.jobsToEdgeKey);
    // portal→jobs: the portal mints lifecycle deliveries with the key the service verifies.
    expect(portalDelivery?.get("jobs")?.portalToJobsKey).toEqual(jobs.portalToJobsKey);
  });

  it("carries only each consumer's permitted subset — no credential crosses custody", () => {
    // The edge's document: two roots, no portal root, no database URL — the
    // strict parse would refuse a leak, and the minted document must not need
    // that refusal.
    expect(edgeDoc.servers.jobs).toEqual({
      endpoint: expect.any(String),
      edgeToJobsRoot: expect.any(String),
      jobsToEdgeRoot: expect.any(String),
    });
    // The portal's document: its one root and the endpoint, nothing else.
    expect(portalDoc.servers.jobs).toEqual({
      endpoint: expect.any(String),
      portalToJobsRoot: expect.any(String),
    });
    // The catalogue projection: state and types only.
    expect(catalogueDoc).toEqual({
      servers: { jobs: { state: "serving", types: ["jobs:fetch"] } },
    });
    // No database credential reaches any document: the private store's name
    // appears only in the jobs service's own DSN.
    const databaseName = `helix_jobs_${SUFFIX}`;
    for (const doc of [
      minted.EDGE_JOBS_CONFIG,
      minted.PORTAL_JOBS_CONFIG,
      minted.PORTAL_JOBS_CATALOGUE,
    ]) {
      expect(doc).not.toContain(databaseName);
      expect(doc).not.toContain("helix_jobs_migrate");
    }
    // Each root exists in exactly the documents its direction's custody allows:
    // the portal root never reaches the edge's document and vice versa.
    const edgeToJobs = minted.JOBS_EDGE_TO_JOBS_SECRET;
    const jobsToEdge = minted.JOBS_JOBS_TO_EDGE_SECRET;
    const portalToJobs = minted.JOBS_PORTAL_TO_JOBS_SECRET;
    expect(portalDoc.servers.jobs?.portalToJobsRoot).toBe(portalToJobs);
    expect(minted.EDGE_JOBS_CONFIG).not.toContain(portalToJobs);
    expect(minted.PORTAL_JOBS_CONFIG).not.toContain(edgeToJobs);
    expect(minted.PORTAL_JOBS_CONFIG).not.toContain(jobsToEdge);
  });

  it("the three direction roots are distinct secrets", () => {
    const roots = [
      minted.JOBS_EDGE_TO_JOBS_SECRET,
      minted.JOBS_JOBS_TO_EDGE_SECRET,
      minted.JOBS_PORTAL_TO_JOBS_SECRET,
    ];
    expect(new Set(roots).size).toBe(3);
    for (const root of roots) {
      expect(root).toMatch(/^[A-Za-z0-9+/]{43}=$/); // canonical base64 of 32 bytes
    }
  });

  it("the catalogue projection is the shared derivation over the same map", () => {
    // Rebuild the one local deployment map from the minted pieces and pin the
    // emitted projection to `jobsCatalogueServers`'s output for it — the two
    // documents cannot disagree about which servers exist or what they installed.
    const fullConfig = JobsDeploymentConfigSchema.parse({
      servers: {
        jobs: {
          server: "jobs",
          endpoint: edgeDoc.servers.jobs?.endpoint,
          state: catalogueDoc.servers.jobs?.state,
          accepting: minted.JOBS_ACCEPTING === "true",
          types: ["jobs:fetch"],
          databaseUrl: minted.JOBS_DATABASE_URL,
          edgeProdCallbackUrl: minted.JOBS_EDGE_PROD_URL,
          edgeDevCallbackUrl: minted.JOBS_EDGE_DEV_URL,
          roots: {
            edgeToJobs: minted.JOBS_EDGE_TO_JOBS_SECRET,
            jobsToEdge: minted.JOBS_JOBS_TO_EDGE_SECRET,
            portalToJobs: minted.JOBS_PORTAL_TO_JOBS_SECRET,
          },
        },
      },
    });
    expect(catalogueDoc).toEqual(jobsCatalogueServers(fullConfig));
  });

  it("moves the jobs port and private database with the stack — and the stack-level env is complete", () => {
    expect(minted.JOBS_PORT).toBe(String(3003 + OFFSET));
    // The runtime DSN is the least-privilege runtime role — never the owner,
    // never the migration identity.
    const dsn = new URL(minted.JOBS_DATABASE_URL ?? "");
    expect(dsn.username).toBe("helix_jobs");
    expect(dsn.pathname).toBe(`/helix_jobs_${SUFFIX}`);
    // The migration identity's DSN is never part of a stack's runtime env.
    for (const key of Object.keys(minted)) {
      expect(key).not.toBe("JOBS_MIGRATE_DATABASE_URL");
    }
    // The resolved env is authoritative: the services skip their
    // developer-local override files under it, so an offset stack cannot boot
    // cross-wired into the developer's own credentials.
    expect(minted.HELIX_STACK_ENV).toBe("1");
    // The services' half of the IdP wire: the offset edge and portal point at
    // THIS stack's IdP — the same port the minted redirect URIs allowlist —
    // not at the dev stack's :3002 issuer, which would refuse every offset
    // callback (and fail discovery when the dev IdP is not running).
    expect(minted.EDGE_OIDC_ISSUER).toBe(`http://localhost:${3002 + OFFSET}`);
    expect(minted.PORTAL_OIDC_ISSUER).toBe(minted.EDGE_OIDC_ISSUER);
    // Every internal hop between the planes targets this stack's own ports.
    expect(minted.EDGE_EGRESS_URL).toBe(`http://localhost:${8081 + OFFSET}`);
    expect(minted.EDGE_PORTAL_URL).toBe(`http://localhost:${3001 + OFFSET}`);
    expect(minted.PORTAL_EGRESS_URL).toBe(minted.EDGE_EGRESS_URL);
  });

  it("a typo'd HELIX_JOBS_ENABLED fails the resolution loudly, naming the value", () => {
    expect(() =>
      stackEnv(["--env", "--offset", String(OFFSET), "--suffix", SUFFIX], {
        ...CHILD_ENV,
        HELIX_JOBS_ENABLED: "maybe",
      }),
    ).toThrow(/HELIX_JOBS_ENABLED must be 1\/true or 0\/false — got "maybe"/);
  });

  it("a retiring stack withdraws the catalogue and closes intake, keeping routing and delivery", () => {
    const retiring = stackEnv(["--env", "--offset", String(OFFSET), "--suffix", SUFFIX], {
      ...CHILD_ENV,
      HELIX_JOBS_STATE: "retiring",
    });
    const catalogue = resolveJobsCatalogueServers(retiring);
    expect(catalogue.servers.jobs?.state).toBe("retiring");
    expect(advertisedJobTypes(catalogue)).toEqual([]);
    expect(retiring.JOBS_ACCEPTING).toBe("false");
    expect(loadJobsConfig(retiring).accepting).toBe(false);
    // Routing and lifecycle delivery are untouched by retirement.
    expect(retiring.EDGE_JOBS_CONFIG).toBe(minted.EDGE_JOBS_CONFIG);
    expect(retiring.PORTAL_JOBS_CONFIG).toBe(minted.PORTAL_JOBS_CONFIG);
    expect(() => assertDeploymentConfig(retiring)).not.toThrow();
    // The full map the documents project from is a valid retiring entry.
    expect(
      JobsDeploymentConfigSchema.safeParse({
        servers: {
          jobs: {
            server: "jobs",
            endpoint: edgeDoc.servers.jobs?.endpoint,
            state: "retiring",
            accepting: false,
            types: ["jobs:fetch"],
            databaseUrl: retiring.JOBS_DATABASE_URL,
            edgeProdCallbackUrl: retiring.JOBS_EDGE_PROD_URL,
            edgeDevCallbackUrl: retiring.JOBS_EDGE_DEV_URL,
            roots: {
              edgeToJobs: retiring.JOBS_EDGE_TO_JOBS_SECRET,
              jobsToEdge: retiring.JOBS_JOBS_TO_EDGE_SECRET,
              portalToJobs: retiring.JOBS_PORTAL_TO_JOBS_SECRET,
            },
          },
        },
      }).success,
    ).toBe(true);
  });

  it("a serving stack can close intake without withdrawing its types", () => {
    const closed = stackEnv(["--env", "--offset", String(OFFSET), "--suffix", SUFFIX], {
      ...CHILD_ENV,
      HELIX_JOBS_ACCEPTING: "0",
    });
    expect(resolveJobsCatalogueServers(closed).servers.jobs?.state).toBe("serving");
    expect(closed.JOBS_ACCEPTING).toBe("false");
    expect(loadJobsConfig(closed).accepting).toBe(false);
  });

  it("refuses an open intake on a retiring stack and typo'd intake knobs", () => {
    const run = (extra: NodeJS.ProcessEnv) => () =>
      stackEnv(["--env", "--offset", String(OFFSET), "--suffix", SUFFIX], {
        ...CHILD_ENV,
        ...extra,
      });
    expect(run({ HELIX_JOBS_STATE: "retiring", HELIX_JOBS_ACCEPTING: "1" })).toThrow(
      /HELIX_JOBS_ACCEPTING cannot be true for a retiring server/,
    );
    expect(run({ HELIX_JOBS_STATE: "retired" })).toThrow(
      /HELIX_JOBS_STATE must be serving or retiring — got "retired"/,
    );
    expect(run({ HELIX_JOBS_ACCEPTING: "yes" })).toThrow(
      /HELIX_JOBS_ACCEPTING must be 1\/true or 0\/false — got "yes"/,
    );
  });

  it("the documented HELIX_JOBS_ENABLED spellings resolve on and off", () => {
    for (const value of ["1", "true", "", " "]) {
      const on = stackEnv(["--env", "--offset", String(OFFSET), "--suffix", SUFFIX], {
        ...CHILD_ENV,
        HELIX_JOBS_ENABLED: value,
      });
      expect(on.JOBS_SERVER_ID, `HELIX_JOBS_ENABLED=${JSON.stringify(value)} should enable`).toBe(
        "jobs",
      );
    }
    for (const value of ["0", "false", " false\n"]) {
      const off = stackEnv(["--env", "--offset", String(OFFSET), "--suffix", SUFFIX], {
        ...CHILD_ENV,
        HELIX_JOBS_ENABLED: value,
      });
      expect(
        off.JOBS_SERVER_ID,
        `HELIX_JOBS_ENABLED=${JSON.stringify(value)} should disable`,
      ).toBeUndefined();
    }
  });

  it("signing roots are reproducible for one stack and private to it", () => {
    // The human path resolves one stack from several terminals; independent
    // resolutions must agree, and two stacks must never share a root.
    const again = stackEnv(["--env", "--offset", String(OFFSET), "--suffix", SUFFIX]);
    const elsewhere = stackEnv(["--env", "--offset", String(OFFSET), "--suffix", "otherstack"]);
    for (const key of [
      "JOBS_EDGE_TO_JOBS_SECRET",
      "JOBS_JOBS_TO_EDGE_SECRET",
      "JOBS_PORTAL_TO_JOBS_SECRET",
    ] as const) {
      expect(again[key], `${key} must not depend on resolution order`).toBe(minted[key]);
      expect(elsewhere[key], `${key} must not be shared across stacks`).not.toBe(minted[key]);
    }
  });

  it("a developer's JOBS_DATABASE_URL is kept — only the database name moves", () => {
    const withOverride = stackEnv(["--env", "--offset", String(OFFSET), "--suffix", SUFFIX], {
      ...CHILD_ENV,
      JOBS_DATABASE_URL: "postgresql://custom:secret@dbhost:6543/devjobs?sslmode=disable",
    });
    const dsn = new URL(withOverride.JOBS_DATABASE_URL ?? "");
    expect(dsn.username).toBe("custom");
    expect(dsn.password).toBe("secret");
    expect(dsn.host).toBe("dbhost:6543");
    expect(dsn.pathname).toBe(`/helix_jobs_${SUFFIX}`);
    expect(dsn.search).toBe("?sslmode=disable");
  });

  it("a blank JOBS_DATABASE_URL counts as absent — the derived DSN stands in", () => {
    // The file's blank-means-unset convention (jobsEnabled's own): a blank
    // value names no store, so nothing is relocated when the derived DSN is
    // minted — unlike a set-but-unparseable value, which refuses.
    const blank = stackEnv(["--env", "--offset", String(OFFSET), "--suffix", SUFFIX], {
      ...CHILD_ENV,
      JOBS_DATABASE_URL: "   ",
    });
    const dsn = new URL(blank.JOBS_DATABASE_URL ?? "");
    expect(dsn.username).toBe("helix_jobs");
    expect(dsn.pathname).toBe(`/helix_jobs_${SUFFIX}`);
  });

  it("with no usable DSN source the map is still complete — the boot owns the DSN refusal", () => {
    const dsnless = stackEnv(["--env", "--offset", String(OFFSET), "--suffix", SUFFIX], {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
    });
    expect(dsnless.JOBS_DATABASE_URL).toBeUndefined();
    for (const key of JOBS_KEYS.filter((k) => k !== "JOBS_DATABASE_URL")) {
      expect(dsnless[key], `${key} must still be emitted`).toBeDefined();
    }
    // Closing the loop: the real boot loader refuses this map, naming the key.
    expect(() => loadJobsConfig(dsnless)).toThrow(/JOBS_DATABASE_URL is required/);
    // The fallback source degrading — an unparseable platform DSN — lands in
    // the same key-omission: the map stays complete and the boot owns the
    // refusal, the degradation the resolver documents for this arm.
    const degraded = stackEnv(["--env", "--offset", String(OFFSET), "--suffix", SUFFIX], {
      ...CHILD_ENV,
      DATABASE_URL: "postgresql://ho st/db",
    });
    expect(degraded.JOBS_DATABASE_URL).toBeUndefined();
    expect(() => loadJobsConfig(degraded)).toThrow(/JOBS_DATABASE_URL is required/);
  });

  it("an unparseable JOBS_DATABASE_URL is refused, never silently substituted", () => {
    // The resolver must not conflate "unparseable" with "absent": silently
    // pointing the private store at the derived well-known DSN would relocate
    // the operator's explicit credential choice without a signal. Failing the
    // resolution is the earliest stage that can catch it (the jobsEnabled
    // typo's precedent); passing the value through to the boot's loud refusal
    // would also honour this contract.
    expect(() =>
      stackEnv(["--env", "--offset", String(OFFSET), "--suffix", SUFFIX], {
        ...CHILD_ENV,
        JOBS_DATABASE_URL: "postgresql://ho st/db",
      }),
    ).toThrow(/JOBS_DATABASE_URL/);
  });

  it("a stack suffix that cannot form a database name refuses the resolution", () => {
    // The pairing derivation refuses a name outside the helix convention, and
    // the resolver must surface that refusal at the earliest stage — never
    // mint a DSN from a null (which would name the database literally "null")
    // and never carry an unusable suffix silently into the jobs plane.
    expect(() =>
      stackEnv(["--env", "--offset", String(OFFSET), "--suffix", "My-Stack"], {
        ...CHILD_ENV,
        HELIX_STACK_SUFFIX: "My-Stack",
      }),
    ).toThrow(/HELIX_STACK_SUFFIX="My-Stack" does not form a valid database name/);
  });

  it("a garbage offset refuses the resolution instead of resolving the dev stack", () => {
    // `Number(...) || 0` turned "abc" into offset 0 — the DEV stack's ports,
    // which the SKILL's own stop line then frees. The refusal names the value.
    expect(() => stackEnv(["--env", "--offset", "abc"])).toThrow(
      /HELIX_PORT_OFFSET must be a non-negative whole number of ports — got "abc"/,
    );
    for (const bad of ["-5", "1000.5"]) {
      expect(() => stackEnv(["--env", "--offset", bad])).toThrow(/HELIX_PORT_OFFSET/);
    }
  });

  it("an offset that lands a service on a fetch-blocked port refuses the resolution", () => {
    // Offset 2000 puts the edge on 10080, which Node's fetch refuses outright:
    // the stack would boot and no probe, service hop or test could reach it.
    expect(() => stackEnv(["--env", "--offset", "2000", "--suffix", SUFFIX])).toThrow(
      /HELIX_PORT_OFFSET=2000 puts edge :10080 on the fetch standard's blocked-port list/,
    );
    expect(() => stackEnv(["--ports", "--offset", "2000"])).toThrow(/edge :10080/);
    expect(stackEnv(["--env", "--offset", "3000", "--suffix", SUFFIX]).EDGE_PORT).toBe("11080");
  });

  it("a blank HELIX_PORT_OFFSET refuses the resolution — never silently the dev stack", () => {
    // Number("") === Number(" ") === 0, so the blank spellings slip past the
    // integer validation and resolve the DEV stack — the exact silently-wrong
    // target the parse exists to refuse (its own message demands "a
    // non-negative whole number", which blank is not). An empty
    // HELIX_PORT_OFFSET left in a shell or CI env is the likeliest trigger:
    // --env prints nothing, and the smoke driver — which passes the raw env
    // value through — runs the whole composition on the developer's own
    // ports. Blank must refuse naming the value (the jobsEnabled typo's
    // precedent): unlike HELIX_JOBS_ENABLED, the offset has no safe blank
    // default to fall back to — the CLI's own fallback is the dev stack.
    expect(() => stackEnv(["--env", "--offset", "", "--suffix", SUFFIX], CHILD_ENV)).toThrow(
      /HELIX_PORT_OFFSET/,
    );
    expect(() =>
      stackEnv(["--env", "--suffix", SUFFIX], { ...CHILD_ENV, HELIX_PORT_OFFSET: "   " }),
    ).toThrow(/HELIX_PORT_OFFSET/);
  });

  it("a valueless --offset or --suffix flag refuses instead of taking its default", () => {
    // The CLI's own fallback for a missing value is `undefined` — which the
    // resolution reads as "unset": a trailing --offset would resolve the DEV
    // stack (and the skill's stop line would free the developer's own ports),
    // a trailing --suffix would resolve onto the smoke stack's database. The
    // flag guard refuses before the resolution sees it, naming the flag.
    for (const name of ["--offset", "--suffix"]) {
      expect(() => stackEnv(["--env", name], CHILD_ENV)).toThrow(
        new RegExp(`${name} requires a value`),
      );
    }
  });

  it("refuses a stack suffix whose platform database would be a jobs-store name", () => {
    // The suffix validation only checks the platform name is PAIRABLE; a
    // suffix of "jobs" (or "jobs_<x>") passes it while minting the platform
    // database helix_jobs (or helix_jobs_<x>) — the developer's own jobs
    // store, or a sibling stack's. Every platform DSN then points there and
    // the prep migrates the portal schema into it, exiting 0: the isolation
    // the suffix exists to provide, broken by an accepted input. The
    // resolution must refuse, naming the suffix.
    let minted: Record<string, string> | undefined;
    let refused: unknown;
    try {
      minted = stackEnv(["--env", "--offset", String(OFFSET), "--suffix", "jobs"]);
    } catch (error) {
      refused = error;
    }
    if (refused instanceof Error) {
      expect(refused.message).toMatch(/\bjobs\b/);
      return;
    }
    // No refusal today — the evidence is the mint itself: every platform
    // DSN points at the developer's own jobs database.
    expect(minted).toBeUndefined();
  });

  it("refuses a stack suffix whose platform database would be a sibling stack's jobs store", () => {
    // The namespace's second face: helix_jobs_<x> is some resolved stack's
    // jobs database, so a suffix like "jobs_smoke" puts the platform database
    // inside the jobs namespace exactly as "jobs" does — the same predicate's
    // other branch, refused the same way.
    expect(() => stackEnv(["--env", "--offset", String(OFFSET), "--suffix", "jobs_smoke"])).toThrow(
      /would make this stack's platform database "helix_jobs_smoke" a jobs-store name/,
    );
  });

  it("a disabled stack emits no jobs key anywhere", () => {
    const disabled = stackEnv(["--env", "--offset", String(OFFSET), "--suffix", SUFFIX], {
      ...CHILD_ENV,
      HELIX_JOBS_ENABLED: "false",
    });
    for (const key of JOBS_KEYS) {
      expect(disabled[key]).toBeUndefined();
    }
    // Isolation is a stack-level property, not a jobs-level one: the flag
    // that makes the resolved env authoritative over the developer's
    // .env.local files rides on the disabled arm too.
    expect(disabled.HELIX_STACK_ENV).toBe("1");
  });

  describe("the HELIX_JOBS_DIAGNOSTICS knob", () => {
    it("the default resolution carries no diagnostic anywhere", () => {
      for (const [key, value] of Object.entries(minted)) {
        expect(
          `${key}=${value}`,
          `the default resolution must not mention diagnostics at ${key}`,
        ).not.toContain("diagnostic");
      }
      expect(minted.JOBS_DIAGNOSTICS).toBeUndefined();
      expect(loadJobsConfig(minted).diagnostics).toBe(false);
    });

    it("opting in lists the type in the catalogue and turns the service knob on, changing nothing else", () => {
      const optedIn = stackEnv(["--env", "--offset", String(OFFSET), "--suffix", SUFFIX], {
        ...CHILD_ENV,
        HELIX_JOBS_DIAGNOSTICS: "1",
      });
      const optCatalogue = resolveJobsCatalogueServers(optedIn);
      expect(optCatalogue.servers.jobs?.types).toEqual([
        "jobs:fetch",
        JOBS_DIAGNOSTIC_QUALIFIED_TYPE,
      ]);
      // The minted env carries no NODE_ENV, so the loaders read the
      // non-production posture: the diagnostic entry is advertised.
      expect(
        advertisedJobTypes(optCatalogue, { diagnostics: true }).map((entry) => entry.id),
      ).toContain(JOBS_DIAGNOSTIC_QUALIFIED_TYPE);
      expect(loadJobsConfig(optedIn).diagnostics).toBe(true);
      // The knob changes ONLY the catalogue's types and the jobs service's
      // own knob: the edge and portal delivery documents are byte-identical.
      expect(optedIn.EDGE_JOBS_CONFIG).toBe(minted.EDGE_JOBS_CONFIG);
      expect(optedIn.PORTAL_JOBS_CONFIG).toBe(minted.PORTAL_JOBS_CONFIG);
      expect(optedIn.JOBS_DIAGNOSTICS).toBe("true");
      // And every other key is untouched by the opt-in.
      for (const [key, value] of Object.entries(minted)) {
        if (key === "PORTAL_JOBS_CATALOGUE") continue;
        expect(optedIn[key], `${key} must not change with the opt-in`).toBe(value);
      }
    });

    it("the opted-in env can never carry diagnostics into a production process", () => {
      const optedIn = stackEnv(["--env", "--offset", String(OFFSET), "--suffix", SUFFIX], {
        ...CHILD_ENV,
        HELIX_JOBS_DIAGNOSTICS: "true",
      });
      expect(() => loadJobsConfig({ ...optedIn, NODE_ENV: "production" })).toThrow(
        /JOBS_DIAGNOSTICS cannot be enabled in production/,
      );
      expect(() => assertDeploymentConfig({ ...optedIn, NODE_ENV: "production" })).toThrow(
        /PORTAL_JOBS_CATALOGUE is not a valid jobs catalogue source/,
      );
    });

    it("a typo'd value fails the resolution naming the value, and a disabled jobs plane emits nothing", () => {
      expect(() =>
        stackEnv(["--env", "--offset", String(OFFSET), "--suffix", SUFFIX], {
          ...CHILD_ENV,
          HELIX_JOBS_DIAGNOSTICS: "yes",
        }),
      ).toThrow(/HELIX_JOBS_DIAGNOSTICS must be 1\/true or 0\/false — got "yes"/);
      // The knob is validated even where it can emit nothing.
      const disabledJobs = stackEnv(["--env", "--offset", String(OFFSET), "--suffix", SUFFIX], {
        ...CHILD_ENV,
        HELIX_JOBS_ENABLED: "0",
        HELIX_JOBS_DIAGNOSTICS: "1",
      });
      for (const key of JOBS_KEYS) {
        expect(disabledJobs[key]).toBeUndefined();
      }
      expect(disabledJobs.JOBS_DIAGNOSTICS).toBeUndefined();
    });
  });

  describe("the HELIX_JOBS_SUBMISSION_LIMITS knob", () => {
    it("the default resolution emits no EDGE_JOBS_LIMITS", () => {
      expect(minted.EDGE_JOBS_LIMITS).toBeUndefined();
    });

    it("a set knob is emitted as EDGE_JOBS_LIMITS, changes no other key, and resolves through the edge's loader", () => {
      const tuned = stackEnv(["--env", "--offset", String(OFFSET), "--suffix", SUFFIX], {
        ...CHILD_ENV,
        HELIX_JOBS_SUBMISSION_LIMITS: '{"submissionAttemptsDeployment":7}',
      });
      expect(tuned.EDGE_JOBS_LIMITS).toBe('{"submissionAttemptsDeployment":7}');
      // The knob changes ONLY its own emitted key: the edge and portal
      // documents are byte-identical to the default resolution's.
      for (const [key, value] of Object.entries(minted)) {
        expect(tuned[key], `${key} must not change with the knob`).toBe(value);
      }
      // The edge's (and, sharing the parse, the dev-gateway's) own boot
      // resolves the emitted override over the platform defaults.
      const edge = loadEdgeJobsConfig(tuned);
      expect(edge.submissionLimits.submissionAttemptsDeployment).toBe(7);
      expect(edge.submissionLimits.submissionAttemptsPerAppEnv).toBe(
        JOBS_CAPACITY_DEFAULTS.submissionAttemptsPerAppEnv,
      );
    });

    it("a value that is not a JSON object refuses the resolution, naming the knob", () => {
      for (const bad of ["{not json", "[]", "5", "null"]) {
        expect(
          () =>
            stackEnv(["--env", "--offset", String(OFFSET), "--suffix", SUFFIX], {
              ...CHILD_ENV,
              HELIX_JOBS_SUBMISSION_LIMITS: bad,
            }),
          bad,
        ).toThrow(
          /HELIX_JOBS_SUBMISSION_LIMITS must be a JSON object of submission-limit overrides/,
        );
      }
    });

    it("a disabled jobs plane emits nothing but still validates the knob", () => {
      const disabled = stackEnv(["--env", "--offset", String(OFFSET), "--suffix", SUFFIX], {
        ...CHILD_ENV,
        HELIX_JOBS_ENABLED: "0",
        HELIX_JOBS_SUBMISSION_LIMITS: '{"submissionAttemptsDeployment":7}',
      });
      for (const key of JOBS_KEYS) {
        expect(disabled[key]).toBeUndefined();
      }
      expect(disabled.EDGE_JOBS_LIMITS).toBeUndefined();
      // The validation holds on the disabled arm too — the typo posture.
      expect(() =>
        stackEnv(["--env", "--offset", String(OFFSET), "--suffix", SUFFIX], {
          ...CHILD_ENV,
          HELIX_JOBS_ENABLED: "0",
          HELIX_JOBS_SUBMISSION_LIMITS: "{not json",
        }),
      ).toThrow(/HELIX_JOBS_SUBMISSION_LIMITS must be a JSON object of submission-limit overrides/);
    });
  });

  it("the developer stack (offset 0) is left exactly as configured", () => {
    const dev = stackEnv(["--env", "--offset", "0"]);
    expect(dev).toEqual({});
  });
});
