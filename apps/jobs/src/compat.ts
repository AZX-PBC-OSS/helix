import type { Pool, PoolClient } from "pg";

import {
  JOBS_INSTRUCTION_BURNS_QUALIFIED,
  JOBS_PGBOSS_SCHEMA,
  JOBS_QUEUE_NAME,
  JOBS_QUEUE_POLICY_EFFECTIVE,
  JOBS_SCHEMA,
} from "./policy.js";

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
 * The runtime DML the runner needs on the store, probed through the privilege
 * system rather than by writing. Read-only: `has_*_privilege` never mutates.
 * The burn table needs INSERT (the burn claim), DELETE (the sweep) and SELECT
 * (the `ON CONFLICT` arbiter's read, as on the egress burn table).
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
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    return await readVerdict(client);
  } catch (error) {
    // A probe that cannot run is a store that did not answer — connection
    // death mid-check, an unresolvable server error. The specific verdicts
    // (missing schema, denied probe) are classified where they are expected.
    return unreachable(error);
  } finally {
    client?.release();
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

  const missing = await missingRuntimePrivileges(client);
  if (missing.length > 0) {
    return { kind: "runtime_privileges", missing };
  }
  return { kind: "compatible", schemaVersion };
}
