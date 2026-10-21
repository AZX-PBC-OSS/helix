import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import {
  JobsDeploymentConfigSchema,
  JobsServerEntrySchema,
  advertisedJobTypes,
  jobsCatalogueServers,
  type JobsCatalogueServers,
} from "@azx-pbc/shared";

import { loadEdgeJobsConfig, type EdgeJobsConfig } from "../../edge/src/config.js";
import {
  assertDeliveryTargetsMatch,
  assertDeploymentConfig,
  resolveJobsCatalogueServers,
  resolvePortalJobsDeliveryConfig,
  type PortalJobsDeliveryConfig,
} from "../../portal/src/deployment.js";
import { loadJobsConfig, type JobsServiceConfig } from "./config.js";

/**
 * The Azure service wiring is a chain no test deploys: main.bicep builds one
 * jobs server map and hands each consumer only its custody subset; the
 * container apps receive those documents as secrets and env vars; every
 * service parses them at boot with its real config loader. Nothing executes
 * these files together (Azure only), so this pins the chain statically AND
 * evaluates the three projections the template writes through each consumer's
 * REAL loader — a renamed field, a swapped root or a leaked credential fails
 * here, the same composition discipline localStack.test.ts applies to the
 * local stack's minted env.
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function read(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

const MAIN = read("infra/azure/main.bicep");
const CONTAINERAPP = read("infra/azure/modules/containerapp.bicep");
const KV_SECRETS = read("infra/azure/modules/kv-secrets.bicep");
const BOOTSTRAP_PARAMS = read("infra/azure/main.bootstrap.bicepparam");
const STEADY_PARAMS = read("infra/azure/main.bicepparam");
const JOBS_DOCKERFILE = read("apps/jobs/Dockerfile");

// ── Bicep-parsing helpers ────────────────────────────────────────────────────

/** The text of one `module <name> 'modules/containerapp.bicep'` call in main.bicep. */
function appCall(name: string): string {
  const call = MAIN.match(
    new RegExp(
      `module ${name} 'modules/containerapp\\.bicep'[\\s\\S]*?(?=\\nmodule |\\n// -{10,})`,
    ),
  );
  expect(call, `main.bicep must declare the ${name} container app`).not.toBeNull();
  return call![0];
}

interface EnvEntry {
  name: string;
  /** The raw `value:` expression, for a plain-value entry. */
  value?: string;
  /** The referenced secret name, for a secretRef entry. */
  secretRef?: string;
}

/**
 * Every env entry of a container app call, single-line or multi-line. The
 * `${...}` interpolations are flattened first: their braces would otherwise
 * cut a flat-object match short (they never carry an env name).
 */
function envEntries(callText: string): EnvEntry[] {
  const flat = callText.replace(/\$\{[^}]*\}/g, "I");
  const entries: EnvEntry[] = [];
  for (const match of flat.matchAll(/\{([^{}]*)\}/g)) {
    const body = match[1]!;
    const name = body.match(/name:\s*'([A-Z0-9_]+)'/);
    if (!name) continue;
    // `value:` is each entry's last property, single-line or multi-line; the
    // match anchors to the end of the value's own line.
    const value = body.match(/value:[ \t]*([^\n]*?)[ \t]*$/m);
    const secretRef = body.match(/secretRef:\s*'([a-z0-9-]+)'/);
    entries.push({ name: name[1]!, value: value?.[1]?.trim(), secretRef: secretRef?.[1] });
  }
  expect(
    entries.length,
    `no env entries parsed from the call — extend this test's envEntries parser`,
  ).toBeGreaterThan(0);
  return entries;
}

interface SecretEntry {
  /** The inline `value:` expression, when the secret is not a Key Vault reference. */
  value?: string;
}

/**
 * Every named secret of a container app call — `'<name>': { … }` entries,
 * whether inside a plain secretValues object or a union()'s conditional arm —
 * with its inline value expression when it has one (a Key Vault reference
 * carries keyVaultUrl instead, and no value).
 */
function secretEntries(callText: string): Map<string, SecretEntry> {
  const flat = callText.replace(/\$\{[^}]*\}/g, "I");
  const entries = new Map<string, SecretEntry>();
  for (const match of flat.matchAll(/'([a-z0-9-]+)':\s*\{([^{}]*)\}/g)) {
    const body = match[2]!;
    if (body.includes("keyVaultUrl:")) {
      entries.set(match[1]!, {});
      continue;
    }
    const value = body.match(/value:[ \t]*([^\n]*?)[ \t]*$/m);
    entries.set(match[1]!, { value: value?.[1]?.trim() });
  }
  expect(
    entries.size,
    `no secret entries parsed from the call — extend this test's secretEntries parser`,
  ).toBeGreaterThan(0);
  return entries;
}

interface Projection {
  /** Ordered `[field, path]` pairs of the projection's lambda body. */
  fields: Array<[string, string]>;
  /** The map the projection iterates — asserted to be exactly `jobsServers`. */
  iterated: string;
}

/**
 * Parse one of the three `var <name> = string({ servers: toObject(items(map),
 * e => e.key, e => { field: e.value.path … }) })` projections.
 */
