import {
  JobServerIdSchema,
  JobsDatabaseUrlSchema,
  JobsCapacityOverridesSchema,
  JobsInternalUrlSchema,
  resolveJobsCapacityLimits,
  type JobsCapacityLimits,
} from "@azx-pbc/shared";
import { deriveJobsInstructionKey, JobsSigningDomains } from "@azx-pbc/shared/jobsSigning";
import { z } from "zod";

/**
 * The jobs service's boot configuration, resolved once at startup and never
 * re-read from `process.env` afterwards (the sibling services' discipline:
 * handlers never read the environment).
 *
 * This owns the configuration the service itself reads: its server identity,
 * its private store, and all three signing roots of this server — the
 * edge→jobs root for the four job operations and the portal→jobs root for
 * lifecycle delivery, named by {@link JobsSigningDomains}' own `secretEnvVar`
 * keys so the deployment wiring and this loader cannot drift, plus the
 * jobs→edge root this service MINTS its fetch callbacks with. The keys are
 * derived here, at boot, so a malformed root is an explicit startup error
 * rather than a first-request failure.
 *
 * The two callback destinations are resolved at boot too (`JOBS_EDGE_PROD_URL`
 * / `JOBS_EDGE_DEV_URL`, ADR-0008): the executing handler selects between them
 * by the job's signed environment tier, never by user input, with no fallback
 * between them. Every failure here is an explicit startup error (design §8:
 * "Parse-invalid config and missing keys are boot errors") — a service that
 * cannot say which configuration it runs under must not boot into a
 * half-known state.
 */

/** The jobs service's runtime configuration. */
export interface JobsServiceConfig {
  /** The configured job server this instance runs as (`JOBS_SERVER_ID`). */
  serverId: string;
  /** This server's private store (`JOBS_DATABASE_URL`) — no other component holds it. */
  databaseUrl: string;
  /**
   * The intake posture this instance applies durably to its store at boot
   * (`JOBS_ACCEPTING`): `true` admits new work, `false` closes intake. Both
   * the config and the durable row must say open before work is admitted.
   */
  accepting: boolean;
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
  /** The derived jobs→edge minting key (HKDF over this server's callback root). */
  jobsToEdgeKey: Uint8Array;
  /**
   * The edge's fetch-callback base for `prod` jobs — selected by the job's
   * signed tier, never by input (`JOBS_EDGE_PROD_URL`).
   */
  edgeProdCallbackUrl: string;
  /**
   * The edge's fetch-callback base for `dev` jobs; no fallback to the other
   * destination when one is unavailable (`JOBS_EDGE_DEV_URL`).
   */
  edgeDevCallbackUrl: string;
  /**
   * The resolved capacity limits this service enforces with new enqueue —
   * the shared platform defaults with this deployment's `JOBS_LIMITS`
   * override applied. Platform-owned: inputs, manifests and grants cannot
   * change them.
   */
  limits: JobsCapacityLimits;
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
function requireSigningKey(
  env: NodeJS.ProcessEnv,
  direction: "edgeToJobs" | "portalToJobs" | "jobsToEdge",
): Uint8Array {
  const secretEnvVar = JobsSigningDomains[direction].secretEnvVar;
  const raw = env[secretEnvVar];
  if (raw === undefined || raw.trim() === "") {
    throw new Error(
      `${secretEnvVar} is required — this server's ${direction} signing root, which its instructions must ${direction === "jobsToEdge" ? "be minted from" : "verify against"}`,
    );
  }
  return deriveJobsInstructionKey(raw, direction);
}

/**
 * Require one internal callback destination: present, an absolute http(s) URL
 * with no credentials, query string or fragment (the shared
 * {@link JobsInternalUrlSchema}), trailing slashes stripped so appending the
 * operation's route cannot produce a doubled one.
 */
function requireCallbackUrl(env: NodeJS.ProcessEnv, key: string, tier: string): string {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") {
    throw new Error(
      `${key} is required — the edge's fetch-callback destination for ${tier} jobs, selected by the job's signed tier, never by input`,
    );
  }
  const verdict = JobsInternalUrlSchema.safeParse(raw.trim());
  if (!verdict.success) {
    throw new Error(
      `${key} must be an internal http(s) base URL — ${z.prettifyError(verdict.error)}`,
    );
  }
  return verdict.data.replace(/\/+$/, "");
}

/**
 * Require the intake posture: exactly `true` or `false` (trimmed). There is
 * no default and no looser spelling (`1`, `yes`, `TRUE`) on purpose — a
 * deployment that cannot say whether it admits work must not boot into a
 * half-known intake state, and a typo must never silently read as open.
 */
function requireAccepting(env: NodeJS.ProcessEnv): boolean {
  const raw = env.JOBS_ACCEPTING;
  const value = raw?.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(
    `JOBS_ACCEPTING is required and must be exactly "true" or "false" — the intake ` +
      `posture this instance applies durably to its store at boot` +
      (raw === undefined || value === "" ? "" : ` (got ${JSON.stringify(raw)})`),
  );
}

/**
 * Resolve the capacity limits this service enforces: the shared platform
 * defaults, with this deployment's optional `JOBS_LIMITS` override (the JSON
 * form of the shared override schema — the same fields a deployment map's
 * `limits` entry carries) applied through the one shared resolver. Absent or
 * blank means the defaults unchanged; anything present that does not parse as
 * an override — unknown controls, zero, negative, non-finite, past the
 * ceiling — is an explicit startup error, never a silently partial tuning.
 */
function loadCapacityLimits(env: NodeJS.ProcessEnv): JobsCapacityLimits {
  const raw = env.JOBS_LIMITS;
  if (raw === undefined || raw.trim() === "") {
    return resolveJobsCapacityLimits();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // The cause rides along for whoever inspects it, but never into a
    // default-rendered message: a parse error quotes fragments of the value,
    // and the operator needs the key, not the quote.
    throw new Error("JOBS_LIMITS must be a JSON object of capacity-limit overrides", {
      cause: error,
    });
  }
  const verdict = JobsCapacityOverridesSchema.safeParse(parsed);
  if (!verdict.success) {
    throw new Error(
      `JOBS_LIMITS is not a valid capacity override — ${z.prettifyError(verdict.error)}`,
    );
  }
  return resolveJobsCapacityLimits(verdict.data);
}

/**
 * Resolve the boot configuration from the environment. Throws — with the key
 * named — on a missing credential, a value that cannot describe a valid
 * server identity or store, a signing root that cannot derive a key, an
 * intake posture that is not exactly `true`/`false`, or a callback
 * destination that is not an internal base URL. The caller decides
 * what a throw means (the production boot lets it crash the process: fail at
 * startup, never at the first request).
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
    accepting: requireAccepting(env),
    statementTimeoutMs: requirePositiveMs(
      env.JOBS_STATEMENT_TIMEOUT_MS,
      DEFAULT_JOBS_STATEMENT_TIMEOUT_MS,
      "JOBS_STATEMENT_TIMEOUT_MS",
    ),
    edgeToJobsKey: requireSigningKey(env, "edgeToJobs"),
    portalToJobsKey: requireSigningKey(env, "portalToJobs"),
    jobsToEdgeKey: requireSigningKey(env, "jobsToEdge"),
    edgeProdCallbackUrl: requireCallbackUrl(env, "JOBS_EDGE_PROD_URL", "prod"),
    edgeDevCallbackUrl: requireCallbackUrl(env, "JOBS_EDGE_DEV_URL", "dev"),
    limits: loadCapacityLimits(env),
  };
}
