import { JobServerIdSchema, JobsDatabaseUrlSchema } from "@azx-pbc/shared";
import { deriveJobsInstructionKey, JobsSigningDomains } from "@azx-pbc/shared/jobsSigning";
import { z } from "zod";

/**
 * The jobs service's boot configuration, resolved once at startup and never
 * re-read from `process.env` afterwards (the sibling services' discipline:
 * handlers never read the environment).
 *
 * This owns the configuration the service itself reads: its server identity,
 * its private store, and the two signing roots this receiver verifies
 * instructions with — the edge→jobs root for the four job operations and the
 * portal→jobs root for lifecycle delivery, named by
 * {@link JobsSigningDomains}' own `secretEnvVar` keys so the deployment wiring
 * and this loader cannot drift. The keys are derived here, at boot, so a
 * malformed root is an explicit startup error rather than a first-request
 * failure. The jobs→edge root (this service's minting half, for its fetch
 * callbacks) has no reader until the worker tickets consume it and is
 * deliberately not parsed here.
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
  /** The derived edge→jobs verification key (HKDF over this server's edge root). */
  edgeToJobsKey: Uint8Array;
  /** The derived portal→jobs verification key (HKDF over this server's portal root). */
  portalToJobsKey: Uint8Array;
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
 * Require one receiver signing root and derive its key. A missing root or one
 * that is not a canonical base64 32-byte secret is a boot error naming the
 * key — `deriveJobsInstructionKey`'s message already does, and derivation
 * here (not at first use) is what keeps a bad root from booting.
 */
function requireReceiverKey(
  env: NodeJS.ProcessEnv,
  direction: "edgeToJobs" | "portalToJobs",
): Uint8Array {
  const secretEnvVar = JobsSigningDomains[direction].secretEnvVar;
  const raw = env[secretEnvVar];
  if (raw === undefined || raw.trim() === "") {
    throw new Error(
      `${secretEnvVar} is required — this server's ${direction} signing root, which its instructions must verify against`,
    );
  }
  return deriveJobsInstructionKey(raw, direction);
}

/**
 * Resolve the boot configuration from the environment. Throws — with the key
 * named — on a missing credential, a value that cannot describe a valid
 * server identity or store, or a signing root that cannot derive a key. The
 * caller decides what a throw means (the production boot lets it crash the
 * process: fail at startup, never at the first request).
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
    edgeToJobsKey: requireReceiverKey(env, "edgeToJobs"),
    portalToJobsKey: requireReceiverKey(env, "portalToJobs"),
  };
}