function projection(varName: string): Projection {
  const block = MAIN.match(
    new RegExp(
      `var ${varName} = string\\(\\{\\s*servers: toObject\\(items\\((\\w+)\\), e => e\\.key, e => \\{([\\s\\S]*?)\\}\\)`,
    ),
  );
  expect(
    block,
    `main.bicep must define the projection ${varName} — extend this test's parser`,
  ).not.toBeNull();
  const iterated = block![1]!;
  expect(iterated, `the ${varName} projection must iterate the one jobs server map`).toBe(
    "jobsServers",
  );
  const fields = [...block![2]!.matchAll(/^\s{4}(\w+): e\.value\.([\w.]+)\s*$/gm)].map(
    (m) => [m[1]!, m[2]!] as [string, string],
  );
  expect(
    fields.length,
    `no projected fields parsed from ${varName} — extend the parser`,
  ).toBeGreaterThan(0);
  return { fields, iterated };
}

/** Top-level keys of a simple multi-line `var <name> = { … }` object literal. */
function objectKeys(varName: string): string[] {
  const block = MAIN.match(new RegExp(`var ${varName} = \\{([\\s\\S]*?)\\n\\}`));
  expect(block, `main.bicep must define ${varName} — extend this test's parser`).not.toBeNull();
  return [...block![1]!.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]!);
}

/** The text of one multi-line `var <name> = { … }` object literal. */
function varBlock(varName: string): string {
  const block = MAIN.match(new RegExp(`var ${varName} = \\{[\\s\\S]*?\\n\\}`));
  expect(block, `main.bicep must define ${varName} — extend this test's parser`).not.toBeNull();
  return block![0];
}

// ── Evaluation helpers ───────────────────────────────────────────────────────

/**
 * Resolve a `jobsServer.<path>` expression on a JS entry — the same walk the
 * Bicep lambda's `e.value.<path>` performs on the map's value.
 */
function resolveOnEntry(expr: string, entry: Record<string, unknown>): string {
  const path = expr.replace(/^jobsServer\./, "");
  let value: unknown = entry;
  for (const segment of path.split(".")) {
    if (value === null || typeof value !== "object") {
      throw new Error(`the jobsServer path ${path} does not resolve on the entry`);
    }
    value = (value as Record<string, unknown>)[segment];
  }
  if (typeof value !== "string") {
    throw new Error(`the jobsServer path ${path} does not resolve to a string`);
  }
  return value;
}

/** Apply one projection's `[field, path]` pairs to one map entry. */
function evaluate(
  fields: Array<[string, string]>,
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, path] of fields) {
    let value: unknown = entry;
    for (const segment of path.split(".")) {
      if (value === null || typeof value !== "object") {
        throw new Error(`the projection path ${path} does not resolve on the entry`);
      }
      value = (value as Record<string, unknown>)[segment];
    }
    out[field] = value;
  }
  return out;
}

/**
 * Apply one projection to a whole server map — `toObject(items(map))` with the
 * projection's fields — and serialize it the way the template's `string(...)`
 * does. The empty map yields `{"servers":{}}`, the fully disabled document.
 */
function evaluateMap(
  fields: Array<[string, string]>,
  map: Record<string, Record<string, unknown>>,
): string {
  const servers: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(map)) {
    servers[key] = evaluate(fields, entry);
  }
  return JSON.stringify({ servers });
}

/**
 * Build the jobs app's concrete env from its containerapp call: plain values
 * from the literals the call writes, `jobsServer.<path>` values resolved on
 * the full entry, secretRef entries through the call's own secretValues.
 */
function jobsAppEnv(fullEntry: Record<string, unknown>): Record<string, string> {
  const call = appCall("jobsApp");
  const secrets = secretEntries(call);
  const env: Record<string, string> = {};
  for (const entry of envEntries(call)) {
    if (entry.secretRef !== undefined) {
      const secret = secrets.get(entry.secretRef);
      expect(
        secret,
        `the jobs app's secret '${entry.secretRef}' must be declared in its secretValues`,
      ).toBeDefined();
      expect(
        secret!.value,
        `the secret '${entry.secretRef}' must be an inline value — the jobs app has no identity to resolve a Key Vault reference`,
      ).toBeDefined();
      env[entry.name] = resolveOnEntry(secret!.value!, fullEntry);
      continue;
    }
    const expr = entry.value ?? "";
    if (/^'.*'$/.test(expr)) {
      env[entry.name] = expr.slice(1, -1);
    } else if (expr === "logLevel") {
      env[entry.name] = "info";
    } else if (expr === "string(jobsServerConfig.accepting)") {
      // Bicep's string() of a bool is its lowercase literal.
      env[entry.name] = String(fullEntry.accepting);
    } else if (expr.startsWith("jobsServer.")) {
      env[entry.name] = resolveOnEntry(expr, fullEntry);
    } else if (expr.includes("deployTelemetry")) {
      // The OTEL destination: telemetry is not part of this evaluation, and
      // the loaders treat the empty value as unconfigured.
      env[entry.name] = "";
    } else {
      throw new Error(
        `unhandled env value expression for ${entry.name}: ${expr} — extend the evaluator`,
      );
    }
  }
  return env;
}

// ── The sample deployment map ────────────────────────────────────────────────

const EDGE_TO_JOBS_ROOT = randomBytes(32).toString("base64");
const JOBS_TO_EDGE_ROOT = randomBytes(32).toString("base64");
const PORTAL_TO_JOBS_ROOT = randomBytes(32).toString("base64");

