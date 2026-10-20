import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The Azure jobs-migration wiring is a chain of agreements no deploy runs in
 * a test: main.bicep composes the two jobs DSNs and passes them to
 * kv-secrets; kv-secrets writes them to kv-platform by name;
 * jobs-migrate-job.bicep declares the Manual job that runs the helix-jobs
 * image's azure migration entry; that entry reads one secret by name and
 * runs the package's own `db:migrate` command. Nothing executes these files
 * together (Azure only), so the chain is pinned statically, the way
 * `provisioning-parity.test.ts` pins the SQL/Bicep ACL agreements and
 * `imagePackaging.test.ts` pins the image's wiring.
 *
 * The contracts, in custody terms (spec criterion 69, ADR-0008):
 *
 * - The migration job's ONLY credential is the migration identity's DSN,
 *   read from the vault at run time; it never holds the runtime DSN or the
 *   schema-owner credential.
 * - No runtime container (edge/portal/egress/dev-gateway) receives any jobs
 *   database credential.
 * - The job is Manual: migrations run when an operator triggers them, never
 *   at startup and never on a schedule.
 * - The jobs database itself is declared UNCONDITIONALLY — an apply must
 *   never be able to delete the store (retirement rules, background-jobs
 *   design §8).
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function read(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

const MAIN = read("infra/azure/main.bicep");
const KV_SECRETS = read("infra/azure/modules/kv-secrets.bicep");
const JOBS_MIGRATE_JOB = read("infra/azure/modules/jobs-migrate-job.bicep");
const JOBS_PACKAGE: { scripts?: Record<string, string> } = JSON.parse(
  read("apps/jobs/package.json"),
);
const BOOTSTRAP_PARAMS = read("infra/azure/main.bootstrap.bicepparam");

const RUNTIME_DSN_SECRET = "jobs-database-url";
const MIGRATE_DSN_SECRET = "jobs-migrate-database-url";

/**
 * The composed DSN and bootstrap-password variables the custody pins must
 * also refuse: a containerapp call that received one as a literal `value`
 * would carry the credential in the app definition (readable at rest) while
 * never mentioning the vault secret name the secret-name scan looks for.
 */
const JOBS_CREDENTIAL_VARS = [
  "jobsDbConn",
  "jobsMigrateDbConn",
  "jobsDbPassword",
  "jobsMigrateDbPassword",
];

describe("the jobs migration job runs the package's own azure entry", () => {
  it("the package carries db:migrate:azure, and the job's command is that script", () => {
    const script = JOBS_PACKAGE.scripts?.["db:migrate:azure"];
    expect(script, "apps/jobs must declare the db:migrate:azure script the job runs").toBeDefined();
    expect(existsSync(path.join(REPO_ROOT, "apps/jobs/scripts/migrate-azure.ts"))).toBe(true);

    const command = moduleCommand(JOBS_MIGRATE_JOB, "infra/azure/modules/jobs-migrate-job.bicep");
    expect(command).toEqual(script!.split(" "));
    expect(script).toBe("node --import tsx scripts/migrate-azure.ts");
  });

  it("the azure entry's child is the package's own db:migrate command", () => {
    const source = read("apps/jobs/scripts/migrate-azure.ts");
    const child = source.match(/const MIGRATE_COMMAND = \[([^\]]+)\] as const/);
    expect(child, "migrate-azure.ts must name its child command in MIGRATE_COMMAND").not.toBeNull();
    const command = ["node", ...child![1]!.split(",").map((p) => JSON.parse(p.trim()) as string)];
    expect(command).toEqual(JOBS_PACKAGE.scripts?.["db:migrate"]?.split(" "));
  });
});

