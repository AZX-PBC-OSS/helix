import { Pool } from "pg";
import { PgBoss, type UpdateQueueOptions } from "pg-boss";

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
  JOBS_INSTRUCTION_BURNS_QUALIFIED,
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
  const pool = new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
  });
  // pg-pool strips a checked-out client's 'error' listener, so a connection
  // death while no query is outstanding would be an unhandled event that
  // kills the process before any await rejects; this listener keeps the run
  // alive so the next query's own failure carries the cause.
  pool.on("error", (error) => {
    console.error(
      JSON.stringify({ event: "jobs_storage_migration_pool_error", error: error.message }),
    );
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
  const row = checked.rows[0];
  const burnRow = burnChecked.rows[0];
  const missing: string[] = probes.filter((privilege) => row?.[privilege.toLowerCase()] !== true);
  for (const privilege of ["SELECT", "INSERT", "DELETE"] as const) {
    if (burnRow?.[privilege.toLowerCase()] !== true) {
      missing.push(`${privilege} on ${JOBS_INSTRUCTION_BURNS_QUALIFIED}`);
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