const SAMPLE_ENDPOINT = "https://helix-test-jobs.internal.example.azurecontainerapps.io";
const SAMPLE_EDGE_PROD_URL = "https://helix-test-edge.example.azurecontainerapps.io";
const SAMPLE_EDGE_DEV_URL = "https://helix-test-dev-gateway.example.azurecontainerapps.io";

/** The map entry built over exactly the keys the template's `jobsServerConfig` declares. */
const SAMPLE_ENTRY: Record<string, unknown> = {
  server: "jobs",
  endpoint: SAMPLE_ENDPOINT,
  state: "serving",
  accepting: true,
  types: ["jobs:fetch"],
  databaseUrl: "postgresql://helix_jobs:pw@pg.example:5432/helix_jobs?sslmode=require",
  roots: {
    edgeToJobs: EDGE_TO_JOBS_ROOT,
    jobsToEdge: JOBS_TO_EDGE_ROOT,
    portalToJobs: PORTAL_TO_JOBS_ROOT,
  },
};

/** The full entry the jobs service runs from: the map entry plus the two callback destinations. */
const FULL_ENTRY: Record<string, unknown> = {
  ...SAMPLE_ENTRY,
  edgeProdCallbackUrl: SAMPLE_EDGE_PROD_URL,
  edgeDevCallbackUrl: SAMPLE_EDGE_DEV_URL,
};

