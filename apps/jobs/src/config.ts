import { JobServerIdSchema, JobsDatabaseUrlSchema } from "@azx-pbc/shared";
import { z } from "zod";

/**
 * The jobs service's boot configuration, resolved once at startup and never
 * re-read from `process.env` afterwards (the sibling services' discipline:
 * handlers never read the environment).
 *
 * This owns the configuration the service itself reads: its server identity
 * and its private store. The deployment map's remaining entry fields — the
 * signing roots, callback destinations, installed types and intake/state
 * flags — arrive with the tickets that consume them (signed instruction
 * verification, the admission gate, worker registration); a value with no
 * reader is not parsed here, so a config field cannot look wired while
 * nothing consults it.
 *
 * Every failure here is an explicit startup error (design §8: "Parse-invalid
 * config and missing keys are boot errors") — a service that cannot say which
 * configuration it runs under must not boot into a half-known state.
 */

/** The jobs service's runtime configuration. */
export interface JobsServiceConfig {
  /** The configured job server this instance runs as (`JOBS_SERVER_ID`). */
  serverId: string;
  /** This server's private store (`JOBS_DATABASE_URL`) — no other component holds it. */
  databaseUrl: string;
  /**
   * Per-query `statement_timeout` for the service's pool
   * (`JOBS_STATEMENT_TIMEOUT_MS`; default {@link DEFAULT_JOBS_STATEMENT_TIMEOUT_MS}).
   * The same pool-exhaustion guard the edge's and egress's pools carry.
   */
  statementTimeoutMs: number;
}

/**
 * Default per-query ceiling for the jobs service's pool — the same shape and
 * reasoning as the edge's and egress's defaults: long enough for the
 * compatibility probes and the runner's own queries, short enough that no
 * stuck query can pin a pooled connection indefinitely.
 */
export const DEFAULT_JOBS_STATEMENT_TIMEOUT_MS = 10_000;

/**
 * A positive-milliseconds env value with a fallback: a non-finite or
 * non-positive interval would leave stuck queries unbounded or turn the
 * timeout into a no-op, so it is a boot error, not a runtime surprise.
 */
function requirePositiveMs(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `${name} must be a positive number of milliseconds (got ${JSON.stringify(raw)})`,
    );
  }
  return value;
}

/**
 * Resolve the boot configuration from the environment. Throws — with the key
 * named — on a missing credential or a value that cannot describe a valid
 * server identity or store. The caller decides what a throw means (the
 * production boot lets it crash the process: fail at startup, never at the
 * first request).
 */
export function loadJobsConfig(env: NodeJS.ProcessEnv = process.env): JobsServiceConfig {
  const serverId = env.JOBS_SERVER_ID;
  if (serverId === undefined || serverId.trim() === "") {
    throw new Error("JOBS_SERVER_ID is required — the configured job server this instance runs as");
  }
  const parsedServerId = JobServerIdSchema.safeParse(serverId.trim());
  if (!parsedServerId.success) {
    throw new Error(
      `JOBS_SERVER_ID is not a valid server id: ${z.prettifyError(parsedServerId.error)}`,
    );
  }

  const databaseUrl = env.JOBS_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === "") {
    throw new Error("JOBS_DATABASE_URL is required — this server's private jobs store");
  }
  const parsedDatabaseUrl = JobsDatabaseUrlSchema.safeParse(databaseUrl.trim());
  if (!parsedDatabaseUrl.success) {
    throw new Error(
      `JOBS_DATABASE_URL must be a postgres connection string — ${z.prettifyError(parsedDatabaseUrl.error)}`,
    );
  }

  return {
    serverId: parsedServerId.data,
    databaseUrl: parsedDatabaseUrl.data,
    statementTimeoutMs: requirePositiveMs(
      env.JOBS_STATEMENT_TIMEOUT_MS,
      DEFAULT_JOBS_STATEMENT_TIMEOUT_MS,
      "JOBS_STATEMENT_TIMEOUT_MS",
    ),
  };
}
