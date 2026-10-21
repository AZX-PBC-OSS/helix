import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  HealthStatusSchema,
  JOBS_DATABASE_CHECK,
  JOBS_DIAGNOSTIC_QUALIFIED_TYPE,
  JOBS_FETCH_QUALIFIED_TYPE,
  JOBS_LIFECYCLE_DELIVERY_CHECK,
  JobAcceptedSchema,
  JobRequestErrorSchema,
  JobSnapshotSchema,
  ManifestUpdateResultSchema,
  type HealthCheck,
  type HealthStatus,
  type JobAccepted,
  type JobSnapshot,
} from "@azx-pbc/shared";

import {
  JOBS_JOB_RECORD_QUALIFIED,
  JOBS_PGBOSS_SCHEMA,
  JOBS_RUNTIME_ROLE,
  JOBS_SCHEMA,
} from "./policy.js";
import { appCall, envEntries } from "./test/bicep.js";
import {
  createLiveApp,
  startJsonOrigin,
  startRealStack,
  waitFor,
  type AppSession,
  type ControlledJsonOrigin,
  type DevClient,
  type PortalClient,
  type RealStack,
} from "./test/realStack.js";

/**
 * The deployed composition, observed through the REAL running platform: every
 * service started holding ONLY the credentials its Azure container app
 * receives (per infra/azure/main.bicep), proven on the clean install and
 * again after an upgrade of the jobs store.
 *
 * The suite composes the local stack from the deployment definitions: a
 * custody table (read off main.bicep) says which credentials each container
 * app binds; the harness's `setServiceEnv` strips every other credential-shaped
 * key from each service's environment, and the services are restarted and then
 * driven through the whole jobs journey — signed hops included. The actual
 * credentials are then probed directly against Postgres: every platform
 * runtime credential is refused the jobs database, the jobs runtime credential
 * is refused the platform database, and neither can create schema objects,
 * record a migration, alter or drop the jobs store, assume the migration
 * identity, or widen its own grants — and the jobs migration command run with
 * a runtime credential exits non-zero leaving the store unchanged.
 *
 * Finally, the documented upgrade procedure (infra/azure/README.md, "The jobs
 * upgrade procedure (existing install)" — re-apply roles, run the two
 * migrations, roll the images) runs against a store holding accepted work:
 * every accepted job reference, outcome, result and retry identity stays
 * readable; a new jobs image against a not-yet-migrated store refuses through
 * `/health` and the job routes without migrating or writing; and the two
 * migrations are order-independent (proved in BOTH orders). A new image never
 * holds migration authority: the migration runs as its own identity, in a
 * command whose DSN lives only in this test process.
 *
 * What stays outside this suite: the processes run locally with the dev
 * IdP, Azurite and the dev secret envelope (the custody table's stand-ins,
 * each named with its reason) and without NODE_ENV=production; Key Vault
 * references, managed identities, ingress and the two Container Apps Jobs
 * exist only on Azure and are pinned statically by azureServiceWiring.test.ts
 * and azureMigrationWiring.test.ts.
 *
 * The tests run sequentially in file order and share one stack. The per-app
 * edge submission throttle (10 per minute, refusals included) is budgeted: a
 * handful of submissions per app per leg, never a submit loop.
 */

// ── the custody table: what each container app binds, per main.bicep ────────

const DEPLOYED_SERVICES = ["edge", "devGateway", "portal", "egress", "jobs"] as const;
type DeployedService = (typeof DEPLOYED_SERVICES)[number];

interface ServiceCustody {
  /** The main.bicep module that defines the container app. */
  bicepModule: string;
  /** The EXACT set of env names main.bicep binds with `secretRef` for that app. */
  secretRefs: readonly string[];
  /** secretRefs the LOCAL stack substitutes (the deployment's credential exists only on Azure). */
  notHeldLocally?: readonly string[];
  /**
   * Local credential keys that stand in for what Azure supplies by managed
   * identity or ingress — each with the one-line reason it must exist here.
   */
  standIns?: Record<string, string>;
}

const CUSTODY: Record<DeployedService, ServiceCustody> = {
  edge: {
    bicepModule: "edgeApp",
    secretRefs: [
      "EDGE_DATABASE_URL",
      "EDGE_OIDC_CLIENT_PRIVATE_KEY",
      "EDGE_OIDC_CLIENT_CERTIFICATE",
      "EDGE_AUTH_SECRET",
      "HELIX_INSTRUCTION_SECRET",
      "HELIX_INTERNAL_SECRET",
      "EDGE_JOBS_CONFIG",
    ],
    // Azure authenticates the edge's OIDC client with a certificate pair
    // (private_key_jwt); the local dev IdP takes a client secret instead.
    notHeldLocally: ["EDGE_OIDC_CLIENT_PRIVATE_KEY", "EDGE_OIDC_CLIENT_CERTIFICATE"],
    standIns: {
      EDGE_OIDC_CLIENT_SECRET:
        "client-secret auth to the dev IdP, in place of the certificate pair",
      AZURE_STORAGE_CONNECTION_STRING: "Azurite, in place of the blob managed identity",
      EDGE_TLS_CERT_FILE: "the edge terminates TLS locally; the ingress does in Azure",
      EDGE_TLS_KEY_FILE: "the edge terminates TLS locally; the ingress does in Azure",
    },
  },
  devGateway: {
    bicepModule: "devGatewayApp",
    secretRefs: [
      "EDGE_DEV_DATABASE_URL",
      "HELIX_INSTRUCTION_SECRET",
      "HELIX_INTERNAL_SECRET",
      "EDGE_JOBS_CONFIG",
    ],
    standIns: {
      EDGE_TLS_CERT_FILE: "the dev gateway terminates TLS locally; the ingress does in Azure",
      EDGE_TLS_KEY_FILE: "the dev gateway terminates TLS locally; the ingress does in Azure",
    },
  },
  portal: {
    bicepModule: "portalApp",
    secretRefs: [
      "PORTAL_DATABASE_URL",
      "PORTAL_SECRET",
      "HELIX_INTERNAL_SECRET",
      "HELIX_EXCHANGE_SECRET",
      "PORTAL_JOBS_CONFIG",
    ],
    standIns: {
      AZURE_STORAGE_CONNECTION_STRING: "Azurite, in place of the blob managed identity",
      DEV_SECRETS_KEK_FILE: "the dev envelope, in place of Key Vault",
    },
  },
  egress: {
    bicepModule: "egressApp",
    secretRefs: ["EGRESS_DATABASE_URL", "HELIX_INSTRUCTION_SECRET", "HELIX_EXCHANGE_SECRET"],
    standIns: {
      DEV_SECRETS_KEK_FILE: "the dev envelope, in place of Key Vault",
    },
  },
  jobs: {
    bicepModule: "jobsApp",
    secretRefs: [
      "JOBS_DATABASE_URL",
      "JOBS_EDGE_TO_JOBS_SECRET",
      "JOBS_JOBS_TO_EDGE_SECRET",
      "JOBS_PORTAL_TO_JOBS_SECRET",
    ],
  },
};

