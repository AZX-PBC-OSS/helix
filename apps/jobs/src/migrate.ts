import { PgBoss, type UpdateQueueOptions } from "pg-boss";
import type { Pool } from "pg";

import { JOB_ERROR_CODES, JOB_STATUSES } from "@azx-pbc/shared";

import { createJobsPool } from "./pool.js";

import {
  PGBOSS_SCHEMA_VERSION,
  compareQueuePolicy,
  readQueuePolicyRow,
  readSchemaVersion,
  type JobsQueuePolicyDiff,
  type QueuePolicyRow,
} from "./compat.js";
import { describeDsn } from "./dsn.js";
import {
  JOBS_APP_LIFECYCLE_QUALIFIED,
  JOBS_INSTRUCTION_BURNS_QUALIFIED,
  JOBS_JOB_RECORD_QUALIFIED,
  JOBS_PGBOSS_SCHEMA,
  JOBS_QUEUE_NAME,
  JOBS_QUEUE_POLICY,
  JOBS_RUNTIME_ROLE,
  JOBS_SCHEMA,
  jobsMigrationBossOptions,
} from "./policy.js";
import { pathToFileURL } from "node:url";

/**
 * The private migration/configuration entry point for the jobs runner's own
 * database — the only path that changes jobs storage, executed separately
 * from the service (nothing at runtime startup migrates). Run it with the
 * migration identity's DSN:
 *
 *     JOBS_MIGRATE_DATABASE_URL=… pnpm --filter @azx-pbc/jobs db:migrate
 *
 * It installs (or migrates) the pg-boss schema, creates the platform queue
 * with the policy from `src/policy.ts`, converges any policy drift the
 * pinned dependency can update, creates the service's instruction burn store,
 * and grants the runtime role the DML it needs on all of it. Later
 * jobs-owned migrations (the wrapper tables and their grants) extend this
 * command the same way: a step under the migration identity, after the schema
 * they depend on exists.
 */

/** A migration failure carries the operation and what went wrong, never the DSN. */
export class JobsMigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "JobsMigrationError";
  }
}

/** What one migration run did — the run's evidence for the operator log. */
export interface JobsMigrationSummary {
  /** The schema version found before the run (null: no install existed). */
  schemaVersionBefore: number | null;
  /** The schema version after the run. */
  schemaVersion: number;
  /** The queue already existed with the platform policy (nothing to create). */
  queueExisted: boolean;
  /** Queue-policy fields the run repaired back to the platform policy. */
  queuePolicyRepairs: readonly string[];
  /** The instruction burn table already existed (nothing to create). */
  burnStoreExisted: boolean;
  /** The app-lifecycle store already existed (nothing to create). */
  lifecycleStoreExisted: boolean;
  /** The job-record store already existed (nothing to create). */
  jobRecordExisted: boolean;
  /** Execution columns this run added to the job-record store (empty: already present). */
  jobRecordColumnsAdded: readonly string[];
}

/**
 * The policy fields pg-boss can update after queue creation, carrying the
 * platform's expected values. The queue's policy name and partitioning are
 * fixed at creation — drift there is unrepairable by this command.
 */
function queueRepairOptions(): UpdateQueueOptions {
  return {
    retryLimit: JOBS_QUEUE_POLICY.retryLimit,
    retryDelay: JOBS_QUEUE_POLICY.retryDelay,
    retryBackoff: JOBS_QUEUE_POLICY.retryBackoff,
    retryDelayMax: JOBS_QUEUE_POLICY.retryDelayMax ?? null,
    expireInSeconds: JOBS_QUEUE_POLICY.expireInSeconds,
    retentionSeconds: JOBS_QUEUE_POLICY.retentionSeconds,
    deleteAfterSeconds: JOBS_QUEUE_POLICY.deleteAfterSeconds,
    warningQueueSize: JOBS_QUEUE_POLICY.warningQueueSize ?? 0,
    heartbeatSeconds: JOBS_QUEUE_POLICY.heartbeatSeconds,
    notify: JOBS_QUEUE_POLICY.notify ?? false,
    deadLetter: JOBS_QUEUE_POLICY.deadLetter ?? null,
  };
}

const UNREPAIRABLE_QUEUE_FIELDS = new Set(["policy", "partition", "table_name"]);