describe("one map, three custody subsets", () => {
  let edgeFields: Array<[string, string]>;
  let portalFields: Array<[string, string]>;
  let catalogueFields: Array<[string, string]>;
  let edgeDoc: string;
  let portalDoc: string;
  let catalogueDoc: string;
  let edge: EdgeJobsConfig;
  let delivery: PortalJobsDeliveryConfig;
  let catalogue: JobsCatalogueServers;
  let jobs: JobsServiceConfig;

  beforeAll(() => {
    edgeFields = projection("edgeJobsConfig").fields;
    portalFields = projection("portalJobsConfig").fields;
    catalogueFields = projection("portalJobsCatalogue").fields;
    edgeDoc = evaluateMap(edgeFields, { jobs: FULL_ENTRY });
    portalDoc = evaluateMap(portalFields, { jobs: FULL_ENTRY });
    catalogueDoc = evaluateMap(catalogueFields, { jobs: FULL_ENTRY });
    edge = loadEdgeJobsConfig({ EDGE_JOBS_CONFIG: edgeDoc });
    delivery = resolvePortalJobsDeliveryConfig({ PORTAL_JOBS_CONFIG: portalDoc })!;
    catalogue = resolveJobsCatalogueServers({ PORTAL_JOBS_CATALOGUE: catalogueDoc });
    jobs = loadJobsConfig(jobsAppEnv(FULL_ENTRY));
  });

  it("the Bicep map is the shared JobsDeploymentConfig shape, not a lookalike", () => {
    // The sample entry is built over exactly the keys the template's map
    // entry declares — a renamed or added field fails here, before a
    // consumer's strict parse fails at boot on Azure.
    expect([...objectKeys("jobsServerConfig")].sort()).toEqual(
      ["accepting", "databaseUrl", "endpoint", "roots", "server", "state", "types"].sort(),
    );
    const configBlock = varBlock("jobsServerConfig");
    expect(configBlock, "the map's server id literal").toContain("server: 'jobs'");
    expect(configBlock, "the map's installed-type literal").toContain("types: ['jobs:fetch']");

    // The full entry — the map entry plus the two callback destinations the
    // jobsServer union adds — is a valid shared-schema server entry, and the
    // whole map parses as the shared deployment configuration.
    expect(new Set([EDGE_TO_JOBS_ROOT, JOBS_TO_EDGE_ROOT, PORTAL_TO_JOBS_ROOT]).size).toBe(3);
    expect(JobsServerEntrySchema.parse(FULL_ENTRY)).toBeDefined();
    expect(JobsDeploymentConfigSchema.parse({ servers: { jobs: FULL_ENTRY } })).toBeDefined();

    // The union's additions are exactly the two callback destinations, each
    // bound to the var of its tier — the only fields that distinguish the
    // jobs service's view from the map it projects from.
    const unionBlock = MAIN.match(/var jobsServer = union\(jobsServerConfig, \{([\s\S]*?)\}\)/);
    expect(
      unionBlock,
      "main.bicep must define jobsServer as the union of the map entry",
    ).not.toBeNull();
    const added = [...unionBlock![1]!.matchAll(/(\w+): (\w+)/g)].map(
      (m) => [m[1]!, m[2]!] as const,
    );
    expect(added).toEqual([
      ["edgeProdCallbackUrl", "jobsEdgeProdCallbackUrl"],
      ["edgeDevCallbackUrl", "jobsEdgeDevCallbackUrl"],
    ]);
  });

  it("each projection carries exactly its custody subset of paths", () => {
    expect(edgeFields).toEqual([
      ["endpoint", "endpoint"],
      ["edgeToJobsRoot", "roots.edgeToJobs"],
      ["jobsToEdgeRoot", "roots.jobsToEdge"],
    ]);
    expect(portalFields).toEqual([
      ["endpoint", "endpoint"],
      ["portalToJobsRoot", "roots.portalToJobs"],
    ]);
    expect(catalogueFields).toEqual([
      ["state", "state"],
      ["types", "types"],
    ]);
    // No projection path reaches the database credential.
    for (const fields of [edgeFields, portalFields, catalogueFields]) {
      for (const [, path] of fields) {
        expect(path, "no projection may project the databaseUrl").not.toContain("databaseUrl");
      }
    }
    // Only the portal's delivery projection carries the portal root; neither
    // the portal's nor the catalogue's ever carries an edge hop root.
    for (const fields of [edgeFields, catalogueFields]) {
      expect(
        JSON.stringify(fields),
        "the portal root must stay in the portal projection",
      ).not.toContain("portalToJobs");
    }
    for (const fields of [portalFields, catalogueFields]) {
      expect(
        JSON.stringify(fields),
        "edge hop roots must stay in the edge projection",
      ).not.toContain("edgeToJobs");
      expect(
        JSON.stringify(fields),
        "edge hop roots must stay in the edge projection",
      ).not.toContain("jobsToEdge");
    }
  });

  it("the three evaluated documents boot every consumer's real loader", () => {
    // The edge's (and the dev-gateway's) forwarding config parses whole.
    expect(Object.keys(edge.servers)).toEqual(["jobs"]);
    expect(edge.servers.jobs?.endpoint).toBe(SAMPLE_ENDPOINT);

    // The portal's delivery config parses whole and matches its catalogue.
    expect(delivery.get("jobs")?.endpoint).toBe(SAMPLE_ENDPOINT);
    expect(catalogue.servers.jobs?.state).toBe("serving");
    expect(() => assertDeliveryTargetsMatch(catalogue, delivery)).not.toThrow();

    // The portal's full deployment boot check passes on these documents with
    // the rest of its env satisfied minimally.
    expect(() =>
      assertDeploymentConfig({
        APP_PUBLIC_BASE: "https://apps.example",
        PORTAL_JOBS_CONFIG: portalDoc,
        PORTAL_JOBS_CATALOGUE: catalogueDoc,
      }),
    ).not.toThrow();

    // The catalogue document is the shared derivation over the same map.
    expect(JSON.parse(catalogueDoc)).toEqual(
      jobsCatalogueServers(JobsDeploymentConfigSchema.parse({ servers: { jobs: FULL_ENTRY } })),
    );

    // The jobs service's own env — built from its containerapp call's entries
    // and inline secrets — boots the service's real loader.
    expect(jobs.serverId).toBe("jobs");
    expect(jobs.databaseUrl).toBe(SAMPLE_ENTRY.databaseUrl);
    expect(jobs.edgeProdCallbackUrl).toBe(SAMPLE_EDGE_PROD_URL);
    expect(jobs.edgeDevCallbackUrl).toBe(SAMPLE_EDGE_DEV_URL);
  });

  it("derives the same key on both ends of every signed hop", () => {
    expect(edge.servers.jobs?.edgeToJobsKey).toEqual(jobs.edgeToJobsKey);
    expect(edge.servers.jobs?.jobsToEdgeKey).toEqual(jobs.jobsToEdgeKey);
    expect(delivery.get("jobs")?.portalToJobsKey).toEqual(jobs.portalToJobsKey);

    // The adversarial half: the three sample roots are distinct, and each
    // reached exactly one env var — a swapped secretRef would make a pair of
    // these keys equal or break a hop outright.
    expect(jobs.edgeToJobsKey).not.toEqual(jobs.jobsToEdgeKey);
    expect(jobs.edgeToJobsKey).not.toEqual(jobs.portalToJobsKey);
    expect(jobs.jobsToEdgeKey).not.toEqual(jobs.portalToJobsKey);
  });

  it("the portal's two documents iterate the same map — and the parity check holds them together", () => {
    // Both projections iterate jobsServers (asserted inside projection()), so
    // the evaluated documents name the same server set.
    expect(Object.keys(JSON.parse(portalDoc).servers).sort()).toEqual(
      Object.keys(JSON.parse(catalogueDoc).servers).sort(),
    );

    // The boot check the parity protects: a catalogue naming `jobs` with an
    // empty delivery document is a broken deployment, refused at boot.
    const emptyDelivery = resolvePortalJobsDeliveryConfig({ PORTAL_JOBS_CONFIG: '{"servers":{}}' });
    expect(() => assertDeliveryTargetsMatch(catalogue, emptyDelivery)).toThrow();
  });
});