/**
 * A key is credential-shaped when its NAME says it could carry a secret. The
 * catalogue document (PORTAL_JOBS_CATALOGUE) is deliberately outside this
 * regex: it is serving state and type ids, rides as a plain value on Azure
 * too, and stripping it would change the composition's behavior.
 */
const CREDENTIAL_SHAPED =
  /(DATABASE_URL|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|_KEY_FILE|KEK|CONNECTION_STRING|CERTIFICATE|_CERT_FILE|JOBS_CONFIG)/;

/** Which jobs signing roots each service's env VALUES may carry: a root reaches only its hop's signer and receiver. */
const PERMITTED_ROOTS: Record<
  DeployedService,
  { edgeToJobs: boolean; jobsToEdge: boolean; portalToJobs: boolean }
> = {
  edge: { edgeToJobs: true, jobsToEdge: true, portalToJobs: false },
  devGateway: { edgeToJobs: true, jobsToEdge: true, portalToJobs: false },
  portal: { edgeToJobs: false, jobsToEdge: false, portalToJobs: true },
  egress: { edgeToJobs: false, jobsToEdge: false, portalToJobs: false },
  jobs: { edgeToJobs: true, jobsToEdge: true, portalToJobs: true },
};

const ROOT_KEY_OF = {
  edgeToJobs: "JOBS_EDGE_TO_JOBS_SECRET",
  jobsToEdge: "JOBS_JOBS_TO_EDGE_SECRET",
  portalToJobs: "JOBS_PORTAL_TO_JOBS_SECRET",
} as const;

/** The DSNs and named secrets whose VALUES the custody check traces into each service's env. */
const VALUE_CUSTODY_KEYS = [
  "DATABASE_URL",
  "PORTAL_DATABASE_URL",
  "EDGE_DATABASE_URL",
  "EDGE_DEV_DATABASE_URL",
  "EGRESS_DATABASE_URL",
  "JOBS_DATABASE_URL",
  "JOBS_EDGE_TO_JOBS_SECRET",
  "JOBS_JOBS_TO_EDGE_SECRET",
  "JOBS_PORTAL_TO_JOBS_SECRET",
  "HELIX_INSTRUCTION_SECRET",
  "HELIX_INTERNAL_SECRET",
  "HELIX_EXCHANGE_SECRET",
  "EDGE_AUTH_SECRET",
  "PORTAL_SECRET",
] as const;

// ── shared suite state ───────────────────────────────────────────────────────

let stack: RealStack;
let origin: ControlledJsonOrigin;
let bob: PortalClient;
let alice: PortalClient;
/** The shared stack env, snapshotted in beforeAll before any per-service override. */
let sharedEnv: Readonly<Record<string, string>>;

let slugA: string;
let sessionA: AppSession;
let slugB: string;
let sessionB: AppSession;

/** S's retry identity: a KNOWN key and exact body bytes, replayed after each upgrade. */
let keyS = "";
let bodyS = "";

interface RecordedJob {
  jobId: string;
  snapshot: JobSnapshot;
  /** The exact result bytes, for the job that produced one. */
  resultText: string | null;
}
const recorded: Partial<Record<"S" | "F" | "C", RecordedJob>> = {};
const recordedJob = (which: "S" | "F" | "C"): RecordedJob =>
  must(recorded[which], `the recorded ${which} job`);

/** The diagnostic left RUNNING when jobs stops (leg 4), recovered after each upgrade. */
let runningJobId = "";
/** The diagnostic left RUNNING across the second (jobs-first) upgrade. */
let runningJob2Id = "";

const must = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) throw new Error(`the suite never produced ${what}`);
  return value;
};

// ── small drivers over the harness clients (copied patterns, not imports) ────

const SUBMIT_PATH_FETCH = "/_api/jobs/jobs/types/fetch";
const SUBMIT_PATH_DIAGNOSTIC = "/_api/jobs/jobs/types/diagnostic";
const statusPath = (jobId: string): string => `/_api/jobs/jobs/${jobId}`;
const resultPath = (jobId: string): string => `/_api/jobs/jobs/${jobId}/result`;

type Api = AppSession["api"] | DevClient["api"];

/** One health read, asserting the always-200 contract every time. */
async function healthOf(name: "jobs" | "portal" | "edge"): Promise<HealthStatus> {
  const url =
    name === "jobs"
      ? `http://localhost:${stack.ports.jobs}/health`
      : name === "portal"
        ? `${stack.portalUrl}/health`
        : `https://${stack.baseDomain}:${stack.ports.edge}/health`;
  const res = await stack.request(url);
  expect(res.status, `the ${name} /health answers HTTP 200 in every state`).toBe(200);
  return HealthStatusSchema.parse(res.json());
}

/** One named sub-check of a health body — throws when absent. */
function check(body: HealthStatus, name: string): HealthCheck {
  const found = body.checks?.find((c) => c.name === name);
  if (found === undefined) {
    throw new Error(
      `the ${body.service} health body carries no ${name} check: ${JSON.stringify(body.checks)}`,
    );
  }
  return found;
}

/** The portal `/health` body's lifecycle-delivery reading: pass count and synchronized state. */
async function lifecycleDeliveryReading(): Promise<{ passes: number; synchronized: boolean }> {
  const res = await stack.request(`${stack.portalUrl}/health`);
  expect(res.status, "portal /health status").toBe(200);
  const body = HealthStatusSchema.parse(res.json());
  const delivery = body.checks?.find((c) => c.name === JOBS_LIFECYCLE_DELIVERY_CHECK);
  const metrics = delivery?.metrics;
  if (!metrics) return { passes: 0, synchronized: false };
  return {
    passes: metrics.passes ?? 0,
    synchronized: (metrics.targets ?? 0) > 0 && metrics.synchronizedTargets === metrics.targets,
  };
}

