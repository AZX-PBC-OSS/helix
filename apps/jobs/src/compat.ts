import type { Pool, PoolClient } from "pg";

import {
  JOBS_APP_LIFECYCLE_QUALIFIED,
  JOBS_INSTRUCTION_BURNS_QUALIFIED,
  JOBS_INTAKE_QUALIFIED,
  JOBS_JOB_RECORD_QUALIFIED,
  JOBS_PGBOSS_SCHEMA,
  JOBS_QUEUE_NAME,
  JOBS_QUEUE_POLICY_EFFECTIVE,
  JOBS_SCHEMA,
} from "./policy.js";
import { withJobsClient } from "./pool.js";

// The expected pg-boss schema version, read from the installed package, so a
// catalog bump moves the expectation with the dependency.
import pgBossPackageJson from "pg-boss/package.json" with { type: "json" };

export const PGBOSS_SCHEMA_VERSION: number = pgBossPackageJson.pgboss.schema;

/** One queue-policy field that differs from the platform's expectation. */
export interface JobsQueuePolicyDiff {
  field: string;
  expected: number | string | boolean | null;
  actual: unknown;
}

/**
 * The compatibility verdict. The union is closed: the service boot maps each
 * kind to its own health answer, and an unknown store state must never read
 * as healthy.
 */
export type JobsStorageCompatibility =
  | { kind: "compatible"; schemaVersion: number }
  | { kind: "unreachable"; message: string }
  | { kind: "schema_missing" }
  | { kind: "schema_version"; found: number | null; expected: number }
  | { kind: "queue_missing" }
  | { kind: "queue_policy"; diffs: readonly JobsQueuePolicyDiff[] }
  | { kind: "burn_missing" }
  | { kind: "lifecycle_missing" }
  | { kind: "intake_missing" }
  | { kind: "record_missing" }
  | { kind: "record_schema"; problems: readonly string[] }
  | { kind: "runtime_privileges"; missing: readonly string[] };

/** The queue-table columns this check compares — pg-boss's effective queue policy. */
const QUEUE_POLICY_FIELDS = [
  "policy",
  "retry_limit",
  "retry_delay",
  "retry_backoff",
  "retry_delay_max",
  "expire_seconds",
  "retention_seconds",
  "deletion_seconds",
  "warning_queued",
  "dead_letter",
  "partition",
  "table_name",
  "heartbeat_seconds",
  "notify",
] as const;

type QueuePolicyRow = {
  [K in (typeof QUEUE_POLICY_FIELDS)[number]]: unknown;
};
export type { QueuePolicyRow };

/** Postgres SQLSTATE for "undefined table" — a missing schema or version table. */
const UNDEFINED_TABLE = "42P01";
/** Postgres SQLSTATE for "insufficient privilege" — the identity cannot read a probe. */
const INSUFFICIENT_PRIVILEGE = "42501";