/** The role name is interpolated into the grant statements — assert the bare-identifier shape at the seam. */
function assertRoleName(role: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
    throw new JobsMigrationError(
      `the runtime role name is not a bare lowercase identifier: ${role}`,
    );
  }
  return role;
}

function describeDiffs(diffs: readonly JobsQueuePolicyDiff[]): string {
  return diffs
    .map(
      (d) =>
        `${d.field} (expected ${JSON.stringify(d.expected)}, found ${JSON.stringify(d.actual)})`,
    )
    .join(", ");
}

/**
 * Run the migration/configuration under the migration identity. Fails loudly
 * — without changing anything — when the identity cannot own the DDL (the
 * runtime DSN's shape: no CREATE on the database), and after every step by
 * re-reading the state it is responsible for. The caller owns the process
 * exit; this function closes everything it opens.
 */
export async function migrateJobsStorage(connectionString: string): Promise<JobsMigrationSummary> {
  const role = assertRoleName(JOBS_RUNTIME_ROLE);
  // The migration's own pool, through the service's shared discipline: its
  // DDL statements are long, so the per-query ceiling is looser than the
  // runtime pools'. The migration runs raw SQL only through `pool.query()`
  // (which plugs its own per-checkout error handler) — the checked-out
  // window's bracket is for the runtime stores' transactions.
  const pool = createJobsPool({
    databaseUrl: connectionString,
    statementTimeoutMs: 60_000,
    max: 2,
    onClientError: (err, phase) => {
      console.error(
        JSON.stringify({
          event: "jobs_storage_migration_pool_error",
          phase,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    },
  });
  let boss: PgBoss | undefined;
  try {
    const preCheck = await pool.query<{ user: string; database: string; create: boolean }>(
      `SELECT current_user AS user,
              current_database() AS database,
              has_database_privilege(current_user, current_database(), 'CREATE') AS create`,
    );
    const identity = preCheck.rows[0];
    if (!identity) {
      throw new JobsMigrationError("the migration connection returned no identity");
    }
    if (!identity.create) {
      throw new JobsMigrationError(
        `the migration identity "${identity.user}" holds no CREATE on database ` +
          `"${identity.database}" — this looks like a runtime DSN; the migration runs ` +
          `under the migration identity, never a runtime credential`,
      );
    }

    const before = await pool.query<{ found: string | null }>(
      `SELECT to_regclass('${JOBS_PGBOSS_SCHEMA}.version')::text AS found`,
    );
    const schemaExisted = before.rows[0]?.found != null;
    const schemaVersionBefore = schemaExisted ? await readSchemaVersion(pool) : null;
    // The queue table is created in the same DDL as the version table, so a
    // schema that exists carries a readable queue row; a half-installed
    // schema fails this read and fails the run loudly.
    const queueBefore: QueuePolicyRow | null = schemaExisted
      ? await readQueuePolicyRow(pool)
      : null;
    const queueExisted = queueBefore != null;

    boss = new PgBoss({ connectionString, ...jobsMigrationBossOptions() });
    // Installs the schema when missing, migrates it when behind, and verifies
    // it (read-only) when current — the pinned dependency's own DDL path.
    await boss.start();
    if (!queueExisted) {
      await boss.createQueue(JOBS_QUEUE_NAME, JOBS_QUEUE_POLICY);
    }

    let row = await readQueuePolicyRow(pool);
    if (!row) {
      throw new JobsMigrationError(
        `the "${JOBS_QUEUE_NAME}" queue is absent after the migration run — the queue creation did not take effect`,
      );
    }
    let diffs = compareQueuePolicy(row);
    const repairable = diffs.filter((diff) => !UNREPAIRABLE_QUEUE_FIELDS.has(diff.field));
    if (repairable.length > 0 && queueExisted) {
      // The platform owns the queue policy: converge an existing queue's
      // updatable fields back to it rather than accepting the drift.
      await boss.updateQueue(JOBS_QUEUE_NAME, queueRepairOptions());
      row = await readQueuePolicyRow(pool);
      if (!row) {
        throw new JobsMigrationError(`the "${JOBS_QUEUE_NAME}" queue disappeared during repair`);
      }
      diffs = compareQueuePolicy(row);
    }
    if (diffs.length > 0) {
      throw new JobsMigrationError(
        `the "${JOBS_QUEUE_NAME}" queue does not carry the platform policy — ${describeDiffs(diffs)}. ` +
          (queueExisted
            ? `Fields fixed at creation (policy, partition) cannot be repaired by this command; ` +
              `resolve the drift on the store before it is used`
            : `the queue was created by this run, so the stored policy is not what this ` +
              `command set — the pinned dependency's create path changed; re-verify the policy`),
      );
    }

    const burnStoreExisted = await ensureInstructionBurnStore(pool);
    const lifecycleStoreExisted = await ensureAppLifecycleStore(pool);
    const { existed: jobRecordExisted, columnsAdded: jobRecordColumnsAdded } =
      await ensureJobRecordStore(pool);

    await grantRuntimeAccess(pool, role);

    const schemaVersion = await readSchemaVersion(pool);
    if (schemaVersion !== PGBOSS_SCHEMA_VERSION) {
      throw new JobsMigrationError(
        `the pg-boss schema is at version ${schemaVersion} after the run, expected ${PGBOSS_SCHEMA_VERSION}`,
      );
    }
    return {
      schemaVersionBefore,
      schemaVersion,
      queueExisted,
      queuePolicyRepairs: repairable.map((diff) => diff.field),
      burnStoreExisted,
      lifecycleStoreExisted,
      jobRecordExisted,
      jobRecordColumnsAdded,
    };
  } finally {
    if (boss) {
      // A failed stop must not mask the migration's own failure: the pools it
      // would leak belong to this short-lived process, and the exit code
      // carries the migration outcome.
      await boss.stop({ graceful: true, timeout: 5_000 }).catch(() => {});
    }
    await pool.end();
  }
}

/**
 * Create the instruction burn store — the jobs service's own durable nonce
 * table (its schema, its database, never a `pgboss` object) — idempotently:
 * the schema and table are created when missing and left alone when present,
 * so re-running converges rather than resets. Burned nonces outlive any one
 * token's validity, so the table's contents are the receiver's replay memory;
 * the runtime keeps no retention here (each burn row carries its own
 * `burn_until`, and the service's sweep removes what has expired).
 *
 * Returns whether the table already existed, for the run's summary.
 */
async function ensureInstructionBurnStore(pool: Pool): Promise<boolean> {
  const before = await pool.query<{ found: string | null }>(
    `SELECT to_regclass($1)::text AS found`,
    [JOBS_INSTRUCTION_BURNS_QUALIFIED],
  );
  const existed = before.rows[0]?.found != null;
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${JOBS_SCHEMA}`);
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${JOBS_INSTRUCTION_BURNS_QUALIFIED} (
       scope      text        NOT NULL,
       jti        text        NOT NULL,
       burn_until timestamptz NOT NULL,
       PRIMARY KEY (scope, jti)
     )`,
  );
  // The sweep's only filter; without it every pass is a seq scan.
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_instruction_burns_burn_until
       ON ${JOBS_INSTRUCTION_BURNS_QUALIFIED} (burn_until)`,
  );
  return existed;
}

/**
 * Create the app-lifecycle store — one row per known app carrying the highest
 * lifecycle generation this server has durably applied and whether it is
 * archived (ADR-0007's admission/start authority) — idempotently, like the
 * burn store. The rows are tombstone-keeping state: a future hard app
 * deletion must still deliver its cancellation intent, so the runtime gets no
 * DELETE here and the rows are never removed by the service.
 *
 * Returns whether the table already existed, for the run's summary.
 */
async function ensureAppLifecycleStore(pool: Pool): Promise<boolean> {
  const before = await pool.query<{ found: string | null }>(
    `SELECT to_regclass($1)::text AS found`,
    [JOBS_APP_LIFECYCLE_QUALIFIED],
  );
  const existed = before.rows[0]?.found != null;
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${JOBS_SCHEMA}`);
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${JOBS_APP_LIFECYCLE_QUALIFIED} (
       app_id     text        NOT NULL,
       generation bigint      NOT NULL,
       archived   boolean     NOT NULL,
       PRIMARY KEY (app_id)
     )`,
  );
  return existed;
}

/**
 * Create the job-record store — one row per accepted job carrying the
 * wrapper identity the acceptance transaction commits with the runner's own
 * row (ADR-0003): the immutable attribution, the admitted lifecycle
 * generation, the public status projection, the durable owner-cancellation
 * intent, the optional retry key's scoped claim and the digest of the exact
 * original input bytes. The execution
 * seam's columns ride the same table: the attempt number, the bounded latest
 * progress snapshot, the last attempt's failure code and the successful
 * result. Idempotent, like the other stores — the execution columns converge
 * by `ADD COLUMN IF NOT EXISTS`, so a record store created before the
 * execution migration is brought forward in place, never rebuilt.
 *
 * The scoped-key UNIQUE constraint is the retry namespace
 * (`server/appId/env/ownerKind/ownerOid/type/key`): two keys' namespaces are
 * disjoint by those columns, and unkeyed rows (a NULL `retry_key`) are
 * distinct under the default NULLS DISTINCT semantics, so unkeyed
 * submissions never collide. The status column carries only the shared
 * public-status vocabulary; the check is generated from the shared constant
 * so the SQL and the wire contract cannot drift. The `runner_job_id` is
 * unique with the server — the join the worker and the cleanup consume.
 *
 * The execution columns' checks carry the projection's state machine in the
 * store: a successful row always has its result, a result exists only on a
 * row projecting success (including its expired-but-uncleaned form), the
 * error code is always from the shared vocabulary, and an attempt is 1-based.
 *
 * The occupancy index bounds the acceptance transaction's capacity counts
 * (`server, app_id, env, status`): the leading column serves the server-wide
 * counts, the whole index the per-app/environment ones, and the status
 * column the unfinished/retained split — the design's "bounded indexed
 * counts" (§4).
 *
 * Returns whether the table already existed, for the run's summary.
 */
async function ensureJobRecordStore(
  pool: Pool,
): Promise<{ existed: boolean; columnsAdded: string[] }> {
  const before = await pool.query<{ found: string | null }>(
    `SELECT to_regclass($1)::text AS found`,
    [JOBS_JOB_RECORD_QUALIFIED],
  );
  const existed = before.rows[0]?.found != null;
  // The status vocabulary is the shared contract's, interpolated — the SQL
  // check and the wire enum cannot drift.
  const publicStatuses = JOB_STATUSES.map((status) => `'${status}'`).join(", ");
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${JOBS_SCHEMA}`);
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${JOBS_JOB_RECORD_QUALIFIED} (
       server        text        NOT NULL,
       job_id        text        NOT NULL,
       runner_job_id text        NOT NULL,
       app_id        text        NOT NULL,
       env           text        NOT NULL,
       owner_kind    text        NOT NULL,
       owner_oid     text        NOT NULL,
       type          text        NOT NULL,
       generation    bigint      NOT NULL,
       status        text        NOT NULL CHECK (status IN (${publicStatuses})),
       cancellation_requested boolean NOT NULL DEFAULT false,
       retry_key     text,
       body_sha256   text        NOT NULL,
       created_at    timestamptz NOT NULL,
       attempt       integer,
       progress      jsonb,
       error_code    text,
       result        text,
       PRIMARY KEY (server, job_id),
       UNIQUE (server, runner_job_id),
       UNIQUE (server, app_id, env, owner_kind, owner_oid, type, retry_key)
     )`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_job_record_server_app_env_status
        ON ${JOBS_JOB_RECORD_QUALIFIED} (server, app_id, env, status)`,
  );
  // The execution columns, converged for a store created before them.
  const added: string[] = [];
  for (const [name, ddl] of [
    [
      "attempt",
      `ALTER TABLE ${JOBS_JOB_RECORD_QUALIFIED} ADD COLUMN IF NOT EXISTS attempt integer`,
    ],
    [
      "progress",
      `ALTER TABLE ${JOBS_JOB_RECORD_QUALIFIED} ADD COLUMN IF NOT EXISTS progress jsonb`,
    ],
    [
      "error_code",
      `ALTER TABLE ${JOBS_JOB_RECORD_QUALIFIED} ADD COLUMN IF NOT EXISTS error_code text`,
    ],
    ["result", `ALTER TABLE ${JOBS_JOB_RECORD_QUALIFIED} ADD COLUMN IF NOT EXISTS result text`],
    [
      "cancellation_requested",
      // NOT NULL DEFAULT so every pre-existing row reads as "no cancellation
      // intent" — the only value the projection paths wrote before the column
      // could exist.
      `ALTER TABLE ${JOBS_JOB_RECORD_QUALIFIED} ADD COLUMN IF NOT EXISTS cancellation_requested boolean NOT NULL DEFAULT false`,
    ],
  ] as const) {
    const had = await pool.query<{ found: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2 AND column_name = $3
       ) AS found`,
      [JOBS_SCHEMA, "job_record", name],
    );
    await pool.query(ddl);
    if (had.rows[0]?.found !== true) added.push(name);
  }
  // The result column is TEXT — the bound's own canonical JSON text, never
  // parsed or re-serialized server-side: jsonb's parser is recursive and
  // refuses past ~8,000 nesting levels at the default max_stack_depth, and
  // the store must hold everything the result bound accepts (the wire
  // contract's judge is iterative; the storage form is what makes that true
  // end to end). An older store's jsonb column converges in place — its
  // jsonb text form is the same canonical JSON.
  const resultType = await pool.query<{ data_type: string }>(
    `SELECT data_type FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = 'result'`,
    [JOBS_SCHEMA, "job_record"],
  );
  const resultColumnType = resultType.rows[0]?.data_type;
  if (resultColumnType !== undefined && resultColumnType !== "text") {
    await pool.query(
      `ALTER TABLE ${JOBS_JOB_RECORD_QUALIFIED} ALTER COLUMN result TYPE text USING result::text`,
    );
  }
  const errorCodes = JOB_ERROR_CODES.map((code) => `'${code}'`).join(", ");
  await ensureCheckConstraint(
    pool,
    "job_record_attempt_positive",
    `attempt IS NULL OR attempt >= 1`,
  );
  await ensureCheckConstraint(
    pool,
    "job_record_error_code_vocabulary",
    `error_code IS NULL OR error_code IN (${errorCodes})`,
  );
  // The result's lifecycle: a row projecting success always has its result,
  // and a result exists only while the public record still projects it —
  // `expired` keeps its (soon-to-be-removed) result until the physical
  // cleanup clears both together.
  await ensureCheckConstraint(
    pool,
    "job_record_success_has_result",
    `status <> 'succeeded' OR result IS NOT NULL`,
  );
  await ensureCheckConstraint(
    pool,
    "job_record_result_only_while_projected",
    `result IS NULL OR status IN ('succeeded', 'expired')`,
  );
  return { existed, columnsAdded: added };
}

/**
 * Add one named CHECK constraint when it is missing — Postgres has no
 * `ADD CONSTRAINT IF NOT EXISTS`, so the constraint's presence is probed in
 * the catalog first and the migration converges instead of failing on
 * re-run.
 */
async function ensureCheckConstraint(pool: Pool, name: string, definition: string): Promise<void> {
  const present = await pool.query<{ found: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname = $1 AND conrelid = '${JOBS_JOB_RECORD_QUALIFIED}'::regclass
     ) AS found`,
    [name],
  );
  if (present.rows[0]?.found === true) return;
  await pool.query(
    `ALTER TABLE ${JOBS_JOB_RECORD_QUALIFIED} ADD CONSTRAINT ${name} CHECK (${definition})`,
  );
}