describe("each container app receives only its custody", () => {
  it("the edge and the dev-gateway receive exactly the edge document — and no jobs credential", () => {
    for (const name of ["edgeApp", "devGatewayApp"]) {
      const call = appCall(name);
      const env = envEntries(call);
      const jobsEnvs = env.filter((e) => e.name === "EDGE_JOBS_CONFIG");
      expect(jobsEnvs, `the ${name} app must receive the jobs document exactly once`).toHaveLength(
        1,
      );
      expect(jobsEnvs[0]!.secretRef).toBe("jobs-config");
      expect(
        jobsEnvs[0]!.value,
        `the ${name} app's jobs document must ride the secret, not a plain env value`,
      ).toBeUndefined();
      expect(
        secretEntries(call).get("jobs-config")?.value,
        `the ${name} app's jobs-config secret must be exactly the edge projection`,
      ).toBe("edgeJobsConfig");

      for (const entry of env) {
        expect(entry.name, `the ${name} app must not receive a jobs env var`).not.toMatch(
          /^(JOBS_|PORTAL_JOBS)/,
        );
      }

      // The credential-holding shapes never reach a gateway call. Word
      // boundaries: edgeJobsConfig legitimately appears and shares no word
      // with any of these.
      for (const token of [
        "portalJobsConfig",
        "portalJobsCatalogue",
        "jobsDbConn",
        "jobsMigrateDbConn",
        "jobsEdgeToJobsRoot",
        "jobsJobsToEdgeRoot",
        "jobsPortalToJobsRoot",
      ]) {
        expect(call, `the ${name} app must not reference ${token}`).not.toContain(token);
      }
      for (const token of ["jobsServer", "jobsServers", "jobsServerConfig", "jobsRoots"]) {
        expect(call, `the ${name} app must not reference ${token}`).not.toMatch(
          new RegExp(`\\b${token}\\b`),
        );
      }
    }
  });

  it("the portal receives its delivery root as a secret and the credential-free catalogue as a plain value", () => {
    const call = appCall("portalApp");
    const env = envEntries(call);
    const configEnv = env.find((e) => e.name === "PORTAL_JOBS_CONFIG");
    expect(configEnv, "the portal must receive PORTAL_JOBS_CONFIG").toBeDefined();
    expect(configEnv!.secretRef).toBe("jobs-config");
    expect(
      secretEntries(call).get("jobs-config")?.value,
      "the portal's jobs-config secret must be exactly the portal delivery projection",
    ).toBe("portalJobsConfig");

    const catalogueEnv = env.find((e) => e.name === "PORTAL_JOBS_CATALOGUE");
    expect(catalogueEnv, "the portal must receive PORTAL_JOBS_CATALOGUE").toBeDefined();
    expect(
      catalogueEnv!.value,
      "the catalogue carries no credential — it rides as a plain value",
    ).toBe("portalJobsCatalogue");
    expect(
      catalogueEnv!.secretRef,
      "the catalogue must not be delivered as a secret",
    ).toBeUndefined();

    expect(
      env.some((e) => e.name === "EDGE_JOBS_CONFIG"),
      "the portal gets no edge document",
    ).toBe(false);
    expect(
      env.some((e) => /^JOBS_/.test(e.name)),
      "the portal must receive no JOBS_* env var",
    ).toBe(false);

    for (const token of [
      "edgeJobsConfig",
      "jobsDbConn",
      "jobsMigrateDbConn",
      "jobsEdgeToJobsRoot",
      "jobsJobsToEdgeRoot",
      "jobsPortalToJobsRoot",
    ]) {
      expect(call, `the portal app must not reference ${token}`).not.toContain(token);
    }
    for (const token of ["jobsServer", "jobsServers", "jobsServerConfig", "jobsRoots"]) {
      expect(call, `the portal app must not reference ${token}`).not.toMatch(
        new RegExp(`\\b${token}\\b`),
      );
    }
  });

  it("the egress call never mentions jobs at all", () => {
    const call = appCall("egressApp");
    for (const entry of envEntries(call)) {
      expect(entry.name, "the egress app must receive no jobs env var").not.toContain("JOBS");
    }
    expect(/jobs/i.test(call), "the egress call text must not mention jobs in any form").toBe(
      false,
    );
  });

  it("the jobs app receives exactly its own env — and none of the platform's secrets", () => {
    const call = appCall("jobsApp");
    const env = envEntries(call);
    expect(
      env.map((e) => e.name).sort(),
      "the jobs app's env must be exactly its own identity, store, roots, callbacks and plumbing",
    ).toEqual(
      [
        "HOST",
        "JOBS_ACCEPTING",
        "JOBS_DATABASE_URL",
        "JOBS_EDGE_DEV_URL",
        "JOBS_EDGE_PROD_URL",
        "JOBS_EDGE_TO_JOBS_SECRET",
        "JOBS_JOBS_TO_EDGE_SECRET",
        "JOBS_PORT",
        "JOBS_PORTAL_TO_JOBS_SECRET",
        "JOBS_SERVER_ID",
        "LOG_LEVEL",
        "NODE_ENV",
        "OTEL_EXPORTER_OTLP_ENDPOINT",
      ].sort(),
    );
    for (const name of [
      "JOBS_DATABASE_URL",
      "JOBS_EDGE_TO_JOBS_SECRET",
      "JOBS_JOBS_TO_EDGE_SECRET",
      "JOBS_PORTAL_TO_JOBS_SECRET",
    ]) {
      const entry = env.find((e) => e.name === name);
      expect(entry?.secretRef, `${name} must be delivered by secretRef`).toBeDefined();
      expect(entry?.value, `${name} must never be a plain value`).toBeUndefined();
    }

    // No managed identity, no Key Vault reference — every secret is an inline
    // value and the app holds no Azure credential at all.
    expect(call).not.toContain("userAssignedIdentityId");
    expect(call).not.toContain("keyVaultUrl");
    expect(call, "the jobs app must declare no identity").not.toMatch(/^\s*identity:/m);

    // The jobs service holds none of the platform's own secrets.
    for (const token of [
      "jobsMigrateDbConn",
      "jobsMigrateDbPassword",
      "jobs-migrate-database-url",
      "helix_jobs_migrate",
      "postgres-admin-password",
      "edgeAuthSecret",
      "instructionSecret",
      "internalSecret",
      "exchangeSecret",
      "portalSecret",
    ]) {
      expect(call, `the jobs app must not hold ${token}`).not.toContain(token);
    }
  });

  it("no credential ever rides a plain env value, on any container app", () => {
    // `envVars` is not a secure module parameter, so a plain `value:` lands in
    // the deployment history and the app definition in clear; credentials
    // must ride `secretValues` (secure) and reach the env by secretRef. The
    // credential-free catalogue is the one jobs document allowed as a value.
    for (const name of ["edgeApp", "portalApp", "egressApp", "devGatewayApp", "jobsApp"]) {
      for (const entry of envEntries(appCall(name))) {
        if (entry.value === undefined) continue;
        expect(
          entry.value,
          `${name}'s ${entry.name} carries a credential-bearing expression as a plain value`,
        ).not.toMatch(
          /roots|Root\b|databaseUrl|DbConn|DbPassword|\bedgeJobsConfig\b|\bportalJobsConfig\b/,
        );
      }
    }
  });

  it("an app without a managed identity declares no identity at all", () => {
    expect(CONTAINERAPP).toMatch(
      /identity: empty\(userAssignedIdentityId\)\s*\?\s*\{\s*type: 'None'\s*\}/,
    );
    expect(CONTAINERAPP).toMatch(/param userAssignedIdentityId string = ''/);
  });
});

