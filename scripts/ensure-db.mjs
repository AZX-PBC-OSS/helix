#!/usr/bin/env node
// ensure-db.mjs — create + provision + migrate an isolated stack's databases,
// idempotently.
//
// Why this exists: a second local stack (scripts/stack-env.mjs) points its DSNs
// at `helix_<suffix>` instead of `helix`, so its rows — apps, sessions, the
// shared rate-limit and login-throttle counters — never touch the developer's
// database. That database has to exist and be migrated first.
//
// This is the same two-step vitest.globalSetup.ts already uses to stand up
// `helix_test`. Postgres roles are cluster-wide, so the least-privilege roles
// come from the ONE provisioning definition (.devcontainer/db-init/01-roles.sql)
// applied with the stack's database names substituted — it creates what is
// missing, hardens CONNECT on both databases, and is idempotent. The per-table
// GRANTs ride in with the migrations.
//
// The jobs plane's private database (`helix_jobs_<suffix>`, background-jobs
// design §8) is prepared the same way when a jobs DSN is supplied: the roles
// file creates and hardens it, then the jobs migration runs as the separate
// migration identity (`helix_jobs_migrate`) — never the runtime role, which
// holds no DDL authority. That is the explicit migration path the runtime
// never owns. Without a jobs DSN the provisioning still ensures the DEV-stack
// jobs database (`helix_jobs`) — existence and ACLs only, never a migration —
// a stated choice: the file is idempotent and the devcontainer's initdb runs
// the same defaults, so a disabled stack's marginal effect on any provisioned
// cluster is nil.
//
// Usage: node scripts/ensure-db.mjs <owner-dsn> [jobs-runtime-dsn]
//   e.g. node scripts/ensure-db.mjs postgresql://helix:helix@db:5432/helix_smoke \
//          postgresql://helix_jobs:helix_jobs@db:5432/helix_jobs_smoke
//
// The jobs DSN must name a database on the SAME Postgres server as the owner
// DSN — the provisioning reaches the jobs database through that connection;
// a cross-server override fails the jobs migration after the stray platform
// work is done. (scripts/stack-env.mjs mints it on the same server.)

import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { isJobsStoreName, jobsDatabaseName, withLogin } from "./dsn.mjs";

/** The one role/database provisioning definition, parametrized per database. */
const ROLES_SQL = fileURLToPath(new URL("../.devcontainer/db-init/01-roles.sql", import.meta.url));

/** The cluster's system databases: never provisioning targets. */
const RESERVED_DATABASES = new Set(["postgres", "template0", "template1"]);

/** Refuse a name the prep must never provision into, whatever the slot. */
function assertProvisionable(slot, dbName) {
  if (RESERVED_DATABASES.has(dbName)) {
    throw new Error(
      `refusing to provision the ${slot} slot with the system database "${dbName}" — ` +
        `the roles file's CONNECT hardening would apply to the cluster's maintenance defaults`,
    );
  }
}

/**
 * Create `dsn`'s database if absent, provision roles + ACLs for both it and
 * the jobs database, and apply the migrations. With `jobsDsn`, the jobs
 * database is provisioned and migrated too, through the migration identity.
 */