/**
 * Wait — bounded — for the portal's delivery to end a pass (after
 * `passesBefore` was read, so the reading cannot predate the app) with every
 * target synchronized.
 */
async function waitForLifecycleDelivery(passesBefore: number): Promise<void> {
  await waitFor(
    stack,
    "the portal's jobs_lifecycle_delivery check to end a pass with every target synchronized",
    { timeoutMs: 90_000 },
    async () => {
      const reading = await lifecycleDeliveryReading();
      return reading.passes > passesBefore && reading.synchronized ? true : undefined;
    },
  );
}

/**
 * Submit with a caller-chosen key and exact body bytes. A retryable 503 keeps
 * polling — the SAME key and bytes every time, the keyed-retry rule — with one
 * attempt per 7 s so refusals stay inside the per-app throttle; anything else
 * non-202 fails loudly.
 */
async function submitKeyed(
  api: Api,
  path: string,
  key: string,
  body: string,
  what: string,
): Promise<JobAccepted> {
  let last = "<none>";
  return waitFor(
    stack,
    () => `${what} to be accepted — last answer: ${last}`,
    { timeoutMs: 60_000, pollMs: 7_000 },
    async () => {
      const res = await api("POST", path, {
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body,
      });
      last = `${res.status} ${res.text.slice(0, 300)}`;
      if (res.status === 503) return undefined;
      if (res.status !== 202) {
        throw new Error(`${what} was refused: ${res.status} ${res.text.slice(0, 400)}`);
      }
      return JobAcceptedSchema.parse(res.json());
    },
  );
}

/** Submit new work under a fresh random key. */
const submitAccepted = (
  api: Api,
  path: string,
  input: unknown,
  what: string,
): Promise<JobAccepted> =>
  submitKeyed(api, path, `composition-${randomUUID()}`, JSON.stringify(input), what);

/** One snapshot read, parsed against the wire schema. */
async function readSnapshot(api: Api, jobId: string): Promise<JobSnapshot> {
  const res = await api("GET", statusPath(jobId));
  expect(res.status, `status read of job ${jobId}`).toBe(200);
  return JobSnapshotSchema.parse(res.json());
}

/**
 * Poll the snapshot until `until` holds. A retryable 503 keeps polling inside
 * the bound; anything else non-200 fails loudly.
 */
async function pollSnapshot(
  api: Api,
  jobId: string,
  until: (snapshot: JobSnapshot) => boolean,
  timeoutMs: number,
): Promise<JobSnapshot> {
  let last: JobSnapshot | undefined;
  return waitFor(
    stack,
    () => `job ${jobId} — last snapshot: ` + (last === undefined ? "<none>" : JSON.stringify(last)),
    { timeoutMs },
    async () => {
      const res = await api("GET", statusPath(jobId));
      if (res.status === 503) return undefined;
      expect(res.status, `status poll of job ${jobId}`).toBe(200);
      last = JobSnapshotSchema.parse(res.json());
      return until(last) ? last : undefined;
    },
  );
}

/** Wait until the job runs with at least the given reported step. */
async function pollUntilRunning(api: Api, jobId: string, minStep: number): Promise<JobSnapshot> {
  return pollSnapshot(
    api,
    jobId,
    (s) => s.status === "running" && (s.progress?.step ?? 0) >= minStep,
    60_000,
  );
}

// ── provisioning and upgrade commands, run the way a shell runs them ─────────

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const platformDbName = (): string => new URL(stack.platformOwnerDsn).pathname.replace(/^\//, "");
const jobsDbName = (): string => new URL(stack.jobsRuntimeDsn).pathname.replace(/^\//, "");
const swapDatabase = (dsn: string, name: string): string => {
  const u = new URL(dsn);
  u.pathname = `/${name}`;
  return u.toString();
};
const withLogin = (dsn: string, user: string, password: string): string => {
  const u = new URL(dsn);
  u.username = user;
  u.password = password;
  return u.toString();
};
/**
 * The jobs migration identity's DSN — the runtime DSN with the migration
 * identity's login. It lives only in this test process and in the migration
 * command's environment, never in any service's env.
 */
const migrationIdentityDsn = (): string =>
  withLogin(stack.jobsRuntimeDsn, "helix_jobs_migrate", "helix_jobs_migrate");

/** Run one upgrade step; a non-zero exit (or a spawn failure) throws with the output tail. */
function runOrThrow(cmd: {
  argv: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  what: string;
}): void {
  const res = spawnSync(cmd.argv[0]!, cmd.argv.slice(1), {
    cwd: cmd.cwd,
    encoding: "utf8",
    timeout: cmd.timeoutMs,
    ...(cmd.env === undefined ? {} : { env: cmd.env }),
  });
  const tail = (res.stderr || res.stdout || "").slice(-2_000);
  if (res.error !== undefined) {
    throw new Error(`${cmd.what}: ${res.error.message}\n${tail}`);
  }
  if (res.status !== 0) {
    throw new Error(`${cmd.what} exited ${res.status}:\n${tail}`);
  }
}

/** The documented roles re-apply: the one provisioning definition, idempotent. */
function applyRoles(what: string): void {
  runOrThrow({
    argv: [
      "psql",
      stack.platformOwnerDsn,
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      `platform_db=${platformDbName()}`,
      "-v",
      `jobs_db=${jobsDbName()}`,
      "-f",
      ".devcontainer/db-init/01-roles.sql",
    ],
    cwd: REPO_ROOT,
    timeoutMs: 120_000,
    what,
  });
}

/** The platform migration, with no jobs credential anywhere in its environment. */
function runPlatformMigration(what: string): void {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("JOBS_")) continue;
    env[key] = value;
  }
  env.DATABASE_URL = stack.platformOwnerDsn;
  runOrThrow({
    argv: ["pnpm", "--filter", "@azx-pbc/portal", "exec", "prisma", "migrate", "deploy"],
    cwd: REPO_ROOT,
    env,
    timeoutMs: 300_000,
    what,
  });
}

/** The jobs migration, under the migration identity alone — never a runtime credential. */
function runJobsMigration(what: string): void {
  runOrThrow({
    argv: [process.execPath, "--import", "tsx", "src/migrate.ts"],
    cwd: path.join(REPO_ROOT, "apps/jobs"),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      JOBS_MIGRATE_DATABASE_URL: migrationIdentityDsn(),
    },
    timeoutMs: 300_000,
    what,
  });
}

