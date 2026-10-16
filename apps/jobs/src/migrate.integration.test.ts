import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { JOBS_FETCH_QUALIFIED_TYPE, resolveJobsCapacityLimits } from "@azx-pbc/shared";

import {
  checkJobsStorageCompatibility,
  PGBOSS_SCHEMA_VERSION,
  readSchemaVersion,
  type JobsStorageCompatibility,
} from "./compat.js";
import { migrateJobsStorage } from "./migrate.js";
import {
  JOBS_APP_LIFECYCLE_QUALIFIED,
  JOBS_INSTRUCTION_BURNS_QUALIFIED,
  JOBS_JOB_RECORD_QUALIFIED,
  JOBS_QUEUE_NAME,
  JOBS_PGBOSS_SCHEMA,
  JOBS_RUNTIME_ROLE,
  JOBS_SCHEMA,
  jobTypePolicy,
  jobsRuntimeBossOptions,
  jobsWorkOptions,
} from "./policy.js";
import { applyRolesProvisioning } from "../../portal/src/test/provisionDatabases.js";

/**
 * The migration/configuration path against the real Postgres cluster, through
 * the real role split: the migration runs as `helix_jobs_migrate`, the
 * compatibility check runs as the runtime role `helix_jobs`, and the store is
 * a scratch database provisioned by the same role-provisioning file the
 * platform applies everywhere (no parallel schema, no test superuser for the
 * assertions that must hold for the runtime).
 *
 * The legs build on each other in order — unmigrated, migrated, re-run,
 * drift — so the file's tests run serially against one scratch database,
 * dropped at the end. Nothing here touches the platform database's data.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

const SCRATCH_DB = `helix_jobs_migrate_${randomUUID().replaceAll("-", "")}`;

function urlFor(database: string, role?: string): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  if (role) {
    url.username = role;
    url.password = role;
  }
  return url.toString();
}

const MIGRATE_DSN = urlFor(SCRATCH_DB, "helix_jobs_migrate");
const RUNTIME_DSN = urlFor(SCRATCH_DB, JOBS_RUNTIME_ROLE);

/** A one-shot pool as the given role, handed to the compatibility check. */
async function compatibilityAs(role: string | undefined): Promise<JobsStorageCompatibility> {
  const pool = new Pool({ connectionString: urlFor(SCRATCH_DB, role), max: 1 });
  try {
    return await checkJobsStorageCompatibility(pool);
  } finally {
    await pool.end();
  }
}

/** One statement as the migration identity — the store's owner, and the actor behind a bad hand-patch. */
async function asMigrateRole(sql: string): Promise<void> {
  const pool = new Pool({ connectionString: MIGRATE_DSN, max: 1 });
  try {
    await pool.query(sql);
  } finally {
    await pool.end();
  }
}

async function ownerProbe(sql: string): Promise<unknown> {
  const pool = new Pool({ connectionString: urlFor("postgres"), max: 1 });
  try {
    return (await pool.query(sql)).rows[0];
  } finally {
    await pool.end();
  }
}

async function scratchStoreOwner(): Promise<string | null> {
  // pg_class is per-database: the probe runs against the scratch store itself,
  // as its owner.
  const pool = new Pool({ connectionString: MIGRATE_DSN, max: 1 });
  try {
    const row = (
      await pool.query<{ owner: string }>(
        `SELECT pg_get_userbyid(c.relowner) AS owner
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = '${JOBS_PGBOSS_SCHEMA}' AND c.relname = 'job'`,
      )
    ).rows[0];
    return row?.owner ?? null;
  } finally {
    await pool.end();
  }
}

