import { execSync } from "node:child_process";
import { Client } from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

/** The one role/database provisioning definition, parametrized per database. */
const ROLES_SQL = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../.devcontainer/db-init/01-roles.sql",
);

/**
 * The session-scoped advisory lock every concurrent application of the roles
 * provisioning takes — the same number, agreed by every caller (the jobs
 * integration suites apply the same file for their scratch databases).
 * Postgres's role catalog does not tolerate two overlapping CREATE ROLE
 * batches — the loser dies with "tuple concurrently updated" — and several
 * suites apply the file at once, in parallel vitest workers.
 *
 * Two properties make the lock real, and both are easy to lose:
 *
 * - **Advisory locks are per-database.** The lock serializes callers only if
 *   every one of them takes it in the same database; the agreed one is
 *   `postgres`, which every cluster the test URLs reach has. A caller that
 *   locks `helix_test` instead serializes nobody but itself.
 * - **The lock must outlive the file's own `\connect :"jobs_db"`.** That
 *   meta-command closes the psql session the file runs in — a lock taken by
 *   that session dies mid-file (and the trailing unlock warns "you don't own
 *   a lock"). So the lock lives on a dedicated connection here, held across
 *   the child psql's whole run and released in a `finally`, never inside the
 *   applying psql.
 */
const PROVISION_LOCK_KEY = 918273645;

function lockUrl(): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = "/postgres";
  return url.toString();
}

/**
 * Apply the role/database ACL provisioning (`.devcontainer/db-init/01-roles.sql`)
 * with the TEST database names substituted: the platform runtime roles keep
 * their grants on `helix_test`, and the jobs plane gets `jobsDb` — created by
 * the file itself when missing, inside the lock. The file is idempotent — on
 * a cluster where db-init already ran (CI, fresh dev volume) this is the same
 * definition re-applied to different database names; on an older dev volume
 * it is the upgrade that brings the cluster to the current ACL posture.
 *
 * `jobsDb` is the parameter for callers provisioning their own scratch jobs
 * database; {@link provisionTestDatabases} is the fixed-name application the
 * test run's global setup and the isolation suite's upgrade leg make.
 */
export async function applyRolesProvisioning(jobsDb: string): Promise<void> {
  // The name reaches the shell inside the psql command string, so it must be
  // a bare identifier — validated at the entry, before anything runs. A name
  // derived from input must fail at this validation, never in a shell where
  // a mangled command can exit 0 without applying anything (the failure that
  // looks like a success).
  if (!/^[a-z_][a-z0-9_]*$/.test(jobsDb)) {
    throw new Error(`the jobs database name is not a bare lowercase identifier: ${jobsDb}`);
  }
  const lock = new Client({ connectionString: lockUrl(), connectionTimeoutMillis: 10_000 });
  await lock.connect();
  try {
    await lock.query("SELECT pg_advisory_lock($1)", [PROVISION_LOCK_KEY]);
    try {
      // Bounded: a wedged application (a stuck cluster, a hung psql) fails
      // this run instead of hanging every parallel worker waiting on the
      // lock behind it.
      execSync(
        `psql "${TEST_DATABASE_URL}" -v ON_ERROR_STOP=1 ` +
          `-v platform_db=helix_test -v jobs_db=${jobsDb} ` +
          `-f "${ROLES_SQL}"`,
        { stdio: "inherit", timeout: 120_000 },
      );
    } finally {
      await lock.query("SELECT pg_advisory_unlock($1)", [PROVISION_LOCK_KEY]);
    }
  } finally {
    await lock.end();
  }
}

/**
 * The test databases' application of the provisioning: platform runtime
 * roles on `helix_test`, jobs identities on `helix_jobs_test`. Async because
 * the lock is held by a live connection across the child psql — callers
 * await it (vitest's global setup supports that).
 */
export async function provisionTestDatabases(): Promise<void> {
  await applyRolesProvisioning("helix_jobs_test");
}