describe("the migration job's credential custody", () => {
  it("the entry reads exactly the kv-platform secret kv-secrets writes, by the same name", () => {
    const secretName = read("apps/jobs/scripts/migrate-azure.ts").match(
      /const SECRET_NAME = "([a-z-]+)"/,
    );
    expect(secretName, "migrate-azure.ts must name its secret in SECRET_NAME").not.toBeNull();
    expect(secretName![1]).toBe(MIGRATE_DSN_SECRET);
    expect(
      KV_SECRETS.includes(`'${MIGRATE_DSN_SECRET}':`),
      "kv-secrets.bicep must write the secret name the azure entry reads",
    ).toBe(true);
  });

  it("the job's env is exactly the vault URL and its identity — no DSN, no admin credential", () => {
    const env = moduleEnv(JOBS_MIGRATE_JOB, "infra/azure/modules/jobs-migrate-job.bicep");
    expect(env.map((e) => e.name).sort()).toEqual(["AZURE_CLIENT_ID", "PLATFORM_VAULT_URL"]);
    expect(
      env.some((e) => /password|database.url|admin/i.test(e.value ?? "")),
      "the job definition carries a credential-shaped value; the DSN is read at run time",
    ).toBe(false);
  });

  it("the job is manual, unretrying, and single-threaded", () => {
    expect(JOBS_MIGRATE_JOB).toMatch(/triggerType: 'Manual'/);
    expect(JOBS_MIGRATE_JOB).toMatch(/replicaRetryLimit: 0/);
    expect(JOBS_MIGRATE_JOB).toMatch(/parallelism: 1/);
  });

  it("the job's identity is its own — not the portal migrate job's", () => {
    expect(JOBS_MIGRATE_JOB).toContain("name: '${namePrefix}-jobs-migrate-id'");
    expect(read("infra/azure/modules/migrate-job.bicep")).toContain(
      "name: '${namePrefix}-migrate-id'",
    );
  });

  it("the job's only permission is reading the platform vault", () => {
    // Key Vault Secrets User (the same one-role shape the platform migrate
    // job holds) — and no other role assignment in the module.
    expect(JOBS_MIGRATE_JOB).toContain(
      "var kvSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'",
    );
    expect(JOBS_MIGRATE_JOB.match(/roleAssignments@/g)?.length).toBe(1);
  });
});