export function ensureDatabase(dsn, { quiet = false, jobsDsn } = {}) {
  let url;
  try {
    url = new URL(dsn);
  } catch {
    // The sibling refusals name the key and the contract; a bare TypeError
    // from the URL constructor would not. The owner DSN is the primary input:
    // every provisioning step and the platform migration run through it.
    throw new Error(
      `the owner DSN is not a parseable connection string — ` +
        `this prep's platform database argument (created, provisioned and migrated)`,
    );
  }
  const name = url.pathname.replace(/^\//, "");
  if (!name) throw new Error(`no database name in DSN: ${dsn}`);
  // Identifiers cannot be parameterised in CREATE DATABASE; refuse anything
  // that is not a plain identifier rather than interpolating it blindly.
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`unsafe database name: ${name}`);
  assertProvisionable("platform", name);

  // The jobs name is validated and related to the platform name BEFORE anything
  // runs. The roles definition's jobs statements are written for the jobs
  // database, so applied with jobs_db == platform_db they would land the jobs
  // identities' CONNECT and CREATE grants on the platform database — and the
  // jobs migration would create its schema in it — the boundary this prep
  // exists to enforce, inverted, exiting 0. A copy-paste DSN (the login
  // updated, the database name not) is exactly how it happens, from either
  // direction: the jobs DSN naming the platform database, or the platform DSN
  // naming the default jobs database. The relation holds whatever source the
  // jobs name came from.
  let jobsName = "helix_jobs";
  if (jobsDsn) {
    try {
      jobsName = new URL(jobsDsn).pathname.replace(/^\//, "");
    } catch {
      // The sibling refusals name the key and the contract; a bare TypeError
      // from the URL constructor would not.
      throw new Error(
        `the jobs DSN is not a parseable connection string — ` +
          `this prep's jobs database argument (provisioned and migrated as the jobs plane's store)`,
      );
    }
  }
  if (!/^[a-z_][a-z0-9_]*$/i.test(jobsName)) throw new Error(`unsafe database name: ${jobsName}`);
  assertProvisionable("jobs", jobsName);
  if (jobsName === name) {
    throw new Error(
      `the jobs database must be private: the platform database "${name}" is also ` +
        `${jobsDsn ? "the jobs DSN's" : "the default"} jobs database — the roles provisioning ` +
        `and migrations would invert the boundary onto it`,
    );
  }
  // The platform database must not wear a jobs-store name at all (helix_jobs,
  // helix_jobs_<x>): that namespace is the jobs pairing's own — the dev stack's
  // store and every resolved stack's — and the portal migration would write the
  // platform's schema into a database the jobs plane owns, exiting 0. The
  // resolver refuses suffixes that would mint such a name; the CLI is a
  // documented surface, so the prep holds the same line with the shared
  // predicate, whatever the jobs DSN's presence (the platform migration runs
  // regardless).
  if (isJobsStoreName(name)) {
    throw new Error(
      `the platform database must not be a jobs-store name: "${name}" is in the jobs ` +
        `namespace (helix_jobs, helix_jobs_<suffix>) — the platform schema would be written ` +
        `into a database the jobs plane owns`,
    );
  }
  // A supplied jobs DSN must name THIS stack's jobs database — the pairing the
  // stack resolution mints (helix ↔ helix_jobs, helix_<suffix> ↔
  // helix_jobs_<suffix>). The jobs migration WRITES schema and migration
  // bookkeeping into whatever database its DSN names, so a foreign one (the
  // likeliest wrong argument: the developer's own runtime DSN, already in their
  // shell) would have this prep migrate into another stack's store and exit 0.
  // With no jobs DSN no migration runs — the provisioning only ensures the
  // dev-stack jobs database's existence and ACLs — so no pairing applies there.
  // A platform name outside the convention leaves the pairing underivable:
  // the isolation check cannot be completed, so the prep refuses (fail closed)
  // rather than migrating into an unverified store.
  if (jobsDsn) {
    const expectedJobsName = jobsDatabaseName(name);
    if (expectedJobsName === null || jobsName !== expectedJobsName) {
      throw new Error(
        expectedJobsName === null
          ? `cannot verify the jobs database pairing for the platform database "${name}" — ` +
              `this prep provisions helix stacks (helix or helix_<suffix>); refusing rather ` +
              `than migrating the jobs schema into an unverified store`
          : `the jobs DSN must name this stack's jobs database "${expectedJobsName}" — it names ` +
              `"${jobsName}", whose schema the jobs migration would write into another store`,
      );
    }
  }

  // Connect to the cluster's default database to ask about / create the target.
  const admin = new URL(dsn);
  admin.pathname = "/postgres";
  const adminDsn = admin.toString();

  const exists =
    execFileSync("psql", [adminDsn, "-tAc", `SELECT 1 FROM pg_database WHERE datname='${name}'`], {
      encoding: "utf8",
    }).trim() === "1";

  if (!exists) {
    if (!quiet) console.error(`[ensure-db] creating ${name}`);
    execFileSync("psql", [adminDsn, "-c", `CREATE DATABASE ${name}`], { stdio: "ignore" });
  }

  // The one provisioning definition, with the stack's database names
  // substituted (the jobs database is created by the file itself when missing).
  // Roles must exist before either migration: the migrations' per-table GRANTs
  // are guarded on the roles' presence.
  if (!quiet) console.error(`[ensure-db] provisioning roles (platform ${name}, jobs ${jobsName})`);
  execFileSync(
    "psql",
    [
      dsn,
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      `platform_db=${name}`,
      "-v",
      `jobs_db=${jobsName}`,
      "-f",
      ROLES_SQL,
    ],
    { stdio: quiet ? "ignore" : "inherit" },
  );

  // migrate deploy is idempotent; on an up-to-date database it is a no-op.
  execSync("pnpm --filter @azx-pbc/portal exec prisma migrate deploy", {
    stdio: quiet ? "ignore" : "inherit",
    env: { ...process.env, DATABASE_URL: dsn },
  });

  if (jobsDsn) {
    // The migration identity, derived for this one command and never handed to
    // a service: same private database, the role that owns the schema step.
    const migrateDsn = withLogin(jobsDsn, "helix_jobs_migrate", "helix_jobs_migrate");
    if (!quiet) console.error(`[ensure-db] migrating the jobs database ${jobsName}`);
    execSync("pnpm --filter @azx-pbc/jobs db:migrate", {
      stdio: quiet ? "ignore" : "inherit",
      env: { ...process.env, JOBS_MIGRATE_DATABASE_URL: migrateDsn },
    });
  }

  return { name, created: !exists };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const dsn = process.argv[2] ?? process.env.DATABASE_URL;
  const jobsDsn = process.argv[3];
  if (!dsn) {
    console.error("usage: node scripts/ensure-db.mjs <owner-dsn> [jobs-runtime-dsn]");
    process.exit(2);
  }
  ensureDatabase(dsn, { jobsDsn });
}