// ── Postgres probes: one short-lived connection per statement ────────────────

async function withClient<T>(dsn: string, fn: (client: PgClient) => Promise<T>): Promise<T> {
  const client = new PgClient({ connectionString: dsn, connectionTimeoutMillis: 15_000 });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    try {
      await client.end();
    } catch {
      // A client whose connect failed has nothing left to release.
    }
  }
}

/** Assert one statement is REFUSED with the expected Postgres error. */
async function expectRefused(
  dsn: string,
  sql: string,
  pattern: RegExp,
  what: string,
): Promise<void> {
  let refused: string | null = null;
  try {
    await withClient(dsn, (client) => client.query(sql));
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  if (refused === null) {
    throw new Error(`${what}: the statement was NOT refused`);
  }
  expect(refused, what).toMatch(pattern);
}

/** Assert one statement is allowed (a positive control). */
async function expectAllowed(dsn: string, sql: string, what: string): Promise<void> {
  try {
    await withClient(dsn, (client) => client.query(sql));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${what} — the positive control was refused: ${message}`, { cause: error });
  }
}

/** The count of tables (and views) in the jobs-owned schemas, via the jobs owner DSN. */
async function jobsSchemaTableCounts(): Promise<{ jobs: number; pgboss: number }> {
  return withClient(stack.jobsOwnerDsn, async (client) => {
    const res = await client.query<{ jobs: number; pgboss: number }>(
      `SELECT (SELECT count(*)::int FROM information_schema.tables WHERE table_schema = $1) AS jobs,
              (SELECT count(*)::int FROM information_schema.tables WHERE table_schema = $2) AS pgboss`,
      [JOBS_SCHEMA, JOBS_PGBOSS_SCHEMA],
    );
    const row = res.rows[0];
    if (!row) throw new Error("the jobs schema table-count read returned no row");
    return { jobs: row.jobs, pgboss: row.pgboss };
  });
}

async function jobRecordCount(): Promise<number> {
  return withClient(stack.jobsOwnerDsn, async (client) => {
    const res = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${JOBS_JOB_RECORD_QUALIFIED}`,
    );
    return res.rows[0]?.n ?? 0;
  });
}

/** Whether the job-record store carries the cancellation-instant column, via the jobs owner DSN. */
async function cancellationRequestedAtColumnPresent(): Promise<boolean> {
  return withClient(stack.jobsOwnerDsn, async (client) => {
    const res = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'job_record' AND column_name = 'cancellation_requested_at'`,
      [JOBS_SCHEMA],
    );
    return (res.rows[0]?.n ?? 0) > 0;
  });
}

// ── the isolation proof, run on the clean install and after each upgrade ─────

/**
 * Every DSN comes from `serviceEnvOf` — the credentials the composed
 * processes actually hold. Each refused statement runs on its own connection
 * and its own assertion, so one failure cannot mask the rest.
 */
async function assertIsolation(label: "clean" | "upgraded"): Promise<void> {
  const probe = `iso_${randomBytes(4).toString("hex")}`;

  const platformCredentials: ReadonlyArray<[DeployedService, string]> = [
    ["edge", must(stack.serviceEnvOf("edge").EDGE_DATABASE_URL, "the edge's EDGE_DATABASE_URL")],
    [
      "devGateway",
      must(
        stack.serviceEnvOf("devGateway").EDGE_DEV_DATABASE_URL,
        "the dev gateway's EDGE_DEV_DATABASE_URL",
      ),
    ],
    [
      "portal",
      must(stack.serviceEnvOf("portal").PORTAL_DATABASE_URL, "the portal's PORTAL_DATABASE_URL"),
    ],
    [
      "egress",
      must(stack.serviceEnvOf("egress").EGRESS_DATABASE_URL, "the egress's EGRESS_DATABASE_URL"),
    ],
  ];

  for (const [service, dsn] of platformCredentials) {
    await expectRefused(
      swapDatabase(dsn, jobsDbName()),
      "SELECT 1",
      /permission denied for database/,
      `${label}: the ${service} credential is refused the jobs database`,
    );
    await expectAllowed(
      dsn,
      "SELECT 1",
      `${label}: the ${service} credential reads its own database`,
    );
    await expectRefused(
      dsn,
      `CREATE TABLE public.${probe} (id int)`,
      /permission denied for schema public/,
      `${label}: the ${service} credential cannot create a table`,
    );
    await expectRefused(
      dsn,
      `CREATE SCHEMA ${probe}`,
      /permission denied for database/,
      `${label}: the ${service} credential cannot create a schema`,
    );
    await expectRefused(
      dsn,
      `INSERT INTO public._prisma_migrations (id, checksum, migration_name, started_at)
       VALUES ('x', 'x', 'x', now())`,
      /permission denied/,
      `${label}: the ${service} credential cannot record a migration`,
    );
  }

  const jobsDsn = must(
    stack.serviceEnvOf("jobs").JOBS_DATABASE_URL,
    "the jobs service's JOBS_DATABASE_URL",
  );
  await expectRefused(
    swapDatabase(jobsDsn, platformDbName()),
    "SELECT 1",
    /permission denied for database/,
    `${label}: the jobs runtime credential is refused the platform database`,
  );
  await expectAllowed(
    jobsDsn,
    `SELECT count(*) FROM ${JOBS_JOB_RECORD_QUALIFIED}`,
    `${label}: the jobs runtime credential reads its own job records`,
  );
  await expectRefused(
    jobsDsn,
    `CREATE SCHEMA ${probe}`,
    /permission denied for database/,
    `${label}: the jobs runtime credential cannot create a schema`,
  );
  await expectRefused(
    jobsDsn,
    `CREATE TABLE public.${probe} (id int)`,
    /permission denied for schema public/,
    `${label}: the jobs runtime credential cannot create a table in public`,
  );
  await expectRefused(
    jobsDsn,
    `CREATE TABLE ${JOBS_SCHEMA}.${probe} (id int)`,
    /permission denied for schema/,
    `${label}: the jobs runtime credential cannot create a table in the jobs schema`,
  );
  await expectRefused(
    jobsDsn,
    `ALTER TABLE ${JOBS_JOB_RECORD_QUALIFIED} ADD COLUMN ${probe} int`,
    /must be owner/,
    `${label}: the jobs runtime credential cannot alter the job-record store`,
  );
  await expectRefused(
    jobsDsn,
    `DROP TABLE ${JOBS_JOB_RECORD_QUALIFIED}`,
    /must be owner/,
    `${label}: the jobs runtime credential cannot drop the job-record store`,
  );
  await expectRefused(
    jobsDsn,
    "SET ROLE helix_jobs_migrate",
    /permission denied|must be member/,
    `${label}: the jobs runtime credential cannot assume the migration identity`,
  );

  // The runtime cannot widen its own grants. Whether Postgres refuses the
  // statement outright or accepts it as a no-op, PUBLIC must hold no table
  // privilege afterwards — read back through the owner, not trusted to the
  // statement's outcome.
  let grantMessage: string | null = null;
  try {
    await withClient(jobsDsn, (client) =>
      client.query(`GRANT ALL ON ${JOBS_JOB_RECORD_QUALIFIED} TO PUBLIC`),
    );
  } catch (error) {
    grantMessage = error instanceof Error ? error.message : String(error);
  }
  if (grantMessage !== null) {
    expect(grantMessage, `${label}: the jobs runtime credential's GRANT to PUBLIC`).toMatch(
      /permission denied|grant options/,
    );
  }
  await withClient(stack.jobsOwnerDsn, async (client) => {
    const res = await client.query<Record<string, boolean>>(
      `SELECT has_table_privilege('public', '${JOBS_JOB_RECORD_QUALIFIED}', 'SELECT') AS sel,
              has_table_privilege('public', '${JOBS_JOB_RECORD_QUALIFIED}', 'INSERT') AS ins,
              has_table_privilege('public', '${JOBS_JOB_RECORD_QUALIFIED}', 'UPDATE') AS upd,
              has_table_privilege('public', '${JOBS_JOB_RECORD_QUALIFIED}', 'DELETE') AS del`,
    );
    const row = res.rows[0];
    if (!row) throw new Error(`${label}: the PUBLIC-privilege read returned no row`);
    for (const [privilege, granted] of Object.entries(row)) {
      expect(granted, `${label}: PUBLIC holds ${privilege} on the job-record store`).toBe(false);
    }
  });

  // The migration command with the runtime credential: exits non-zero, changes nothing.
  const tablesBefore = await jobsSchemaTableCounts();
  const res = spawnSync(process.execPath, ["--import", "tsx", "src/migrate.ts"], {
    cwd: path.join(REPO_ROOT, "apps/jobs"),
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      JOBS_MIGRATE_DATABASE_URL: jobsDsn,
    },
  });
  expect(
    res.status,
    `${label}: the migration command with the runtime credential must exit non-zero, ` +
      `got ${res.status} (stderr: ${(res.stderr || "").slice(-300)})`,
  ).not.toBe(0);
  expect(
    await jobsSchemaTableCounts(),
    `${label}: the refused migration run left the store's table inventory unchanged`,
  ).toEqual(tablesBefore);
}

