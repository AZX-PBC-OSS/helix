import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `scripts/ensure-db.mjs`'s jobs arm, against the real script.
 *
 * The script's observable behaviour is the processes it spawns — psql and
 * pnpm — so the suite runs the real CLI with those two tools shimmed on PATH:
 * each shim records its argv and the DSN-bearing env it received, and answers
 * the one query the script asks (the database-exists probe). What nothing else
 * pins: the ONE provisioning definition running with the stack's substituted
 * database names, roles being provisioned before either migration, and the
 * jobs migration running through the `helix_jobs_migrate` identity on the
 * jobs' own database — the migration authority that never rides a runtime
 * environment.
 */

const ENSURE_DB_SCRIPT = fileURLToPath(new URL("../../../scripts/ensure-db.mjs", import.meta.url));
const ROLES_SQL = fileURLToPath(
  new URL("../../../.devcontainer/db-init/01-roles.sql", import.meta.url),
);

const OWNER_DSN = "postgresql://helix:helix@db:5432/helix_smoke";
const JOBS_DSN = "postgresql://helix_jobs:helix_jobs@db:5432/helix_jobs_smoke";

/** One shimmed tool invocation, as the shim recorded it. */
interface ShimCall {
  cmd: "psql" | "pnpm";
  args: string[];
  migrateUrl: string | null;
  databaseUrl: string | null;
}

/**
 * A shim body: records its argv plus the two DSN-bearing env keys it received,
 * and prints the database-exists answer when probed with -tAc. It uses
 * `process.getBuiltinModule` so the file parses under either module syntax.
 */
function shimSource(existsProbeAnswer: boolean, exitCode: number): string {
  return `#!/usr/bin/env node
const fs = process.getBuiltinModule("node:fs");
fs.appendFileSync(
  process.env.SHIM_LOG,
  JSON.stringify({
    cmd: process.argv[1]?.split("/").pop(),
    args: process.argv.slice(2),
    migrateUrl: process.env.JOBS_MIGRATE_DATABASE_URL ?? null,
    databaseUrl: process.env.DATABASE_URL ?? null,
  }) + "\\n",
);
if (process.argv.includes("-tAc") && ${JSON.stringify(existsProbeAnswer)}) process.stdout.write("1\\n");
process.exit(${exitCode});
`;
}

/**
 * Run the real script with psql/pnpm shimmed and the child env scrubbed to
 * PATH/HOME/SHIM_LOG, so every DATABASE_URL or JOBS_MIGRATE_DATABASE_URL a
 * shim sees was put there by the script itself. `migrationExit` simulates a
 * failing migration command.
 */