describe("main.bicep wires the jobs DSNs and the job", () => {
  it("the job runs the helix-jobs image from the same single-sourced registry/tag as the apps", () => {
    expect(MAIN).toContain("image: '${imageRegistry}/helix-jobs:${imageTag}'");
    // In the apps environment — the VNet the private endpoints are reachable from.
    expect(MAIN).toMatch(/jobsMigrateJob[\s\S]*?acaEnvId: appsEnv\.outputs\.environmentId/);
  });

  it("the job module is gated on deployApps && deployJobs", () => {
    expect(MAIN).toMatch(
      /module jobsMigrateJob 'modules\/jobs-migrate-job\.bicep' = if \(deployApps && deployJobs\)/,
    );
  });

  it("both composed DSNs derive the database name from the postgres module's declaration", () => {
    // One source of truth for the store's name — the same declaration the
    // provisioning-parity test holds against sql/01-roles.sql.
    expect(
      MAIN.match(/postgresql:\/\/helix_jobs:[^`]*\$\{postgres\.outputs\.jobsDatabaseName\}/),
    ).not.toBeNull();
    expect(
      MAIN.match(
        /postgresql:\/\/helix_jobs_migrate:[^`]*\$\{postgres\.outputs\.jobsDatabaseName\}/,
      ),
    ).not.toBeNull();
  });

  it("deployJobs defaults to on — a stock apply deploys the capability", () => {
    // A default of false would silently drop the jobs plane (its DSN secrets
    // and its migrate job) from every fresh deployment; parking the feature
    // is the operator's explicit flip, never the silent default.
    expect(MAIN).toMatch(/param deployJobs bool = true/);
  });

  it("a fully-disabled install composes neither DSN, so the vault lands no jobs secret", () => {
    // kv-secrets filters empties, so the composition's false arm is what
    // keeps a deployJobs=false install's vault free of jobs DSNs.
    for (const varName of ["jobsDbConn", "jobsMigrateDbConn"]) {
      // A line-start comment may sit between the composition and the next
      // declaration; the capture must stop at it too, or the trailing-`''`
      // check below reads the comment's last line instead of the false arm.
      const block = MAIN.match(
        new RegExp(`var ${varName} = [\\s\\S]*?(?=\\n(?:var|module|resource|output)\\b|\\n//)`),
      );
      expect(block, `main.bicep must define ${varName}`).not.toBeNull();
      expect(block![0]).toMatch(new RegExp(`^var ${varName} = deployJobs\\s*\\?`));
      expect(block![0].trimEnd(), `${varName} must compose nothing when deployJobs is off`).toMatch(
        /: ''$/,
      );
    }
  });

  it("composing a jobs DSN from an empty password fails the apply", () => {
    // An existing steady-state install upgrades this template with both jobs
    // params unset; without this guard the apply would write an
    // unauthenticatable empty-password DSN into the vault. The refusal is the
    // operator's remediation, so it must name the env vars the bootstrap file
    // reads (pinned in "the fresh-install password path") — a rename on
    // either side dead-ends the upgrade.
    for (const varName of ["jobsDbConn", "jobsMigrateDbConn"]) {
      const block = MAIN.match(new RegExp(`var ${varName} = [\\s\\S]*?\\n\\w`));
      expect(block, `main.bicep must define ${varName}`).not.toBeNull();
      expect(block![0], `${varName} must refuse an empty-password composition`).toContain("fail(");
      for (const envName of ["HELIX_JOBS_DB_PASSWORD", "HELIX_JOBS_MIGRATE_DB_PASSWORD"]) {
        expect(block![0], `${varName}'s refusal must name the ${envName} remediation`).toContain(
          envName,
        );
      }
    }
  });

  it("the README's upgrade procedure starts the job name the module declares", () => {
    // The operator runs the documented `az containerapp job start` command
    // verbatim; a rename on either side silently breaks the procedure. Every
    // `<namePrefix>-jobs-…` reference in the README must be the name the
    // module declares — a partial drift on any occurrence passes a weaker
    // contains-check.
    const declared = JOBS_MIGRATE_JOB.match(
      /resource job 'Microsoft\.App\/jobs@[0-9-]+' = \{[\s\S]*?name: '\$\{namePrefix\}-([a-z-]+)'/,
    );
    expect(declared, "jobs-migrate-job.bicep must declare the job's name").not.toBeNull();
    const readmeRefs = [
      ...read("infra/azure/README.md").matchAll(/<namePrefix>-(jobs-[a-z-]+)/g),
    ].map((m) => m[1]!);
    expect(readmeRefs.length, "the README must reference the jobs migrate job").toBeGreaterThan(0);
    for (const ref of readmeRefs) {
      expect(ref, "the README's jobs-job reference must be the name the module declares").toBe(
        declared![1],
      );
    }
  });

  it("kv-secrets receives both DSNs and writes each only when non-empty", () => {
    expect(MAIN).toMatch(/jobsDatabaseUrl: jobsDbConn/);
    expect(MAIN).toMatch(/jobsMigrateDatabaseUrl: jobsMigrateDbConn/);
    expect(KV_SECRETS).toContain(`'${RUNTIME_DSN_SECRET}': jobsDatabaseUrl`);
    expect(KV_SECRETS).toContain(`'${MIGRATE_DSN_SECRET}': jobsMigrateDatabaseUrl`);
    // The optional-secrets loop is the only writer of all three conditional
    // DSNs, and it filters empties (a stock deploy lands no empty secret).
    expect(KV_SECRETS).toMatch(
      /resource optionalSecretResources [\s\S]*?for item in filter\(items\(optionalSecrets\), e => !empty\(e\.value\)\)/,
    );
    expect(KV_SECRETS).toContain("'edge-dev-database-url': edgeDevDatabaseUrl");
  });
});

describe("no runtime container receives a jobs database credential", () => {
  /**
   * ADR-0008's custody matrix: the jobs runtime DSN belongs to the jobs
   * container app — its ONE container reader, which receives it as the inline
   * `jobsServer.databaseUrl` secret — and the migration DSN to the jobs
   * migrate job. The edge, the portal, the egress service and the dev-gateway
   * never appear with either — neither as a Key Vault reference nor as an env
   * var — and the migration DSN secret name never reaches a
   * `containerapp.bicep` call at all.
   */
  it("no containerapp module call references a jobs DSN secret", () => {
    const appCalls = [
      ...MAIN.matchAll(
        /module (\w+) 'modules\/containerapp\.bicep'[\s\S]*?(?=\nmodule |\n\/\/ -{10,})/g,
      ),
    ];
    expect(appCalls.length, "main.bicep must still declare the container apps").toBeGreaterThan(0);
    const callNames = appCalls.map((call) => call[1]!);
    expect(callNames, "the jobsApp exemption below must actually cover a declared call").toContain(
      "jobsApp",
    );
    for (const call of appCalls) {
      const name = call[1]!;
      if (name === "jobsApp") {
        // The runtime DSN's one container reader. It receives the composed DSN
        // only as the inline jobsServer.databaseUrl secret — never the
        // migration credential, never a composed DSN or bootstrap password as
        // a literal value, never an inline DSN.
        expect(
          call[0],
          `the ${name} container app must not receive the jobs migration DSN secret`,
        ).not.toMatch(new RegExp(MIGRATE_DSN_SECRET));
        for (const varName of JOBS_CREDENTIAL_VARS) {
          expect(
            call[0],
            `the ${name} container app must not receive the jobs credential variable ${varName}`,
          ).not.toContain(varName);
        }
        expect(
          call[0],
          `the ${name} container app must not inline a jobs database DSN`,
        ).not.toContain("postgresql://helix_jobs");
        expect(
          call[0],
          `the ${name} container app must receive the runtime DSN only as the inline jobsServer.databaseUrl secret`,
        ).toContain("'jobs-database-url': { value: jobsServer.databaseUrl }");
        continue;
      }
      expect(
        call[0],
        `the ${name} container app must not receive a jobs database credential`,
      ).not.toMatch(new RegExp(RUNTIME_DSN_SECRET));
      expect(call[0]).not.toMatch(new RegExp(MIGRATE_DSN_SECRET));
      // The evasion vector the secret names cannot see: the composed DSN or a
      // bootstrap password passed as a literal env value — the credential at
      // rest in the app definition, no vault reference involved.
      for (const varName of JOBS_CREDENTIAL_VARS) {
        expect(
          call[0],
          `the ${name} container app must not receive the jobs credential variable ${varName}`,
        ).not.toContain(varName);
      }
      // …and the third vector: the DSN composed INLINE in the call (bypassing
      // the vars entirely). The prefix is the DSN's scheme + either jobs role
      // name — the names 01-roles.sql owns.
      expect(
        call[0],
        `the ${name} container app must not inline a jobs database DSN`,
      ).not.toContain("postgresql://helix_jobs");
      // The deployment map holds the runtime DSN (jobsServer.databaseUrl), so
      // a non-jobs app reading the map would carry the credential. Word
      // boundaries: edgeJobsConfig / portalJobsConfig / portalJobsCatalogue
      // legitimately appear in the gateway and portal calls and share no word
      // with these.
      for (const varName of ["jobsServer", "jobsServers", "jobsServerConfig"]) {
        expect(
          call[0],
          `the ${name} container app must not receive the jobs map variable ${varName}`,
        ).not.toMatch(new RegExp(`\\b${varName}\\b`));
      }
    }
  });

  it("neither migrate job composes a DSN from the schema-owner credential", () => {
    // The jobs migration runs under helix_jobs_migrate — never the admin.
    for (const [name, module] of [
      ["the jobs migrate job", JOBS_MIGRATE_JOB],
      ["main.bicep's jobs DSN composition", MAIN],
    ] as const) {
      expect(
        module.match(/postgresql:\/\/\$\{postgresAdminLogin\}|postgres-admin-password/)?.length ??
          0,
        `${name} must not use the schema-owner credential`,
      ).toBe(0);
    }
  });
});

describe("the fresh-install password path", () => {
  it("the bootstrap params file reads both jobs passwords from the environment", () => {
    expect(BOOTSTRAP_PARAMS).toMatch(
      /param jobsDbPassword = readEnvironmentVariable\('HELIX_JOBS_DB_PASSWORD', ''\)/,
    );
    expect(BOOTSTRAP_PARAMS).toMatch(
      /param jobsMigrateDbPassword = readEnvironmentVariable\('HELIX_JOBS_MIGRATE_DB_PASSWORD', ''\)/,
    );
  });
});

describe("the jobs database declaration", () => {
  it("postgres.bicep declares the store unconditionally", () => {
    // A gated (`resource … = if (…)`) declaration would DELETE the jobs
    // database — with its accepted work and retained records — when an
    // operator flipped the feature off. Retirement never deletes the store.
    const bicep = read("infra/azure/modules/postgres.bicep");
    expect(bicep).toMatch(
      /resource jobsDatabase 'Microsoft\.DBforPostgreSQL\/flexibleServers\/databases@\d{4}-\d{2}-\d{2}' = \{/,
    );
    expect(bicep).toContain("output jobsDatabaseName string = jobsDatabaseName");
  });
});

/** The `env` entries of a module file's container/job spec — a missing or unparseable env block fails loudly. */
function moduleEnv(bicep: string, sourceName: string): Array<{ name: string; value?: string }> {
  const env = bicep.match(/env: \[([\s\S]*?)\]\n/);
  expect(env, `${sourceName}: no env block found — extend this test's parser`).not.toBeNull();
  return [...env![1]!.matchAll(/\{ name: '([^']+)'(?:, value: ([^}]+?))? \}/g)].map((m) => ({
    name: m[1]!,
    value: m[2],
  }));
}

/** The `command` array of a module file's container — a missing command fails loudly. */
function moduleCommand(bicep: string, sourceName: string): string[] {
  const command = bicep.match(/command: \[([\s\S]*?)\]/);
  expect(
    command,
    `${sourceName}: no command array found — extend this test's parser`,
  ).not.toBeNull();
  return command![1]!
    .split("\n")
    .map((line) => line.trim().replaceAll("'", ""))
    .filter((line) => line.length > 0);
}