/**
 * Grant the runtime role its DML on the runner's tables. The migration owns
 * the grants because provisioning sets no default privileges on either side
 * (fail-closed): a table that skipped its grant fails the runtime at first
 * use instead of widening the migration identity. The runtime role gets
 * reach and DML — never DDL, so a runtime credential cannot migrate.
 */
async function grantRuntimeAccess(pool: Pool, role: string): Promise<void> {
  const exists = await pool.query<{ found: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS found`,
    [role],
  );
  if (exists.rows[0]?.found !== true) {
    throw new JobsMigrationError(
      `the runtime role "${role}" does not exist — run the platform role provisioning before the jobs migration`,
    );
  }
  await pool.query(`GRANT USAGE ON SCHEMA ${JOBS_PGBOSS_SCHEMA} TO ${role}`);
  await pool.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${JOBS_PGBOSS_SCHEMA} TO ${role}`,
  );
  await pool.query(`GRANT USAGE ON SCHEMA ${JOBS_SCHEMA} TO ${role}`);
  await pool.query(
    `GRANT SELECT, INSERT, DELETE ON ${JOBS_INSTRUCTION_BURNS_QUALIFIED} TO ${role}`,
  );
  // The lifecycle store takes no DELETE from anyone: its rows are tombstone
  // state (a future app deletion still delivers its cancellation intent), so
  // the runtime reads, inserts and updates it — never removes from it.
  await pool.query(`GRANT SELECT, INSERT, UPDATE ON ${JOBS_APP_LIFECYCLE_QUALIFIED} TO ${role}`);
  // The job-record store's full DML: the acceptance transaction inserts, the
  // observation paths read, and the physical cleanup (the record's only
  // remover) deletes the row together with its runner row — which is what
  // releases the retry key.
  await pool.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${JOBS_JOB_RECORD_QUALIFIED} TO ${role}`,
  );

  // Verify the grants landed by asking the privilege system, not by trusting
  // the statements' success: a future pg-boss object kind that `ALL TABLES`
  // does not cover must fail this run, not the runtime at first use.
  const probes = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;
  const checked = await pool.query<Record<string, boolean>>(
    `SELECT ${probes
      .map(
        (privilege) =>
          `has_table_privilege('${role}', '${JOBS_PGBOSS_SCHEMA}.job', '${privilege}') AS ${privilege.toLowerCase()}`,
      )
      .join(", ")}`,
  );
  const burnChecked = await pool.query<Record<string, boolean>>(
    `SELECT ${["SELECT", "INSERT", "DELETE"]
      .map(
        (privilege) =>
          `has_table_privilege('${role}', '${JOBS_INSTRUCTION_BURNS_QUALIFIED}', '${privilege}') AS ${privilege.toLowerCase()}`,
      )
      .join(", ")}`,
  );
  const lifecycleChecked = await pool.query<Record<string, boolean>>(
    `SELECT ${["SELECT", "INSERT", "UPDATE"]
      .map(
        (privilege) =>
          `has_table_privilege('${role}', '${JOBS_APP_LIFECYCLE_QUALIFIED}', '${privilege}') AS ${privilege.toLowerCase()}`,
      )
      .join(", ")}`,
  );
  const recordChecked = await pool.query<Record<string, boolean>>(
    `SELECT ${["SELECT", "INSERT", "UPDATE", "DELETE"]
      .map(
        (privilege) =>
          `has_table_privilege('${role}', '${JOBS_JOB_RECORD_QUALIFIED}', '${privilege}') AS ${privilege.toLowerCase()}`,
      )
      .join(", ")}`,
  );
  const row = checked.rows[0];
  const burnRow = burnChecked.rows[0];
  const lifecycleRow = lifecycleChecked.rows[0];
  const recordRow = recordChecked.rows[0];
  const missing: string[] = probes.filter((privilege) => row?.[privilege.toLowerCase()] !== true);
  for (const privilege of ["SELECT", "INSERT", "DELETE"] as const) {
    if (burnRow?.[privilege.toLowerCase()] !== true) {
      missing.push(`${privilege} on ${JOBS_INSTRUCTION_BURNS_QUALIFIED}`);
    }
  }
  for (const privilege of ["SELECT", "INSERT", "UPDATE"] as const) {
    if (lifecycleRow?.[privilege.toLowerCase()] !== true) {
      missing.push(`${privilege} on ${JOBS_APP_LIFECYCLE_QUALIFIED}`);
    }
  }
  for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"] as const) {
    if (recordRow?.[privilege.toLowerCase()] !== true) {
      missing.push(`${privilege} on ${JOBS_JOB_RECORD_QUALIFIED}`);
    }
  }
  if (missing.length > 0) {
    throw new JobsMigrationError(
      `the runtime role "${role}" lacks ${missing.join(", ")} after the grants — ` +
        `the store is not usable by the runtime`,
    );
  }
}

// The command entry point. The function above is what tests call; this is the
// separately executed job.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const startedAt = Date.now();
  const dsn = process.env.JOBS_MIGRATE_DATABASE_URL;
  if (!dsn) {
    console.error(
      JSON.stringify({
        event: "jobs_storage_migration_failed",
        error: "JOBS_MIGRATE_DATABASE_URL is required — the migration identity's DSN",
      }),
    );
    process.exitCode = 1;
  } else {
    console.log(
      JSON.stringify({ event: "jobs_storage_migration_started", store: describeDsn(dsn) }),
    );
    try {
      const summary = await migrateJobsStorage(dsn);
      console.log(
        JSON.stringify({
          event: "jobs_storage_migration_applied",
          ...summary,
          durationMs: Date.now() - startedAt,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "jobs_storage_migration_failed",
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt,
        }),
      );
      process.exitCode = 1;
    }
  }
}