// ── app provisioning helpers ─────────────────────────────────────────────────

const appPage = (marker: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${marker}</title></head>` +
  `<body><p>${marker}</p></body></html>`;

/**
 * Grant an app the fetch and diagnostic types plus the controlled origin as a
 * keyless fetch origin — exactly the SPA capability editor's save body for
 * these choices. The types are baseline (applied at once); the origin is
 * elevated, so its approval is filed pending and decided by alice (never the
 * requester).
 */
async function grantJobsApp(slug: string): Promise<void> {
  const saved = await bob.put(`/api/v1/apps/${slug}/manifest`, {
    capabilities: {
      mcp: [],
      externalOrigins: [],
      fetch: { shim: false, origins: [{ origin: origin.origin }] },
      jobs: { types: [JOBS_FETCH_QUALIFIED_TYPE, JOBS_DIAGNOSTIC_QUALIFIED_TYPE] },
    },
  });
  expect(saved.status, `the manifest save for ${slug}`).toBe(200);
  const saveResult = ManifestUpdateResultSchema.parse(saved.json());
  const pendingId = must(saveResult.pending ?? null, `the pending origin approval for ${slug}`);
  const approved = await alice.post(`/api/v1/approvals/${pendingId}/approve`);
  expect(approved.status, `the origin approval for ${slug}`).toBe(200);
}

/** Create, deploy, promote and grant an app, then wait for its delivery to the jobs server. */
async function createGrantedApp(purpose: string): Promise<string> {
  const slug = `composition-${purpose}-${randomBytes(3).toString("hex")}`;
  await createLiveApp(stack, bob, {
    slug,
    files: { "index.html": appPage(`composition-${purpose}`) },
  });
  await grantJobsApp(slug);
  const passesBefore = (await lifecycleDeliveryReading()).passes;
  await waitForLifecycleDelivery(passesBefore);
  return slug;
}

// ── the suite ────────────────────────────────────────────────────────────────

describe("the deployed composition: custody, isolation and upgrade, over the real stack", () => {
  beforeAll(async () => {
    stack = await startRealStack({ label: "composition", diagnostics: true });
    origin = await startJsonOrigin();
    // The shared env, before any per-service override: every service composes
    // from it identically until this suite strips it down.
    sharedEnv = stack.serviceEnvOf("edge");
    bob = await stack.portalAs("bob@azx.dev");
    alice = await stack.portalAs("alice@azx.dev");
    keyS = `composition-upgrade-${randomUUID()}`;
    bodyS = JSON.stringify({ url: `${origin.origin}/s` });
  }, 240_000);

  afterAll(async () => {
    await origin?.close();
    if (stack) await stack.close();
  }, 120_000);

  test(
    "leg 1: the deployment definitions name exactly the credentials the composition installs",
    { timeout: 60_000 },
    () => {
      for (const service of DEPLOYED_SERVICES) {
        const custody = CUSTODY[service];
        const bound = new Set(
          envEntries(appCall(custody.bicepModule))
            .filter((entry) => entry.secretRef !== undefined)
            .map((entry) => entry.name),
        );
        expect(
          bound,
          `${service}'s ${custody.bicepModule} must bind exactly the custody table's credentials`,
        ).toEqual(new Set(custody.secretRefs));
      }

      const entriesByModule = new Map(
        DEPLOYED_SERVICES.map((service) => [
          CUSTODY[service].bicepModule,
          envEntries(appCall(CUSTODY[service].bicepModule)),
        ]),
      );
      for (const [bicepModule, entries] of entriesByModule) {
        for (const entry of entries) {
          expect(entry.name, `${bicepModule}'s env must never carry the owner DSN`).not.toBe(
            "DATABASE_URL",
          );
          expect(entry.name, `${bicepModule}'s env must never carry the migration DSN`).not.toBe(
            "JOBS_MIGRATE_DATABASE_URL",
          );
        }
      }
      const modulesNaming = (envName: string): string[] =>
        [...entriesByModule]
          .filter(([, entries]) => entries.some((e) => e.name === envName))
          .map(([bicepModule]) => bicepModule)
          .sort();
      expect(
        modulesNaming("JOBS_DATABASE_URL"),
        "only the jobs app names JOBS_DATABASE_URL",
      ).toEqual(["jobsApp"]);
      expect(
        modulesNaming("EDGE_JOBS_CONFIG"),
        "only the two gateways name EDGE_JOBS_CONFIG",
      ).toEqual(["devGatewayApp", "edgeApp"]);
      expect(
        modulesNaming("PORTAL_JOBS_CONFIG"),
        "only the portal app names PORTAL_JOBS_CONFIG",
      ).toEqual(["portalApp"]);
    },
  );

  test(
    "leg 2: each service boots and serves the journey holding only its deployed credentials",
    { timeout: 300_000 },
    async () => {
      // 1. Strip every credential-shaped key outside the custody table's
      // permitted set, then assert the composition: what each process holds
      // equals exactly what its Azure container app receives (modulo the
      // stand-ins), so the journey below runs under the deployed custody.
      const permittedByService = new Map<DeployedService, Set<string>>();
      for (const service of DEPLOYED_SERVICES) {
        const custody = CUSTODY[service];
        const permitted = new Set<string>([
          ...custody.secretRefs.filter((k) => !(custody.notHeldLocally ?? []).includes(k)),
          ...Object.keys(custody.standIns ?? {}),
        ]);
        permittedByService.set(service, permitted);

        const overrides: Record<string, string | null> = {};
        for (const [key, value] of Object.entries(stack.serviceEnvOf(service))) {
          if (value === undefined) continue;
          if (CREDENTIAL_SHAPED.test(key) && !permitted.has(key)) overrides[key] = null;
        }
        stack.setServiceEnv(service, overrides);

        const held = Object.keys(stack.serviceEnvOf(service)).filter((k) =>
          CREDENTIAL_SHAPED.test(k),
        );
        expect(new Set(held), `${service} must hold exactly its deployed credential set`).toEqual(
          permitted,
        );
      }

      // 2. Value-level custody: each secret's VALUE appears in a service's env
      // iff that service is permitted it. Messages name keys and services,
      // never values.
      const secrets = new Map<string, string>();
      for (const key of VALUE_CUSTODY_KEYS) {
        secrets.set(key, must(sharedEnv[key], `the shared env's ${key}`));
      }
      for (const service of DEPLOYED_SERVICES) {
        const env = stack.serviceEnvOf(service);
        const permittedKeys = must(permittedByService.get(service), "the permitted set");
        const values = Object.values(env).join("\n");
        for (const [key, value] of secrets) {
          const rootName =
            key === ROOT_KEY_OF.edgeToJobs
              ? "edgeToJobs"
              : key === ROOT_KEY_OF.jobsToEdge
                ? "jobsToEdge"
                : key === ROOT_KEY_OF.portalToJobs
                  ? "portalToJobs"
                  : null;
          const expected =
            rootName !== null ? PERMITTED_ROOTS[service][rootName] : permittedKeys.has(key);
          expect(
            values.includes(value),
            `${service}: the ${key} value must appear in its env iff permitted`,
          ).toBe(expected);
        }
        expect(
          values.includes("helix_jobs_migrate"),
          `${service}: no env value may name the migration identity`,
        ).toBe(false);
        const ownerDsn = must(sharedEnv.DATABASE_URL, "the shared owner DSN");
        expect(values.includes(ownerDsn), `${service}: no env value may carry the owner DSN`).toBe(
          false,
        );
      }

      // 3. Restart in dependency order; each must come all the way back.
      for (const name of ["portal", "egress", "jobs", "edge", "devGateway"] as const) {
        await stack.restart(name);
      }

      // 4. The journey under that composition: every signed hop's root
      // reaches its receiver, and only its holder signs it.
      slugA = await createGrantedApp("a");
      sessionA = await stack.appSession(slugA, "bob@azx.dev");

      origin.respond("/ok", { json: { ok: true, n: 1 } });
      const okJob = await submitAccepted(
        sessionA.api,
        SUBMIT_PATH_FETCH,
        { url: `${origin.origin}/ok` },
        "app A's prod fetch",
      );
      await pollSnapshot(sessionA.api, okJob.jobId, (s) => s.status === "succeeded", 60_000);
      const okResult = await sessionA.api("GET", resultPath(okJob.jobId));
      expect(okResult.status, "the prod fetch's result read").toBe(200);
      expect(JSON.parse(okResult.text)).toEqual({ ok: true, n: 1 });

      // The dev tier: a minted dev token, the dev gateway's own namespace,
      // the dev-tier callback reaching the dev gateway.
      const minted = await bob.post(`/api/v1/apps/${slugA}/dev-tokens`, {
        origins: ["http://localhost:5199"],
      });
      expect(minted.status, "the dev-token mint").toBe(201);
      const token = (minted.json() as { token: string }).token;
      const dev = stack.devClient(slugA, token, "http://localhost:5199");
      origin.respond("/dev", { json: { dev: true } });
      const devJob = await submitAccepted(
        dev.api,
        SUBMIT_PATH_FETCH,
        { url: `${origin.origin}/dev` },
        "app A's dev fetch",
      );
      await pollSnapshot(dev.api, devJob.jobId, (s) => s.status === "succeeded", 60_000);
      const devResult = await dev.api("GET", resultPath(devJob.jobId));
      expect(devResult.status, "the dev fetch's result read").toBe(200);
      expect(JSON.parse(devResult.text)).toEqual({ dev: true });
    },
  );

  test(
    "leg 3: the credentials each service holds are refused cross-database and DDL access (clean install)",
    { timeout: 300_000 },
    async () => {
      await assertIsolation("clean");
    },
  );

  test(
    "leg 4: accepted work before the upgrade — succeeded, failed, cancelled, and left running",
    { timeout: 300_000 },
    async () => {
      slugB = await createGrantedApp("b");
      sessionB = await stack.appSession(slugB, "bob@azx.dev");

      origin.respond("/s", { json: { upgraded: "kept", list: [1, 2, 3] } });
      origin.respond("/f", { status: 500, json: { boom: true } });
      origin.respond("/fresh", { json: { fresh: true } });

      // S: succeeded, under a KNOWN retry key and exact body bytes — the
      // identity replayed after each upgrade.
      const sAccepted = await submitKeyed(
        sessionB.api,
        SUBMIT_PATH_FETCH,
        keyS,
        bodyS,
        "the S fetch",
      );
      const sFinal = await pollSnapshot(
        sessionB.api,
        sAccepted.jobId,
        (s) => s.status === "succeeded",
        60_000,
      );
      const sResult = await sessionB.api("GET", resultPath(sAccepted.jobId));
      expect(sResult.status, "the S result read").toBe(200);
      recorded.S = { jobId: sAccepted.jobId, snapshot: sFinal, resultText: sResult.text };

      // F: a refused upstream — terminal failure with its reason recorded.
      const fAccepted = await submitAccepted(
        sessionB.api,
        SUBMIT_PATH_FETCH,
        { url: `${origin.origin}/f` },
        "the F fetch",
      );
      const fFinal = await pollSnapshot(
        sessionB.api,
        fAccepted.jobId,
        (s) => s.status === "failed",
        60_000,
      );
      expect(fFinal.error, "the F job carries its failure reason").not.toBeNull();
      recorded.F = { jobId: fAccepted.jobId, snapshot: fFinal, resultText: null };

      // C: cancelled while running.
      const cAccepted = await submitAccepted(
        sessionB.api,
        SUBMIT_PATH_DIAGNOSTIC,
        { steps: 20, stepDelayMs: 1000 },
        "the C diagnostic",
      );
      await pollUntilRunning(sessionB.api, cAccepted.jobId, 1);
      const cancelled = await sessionB.api("DELETE", statusPath(cAccepted.jobId));
      expect(cancelled.status, "the cancellation of C").toBe(202);
      const cFinal = await pollSnapshot(
        sessionB.api,
        cAccepted.jobId,
        (s) => s.status === "cancelled",
        60_000,
      );
      recorded.C = { jobId: cAccepted.jobId, snapshot: cFinal, resultText: null };

      // R: left RUNNING into the upgrade — submitted last so it cannot finish
      // before jobs stops.
      const rAccepted = await submitAccepted(
        sessionB.api,
        SUBMIT_PATH_DIAGNOSTIC,
        { steps: 20, stepDelayMs: 1000 },
        "the R diagnostic",
      );
      runningJobId = rAccepted.jobId;
      await pollUntilRunning(sessionB.api, runningJobId, 1);
    },
  );

  test(
    "leg 5: a new jobs image against a not-yet-migrated store refuses without migrating or writing, and the upgrade (platform migration first) keeps accepted work",
    { timeout: 300_000 },
    async () => {
      // 1. The old image stops cleanly, with R mid-flight.
      const stopped = await stack.stop("jobs");
      expect(stopped.exitCode, "the jobs stop before the rewind").toBe(0);

      // 2. Rewind the store to the shape from before the cancellation-instant
      // migration, AS THE MIGRATION IDENTITY (the tables' owner; the runtime
      // holds no DDL). The DSN lives only in this test process.
      await withClient(migrationIdentityDsn(), async (client) => {
        await client.query(
          `ALTER TABLE ${JOBS_JOB_RECORD_QUALIFIED} DROP COLUMN cancellation_requested_at`,
        );
      });
      const rowsBefore = await jobRecordCount();

      // 3. The NEW image starts to the listener and reports the incompatible
      // store honestly — naming the missing column and the migration remedy.
      await stack.start("jobs", { until: "listener" });
      await waitFor(
        stack,
        "the jobs body to name the missing column and the migration remedy",
        { timeoutMs: 90_000 },
        async () => {
          const db = check(await healthOf("jobs"), JOBS_DATABASE_CHECK);
          const detail = db.detail ?? "";
          return db.status === "error" &&
            detail.includes("cancellation_requested_at") &&
            detail.includes("run the migration command")
            ? true
            : undefined;
        },
      );

      // Over further probes of the same store: still absent, and no row
      // written — the startup check never migrates and never writes.
      const probesSeen = check(await healthOf("jobs"), JOBS_DATABASE_CHECK).metrics?.probes ?? 0;
      await waitFor(
        stack,
        "the storage supervisor to probe the incompatible store at least twice more",
        { timeoutMs: 90_000 },
        async () =>
          (check(await healthOf("jobs"), JOBS_DATABASE_CHECK).metrics?.probes ?? 0) >=
          probesSeen + 2
            ? true
            : undefined,
      );
      expect(
        await cancellationRequestedAtColumnPresent(),
        "the column is still absent after the window — the service never migrated",
      ).toBe(false);
      expect(
        await jobRecordCount(),
        "the job-record row count never changed while the store read incompatible",
      ).toBe(rowsBefore);

      // The routes refuse through the edge, without migrating or writing.
      const unavailable = await sessionB.api("GET", statusPath(recordedJob("S").jobId));
      expect(unavailable.status, "the snapshot read against the un-migrated store").toBe(503);
      expect(JobRequestErrorSchema.parse(unavailable.json()).code).toBe("jobs_unavailable");
      const refusedSubmit = await sessionB.api("POST", SUBMIT_PATH_FETCH, {
        headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
        body: JSON.stringify({ url: `${origin.origin}/fresh` }),
      });
      expect(refusedSubmit.status, "a submission against the un-migrated store").toBe(503);
      expect(JobRequestErrorSchema.parse(refusedSubmit.json()).code).toBe("jobs_unavailable");
      expect(
        await jobRecordCount(),
        "the refused submission wrote no job record into the un-migrated store",
      ).toBe(rowsBefore);

      // 4. The documented upgrade procedure, order "platform first", each
      // step a real command.
      applyRoles("the roles re-apply (platform first)");
      runPlatformMigration("the platform migration (platform first)");
      runJobsMigration("the jobs migration (platform first)");

      // 5. Without a restart, the running image converges on the migrated store.
      await waitFor(
        stack,
        "the jobs body to read ok after the jobs migration, with no restart",
        { timeoutMs: 120_000 },
        async () => ((await healthOf("jobs")).status === "ok" ? true : undefined),
      );

      for (const which of ["S", "F", "C"] as const) {
        const reread = await readSnapshot(sessionB.api, recordedJob(which).jobId);
        expect(reread, `${which}'s snapshot survives the upgrade unchanged`).toEqual(
          recordedJob(which).snapshot,
        );
      }
      const sResult = await sessionB.api("GET", resultPath(recordedJob("S").jobId));
      expect(sResult.status, "the S result read after the upgrade").toBe(200);
      expect(sResult.text, "the S result survives the upgrade byte for byte").toBe(
        recordedJob("S").resultText,
      );

      const rFinal = await pollSnapshot(
        sessionB.api,
        runningJobId,
        (s) => s.status === "succeeded",
        120_000,
      );
      expect(
        rFinal.attempt ?? 0,
        "the interrupted R was recovered after the stop, not resumed in place",
      ).toBeGreaterThanOrEqual(2);

      // Retry identity kept across the upgrade: the same key and bytes
      // recover S's own job, reporting its retained terminal state.
      const replayed = await submitKeyed(
        sessionB.api,
        SUBMIT_PATH_FETCH,
        keyS,
        bodyS,
        "the S keyed replay after the upgrade",
      );
      // submitKeyed proved the 202; the accepted body recovers S's own job.
      expect(replayed.jobId, "the replay recovers S's own job").toBe(recordedJob("S").jobId);
      expect(replayed.status, "the replay reports S's retained outcome").toBe("succeeded");

      const fresh = await submitAccepted(
        sessionB.api,
        SUBMIT_PATH_FETCH,
        { url: `${origin.origin}/fresh` },
        "the fresh fetch after the upgrade",
      );
      await pollSnapshot(sessionB.api, fresh.jobId, (s) => s.status === "succeeded", 60_000);

      // 6. The upgraded credentials hold the same isolation line.
      await assertIsolation("upgraded");
    },
  );

  test(
    "leg 6: the reverse order (jobs migration first) converges too",
    { timeout: 300_000 },
    async () => {
      // 1. The store still holds everything; R2 goes in and runs.
      for (const which of ["S", "F", "C"] as const) {
        const reread = await readSnapshot(sessionB.api, recordedJob(which).jobId);
        expect(reread, `${which}'s snapshot is unchanged before the second upgrade`).toEqual(
          recordedJob(which).snapshot,
        );
      }
      const r2Accepted = await submitAccepted(
        sessionB.api,
        SUBMIT_PATH_DIAGNOSTIC,
        { steps: 20, stepDelayMs: 1000 },
        "the R2 diagnostic",
      );
      runningJob2Id = r2Accepted.jobId;
      await pollUntilRunning(sessionB.api, runningJob2Id, 1);

      // 2. Stop, then rewind with a different shape: a store whose runtime
      // grants predate this release, every record-store privilege gone. The
      // health check must name the runtime identity's missing grants, not
      // report the columns it can no longer see as missing.
      const stopped = await stack.stop("jobs");
      expect(stopped.exitCode, "the jobs stop before the second rewind").toBe(0);
      await withClient(migrationIdentityDsn(), async (client) => {
        await client.query(
          `REVOKE SELECT, INSERT, UPDATE, DELETE ON ${JOBS_JOB_RECORD_QUALIFIED} FROM ${JOBS_RUNTIME_ROLE}`,
        );
      });
      await stack.start("jobs", { until: "listener" });
      await waitFor(
        stack,
        "the jobs body to name the runtime identity's missing grants",
        { timeoutMs: 90_000 },
        async () => {
          const db = check(await healthOf("jobs"), JOBS_DATABASE_CHECK);
          const detail = db.detail ?? "";
          return db.status === "error" &&
            detail.includes("runtime identity is missing") &&
            detail.includes(`SELECT on ${JOBS_JOB_RECORD_QUALIFIED}`) &&
            !detail.includes("column")
            ? true
            : undefined;
        },
      );

      // 3. The same procedure, order "jobs first": the jobs migration (which
      // re-grants the runtime), THEN the roles re-apply (which must not undo
      // those grants), THEN the platform migration.
      runJobsMigration("the jobs migration (jobs first)");
      applyRoles("the roles re-apply (jobs first)");
      runPlatformMigration("the platform migration (jobs first)");

      // 4. Convergence, without a restart: the grants landed and survived the
      // roles re-apply, or the health would not come back.
      await waitFor(
        stack,
        "the jobs body to read ok after the jobs-first upgrade",
        { timeoutMs: 120_000 },
        async () => ((await healthOf("jobs")).status === "ok" ? true : undefined),
      );

      for (const which of ["S", "F", "C"] as const) {
        const reread = await readSnapshot(sessionB.api, recordedJob(which).jobId);
        expect(reread, `${which}'s snapshot survives the jobs-first upgrade unchanged`).toEqual(
          recordedJob(which).snapshot,
        );
      }
      const sResult = await sessionB.api("GET", resultPath(recordedJob("S").jobId));
      expect(sResult.status, "the S result read after the jobs-first upgrade").toBe(200);
      expect(sResult.text, "the S result survives the jobs-first upgrade byte for byte").toBe(
        recordedJob("S").resultText,
      );

      const r2Final = await pollSnapshot(
        sessionB.api,
        runningJob2Id,
        (s) => s.status === "succeeded",
        120_000,
      );
      expect(
        r2Final.attempt ?? 0,
        "the interrupted R2 was recovered after the stop, not resumed in place",
      ).toBeGreaterThanOrEqual(2);

      const fresh = await submitAccepted(
        sessionB.api,
        SUBMIT_PATH_FETCH,
        { url: `${origin.origin}/fresh` },
        "the fresh fetch after the jobs-first upgrade",
      );
      await pollSnapshot(sessionB.api, fresh.jobId, (s) => s.status === "succeeded", 60_000);

      // 5. The isolation line, third time.
      await assertIsolation("upgraded");

      // 6. The whole composition is still up and healthy.
      for (const name of ["idp", "portal", "egress", "jobs", "edge", "devGateway"] as const) {
        expect(stack.isRunning(name), `the ${name} service is still running`).toBe(true);
      }
      expect((await healthOf("portal")).status, "the portal's health rolls up ok").toBe("ok");
      expect((await healthOf("edge")).status, "the edge's health rolls up ok").toBe("ok");
    },
  );
});