describe("placement and rollout envelope", () => {
  it("the jobs app sits in the apps environment, internally, under its own gated name", () => {
    const call = appCall("jobsApp");
    expect(MAIN).toMatch(
      /module jobsApp 'modules\/containerapp\.bicep' = if \(deployApps && deployJobs\)/,
    );
    expect(call).toContain("name: jobsAppName");
    expect(call).toContain("environmentId: appsEnv.outputs.environmentId");
    expect(call, "the jobs app must never sit in the egress environment").not.toContain(
      "egressEnv",
    );
    expect(call).toContain("external: false");
    expect(call).toContain("image: '${imageRegistry}/helix-jobs:${imageTag}'");
  });

  it("the listen port agrees across Bicep and image", () => {
    const call = appCall("jobsApp");
    expect(call).toContain("targetPort: 3003");
    const port = envEntries(call).find((e) => e.name === "JOBS_PORT");
    expect(port?.value, "the service must listen on the port ingress forwards to").toBe("'3003'");
    expect(JOBS_DOCKERFILE).toMatch(/^EXPOSE 3003$/m);
  });

  it("one replica on a Single-revision rollout — the at-most-two-processes envelope", () => {
    const call = appCall("jobsApp");
    expect(call).toMatch(/minReplicas: 1/);
    expect(call).toMatch(/maxReplicas: 1/);
    expect(CONTAINERAPP).toContain("activeRevisionsMode: 'Single'");
  });

  it("exactly three /health probes, and the module unions them only when supplied", () => {
    const call = appCall("jobsApp");
    const probes = [...call.matchAll(/type: '(Startup|Liveness|Readiness)'/g)].map((m) => m[1]!);
    expect(probes).toEqual(["Startup", "Liveness", "Readiness"]);
    const httpGets = [...call.matchAll(/httpGet: \{([^}]*)\}/g)];
    expect(httpGets, "every probe must be an httpGet against /health").toHaveLength(3);
    for (const httpGet of httpGets) {
      expect(httpGet[1]).toContain("path: '/health'");
      expect(httpGet[1]).toContain("port: 3003");
    }
    expect(CONTAINERAPP).toContain("empty(probes) ? {} : { probes: probes }");
  });

  it("the jobs endpoint is the internal-ingress FQDN form, and the template reports both it and the FQDN", () => {
    expect(MAIN).toContain(
      "var jobsEndpoint = 'https://${jobsAppName}.internal.${appsEnv.outputs.defaultDomain}'",
    );
    expect(varBlock("jobsServerConfig")).toContain("endpoint: jobsEndpoint");
    expect(MAIN).toMatch(
      /output jobsEndpoint string = deployApps && deployJobs \? jobsEndpoint : ''/,
    );
    expect(MAIN).toMatch(/output jobsFqdn string = jobsApp\.\?outputs\.fqdn \?\? ''/);
  });
});

describe("callback destinations never cross tiers", () => {
  it("each tier's callback var references only that tier's app", () => {
    const prodLine = MAIN.match(/var jobsEdgeProdCallbackUrl = .*/)![0];
    expect(prodLine, "prod callbacks must be built from the edge app's FQDN").toContain("edgeApp");
    expect(prodLine).not.toContain("devGateway");

    const devLine = MAIN.match(/var jobsEdgeDevCallbackUrl = .*/)![0];
    expect(devLine, "dev callbacks must be built from the dev-gateway app's FQDN").toContain(
      "devGatewayApp",
    );
    expect(devLine).toContain("devGatewayAppName");
    expect(devLine, "a dev callback must never reference the edge app").not.toContain("edgeApp");
    expect(devLine, "a dev callback must never name the edge host").not.toContain("-edge'");

    // Not swapped at the consumer either.
    const env = envEntries(appCall("jobsApp"));
    expect(env.find((e) => e.name === "JOBS_EDGE_PROD_URL")?.value).toBe(
      "jobsServer.edgeProdCallbackUrl",
    );
    expect(env.find((e) => e.name === "JOBS_EDGE_DEV_URL")?.value).toBe(
      "jobsServer.edgeDevCallbackUrl",
    );
  });

  it("the dev fallback host is the dev-gateway's own name, never the edge's", () => {
    expect(MAIN).toContain("var devGatewayAppName = '${namePrefix}-dev-gateway'");
    expect(appCall("devGatewayApp")).toMatch(/name: devGatewayAppName/);
    expect(appCall("edgeApp")).toMatch(/name: '\$\{namePrefix\}-edge'/);
    const devLine = MAIN.match(/var jobsEdgeDevCallbackUrl = .*/)![0];
    expect(devLine).not.toContain("${namePrefix}-edge");
  });
});