function runEnsureDb(args: string[], migrationExit = 0): ShimCall[] {
  const dir = mkdtempSync(join(tmpdir(), "ensure-db-shims-"));
  try {
    const log = join(dir, "calls.log");
    for (const name of ["psql", "pnpm"]) {
      writeFileSync(
        join(dir, name),
        shimSource(name === "psql", name === "pnpm" ? migrationExit : 0),
        { mode: 0o755 },
      );
    }
    execFileSync(process.execPath, [ENSURE_DB_SCRIPT, ...args], {
      encoding: "utf8",
      env: {
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        HOME: process.env.HOME ?? "",
        SHIM_LOG: log,
      },
    });
    return readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line)
      .map((line) => JSON.parse(line) as ShimCall);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the jobs database's startup prerequisite (scripts/ensure-db.mjs)", () => {
  it("provisions the stack's database names and migrates through the migration identity", () => {
    const calls = runEnsureDb([OWNER_DSN, JOBS_DSN]);

    // The ONE provisioning definition runs with this stack's database names
    // substituted, stopping at the first failed statement.
    const roles = calls.find((c) => c.cmd === "psql" && c.args.includes(ROLES_SQL));
    if (!roles) throw new Error("the roles provisioning psql call never ran");
    expect(roles.args).toContain("ON_ERROR_STOP=1");
    expect(roles.args).toContain("platform_db=helix_smoke");
    expect(roles.args).toContain("jobs_db=helix_jobs_smoke");

    // Roles must exist before either migration: the migrations' per-table
    // GRANTs are guarded on the roles' presence.
    const firstMigration = calls.findIndex((c) => c.cmd === "pnpm");
    expect(firstMigration).toBeGreaterThan(0);
    expect(calls.indexOf(roles)).toBeLessThan(firstMigration);

    // The jobs migration runs through the separate migration identity —
    // derived for that one command, same private database — never the
    // runtime role, which holds no DDL authority.
    const jobsMigration = calls.find((c) => c.args.includes("@azx-pbc/jobs"));
    if (!jobsMigration) throw new Error("the jobs migration pnpm call never ran");
    const migrate = new URL(jobsMigration.migrateUrl ?? "");
    expect(migrate.username).toBe("helix_jobs_migrate");
    expect(migrate.password).toBe("helix_jobs_migrate");
    expect(migrate.pathname).toBe("/helix_jobs_smoke");
    // No other spawned process receives the migration identity.
    for (const call of calls) {
      if (call !== jobsMigration) expect(call.migrateUrl).toBeNull();
    }

    // The platform migration keeps the owner DSN, name-only moved.
    const portalMigration = calls.find((c) => c.args.includes("@azx-pbc/portal"));
    if (!portalMigration) throw new Error("the portal migration pnpm call never ran");
    expect(new URL(portalMigration.databaseUrl ?? "").pathname).toBe("/helix_smoke");
  });

  it("without a jobs DSN no jobs migration runs and no migration identity is minted", () => {
    const calls = runEnsureDb([OWNER_DSN]);

    expect(calls.some((c) => c.args.includes("@azx-pbc/jobs"))).toBe(false);
    expect(calls.every((c) => c.migrateUrl === null)).toBe(true);
    // The roles provisioning still hardens the well-known jobs database.
    const roles = calls.find((c) => c.args.includes(ROLES_SQL));
    expect(roles?.args).toContain("jobs_db=helix_jobs");
  });

  it("a failed migration command fails the prep — it never looks like a success", () => {
    expect(() => runEnsureDb([OWNER_DSN, JOBS_DSN], 1)).toThrow();
  });

  it("refuses an unsafe jobs database name before provisioning anything", () => {
    expect(() =>
      runEnsureDb([OWNER_DSN, "postgresql://helix_jobs:helix_jobs@db:5432/helix_jobs;drop"]),
    ).toThrow(/unsafe database name: helix_jobs;drop/);
  });

  it("refuses the cluster's system databases in either slot", () => {
    // The roles file's CONNECT hardening (REVOKE ... FROM PUBLIC) applied to
    // `postgres` — or a template — would break the cluster's own maintenance
    // defaults for every database user. Never a provisioning target.
    for (const reserved of ["postgres", "template0", "template1"]) {
      expect(() => runEnsureDb([`postgresql://helix:helix@db:5432/${reserved}`, JOBS_DSN])).toThrow(
        new RegExp(
          `refusing to provision the platform slot with the system database "${reserved}"`,
        ),
      );
      expect(() =>
        runEnsureDb([OWNER_DSN, `postgresql://helix_jobs:helix_jobs@db:5432/${reserved}`]),
      ).toThrow(
        new RegExp(`refusing to provision the jobs slot with the system database "${reserved}"`),
      );
    }
  });

  it("refuses an unparseable jobs DSN naming the contract, not a bare TypeError", () => {
    // Every sibling refusal names its input; a bare `Invalid URL` from the URL
    // constructor would not.
    expect(() => runEnsureDb([OWNER_DSN, "postgresql://ho st/db"])).toThrow(
      /the jobs DSN is not a parseable connection string/,
    );
  });

  it("refuses a jobs DSN that names the platform database — the role split must not invert onto it", () => {
    // The roles definition's jobs statements are written for the jobs database.
    // Applied with jobs_db == platform_db (a copy-paste mistake: the login
    // updated, the database name not), its CONNECT and CREATE grants for the
    // jobs identities land on the platform database and the jobs migration
    // runs into it — the boundary the file exists to enforce inverts, and the
    // prep exits 0. Each name is refused in isolation; the relation between
    // them is the same premise, checked before anything runs.
    const JOBS_DSN_SAME_DATABASE = "postgresql://helix_jobs:helix_jobs@db:5432/helix_smoke";
    let calls: ShimCall[] | undefined;
    let refused: unknown;
    try {
      calls = runEnsureDb([OWNER_DSN, JOBS_DSN_SAME_DATABASE]);
    } catch (error) {
      refused = error;
    }
    if (refused instanceof Error) {
      expect(refused.message).toMatch(/helix_smoke/);
      return;
    }
    // No guard today — show what the prep actually did: the recorded spawns
    // carry the jobs migration scheduled INTO the platform database.
    expect(calls).toBeUndefined();
  });

  it("refuses an owner DSN that collides with the default jobs database name", () => {
    // With no jobs DSN the substitution still defaults to jobs_db=helix_jobs,
    // so an owner DSN naming exactly that database is the same jobs_db ==
    // platform_db contradiction the collision guard exists for — the roles
    // definition's jobs statements and the portal migrations would land on
    // one database wearing both roles, exiting 0. The relation between the
    // two names holds whatever source the jobs name came from.
    expect(() => runEnsureDb(["postgresql://helix:helix@db:5432/helix_jobs"])).toThrow(
      /the jobs database must be private/,
    );
  });

  it("refuses a jobs DSN that is not this stack's jobs database — the prep must not migrate into another store", () => {
    // The equality guard refuses jobs_db == platform_db, but the isolation
    // premise is wider: this prep exists so a stack's rows never touch the
    // developer's databases, and the jobs migration WRITES (schema and
    // migration bookkeeping) into whatever database its DSN names. The
    // likeliest wrong argument is the developer's own runtime DSN — the one
    // their shell already holds: helix_jobs, the dev stack's well-known jobs
    // database, while prepping helix_smoke. Nothing refuses it today, so the
    // stack's migration runs into the developer's store and exits 0 — the
    // same write-into-someone-else's-store the resolver prevents for every
    // other DSN by moving names onto the stack's own pairings. The refusal
    // must name the foreign database: the input that identifies this
    // occurrence.
    const DEV_JOBS_STORE_DSN = "postgresql://helix_jobs:helix_jobs@db:5432/helix_jobs";
    let calls: ShimCall[] | undefined;
    let refused: unknown;
    try {
      calls = runEnsureDb([OWNER_DSN, DEV_JOBS_STORE_DSN]);
    } catch (error) {
      refused = error;
    }
    if (refused instanceof Error) {
      expect(refused.message).toMatch(/helix_jobs(?![_\w])/);
      return;
    }
    // No guard today — show what the prep actually did: the recorded spawns
    // carry the jobs migration scheduled INTO the developer's own store.
    expect(calls).toBeUndefined();
  });

  it("refuses fail-closed when the platform database is outside the helix convention", () => {
    // The pairing check can only verify isolation for a platform database the
    // convention can pair (helix or helix_<suffix>). With the pairing
    // underivable, the prep cannot know the jobs DSN's store is isolated, so
    // it refuses before anything runs rather than migrating the jobs schema
    // into an unverified store — the isolation check failing is itself a
    // refusal, never a guess.
    expect(() => runEnsureDb(["postgresql://helix:helix@db:5432/platform_db", JOBS_DSN])).toThrow(
      /cannot verify the jobs database pairing for the platform database "platform_db"/,
    );
  });

  it("refuses a platform DSN that names a jobs-store database — the jobs namespace is not the platform's to wear", () => {
    // The resolver refuses a suffix whose platform database would wear a
    // jobs-store name, so the ordinary workflow never hands the prep such a
    // DSN. But the CLI is a documented surface, and a hand-typed pair can be
    // namespace-internal AND self-consistent: the platform slot wearing
    // "helix_jobs_x" with "helix_jobs_jobs_x" as the jobs DSN — the exact
    // pairing jobsDatabaseName derives for it — passes every existing guard
    // (the names are distinct, the pairing verifies). The portal migration
    // then writes the platform schema into a database the jobs plane owns,
    // exit 0. The namespace predicate is shared (isJobsStoreName, the one
    // convention's other face), so the prep can refuse what the resolver
    // refuses: a platform name inside the jobs namespace.
    const JOBS_STORE_PLATFORM_DSN = "postgresql://helix:helix@db:5432/helix_jobs_x";
    const NAMESPACE_INTERNAL_JOBS_DSN =
      "postgresql://helix_jobs:helix_jobs@db:5432/helix_jobs_jobs_x";
    let calls: ShimCall[] | undefined;
    let refused: unknown;
    try {
      calls = runEnsureDb([JOBS_STORE_PLATFORM_DSN, NAMESPACE_INTERNAL_JOBS_DSN]);
    } catch (error) {
      refused = error;
    }
    if (refused instanceof Error) {
      expect(refused.message).toMatch(/helix_jobs_x/);
      return;
    }
    // No guard today — the evidence is the recorded spawns: the portal
    // migration scheduled into a jobs-store database, exit 0.
    expect(calls).toBeUndefined();
  });

  it("refuses an unparseable owner DSN naming the contract, not a bare TypeError", () => {
    // The jobs slot's refusal names its input and this prep's use of it —
    // "every sibling refusal names its input; a bare Invalid URL from the URL
    // constructor would not". The owner slot is the same premise: its DSN is
    // what every provisioning step and the platform migration run through,
    // from the CLI argument or the ambient DATABASE_URL, and it is the input
    // that identifies the occurrence.
    expect(() => runEnsureDb(["postgresql://ho st/db"])).toThrow(
      /not a parseable connection string/,
    );
  });
});
