#!/usr/bin/env node
// ensure-db.mjs — create + migrate an isolated stack's database, idempotently.
//
// Why this exists: a second local stack (scripts/stack-env.mjs) points its DSNs
// at `helix_<suffix>` instead of `helix`, so its rows — apps, sessions, the
// shared rate-limit and login-throttle counters — never touch the developer's
// database. That database has to exist and be migrated first.
//
// This is the same two-step vitest.globalSetup.ts already uses to stand up
// `helix_test`. Postgres roles are cluster-wide and CONNECT defaults to PUBLIC
// on a new database, so the least-privilege roles from .devcontainer/db-init
// need no extra grant here — the per-table GRANTs ride in with the migrations.
//
// Usage: node scripts/ensure-db.mjs <owner-dsn>
//   e.g. node scripts/ensure-db.mjs postgresql://helix:helix@db:5432/helix_smoke

import { execFileSync, execSync } from "node:child_process";

/** Create `dsn`'s database if absent, then apply migrations to it. */
export function ensureDatabase(dsn, { quiet = false } = {}) {
  const url = new URL(dsn);
  const name = url.pathname.replace(/^\//, "");
  if (!name) throw new Error(`no database name in DSN: ${dsn}`);
  // Identifiers cannot be parameterised in CREATE DATABASE; refuse anything
  // that is not a plain identifier rather than interpolating it blindly.
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`unsafe database name: ${name}`);

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

  // migrate deploy is idempotent; on an up-to-date database it is a no-op.
  execSync("pnpm --filter @azx-pbc/portal exec prisma migrate deploy", {
    stdio: quiet ? "ignore" : "inherit",
    env: { ...process.env, DATABASE_URL: dsn },
  });
  return { name, created: !exists };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const dsn = process.argv[2] ?? process.env.DATABASE_URL;
  if (!dsn) {
    console.error("usage: node scripts/ensure-db.mjs <owner-dsn>");
    process.exit(2);
  }
  ensureDatabase(dsn);
}