describe("serving, retiring and the fully disabled deployment", () => {
  it("the state param has exactly the two serving states, and retiring withdraws the catalogue and closes intake", () => {
    expect(MAIN).toMatch(
      /@allowed\(\['serving', 'retiring'\]\)\s*\nparam jobsServerState string = 'serving'/,
    );
    expect(MAIN).toMatch(/\nparam jobsIntakeOpen bool = true\n/);
    const configBlock = varBlock("jobsServerConfig");
    expect(configBlock).toContain("state: jobsServerState");
    expect(configBlock).toContain("accepting: jobsServerState == 'serving' && jobsIntakeOpen");

    // The edge projection carries no state: routing, credentials and the
    // service stay in place while retiring — only the catalogue changes.
    for (const [, path] of projection("edgeJobsConfig").fields) {
      expect(path).not.toContain("state");
    }

    // Evaluated: a retiring (non-accepting) entry still parses, still routes,
    // and advertises nothing.
    const retiring: Record<string, unknown> = {
      ...FULL_ENTRY,
      state: "retiring",
      accepting: false,
    };
    const retiringCatalogue = resolveJobsCatalogueServers({
      PORTAL_JOBS_CATALOGUE: evaluateMap(projection("portalJobsCatalogue").fields, {
        jobs: retiring,
      }),
    });
    expect(advertisedJobTypes(retiringCatalogue)).toEqual([]);
    const retiringEdge = loadEdgeJobsConfig({
      EDGE_JOBS_CONFIG: evaluateMap(projection("edgeJobsConfig").fields, { jobs: retiring }),
    });
    expect(Object.keys(retiringEdge.servers)).toEqual(["jobs"]);
    expect(retiringEdge.servers.jobs?.endpoint).toBe(SAMPLE_ENDPOINT);
    // The edge's document is byte-identical to the serving one: retirement
    // changes no route and no credential.
    expect(evaluateMap(projection("edgeJobsConfig").fields, { jobs: retiring })).toBe(
      evaluateMap(projection("edgeJobsConfig").fields, { jobs: FULL_ENTRY }),
    );
    // A retiring entry that claims open intake is refused by the shared schema.
    expect(JobsServerEntrySchema.safeParse({ ...retiring, accepting: true }).success).toBe(false);
  });

  it("the jobs service's intake follows the template's derivation for every state", () => {
    // `accepting: jobsServerState == 'serving' && jobsIntakeOpen`, evaluated
    // for each combination and fed through the real container-app env to the
    // real loader.
    const cases: Array<[string, boolean, boolean]> = [
      ["serving", true, true],
      ["serving", false, false],
      ["retiring", true, false],
      ["retiring", false, false],
    ];
    for (const [state, intakeOpen, expected] of cases) {
      const accepting = state === "serving" && intakeOpen;
      expect(accepting).toBe(expected);
      const config = loadJobsConfig(jobsAppEnv({ ...FULL_ENTRY, state, accepting }));
      expect(config.accepting, `${state} with jobsIntakeOpen=${intakeOpen}`).toBe(expected);
    }
  });

  it("a fully disabled deployment evaluates to the empty map everywhere", () => {
    expect(MAIN).toContain("var jobsServers = deployJobs ? { jobs: jobsServerConfig } : {}");
    for (const name of ["edgeJobsConfig", "portalJobsConfig", "portalJobsCatalogue"]) {
      expect(evaluateMap(projection(name).fields, {})).toBe('{"servers":{}}');
    }

    // The loaders treat an absent variable as the disabled installation.
    expect(Object.keys(loadEdgeJobsConfig({}).servers)).toEqual([]);
    expect(resolvePortalJobsDeliveryConfig({})).toBeNull();
    expect(resolveJobsCatalogueServers({})).toEqual({ servers: {} });
    expect(() =>
      assertDeliveryTargetsMatch(
        resolveJobsCatalogueServers({}),
        resolvePortalJobsDeliveryConfig({}),
      ),
    ).not.toThrow();

    // Statically, every jobs addition sits behind the deployJobs gate.
    for (const name of ["edgeApp", "devGatewayApp"]) {
      const call = appCall(name);
      expect(call).toContain("deployJobs ? { 'jobs-config': { value: edgeJobsConfig } } : {}");
      expect(call).toContain(
        "deployJobs ? [{ name: 'EDGE_JOBS_CONFIG', secretRef: 'jobs-config' }] : []",
      );
    }
    const portalCall = appCall("portalApp");
    expect(portalCall).toContain(
      "deployJobs ? { 'jobs-config': { value: portalJobsConfig } } : {}",
    );
    expect(portalCall).toMatch(
      /deployJobs\s*\?\s*\[\s*\{\s*name: 'PORTAL_JOBS_CONFIG', secretRef: 'jobs-config'\s*\}\s*\{\s*name: 'PORTAL_JOBS_CATALOGUE', value: portalJobsCatalogue\s*\}\s*\]\s*:\s*\[\]/,
    );
    expect(MAIN).toMatch(
      /module jobsApp 'modules\/containerapp\.bicep' = if \(deployApps && deployJobs\)/,
    );

    // The disabled roots arm composes three empty strings and no refusal.
    const disabledArm = MAIN.match(
      /: \{\n {6}edgeToJobs: ''\n {6}jobsToEdge: ''\n {6}portalToJobs: ''\n {4}\}/,
    );
    expect(disabledArm, "jobsRoots' false arm must be the three empty strings").not.toBeNull();
    expect(disabledArm![0]).not.toContain("fail(");
    expect(MAIN).toContain("jobsEdgeToJobsRoot: deployJobs ? jobsRoots.edgeToJobs : ''");
    expect(MAIN).toContain("jobsJobsToEdgeRoot: deployJobs ? jobsRoots.jobsToEdge : ''");
    expect(MAIN).toContain("jobsPortalToJobsRoot: deployJobs ? jobsRoots.portalToJobs : ''");
  });
});