/** Whether the job-record store's occupancy index exists in the scratch store. */
async function recordIndexExists(): Promise<boolean> {
  const pool = new Pool({ connectionString: MIGRATE_DSN, max: 1 });
  try {
    const row = (
      await pool.query<{ found: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS found`, [
        `${JOBS_SCHEMA}.idx_job_record_server_app_env_status`,
      ])
    ).rows[0];
    return row?.found === true;
  } finally {
    await pool.end();
  }
}

beforeAll(async () => {
  // The scratch store is created by the provisioning itself (the file's
  // create-if-missing), inside the serialized application: the real
  // provisioning file against the real role split — no parallel schema, no
  // test superuser for the assertions that must hold for the runtime.
  await applyRolesProvisioning(SCRATCH_DB);
}, 30_000);

afterAll(async () => {
  const pool = new Pool({ connectionString: urlFor("postgres"), max: 1 });
  await pool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
  await pool.end();
}, 30_000);

describe("jobs storage migration and startup compatibility", () => {
  const slow = { timeout: 30_000 };

  test(
    "an unmigrated store reports schema_missing and a compatibility run writes nothing",
    slow,
    async () => {
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({ kind: "schema_missing" });
      // The check is read-only by contract: nothing may have appeared.
      await expect(
        ownerProbe(`SELECT to_regclass('${JOBS_PGBOSS_SCHEMA}.version')::text IS NULL AS absent`),
      ).resolves.toEqual({ absent: true });
    },
  );

  test("the migration prepares a compatible queue under the migration identity", slow, async () => {
    await expect(migrateJobsStorage(MIGRATE_DSN)).resolves.toEqual({
      schemaVersionBefore: null,
      schemaVersion: PGBOSS_SCHEMA_VERSION,
      queueExisted: false,
      queuePolicyRepairs: [],
      burnStoreExisted: false,
      lifecycleStoreExisted: false,
      jobRecordExisted: false,
      // A fresh creation carries the execution columns in the CREATE TABLE
      // itself; the summary's list names only what an OLDER store needed
      // added in place.
      jobRecordColumnsAdded: [],
    });
    await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
      kind: "compatible",
      schemaVersion: PGBOSS_SCHEMA_VERSION,
    });
    // The migration identity owns the store; the runtime role is not its owner.
    await expect(scratchStoreOwner()).resolves.toBe("helix_jobs_migrate");
  });

  test("a runtime credential cannot migrate", slow, async () => {
    await expect(migrateJobsStorage(RUNTIME_DSN)).rejects.toThrow(/holds no CREATE on database/);
    // The refusal is pre-flight: the store it pointed at is untouched.
    await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
      kind: "compatible",
      schemaVersion: PGBOSS_SCHEMA_VERSION,
    });
  });

  test("re-running the migration converges and changes nothing", slow, async () => {
    await expect(migrateJobsStorage(MIGRATE_DSN)).resolves.toEqual({
      schemaVersionBefore: PGBOSS_SCHEMA_VERSION,
      schemaVersion: PGBOSS_SCHEMA_VERSION,
      queueExisted: true,
      queuePolicyRepairs: [],
      burnStoreExisted: true,
      lifecycleStoreExisted: true,
      jobRecordExisted: true,
      jobRecordColumnsAdded: [],
    });
    await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
      kind: "compatible",
      schemaVersion: PGBOSS_SCHEMA_VERSION,
    });
  });

  test("updatable queue-policy drift is repaired, not accepted", slow, async () => {
    await asMigrateRole(
      `UPDATE ${JOBS_PGBOSS_SCHEMA}.queue
            SET expire_seconds = 1, deletion_seconds = 604800, heartbeat_seconds = NULL
          WHERE name = '${JOBS_QUEUE_NAME}'`,
    );
    await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
      kind: "queue_policy",
      diffs: expect.arrayContaining([
        { field: "expire_seconds", expected: 3600, actual: 1 },
        { field: "deletion_seconds", expected: 0, actual: 604800 },
        { field: "heartbeat_seconds", expected: 10, actual: null },
      ]),
    });
    await expect(migrateJobsStorage(MIGRATE_DSN)).resolves.toEqual(
      expect.objectContaining({
        queueExisted: true,
        queuePolicyRepairs: expect.arrayContaining([
          "expire_seconds",
          "deletion_seconds",
          "heartbeat_seconds",
        ]),
      }),
    );
    await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
      kind: "compatible",
      schemaVersion: PGBOSS_SCHEMA_VERSION,
    });
  });

  test("queue policy fixed at creation is refused, not repaired", slow, async () => {
    await asMigrateRole(
      `UPDATE ${JOBS_PGBOSS_SCHEMA}.queue SET policy = 'singleton' WHERE name = '${JOBS_QUEUE_NAME}'`,
    );
    await expect(migrateJobsStorage(MIGRATE_DSN)).rejects.toThrow(
      /policy \(expected "standard", found "singleton"\)/,
    );
    // The startup check detects the same drift the migration refused.
    await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
      kind: "queue_policy",
      diffs: [{ field: "policy", expected: "standard", actual: "singleton" }],
    });
    await asMigrateRole(
      `UPDATE ${JOBS_PGBOSS_SCHEMA}.queue SET policy = 'standard' WHERE name = '${JOBS_QUEUE_NAME}'`,
    );
    await expect(migrateJobsStorage(MIGRATE_DSN)).resolves.toEqual(
      expect.objectContaining({ queuePolicyRepairs: [] }),
    );
  });

  test("schema-version drift is detected without changing the database", slow, async () => {
    await asMigrateRole(
      `UPDATE ${JOBS_PGBOSS_SCHEMA}.version SET version = ${PGBOSS_SCHEMA_VERSION - 1}`,
    );
    await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
      kind: "schema_version",
      found: PGBOSS_SCHEMA_VERSION - 1,
      expected: PGBOSS_SCHEMA_VERSION,
    });
    await asMigrateRole(
      `UPDATE ${JOBS_PGBOSS_SCHEMA}.version SET version = ${PGBOSS_SCHEMA_VERSION}`,
    );
    await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
      kind: "compatible",
      schemaVersion: PGBOSS_SCHEMA_VERSION,
    });
  });

  test("a missing queue row is detected and re-created by the migration", slow, async () => {
    await asMigrateRole(
      `DELETE FROM ${JOBS_PGBOSS_SCHEMA}.queue WHERE name = '${JOBS_QUEUE_NAME}'`,
    );
    await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({ kind: "queue_missing" });
    await expect(migrateJobsStorage(MIGRATE_DSN)).resolves.toEqual(
      expect.objectContaining({ queueExisted: false, queuePolicyRepairs: [] }),
    );
    await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
      kind: "compatible",
      schemaVersion: PGBOSS_SCHEMA_VERSION,
    });
  });

  test(
    "missing runtime privileges are detected and re-granted by the migration",
    slow,
    async () => {
      await asMigrateRole(`REVOKE INSERT ON ${JOBS_PGBOSS_SCHEMA}.job FROM ${JOBS_RUNTIME_ROLE}`);
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "runtime_privileges",
        missing: expect.arrayContaining([`INSERT on ${JOBS_PGBOSS_SCHEMA}.job`]),
      });
      await expect(migrateJobsStorage(MIGRATE_DSN)).resolves.toEqual(
        expect.objectContaining({ queuePolicyRepairs: [] }),
      );
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "compatible",
        schemaVersion: PGBOSS_SCHEMA_VERSION,
      });
    },
  );

  test("a dropped burn table is its own verdict and the migration recreates it", slow, async () => {
    // The burn store is the receiver's replay memory: without it no signed
    // instruction can be served, so its absence is an operator-facing
    // answer distinct from the runner schema's.
    await asMigrateRole(`DROP TABLE ${JOBS_INSTRUCTION_BURNS_QUALIFIED}`);
    await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({ kind: "burn_missing" });
    await expect(migrateJobsStorage(MIGRATE_DSN)).resolves.toEqual(
      expect.objectContaining({ burnStoreExisted: false }),
    );
    await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
      kind: "compatible",
      schemaVersion: PGBOSS_SCHEMA_VERSION,
    });
  });

  test(
    "missing burn-store privileges are detected and re-granted by the migration",
    slow,
    async () => {
      await asMigrateRole(
        `REVOKE INSERT ON ${JOBS_INSTRUCTION_BURNS_QUALIFIED} FROM ${JOBS_RUNTIME_ROLE}`,
      );
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "runtime_privileges",
        missing: expect.arrayContaining([`INSERT on ${JOBS_INSTRUCTION_BURNS_QUALIFIED}`]),
      });
      await expect(migrateJobsStorage(MIGRATE_DSN)).resolves.toEqual(
        expect.objectContaining({ burnStoreExisted: true }),
      );
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "compatible",
        schemaVersion: PGBOSS_SCHEMA_VERSION,
      });
    },
  );

  test(
    "a dropped lifecycle store is its own verdict and the migration recreates it",
    slow,
    async () => {
      // The lifecycle store is the admission/start gate's authority: without it
      // every delivery is refused and no submission could ever open, so its
      // absence is an operator-facing answer distinct from the runner schema's.
      await asMigrateRole(`DROP TABLE ${JOBS_APP_LIFECYCLE_QUALIFIED}`);
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "lifecycle_missing",
      });
      await expect(migrateJobsStorage(MIGRATE_DSN)).resolves.toEqual(
        expect.objectContaining({ lifecycleStoreExisted: false }),
      );
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "compatible",
        schemaVersion: PGBOSS_SCHEMA_VERSION,
      });
    },
  );

  test(
    "missing lifecycle-store privileges are detected and re-granted by the migration",
    slow,
    async () => {
      await asMigrateRole(
        `REVOKE UPDATE ON ${JOBS_APP_LIFECYCLE_QUALIFIED} FROM ${JOBS_RUNTIME_ROLE}`,
      );
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "runtime_privileges",
        missing: expect.arrayContaining([`UPDATE on ${JOBS_APP_LIFECYCLE_QUALIFIED}`]),
      });
      await expect(migrateJobsStorage(MIGRATE_DSN)).resolves.toEqual(
        expect.objectContaining({ lifecycleStoreExisted: true }),
      );
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "compatible",
        schemaVersion: PGBOSS_SCHEMA_VERSION,
      });
    },
  );

  test(
    "a dropped job-record store is its own verdict and the migration recreates it",
    slow,
    async () => {
      // The job-record store is acceptance itself: without it no submission
      // can commit, so its absence is an operator-facing answer distinct from
      // the runner schema's.
      await asMigrateRole(`DROP TABLE ${JOBS_JOB_RECORD_QUALIFIED}`);
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "record_missing",
      });
      await expect(migrateJobsStorage(MIGRATE_DSN)).resolves.toEqual(
        expect.objectContaining({ jobRecordExisted: false }),
      );
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "compatible",
        schemaVersion: PGBOSS_SCHEMA_VERSION,
      });
      // The recreation carries the occupancy index the acceptance
      // transaction's capacity counts are bounded by.
      await expect(recordIndexExists()).resolves.toBe(true);
    },
  );

  test("a dropped occupancy index is recreated by the migration's re-run", slow, async () => {
    // An existing store from before the capacity seam lacks the index; the
    // migration command is the convergence path, and the index's presence
    // is the re-run's proof.
    await asMigrateRole(`DROP INDEX IF EXISTS ${JOBS_SCHEMA}.idx_job_record_server_app_env_status`);
    await expect(recordIndexExists()).resolves.toBe(false);
    await expect(migrateJobsStorage(MIGRATE_DSN)).resolves.toEqual(
      expect.objectContaining({ jobRecordExisted: true }),
    );
    await expect(recordIndexExists()).resolves.toBe(true);
  });

  test(
    "a record store from before the execution migration converges in place, and its absence is a startup verdict",
    slow,
    async () => {
      // The execution projection's columns: a store created before them
      // (every row the acceptance transaction has committed so far) must be
      // brought forward by the migration command — the runtime's own
      // compatibility check names the missing columns instead of failing the
      // first execution write.
      await asMigrateRole(`
        ALTER TABLE ${JOBS_JOB_RECORD_QUALIFIED}
          DROP COLUMN IF EXISTS attempt,
          DROP COLUMN IF EXISTS progress,
          DROP COLUMN IF EXISTS error_code,
          DROP COLUMN IF EXISTS result`);
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "record_schema",
        problems: [
          'column "attempt" is missing',
          'column "progress" is missing',
          'column "error_code" is missing',
          'column "result" is missing',
        ],
      });
      await expect(migrateJobsStorage(MIGRATE_DSN)).resolves.toEqual(
        expect.objectContaining({
          jobRecordExisted: true,
          jobRecordColumnsAdded: ["attempt", "progress", "error_code", "result"],
        }),
      );
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "compatible",
        schemaVersion: PGBOSS_SCHEMA_VERSION,
      });
      // The convergence is stable: a re-run adds nothing.
      await expect(migrateJobsStorage(MIGRATE_DSN)).resolves.toEqual(
        expect.objectContaining({ jobRecordColumnsAdded: [] }),
      );
    },
  );

  test(
    "a result column left at the earlier jsonb type is a startup verdict and the migration converges the type in place",
    slow,
    async () => {
      // The projection stores the result bound's canonical TEXT; jsonb's own
      // parser is recursive and would refuse a deep result the bound accepts.
      // A store that missed its re-run therefore fails at STARTUP (the
      // compatibility check reads the column's type beside its presence),
      // never at the first deep result.
      await asMigrateRole(`
        ALTER TABLE ${JOBS_JOB_RECORD_QUALIFIED}
          ALTER COLUMN result TYPE jsonb USING result::jsonb`);
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "record_schema",
        problems: ['column "result" is jsonb, expected text'],
      });
      await expect(migrateJobsStorage(MIGRATE_DSN)).resolves.toEqual(
        expect.objectContaining({ jobRecordColumnsAdded: [] }),
      );
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "compatible",
        schemaVersion: PGBOSS_SCHEMA_VERSION,
      });
    },
  );

  test("the execution projection's state-machine checks hold in the store", slow, async () => {
    // A result exists only on a row still projecting success, and a
    // successful row always has one — the store refuses the projection
    // states no honest writer produces.
    await expect(
      asMigrateRole(`
        INSERT INTO ${JOBS_JOB_RECORD_QUALIFIED}
          (server, job_id, runner_job_id, app_id, env, owner_kind, owner_oid, type,
           generation, status, retry_key, body_sha256, created_at, result)
        VALUES ('jobs', 'integrity-check', 'integrity-check-runner', 'app', 'prod', 'user', 'oid',
                'jobs:fetch', 1, 'queued', NULL, '${"0".repeat(64)}', now(), '{"x":1}')`),
    ).rejects.toThrow(/job_record_result_only_while_projected/);
    await expect(
      asMigrateRole(`
        INSERT INTO ${JOBS_JOB_RECORD_QUALIFIED}
          (server, job_id, runner_job_id, app_id, env, owner_kind, owner_oid, type,
           generation, status, retry_key, body_sha256, created_at)
        VALUES ('jobs', 'integrity-check', 'integrity-check-runner', 'app', 'prod', 'user', 'oid',
                'jobs:fetch', 1, 'succeeded', NULL, '${"0".repeat(64)}', now())`),
    ).rejects.toThrow(/job_record_success_has_result/);
    await expect(
      asMigrateRole(`
        INSERT INTO ${JOBS_JOB_RECORD_QUALIFIED}
          (server, job_id, runner_job_id, app_id, env, owner_kind, owner_oid, type,
           generation, status, retry_key, body_sha256, created_at, error_code)
        VALUES ('jobs', 'integrity-check', 'integrity-check-runner', 'app', 'prod', 'user', 'oid',
                'jobs:fetch', 1, 'failed', NULL, '${"0".repeat(64)}', now(), 'not_a_code')`),
    ).rejects.toThrow(/job_record_error_code_vocabulary/);
    // Attempts are 1-based — the projection never holds a zeroth attempt.
    await expect(
      asMigrateRole(`
        INSERT INTO ${JOBS_JOB_RECORD_QUALIFIED}
          (server, job_id, runner_job_id, app_id, env, owner_kind, owner_oid, type,
           generation, status, retry_key, body_sha256, created_at, attempt)
        VALUES ('jobs', 'integrity-check', 'integrity-check-runner', 'app', 'prod', 'user', 'oid',
                'jobs:fetch', 1, 'queued', NULL, '${"0".repeat(64)}', now(), 0)`),
    ).rejects.toThrow(/job_record_attempt_positive/);
  });

  test(
    "missing job-record privileges are detected and re-granted by the migration",
    slow,
    async () => {
      await asMigrateRole(
        `REVOKE DELETE ON ${JOBS_JOB_RECORD_QUALIFIED} FROM ${JOBS_RUNTIME_ROLE}`,
      );
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "runtime_privileges",
        missing: expect.arrayContaining([`DELETE on ${JOBS_JOB_RECORD_QUALIFIED}`]),
      });
      await expect(migrateJobsStorage(MIGRATE_DSN)).resolves.toEqual(
        expect.objectContaining({ jobRecordExisted: true }),
      );
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "compatible",
        schemaVersion: PGBOSS_SCHEMA_VERSION,
      });
    },
  );

  test(
    "the runtime role can burn a nonce for real, and the burn table survives its own sweep",
    slow,
    async () => {
      // The granted DML works for the exact statements the receiver and its
      // sweep run: a first-use insert wins, the conflict replay loses, and a
      // bounded delete removes expired rows.
      const pool = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
      try {
        const fresh = await pool.query(
          `INSERT INTO ${JOBS_INSTRUCTION_BURNS_QUALIFIED} (scope, jti, burn_until)
             VALUES ('edgeToJobs', 'integration-nonce', now() + interval '60 seconds')
           ON CONFLICT (scope, jti) DO NOTHING`,
        );
        expect(fresh.rowCount).toBe(1);
        const replay = await pool.query(
          `INSERT INTO ${JOBS_INSTRUCTION_BURNS_QUALIFIED} (scope, jti, burn_until)
             VALUES ('edgeToJobs', 'integration-nonce', now() + interval '60 seconds')
           ON CONFLICT (scope, jti) DO NOTHING`,
        );
        expect(replay.rowCount).toBe(0);
        const swept = await pool.query(
          `DELETE FROM ${JOBS_INSTRUCTION_BURNS_QUALIFIED}
             WHERE burn_until < now()
               AND ctid IN (
                 SELECT ctid FROM ${JOBS_INSTRUCTION_BURNS_QUALIFIED} WHERE burn_until < now() LIMIT 100
               )`,
        );
        expect(swept.rowCount).toBe(0); // the nonce is retained, not yet expired
      } finally {
        await pool.end();
      }
    },
  );

  test("a store that does not answer is unreachable, not incompatible", slow, async () => {
    const pool = new Pool({
      connectionString: urlFor(SCRATCH_DB, JOBS_RUNTIME_ROLE).replace(":5432", ":5999"),
      max: 1,
      connectionTimeoutMillis: 2_000,
    });
    try {
      await expect(checkJobsStorageCompatibility(pool)).resolves.toEqual({
        kind: "unreachable",
        message: expect.stringMatching(/.+/),
      });
    } finally {
      await pool.end();
    }
  });

  test(
    "drift in the fields the repair clears or zeroes by fallback is converged too",
    slow,
    async () => {
      // These three exercise the repair options' fallback arms (`?? null` /
      // `?? 0` / `?? false`): a repair option that arrived as undefined instead
      // of null would be dropped from the update payload and the drift would
      // become unrepairable, failing every later migration run.
      await asMigrateRole(
        `UPDATE ${JOBS_PGBOSS_SCHEMA}.queue
            SET retry_delay_max = 5, warning_queued = 3, notify = true
          WHERE name = '${JOBS_QUEUE_NAME}'`,
      );
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "queue_policy",
        diffs: [
          { field: "retry_delay_max", expected: null, actual: 5 },
          { field: "warning_queued", expected: 0, actual: 3 },
          { field: "notify", expected: false, actual: true },
        ],
      });
      await expect(migrateJobsStorage(MIGRATE_DSN)).resolves.toEqual(
        expect.objectContaining({
          queuePolicyRepairs: ["retry_delay_max", "warning_queued", "notify"],
        }),
      );
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "compatible",
        schemaVersion: PGBOSS_SCHEMA_VERSION,
      });
    },
  );

  test(
    "a runtime identity denied a read of the version ledger is a privilege verdict",
    slow,
    async () => {
      await asMigrateRole(
        `REVOKE SELECT ON ${JOBS_PGBOSS_SCHEMA}.version FROM ${JOBS_RUNTIME_ROLE}`,
      );
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "runtime_privileges",
        missing: [`SELECT on ${JOBS_PGBOSS_SCHEMA}.version`],
      });
      await expect(migrateJobsStorage(MIGRATE_DSN)).resolves.toEqual(
        expect.objectContaining({ queuePolicyRepairs: [] }),
      );
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "compatible",
        schemaVersion: PGBOSS_SCHEMA_VERSION,
      });
    },
  );

  test(
    "a runtime identity denied a read of the queue row is a privilege verdict naming it",
    slow,
    async () => {
      await asMigrateRole(`REVOKE SELECT ON ${JOBS_PGBOSS_SCHEMA}.queue FROM ${JOBS_RUNTIME_ROLE}`);
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "runtime_privileges",
        missing: [`SELECT on ${JOBS_PGBOSS_SCHEMA}.queue`],
      });
      await expect(migrateJobsStorage(MIGRATE_DSN)).resolves.toEqual(
        expect.objectContaining({ queuePolicyRepairs: [] }),
      );
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "compatible",
        schemaVersion: PGBOSS_SCHEMA_VERSION,
      });
    },
  );

  test(
    "an emptied version ledger is refused by the run and reads as a schema version of null",
    slow,
    async () => {
      // A missing row in the ledger is corruption, not just drift: the verdict
      // must carry `found: null` so the operator sees the ledger itself is
      // damaged, distinct from a version behind the pin.
      await asMigrateRole(`DELETE FROM ${JOBS_PGBOSS_SCHEMA}.version`);
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "schema_version",
        found: null,
        expected: PGBOSS_SCHEMA_VERSION,
      });
      // The run refuses to bless a ledger it cannot converge: pg-boss's start
      // migrates only a version behind the pin, so a missing row matches
      // neither arm and the run's post-run re-read is what fails it. The
      // store is unchanged and the startup verdict still names the corruption.
      await expect(migrateJobsStorage(MIGRATE_DSN)).rejects.toThrow(
        /the pg-boss schema is at version null after the run/,
      );
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "schema_version",
        found: null,
        expected: PGBOSS_SCHEMA_VERSION,
      });
      // The ledger row is this test's fixture: restore it directly — the
      // version column is the ledger's only non-nullable column.
      await asMigrateRole(
        `INSERT INTO ${JOBS_PGBOSS_SCHEMA}.version (version) VALUES (${PGBOSS_SCHEMA_VERSION})`,
      );
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "compatible",
        schemaVersion: PGBOSS_SCHEMA_VERSION,
      });
    },
  );

  test(
    "a schema version ahead of the pin is refused by the run, not downgraded",
    slow,
    async () => {
      // A store migrated forward by a newer pg-boss — or a rolled-back pin —
      // fails both readers: the startup verdict reports the ahead version,
      // and the run refuses it without touching the store. A merely-behind
      // version never reaches this arm: the run migrates it up first.
      await asMigrateRole(
        `UPDATE ${JOBS_PGBOSS_SCHEMA}.version SET version = ${PGBOSS_SCHEMA_VERSION + 1}`,
      );
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "schema_version",
        found: PGBOSS_SCHEMA_VERSION + 1,
        expected: PGBOSS_SCHEMA_VERSION,
      });
      await expect(migrateJobsStorage(MIGRATE_DSN)).rejects.toThrow(
        `the pg-boss schema is at version ${PGBOSS_SCHEMA_VERSION + 1} after the run, ` +
          `expected ${PGBOSS_SCHEMA_VERSION}`,
      );
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "schema_version",
        found: PGBOSS_SCHEMA_VERSION + 1,
        expected: PGBOSS_SCHEMA_VERSION,
      });
      await asMigrateRole(
        `UPDATE ${JOBS_PGBOSS_SCHEMA}.version SET version = ${PGBOSS_SCHEMA_VERSION}`,
      );
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "compatible",
        schemaVersion: PGBOSS_SCHEMA_VERSION,
      });
    },
  );

  test(
    "a migration run against a store that does not answer fails with the connection error",
    slow,
    async () => {
      // The run's waits are bounded: an unanswered store is a rejection within
      // the pool's connection timeout, not a hang — and the failure is the
      // connection's own, not a verdict-shaped answer.
      const dsn = urlFor(SCRATCH_DB, "helix_jobs_migrate").replace(":5432", ":5999");
      await expect(migrateJobsStorage(dsn)).rejects.toThrow(/ECONNREFUSED/);
    },
  );

  test(
    "the runtime role cannot create objects in the runner schema after the grants",
    slow,
    async () => {
      // The grants give reach and DML — never DDL: a runtime credential that
      // could create objects in the runner schema could migrate its own store.
      // The "a runtime credential cannot migrate" leg pins the command's
      // pre-flight; this pins the grants' scope itself.
      const pool = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
      try {
        await expect(
          pool.query(`CREATE TABLE ${JOBS_PGBOSS_SCHEMA}.redteam_probe (id int)`),
        ).rejects.toThrow(/permission denied/);
      } finally {
        await pool.end();
      }
    },
  );

  test(
    "the runtime role can actually write and delete a job row, not just hold the privileges",
    slow,
    async () => {
      // The migration and the compatibility check verify the grants through
      // has_table_privilege probes; this proves the granted DML works for a
      // real write — the uuid-default insert the runner's own send relies on.
      // The job row's name is its queue name (a job_common FK enforces it),
      // so the probe writes the shape a real send writes.
      const pool = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
      try {
        const inserted = await pool.query<{ id: string }>(
          `INSERT INTO ${JOBS_PGBOSS_SCHEMA}.job (name) VALUES ('${JOBS_QUEUE_NAME}') RETURNING id`,
        );
        const id = inserted.rows[0]?.id;
        expect(id).toBeTruthy();
        const deleted = await pool.query(
          `DELETE FROM ${JOBS_PGBOSS_SCHEMA}.job WHERE id = $1 AND name = '${JOBS_QUEUE_NAME}'`,
          [id],
        );
        expect(deleted.rowCount).toBe(1);
      } finally {
        await pool.end();
      }
    },
  );

  test(
    "dead-letter and retention drift are repaired too — the fields no other leg drifts",
    slow,
    async () => {
      // `dead_letter` rides the repair payload's CASE-presence arm (the only
      // way a null-expected field converges) and `retention_seconds` carries
      // the value that keeps pg-boss's native sweep off primary rows: a
      // retention the repair cannot restore would let the sweep delete
      // accepted work. A hand-patch of either must converge on the next run.
      await asMigrateRole(
        `INSERT INTO ${JOBS_PGBOSS_SCHEMA}.queue
           (name, policy, retry_limit, retry_delay, retry_backoff, expire_seconds,
            retention_seconds, deletion_seconds, partition, table_name)
         VALUES ('redteam_dl', 'standard', 0, 0, false, 900, 1209600, 604800, false, 'job_common')`,
      );
      try {
        await asMigrateRole(
          `UPDATE ${JOBS_PGBOSS_SCHEMA}.queue
              SET dead_letter = 'redteam_dl', retention_seconds = 1
            WHERE name = '${JOBS_QUEUE_NAME}'`,
        );
        await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
          kind: "queue_policy",
          diffs: expect.arrayContaining([
            { field: "retention_seconds", expected: 2_147_483_647, actual: 1 },
            { field: "dead_letter", expected: null, actual: "redteam_dl" },
          ]),
        });
        await expect(migrateJobsStorage(MIGRATE_DSN)).resolves.toEqual(
          expect.objectContaining({
            queueExisted: true,
            queuePolicyRepairs: expect.arrayContaining(["retention_seconds", "dead_letter"]),
          }),
        );
        await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
          kind: "compatible",
          schemaVersion: PGBOSS_SCHEMA_VERSION,
        });
      } finally {
        await asMigrateRole(`DELETE FROM ${JOBS_PGBOSS_SCHEMA}.queue WHERE name = 'redteam_dl'`);
      }
    },
  );

  test(
    "attempts and retry-shape drift are repaired too — the platform owns the queue's retry arms",
    slow,
    async () => {
      // retry_limit is the platform's attempts control: a drifted queue-level
      // retry limit would auto-retry jobs the platform's types never asked to
      // retry. With this leg every updatable queue column has been drifted
      // and converged somewhere in the file — retry_delay and retry_backoff
      // complete the matrix.
      await asMigrateRole(
        `UPDATE ${JOBS_PGBOSS_SCHEMA}.queue
            SET retry_limit = 5, retry_delay = 30, retry_backoff = true
          WHERE name = '${JOBS_QUEUE_NAME}'`,
      );
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "queue_policy",
        diffs: [
          { field: "retry_limit", expected: 0, actual: 5 },
          { field: "retry_delay", expected: 0, actual: 30 },
          { field: "retry_backoff", expected: false, actual: true },
        ],
      });
      await expect(migrateJobsStorage(MIGRATE_DSN)).resolves.toEqual(
        expect.objectContaining({
          queueExisted: true,
          queuePolicyRepairs: ["retry_limit", "retry_delay", "retry_backoff"],
        }),
      );
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "compatible",
        schemaVersion: PGBOSS_SCHEMA_VERSION,
      });
    },
  );

  test(
    "a real runtime composed from the platform options runs a job to completion as the runtime identity",
    slow,
    async () => {
      // The migration and the compatibility check verify the store through
      // privilege probes and a raw row write; neither has ever started a
      // pg-boss runtime. This is the composition the worker ticket builds on
      // — the platform constructor options, the fetch type's send policy and
      // the registry's worker options, against the migrated store, as the
      // role the grants name — and a "compatible" verdict must mean this
      // run succeeds: pg-boss's own start, claim and settle machinery
      // exercises writes the probes never make.
      const boss = new PgBoss({ connectionString: RUNTIME_DSN, ...jobsRuntimeBossOptions() });
      const failures: unknown[] = [];
      boss.on("error", (error) => failures.push(error));
      const seen: Array<{ id: string | undefined; data: unknown }> = [];
      try {
        await boss.start();
        const jobId = await boss.send(
          JOBS_QUEUE_NAME,
          { probe: true },
          jobTypePolicy(JOBS_FETCH_QUALIFIED_TYPE),
        );
        expect(jobId).toBeTruthy();
        await boss.work(
          JOBS_QUEUE_NAME,
          jobsWorkOptions(resolveJobsCapacityLimits()),
          async (batch) => {
            for (const job of batch) seen.push({ id: job.id, data: job.data });
          },
        );
        // Bounded wait: the worker's own poll claims the job, the handler
        // resolves, pg-boss settles the row. The row's state is the outcome.
        const pool = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
        try {
          const deadline = Date.now() + 10_000;
          let state: string | undefined;
          for (;;) {
            const read = await pool.query<{ state: string }>(
              `SELECT state FROM ${JOBS_PGBOSS_SCHEMA}.job WHERE id = $1`,
              [jobId],
            );
            state = read.rows[0]?.state;
            if (state === "completed" || state === "failed" || Date.now() > deadline) break;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          expect(
            state,
            `job ended in state ${state}; runtime errors: ${JSON.stringify(failures)}`,
          ).toBe("completed");
          expect(seen).toEqual([{ id: jobId, data: { probe: true } }]);
          // The stored row must carry the send-time type policy, not the
          // queue's defaults: a send option that did not bind would hand the
          // fetch type the queue-level 3600s claim ceiling instead of its own
          // 300s — a silently weaker deadline nothing else would catch.
          const settled = await pool.query<{ retry_limit: number; expire_seconds: number }>(
            `SELECT retry_limit, expire_seconds FROM ${JOBS_PGBOSS_SCHEMA}.job WHERE id = $1`,
            [jobId],
          );
          expect(settled.rows[0]).toEqual({
            retry_limit: jobTypePolicy(JOBS_FETCH_QUALIFIED_TYPE).retryLimit,
            expire_seconds: jobTypePolicy(JOBS_FETCH_QUALIFIED_TYPE).expireInSeconds,
          });
          // The runtime registered itself — the instance-registry write the
          // grants must cover for a started runtime (the read the compat
          // check refuses to do through a live boss).
          const instance = await pool.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM ${JOBS_PGBOSS_SCHEMA}.instance`,
          );
          expect(instance.rows[0]?.n).toBeGreaterThanOrEqual(1);
        } finally {
          await pool.end();
        }
        expect(failures).toEqual([]);
      } finally {
        await boss.stop({ graceful: true, timeout: 5_000 }).catch(() => {});
      }
    },
  );

  test(
    "a runtime start refuses a store whose schema is behind the pin, without migrating it",
    slow,
    async () => {
      // `migrate: false` is load-bearing: the runtime's start must refuse a
      // behind schema — never migrate it, and never run against one its SQL
      // does not match. The refusal must also be read-only: the ledger it
      // found must be the ledger the migration finds afterwards.
      await asMigrateRole(
        `UPDATE ${JOBS_PGBOSS_SCHEMA}.version SET version = ${PGBOSS_SCHEMA_VERSION - 1}`,
      );
      const boss = new PgBoss({ connectionString: RUNTIME_DSN, ...jobsRuntimeBossOptions() });
      try {
        await expect(boss.start()).rejects.toThrow();
        await expect(readSchemaVersionAsRuntime()).resolves.toBe(PGBOSS_SCHEMA_VERSION - 1);
      } finally {
        await boss.stop({ graceful: true, timeout: 5_000 }).catch(() => {});
      }
      await asMigrateRole(
        `UPDATE ${JOBS_PGBOSS_SCHEMA}.version SET version = ${PGBOSS_SCHEMA_VERSION}`,
      );
      await expect(compatibilityAs(JOBS_RUNTIME_ROLE)).resolves.toEqual({
        kind: "compatible",
        schemaVersion: PGBOSS_SCHEMA_VERSION,
      });
    },
  );

  async function readSchemaVersionAsRuntime(): Promise<number | null> {
    const pool = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
    try {
      return await readSchemaVersion(pool);
    } finally {
      await pool.end();
    }
  }
});