function sqlState(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

function unreachable(error: unknown): JobsStorageCompatibility {
  return {
    kind: "unreachable",
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * The schema name is the platform constant (never caller input), but the
 * probes below interpolate it — assert the bare-identifier invariant at the
 * seam so the interpolation cannot become a second input path.
 */
function qualifiedObject(name: string): string {
  if (!/^[a-z_][a-z0-9_.]*$/.test(name)) {
    throw new Error(`the pg-boss object name is not a bare lowercase identifier: ${name}`);
  }
  return name;
}

/**
 * The installed pg-boss schema version, or null when the version table has no
 * row. A missing table raises a database error for the caller to classify.
 * Accepts a pool or a checked-out client — both run the same parameterized
 * read.
 */
export async function readSchemaVersion(client: Pool | PoolClient): Promise<number | null> {
  const result = await client.query<{ version: string | number }>(
    `SELECT version FROM ${qualifiedObject(`${JOBS_PGBOSS_SCHEMA}.version`)}`,
  );
  const version = result.rows[0]?.version;
  return version === undefined ? null : Number(version);
}

/**
 * The effective policy row of the platform queue, or null when no row exists.
 * The schema-version check runs before this read, so a reshaped queue table
 * cannot reach it silently — a version mismatch answers first.
 */
export async function readQueuePolicyRow(
  client: Pool | PoolClient,
): Promise<QueuePolicyRow | null> {
  const columns = QUEUE_POLICY_FIELDS.join(", ");
  const result = await client.query<QueuePolicyRow>(
    `SELECT ${columns} FROM ${qualifiedObject(`${JOBS_PGBOSS_SCHEMA}.queue`)} WHERE name = $1`,
    [JOBS_QUEUE_NAME],
  );
  return result.rows[0] ?? null;
}

/** The queue-policy fields that differ from {@link JOBS_QUEUE_POLICY_EFFECTIVE}. */
export function compareQueuePolicy(row: QueuePolicyRow): JobsQueuePolicyDiff[] {
  const diffs: JobsQueuePolicyDiff[] = [];
  for (const field of QUEUE_POLICY_FIELDS) {
    const expected = JOBS_QUEUE_POLICY_EFFECTIVE[field];
    const actual: unknown = row[field];
    if (actual !== expected) {
      diffs.push({ field, expected, actual });
    }
  }
  return diffs;
}

/**
 * The job-record store's own columns the execution projection writes — read
 * back by the compatibility check so a record store from before the
 * execution migration (present, but without the execution columns) is a
 * startup-visible verdict, not a first-execution failure. The result
 * column's TYPE is checked beside its presence: the projection stores the
 * bound's canonical JSON text, and a store still carrying the earlier jsonb
 * form would pass a presence-only probe and fail only when a result deep
 * enough to exceed jsonb's own parser arrived — a latent failure the
 * startup check exists to catch.
 */
const JOB_RECORD_COLUMNS = [
  "attempt",
  "progress",
  "error_code",
  "result",
  "cancellation_requested",
  "cancellation_requested_at",
  "terminal_at",
] as const;
/** The type each column must carry, as `information_schema.columns` reports it. */
const JOB_RECORD_COLUMN_TYPES: Record<(typeof JOB_RECORD_COLUMNS)[number], string> = {
  attempt: "integer",
  progress: "jsonb",
  error_code: "text",
  result: "text",
  cancellation_requested: "boolean",
  cancellation_requested_at: "timestamp with time zone",
  terminal_at: "timestamp with time zone",
};

/**
 * The runtime DML the runner needs on the store, probed through the privilege
 * system rather than by writing. Read-only: `has_*_privilege` never mutates.
 * The burn table needs INSERT (the burn claim), DELETE (the sweep) and SELECT
 * (the `ON CONFLICT` arbiter's read, as on the egress burn table). The
 * lifecycle store needs SELECT/INSERT/UPDATE (the apply's
 * insert-lock-merge-write transaction) and deliberately no DELETE — its rows
 * are tombstone state.
 */
async function missingRuntimePrivileges(client: PoolClient): Promise<string[]> {
  const probes: Array<{ name: string; sql: string }> = [
    {
      name: `USAGE on schema ${JOBS_PGBOSS_SCHEMA}`,
      sql: `SELECT has_schema_privilege(current_user, '${JOBS_PGBOSS_SCHEMA}', 'USAGE') AS ok`,
    },
    ...(["SELECT", "INSERT", "UPDATE", "DELETE"] as const).map((privilege) => ({
      name: `${privilege} on ${JOBS_PGBOSS_SCHEMA}.job`,
      sql: `SELECT has_table_privilege(current_user, '${JOBS_PGBOSS_SCHEMA}.job', '${privilege}') AS ok`,
    })),
    {
      name: `USAGE on schema ${JOBS_SCHEMA}`,
      sql: `SELECT has_schema_privilege(current_user, '${JOBS_SCHEMA}', 'USAGE') AS ok`,
    },
    ...(["SELECT", "INSERT", "DELETE"] as const).map((privilege) => ({
      name: `${privilege} on ${JOBS_INSTRUCTION_BURNS_QUALIFIED}`,
      sql: `SELECT has_table_privilege(current_user, '${JOBS_INSTRUCTION_BURNS_QUALIFIED}', '${privilege}') AS ok`,
    })),
    ...(["SELECT", "INSERT", "UPDATE"] as const).map((privilege) => ({
      name: `${privilege} on ${JOBS_APP_LIFECYCLE_QUALIFIED}`,
      sql: `SELECT has_table_privilege(current_user, '${JOBS_APP_LIFECYCLE_QUALIFIED}', '${privilege}') AS ok`,
    })),
    ...(["SELECT", "UPDATE"] as const).map((privilege) => ({
      name: `${privilege} on ${JOBS_INTAKE_QUALIFIED}`,
      sql: `SELECT has_table_privilege(current_user, '${JOBS_INTAKE_QUALIFIED}', '${privilege}') AS ok`,
    })),
    ...(["SELECT", "INSERT", "UPDATE", "DELETE"] as const).map((privilege) => ({
      name: `${privilege} on ${JOBS_JOB_RECORD_QUALIFIED}`,
      sql: `SELECT has_table_privilege(current_user, '${JOBS_JOB_RECORD_QUALIFIED}', '${privilege}') AS ok`,
    })),
  ];
  const missing: string[] = [];
  for (const probe of probes) {
    const result = await client.query<{ ok: boolean }>(probe.sql);
    if (result.rows[0]?.ok !== true) missing.push(probe.name);
  }
  return missing;
}

/**
 * Check the store a runtime is about to use, without changing it: every
 * statement is a catalog or table read. Takes the caller's pool — the caller
 * owns its lifetime. Every outcome is a verdict, never a throw; the verdict
 * names the first incompatibility found. The migration command is what
 * resolves every kind except two: `unreachable`, and a `schema_version` the
 * run cannot converge — an emptied version ledger, or one ahead of the pin —
 * where the run fails loudly without changing the store and an operator
 * repairs the ledger.
 */
export async function checkJobsStorageCompatibility(pool: Pool): Promise<JobsStorageCompatibility> {
  // The checkout window is withJobsClient's: a connection death mid-check is
  // recorded on the client (destroyed on release, never parked back) and
  // reported, while the awaited query's own rejection reaches the catch —
  // a probe that cannot run is a store that did not answer. The specific
  // verdicts (missing schema, denied probe) are classified where expected.
  try {
    return await withJobsClient(pool, (client) => readVerdict(client));
  } catch (error) {
    return unreachable(error);
  }
}

/** The read sequence, typed as always answering. */
async function readVerdict(client: PoolClient): Promise<JobsStorageCompatibility> {
  // A probe that cannot run because the schema or table is absent is the
  // missing-schema answer; one denied to this identity is a privilege
  // answer, not a missing schema.
  let schemaVersion: number | null;
  try {
    schemaVersion = await readSchemaVersion(client);
  } catch (error) {
    return sqlState(error) === INSUFFICIENT_PRIVILEGE
      ? { kind: "runtime_privileges", missing: [`SELECT on ${JOBS_PGBOSS_SCHEMA}.version`] }
      : sqlState(error) === UNDEFINED_TABLE
        ? { kind: "schema_missing" }
        : unreachable(error);
  }
  if (schemaVersion === null || schemaVersion !== PGBOSS_SCHEMA_VERSION) {
    return { kind: "schema_version", found: schemaVersion, expected: PGBOSS_SCHEMA_VERSION };
  }

  let row: QueuePolicyRow | null;
  try {
    row = await readQueuePolicyRow(client);
  } catch (error) {
    return sqlState(error) === INSUFFICIENT_PRIVILEGE
      ? { kind: "runtime_privileges", missing: [`SELECT on ${JOBS_PGBOSS_SCHEMA}.queue`] }
      : unreachable(error);
  }
  if (!row) {
    return { kind: "queue_missing" };
  }
  const diffs = compareQueuePolicy(row);
  if (diffs.length > 0) {
    return { kind: "queue_policy", diffs };
  }

  // The burn store is the receiver's replay memory: a store without it cannot
  // serve a single signed instruction, so its absence is its own verdict —
  // the same remedy (the migration command) as the schema answers, but a
  // different operator-visible reason.
  let burnsPresent: boolean;
  try {
    const found = await client.query<{ found: string | null }>(
      `SELECT to_regclass($1)::text AS found`,
      [JOBS_INSTRUCTION_BURNS_QUALIFIED],
    );
    burnsPresent = found.rows[0]?.found != null;
  } catch (error) {
    return sqlState(error) === INSUFFICIENT_PRIVILEGE
      ? { kind: "runtime_privileges", missing: ["SELECT on the burn store's catalog entry"] }
      : unreachable(error);
  }
  if (!burnsPresent) {
    return { kind: "burn_missing" };
  }

  // The lifecycle store is the admission/start gate's authority: without it
  // every delivery is refused and every submission is answered with retryable
  // unavailability forever, so its absence is its own verdict — the same
  // remedy (the migration command) as the burn store's, a different reason.
  let lifecyclePresent: boolean;
  try {
    const found = await client.query<{ found: string | null }>(
      `SELECT to_regclass($1)::text AS found`,
      [JOBS_APP_LIFECYCLE_QUALIFIED],
    );
    lifecyclePresent = found.rows[0]?.found != null;
  } catch (error) {
    return sqlState(error) === INSUFFICIENT_PRIVILEGE
      ? { kind: "runtime_privileges", missing: ["SELECT on the lifecycle store's catalog entry"] }
      : unreachable(error);
  }
  if (!lifecyclePresent) {
    return { kind: "lifecycle_missing" };
  }

  // The intake store is the durable admission gate: without it no admission
  // can be answered (the gate fails closed), so its absence is its own
  // verdict — the same remedy (the migration command) as the other stores',
  // a different reason.
  let intakePresent: boolean;
  try {
    const found = await client.query<{ found: string | null }>(
      `SELECT to_regclass($1)::text AS found`,
      [JOBS_INTAKE_QUALIFIED],
    );
    intakePresent = found.rows[0]?.found != null;
  } catch (error) {
    return sqlState(error) === INSUFFICIENT_PRIVILEGE
      ? { kind: "runtime_privileges", missing: ["SELECT on the intake store's catalog entry"] }
      : unreachable(error);
  }
  if (!intakePresent) {
    return { kind: "intake_missing" };
  }

  // The job-record store is acceptance itself: without it no submission can
  // commit, so its absence is its own verdict — the same remedy (the
  // migration command) as the other stores', a different reason.
  let recordPresent: boolean;
  try {
    const found = await client.query<{ found: string | null }>(
      `SELECT to_regclass($1)::text AS found`,
      [JOBS_JOB_RECORD_QUALIFIED],
    );
    recordPresent = found.rows[0]?.found != null;
  } catch (error) {
    return sqlState(error) === INSUFFICIENT_PRIVILEGE
      ? { kind: "runtime_privileges", missing: ["SELECT on the job-record store's catalog entry"] }
      : unreachable(error);
  }
  if (!recordPresent) {
    return { kind: "record_missing" };
  }

  // The record store's execution columns: a table from before the execution
  // migration passes the presence probe but cannot carry an attempt, a
  // progress snapshot or an outcome — its absence is its own verdict, the
  // same remedy (the migration command) as the record store's. A column
  // present at the wrong type is the same verdict: the projection's writes
  // would fail only on the values the wrong type cannot hold.
  let recordColumns: Map<string, string>;
  try {
    const columns = await client.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2`,
      [JOBS_SCHEMA, "job_record"],
    );
    recordColumns = new Map(columns.rows.map((row) => [row.column_name, row.data_type]));
  } catch (error) {
    return sqlState(error) === INSUFFICIENT_PRIVILEGE
      ? { kind: "runtime_privileges", missing: ["SELECT on the job-record store's columns"] }
      : unreachable(error);
  }
  const problems: string[] = [];
  for (const name of JOB_RECORD_COLUMNS) {
    const found = recordColumns.get(name);
    if (found === undefined) {
      problems.push(`column "${name}" is missing`);
      continue;
    }
    const expected = JOB_RECORD_COLUMN_TYPES[name];
    if (found !== expected) {
      problems.push(`column "${name}" is ${found}, expected ${expected}`);
    }
  }
  if (problems.length > 0) {
    return { kind: "record_schema", problems };
  }

  const missing = await missingRuntimePrivileges(client);
  if (missing.length > 0) {
    return { kind: "runtime_privileges", missing };
  }
  return { kind: "compatible", schemaVersion };
}