describe("the signing roots' provenance", () => {
  /** The jobsRoots var — the guard chain and the disabled arm. */
  function jobsRootsBlock(): string {
    const block = MAIN.match(/var jobsRoots = deployJobs[\s\S]*?\n {4}\}/);
    expect(block, "main.bicep must define jobsRoots — extend this test's parser").not.toBeNull();
    return block![0];
  }

  it("the guard refuses missing roots by naming the env vars, and never echoes a root back", () => {
    const block = jobsRootsBlock();
    const messages = [...block.matchAll(/fail\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g)].map((m) => m[1]!);
    expect(messages, "the jobsRoots guard must have exactly three fail() arms").toHaveLength(3);
    expect(messages[0]).toContain("HELIX_JOBS_EDGE_TO_JOBS_ROOT");
    expect(messages[0]).toContain("HELIX_JOBS_JOBS_TO_EDGE_ROOT");
    expect(messages[0]).toContain("HELIX_JOBS_PORTAL_TO_JOBS_ROOT");
    // A refusal that echoed the supplied value would put the secret in the
    // apply's error output.
    for (const message of messages) {
      expect(message).not.toMatch(/\$\{jobs\w*Root\}/);
    }
  });

  it("the shape guard admits exactly the base64 of 32 bytes", () => {
    // The apply-time guard is a length/padding heuristic; the services' own
    // boot parse is the precise check. Pin the heuristic and prove it
    // separates 32 bytes from its neighbours, so a malformed root fails the
    // apply instead of taking a service down at boot.
    expect(MAIN).toContain("length(root) == 44 && endsWith(root, '=') && !endsWith(root, '==')");
    const admits = (root: string) =>
      root.length === 44 && root.endsWith("=") && !root.endsWith("==");
    for (let bytes = 28; bytes <= 36; bytes += 1) {
      expect(admits(randomBytes(bytes).toString("base64")), `${bytes} random bytes`).toBe(
        bytes === 32,
      );
    }
    // A base64url root (no padding) is refused too — the services decode
    // standard base64 only.
    expect(admits(randomBytes(32).toString("base64url"))).toBe(false);
  });

  it("the bootstrap params file reads each root from exactly that env var", () => {
    expect(BOOTSTRAP_PARAMS).toContain(
      "param jobsEdgeToJobsRoot = readEnvironmentVariable('HELIX_JOBS_EDGE_TO_JOBS_ROOT', '')",
    );
    expect(BOOTSTRAP_PARAMS).toContain(
      "param jobsJobsToEdgeRoot = readEnvironmentVariable('HELIX_JOBS_JOBS_TO_EDGE_ROOT', '')",
    );
    expect(BOOTSTRAP_PARAMS).toContain(
      "param jobsPortalToJobsRoot = readEnvironmentVariable('HELIX_JOBS_PORTAL_TO_JOBS_ROOT', '')",
    );
  });

  it("the vault lands each root under its secret name, and the steady-state params read the same names back", () => {
    const optionalBlock = KV_SECRETS.match(/var optionalSecrets = \{([\s\S]*?)\n\}/);
    expect(optionalBlock, "kv-secrets.bicep must define optionalSecrets").not.toBeNull();
    expect(optionalBlock![1]).toContain("'jobs-edge-to-jobs-root': jobsEdgeToJobsRoot");
    expect(optionalBlock![1]).toContain("'jobs-jobs-to-edge-root': jobsJobsToEdgeRoot");
    expect(optionalBlock![1]).toContain("'jobs-portal-to-jobs-root': jobsPortalToJobsRoot");
    // The optional-secrets loop is what makes these writes skip-empty.
    expect(KV_SECRETS).toMatch(
      /for item in filter\(items\(optionalSecrets\), e => !empty\(e\.value\)\)/,
    );
    expect(STEADY_PARAMS).toMatch(
      /\/\/ param jobsEdgeToJobsRoot = az\.getSecret\([^)]*'jobs-edge-to-jobs-root'\)/,
    );
    expect(STEADY_PARAMS).toMatch(
      /\/\/ param jobsJobsToEdgeRoot = az\.getSecret\([^)]*'jobs-jobs-to-edge-root'\)/,
    );
    expect(STEADY_PARAMS).toMatch(
      /\/\/ param jobsPortalToJobsRoot = az\.getSecret\([^)]*'jobs-portal-to-jobs-root'\)/,
    );
  });
});
