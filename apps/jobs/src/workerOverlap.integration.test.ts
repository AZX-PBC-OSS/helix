import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  DevTokenMintResponseSchema,
  HealthStatusSchema,
  JOBS_CAPACITY_CHECK,
  JOBS_DIAGNOSTIC_QUALIFIED_TYPE,
  JOBS_LIFECYCLE_DELIVERY_CHECK,
  JOBS_WORKER_CHECK,
  JobAcceptedSchema,
  JobRequestErrorSchema,
  ManifestUpdateResultSchema,
  resolveJobsCapacityLimits,
  type App,
  type HealthStatus,
} from "@azx-pbc/shared";

import { type DiagnosticJobInput } from "./diagnostics.js";
import { JOBS_JOB_RECORD_QUALIFIED, JOBS_PGBOSS_SCHEMA } from "./policy.js";
import {
  createLiveApp,
  startRealStack,
  waitFor,
  type AppSession,
  type DevClient,
  type HttpReply,
  type PortalClient,
  type RealStack,
} from "./test/realStack.js";

/**
 * The background-jobs execution envelope, measured through the REAL running
 * platform (dev IdP, portal, egress, jobs, edge, dev gateway — all child
 * processes), with one jobs process and then with two sharing one store —
 * the rolling-deployment overlap: the per-process execution allowance (eight
 * total, two per app/environment group) delivered in full, the documented
 * two-process envelope (sixteen total, four per group) reached and never
 * exceeded, the database connections and the physical storage footprint
 * (wrapper table, runner partitions, indexes, toast) published with each leg,
 * the per-process capacity caps a rolling change mixes (a lowered server-wide
 * unfinished cap refusing new work while the other process still admits under
 * its own limits, nothing accepted evicted, and a graceful mid-run exit
 * losing no accepted job), and the server-wide unfinished cap holding when
 * both processes admit concurrently through both gateways.
 *
 * Every number in a `[jobs overlap]` record is an observation of THIS run,
 * not a guarantee: the platform's promises are the bounds the assertions
 * enforce (at most — never more), and the published figures exist so a run
 * that trips a bound can be compared against the run that set the current
 * ones.
 */

// ── shared suite state ───────────────────────────────────────────────────────

let stack: RealStack;
let bob: PortalClient;
let jobsDb: Pool;
let sampler: OccupancySampler | undefined;

type SuiteAppKey = "ovl1" | "ovl2" | "cross";

const APP_SLUGS: readonly SuiteAppKey[] = ["ovl1", "ovl2", "cross"];

interface AppUnderTest {
  readonly app: App;
  readonly slug: string;
}

const apps = {} as Record<SuiteAppKey, AppUnderTest>;
const sessions = {} as Record<SuiteAppKey, AppSession>;
const devClients = {} as Record<SuiteAppKey, DevClient>;

/** The jobs runtime role's database and user — the connections the sampler counts. */
let runtimeDbName = "";
let runtimeRole = "";
let maxConnections = "unknown";

/** The one-process leg's connection peak — the baseline the two-process leg must exceed. */
let oneProcessPeakConnections = 0;
/** The two-process leg's submissions, kept for the retire-mid-run leg's replays and waits. */
let overlapJobs: SubmittedJob[] = [];
/** The storage footprint right after the two-process leg's acceptances. */
let footprintAtAcceptance: StorageFootprint | undefined;

const EXECUTION_LIMITS = resolveJobsCapacityLimits();

/**
 * Retry-key prefix. Every leg stays inside the edge's ten-attempts-per-window
 * submission throttle for each app/environment, refusals included.
 */
const KEY_PREFIX = "ovl-";

// ── small drivers over the harness clients ───────────────────────────────────

const SUBMIT_PATH = "/_api/jobs/jobs/types/diagnostic";

/** Either client kind — the app-host session and the dev-gateway client expose the same `api` seam over the same `/_api/jobs/...` paths. */
type ApiClient = AppSession | DevClient;

/** One submission attempt — the exact bytes and key a retry of this submit would reuse. */
function submitDiagnosticOnce(
  client: ApiClient,
  input: DiagnosticJobInput,
  key: string,
): Promise<HttpReply> {
  return client.api("POST", SUBMIT_PATH, {
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(input),
  });
}

interface Group {
  readonly slug: SuiteAppKey;
  readonly env: "prod" | "dev";
}

const GROUPS: readonly Group[] = [
  { slug: "ovl1", env: "prod" },
  { slug: "ovl1", env: "dev" },
  { slug: "ovl2", env: "prod" },
  { slug: "ovl2", env: "dev" },
];

const client = (group: Group): ApiClient =>
  group.env === "prod" ? sessions[group.slug] : devClients[group.slug];

const groupKey = (group: Group): string => `${apps[group.slug].app.id}/${group.env}`;

interface SubmittedJob {
  readonly group: Group;
  readonly jobId: string;
  readonly key: string;
  readonly input: DiagnosticJobInput;
}

/** Submit one new job and require its acceptance. */
async function submitAccepted(
  group: Group,
  input: DiagnosticJobInput,
  key: string,
): Promise<SubmittedJob> {
  const res = await submitDiagnosticOnce(client(group), input, key);
  expect(res.status, `the ${group.slug}/${group.env} submission ${key}: ${res.text}`).toBe(202);
  return { group, jobId: JobAcceptedSchema.parse(res.json()).jobId, key, input };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── store reads ──────────────────────────────────────────────────────────────

const NON_TERMINAL = ["queued", "running"] as const;

interface OverlapRecordRow {
  job_id: string;
  app_id: string;
  env: string;
  status: string;
  attempt: number | null;
  error_code: string | null;
}

/** The current wrapper records of the listed jobs, keyed by job id. */
async function rowsOf(jobIds: readonly string[]): Promise<Map<string, OverlapRecordRow>> {
  const res = await jobsDb.query<OverlapRecordRow>(
    `SELECT job_id, app_id, env, status, attempt, error_code
       FROM ${JOBS_JOB_RECORD_QUALIFIED}
      WHERE job_id = ANY($1::text[])`,
    [jobIds],
  );
  return new Map(res.rows.map((row) => [row.job_id, row]));
}

/** Wait until every listed job's wrapper record is terminal (any terminal outcome). */
async function waitAllTerminal(
  jobIds: readonly string[],
  timeoutMs: number,
  what: string,
): Promise<void> {
  await waitFor(stack, what, { timeoutMs }, async () => {
    const { rows } = await jobsDb.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${JOBS_JOB_RECORD_QUALIFIED}
          WHERE job_id = ANY($1::text[]) AND status = ANY($2::text[])`,
      [jobIds, [...NON_TERMINAL]],
    );
    return (rows[0]?.n ?? 1) === 0 ? true : undefined;
  });
}

/** The physical storage footprint of the jobs store's own schemas. */
interface StorageFootprint {
  totalBytes: number;
  wrapperBytes: number;
  runnerJobBytes: number;
  perRelationBytes: Record<string, number>;
  wrapperRows: number;
  runnerRows: number;
}

/**
 * Sum over ordinary tables so the runner's partition children are counted
 * once and the partitioned parents (which hold no storage) are not double
 * counted; `pg_total_relation_size` includes each table's indexes and toast.
 */
async function storageFootprint(): Promise<StorageFootprint> {
  const relations = await jobsDb.query<{ schema: string; name: string; bytes: string }>(
    `SELECT n.nspname AS schema, c.relname AS name, pg_total_relation_size(c.oid)::bigint AS bytes
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('jobs', 'pgboss') AND c.relkind IN ('r', 'm')`,
  );
  const perRelationBytes: Record<string, number> = {};
  let totalBytes = 0;
  let wrapperBytes = 0;
  let runnerJobBytes = 0;
  for (const row of relations.rows) {
    const qualified = `${row.schema}.${row.name}`;
    const bytes = Number(row.bytes);
    perRelationBytes[qualified] = bytes;
    totalBytes += bytes;
    if (qualified === JOBS_JOB_RECORD_QUALIFIED) wrapperBytes = bytes;
    if (row.schema === JOBS_PGBOSS_SCHEMA && row.name.startsWith("job")) runnerJobBytes += bytes;
  }
  const wrapper = await jobsDb.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${JOBS_JOB_RECORD_QUALIFIED}`,
  );
  const runner = await jobsDb.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${JOBS_PGBOSS_SCHEMA}.job`,
  );
  return {
    totalBytes,
    wrapperBytes,
    runnerJobBytes,
    perRelationBytes,
    wrapperRows: wrapper.rows[0]?.n ?? 0,
    runnerRows: runner.rows[0]?.n ?? 0,
  };
}

// ── the occupancy sampler ────────────────────────────────────────────────────

const SAMPLE_INTERVAL_MS = 100;

/**
 * Samples the running occupancy of the watched apps, grouped by
 * (app_id, env), and the jobs runtime role's connection count while a leg
 * runs, through the owner pool. The database stays up through every
 * deliberate service stop, so a failed read is a harness fault: the loop
 * keeps sampling, and `stop()` rethrows the first failure rather than report
 * peaks over a history with a silent gap.
 */
class OccupancySampler {
  current = 0;
  peakTotal = 0;
  readonly peakByGroup = new Map<string, number>();
  peakConnections = 0;
  samples = 0;

  private readonly pool: Pool;
  private readonly watchedAppIds: readonly string[];
  private readonly runtimeDbName: string;
  private readonly runtimeRole: string;
  private stopped = false;
  private firstError: unknown = undefined;
  private readonly loop: Promise<void>;

  constructor(
    pool: Pool,
    watchedAppIds: readonly string[],
    runtimeDbName: string,
    runtimeRole: string,
  ) {
    this.pool = pool;
    this.watchedAppIds = watchedAppIds;
    this.runtimeDbName = runtimeDbName;
    this.runtimeRole = runtimeRole;
    this.loop = (async () => {
      while (!this.stopped) {
        await this.tick();
        if (!this.stopped) await sleep(SAMPLE_INTERVAL_MS);
      }
    })();
  }

  /** Peaks start at zero for a new leg. */
  reset(): void {
    this.current = 0;
    this.peakTotal = 0;
    this.peakByGroup.clear();
    this.peakConnections = 0;
    this.samples = 0;
  }

  private async tick(): Promise<void> {
    try {
      const running = await this.pool.query<{ app_id: string; env: string; n: number }>(
        `SELECT app_id, env, count(*)::int AS n
           FROM ${JOBS_JOB_RECORD_QUALIFIED}
          WHERE status = 'running' AND app_id = ANY($1::text[])
          GROUP BY app_id, env`,
        [this.watchedAppIds],
      );
      const connections = await this.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND usename = $2`,
        [this.runtimeDbName, this.runtimeRole],
      );
      let total = 0;
      for (const row of running.rows) {
        total += row.n;
        const group = `${row.app_id}/${row.env}`;
        this.peakByGroup.set(group, Math.max(this.peakByGroup.get(group) ?? 0, row.n));
      }
      this.current = total;
      this.peakTotal = Math.max(this.peakTotal, total);
      this.peakConnections = Math.max(this.peakConnections, connections.rows[0]?.n ?? 0);
      this.samples += 1;
    } catch (error) {
      this.firstError ??= error;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
    if (this.firstError !== undefined) {
      throw new Error("the occupancy sampler's read failed", { cause: this.firstError });
    }
  }
}

/** A fresh sampler for a new leg: the previous leg's sampler is stopped, the peaks start at zero. */
async function restartSampler(): Promise<OccupancySampler> {
  if (sampler) await sampler.stop();
  const next = new OccupancySampler(
    jobsDb,
    [apps.ovl1.app.id, apps.ovl2.app.id],
    runtimeDbName,
    runtimeRole,
  );
  sampler = next;
  next.reset();
  return next;
}

// ── published measurements ───────────────────────────────────────────────────

/**
 * Publish one leg's observed measurements — the run's structured evidence
 * line. The text also rides the leg's load-bearing assertion messages, so a
 * failing run publishes the full observation in its own diagnostics (the
 * default test runner suppresses a passing test's console output; a failing
 * one must not suppress the measurements that explain it).
 */
function publish(leg: string, observed: Record<string, unknown>): string {
  const record = JSON.stringify({
    leg,
    limits: {
      runningPerWorker: EXECUTION_LIMITS.runningPerWorker,
      runningPerAppEnv: EXECUTION_LIMITS.runningPerAppEnv,
    },
    observed,
  });
  console.info(`[jobs overlap] ${record}`);
  return record;
}

/** Peaks as plain objects, for the assertions and the published record. */
function peaksByGroup(peaks: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries([...peaks.entries()].sort());
}

// ── setup helpers ────────────────────────────────────────────────────────────

/**
 * Save an app's capabilities with exactly the jobs types given (and no fetch
 * origins) — the SPA capability editor's save body for these choices.
 */
async function saveCapabilities(slug: string, jobTypes: readonly string[]): Promise<void> {
  const capabilities: {
    mcp: string[];
    externalOrigins: string[];
    fetch: { shim: boolean; origins: string[] };
    jobs?: { types: string[] };
  } = { mcp: [], externalOrigins: [], fetch: { shim: false, origins: [] } };
  if (jobTypes.length > 0) capabilities.jobs = { types: [...jobTypes] };
  const saved = await bob.put(`/api/v1/apps/${slug}/manifest`, { capabilities });
  expect(saved.status, `the manifest save for ${slug}`).toBe(200);
  const saveResult = ManifestUpdateResultSchema.parse(saved.json());
  expect(saveResult.pending ?? null, `the manifest save for ${slug} applied directly`).toBeNull();
}

/** Create, deploy and promote an app, then grant it ONLY the diagnostic type. */
async function createDiagnosticApp(slug: string): Promise<AppUnderTest> {
  const app = await createLiveApp(stack, bob, {
    slug,
    files: {
      "index.html":
        '<!doctype html><html><head><meta charset="utf-8"><title>worker overlap</title></head>' +
        `<body><p>${slug}</p></body></html>`,
    },
  });
  await saveCapabilities(slug, [JOBS_DIAGNOSTIC_QUALIFIED_TYPE]);
  return { app, slug };
}

/** The dev-tier client for one app: mint a dev token through the portal, then build the client. */
async function mintDevClient(slug: string): Promise<DevClient> {
  const minted = await bob.post(`/api/v1/apps/${slug}/dev-tokens`, {
    origins: ["http://localhost:5199"],
  });
  expect(minted.status, `the dev-token mint for ${slug}`).toBe(201);
  return stack.devClient(
    slug,
    DevTokenMintResponseSchema.parse(minted.json()).token,
    "http://localhost:5199",
  );
}

// ── health reads ─────────────────────────────────────────────────────────────

/** One read of any service's `/health` body, parsed against the shared contract. */
async function healthBody(url: string): Promise<HealthStatus> {
  const res = await stack.request(url);
  expect(res.status, `the /health read of ${url}`).toBe(200);
  return HealthStatusSchema.parse(res.json());
}

const jobsHealthUrl = (port: number): string => `http://localhost:${port}/health`;

/** A jobs process answers a healthy body before a leg starts measuring it. */
async function requireJobsHealthy(name: string, port: number): Promise<void> {
  const body = await healthBody(jobsHealthUrl(port));
  for (const checkName of [JOBS_WORKER_CHECK, JOBS_CAPACITY_CHECK]) {
    expect(
      body.checks?.find((c) => c.name === checkName)?.status,
      `${name}'s ${checkName} check at the leg's start`,
    ).toBe("ok");
  }
}

// ── lifecycle-delivery waits (the admission gate's precondition) ─────────────

async function lifecycleDeliveryReading(): Promise<{ passes: number; synchronized: boolean }> {
  const res = await stack.request(`${stack.portalUrl}/health`);
  expect(res.status, "the portal /health read").toBe(200);
  const body = HealthStatusSchema.parse(res.json());
  const check = body.checks?.find((c) => c.name === JOBS_LIFECYCLE_DELIVERY_CHECK);
  const metrics = check?.metrics ?? {};
  if (metrics.passes === undefined) return { passes: 0, synchronized: false };
  return {
    passes: metrics.passes,
    synchronized: (metrics.targets ?? 0) > 0 && metrics.synchronizedTargets === metrics.targets,
  };
}

/** Wait — bounded — for a delivery pass that ended after the apps' creation, with every target synchronized. */
async function waitForLifecycleDelivery(passesBefore: number): Promise<void> {
  await waitFor(
    stack,
    "the portal's jobs_lifecycle_delivery check to end a pass (after the apps' creation) with every target synchronized",
    { timeoutMs: 90_000 },
    async () => {
      const reading = await lifecycleDeliveryReading();
      return reading.passes > passesBefore && reading.synchronized ? true : undefined;
    },
  );
}

// ── the suite ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  stack = await startRealStack({ label: "overlap", diagnostics: true });

  bob = await stack.portalAs("bob@azx.dev");

  for (const slug of APP_SLUGS) {
    apps[slug] = await createDiagnosticApp(slug);
  }

  // The jobs service admits an app's work only after the portal delivered
  // that app's lifecycle state to it — wait once, after all the apps exist.
  const passesBefore = (await lifecycleDeliveryReading()).passes;
  await waitForLifecycleDelivery(passesBefore);

  for (const slug of APP_SLUGS) {
    sessions[slug] = await stack.appSession(slug, "bob@azx.dev");
    devClients[slug] = await mintDevClient(slug);
  }

  jobsDb = new Pool({ connectionString: stack.jobsOwnerDsn, max: 4 });

  const dsn = new URL(stack.jobsRuntimeDsn);
  runtimeDbName = dsn.pathname.slice(1);
  runtimeRole = decodeURIComponent(dsn.username);
  maxConnections =
    (await jobsDb.query<{ max_connections: string }>("SHOW max_connections")).rows[0]
      ?.max_connections ?? "unknown";
}, 420_000);

afterAll(async () => {
  if (sampler) await sampler.stop().catch(() => {});
  await jobsDb?.end();
  if (stack) await stack.close();
}, 120_000);

describe("the rolling-overlap execution envelope, measured through the real stack", () => {
  test(
    "one jobs process runs at most eight jobs and at most two per app/environment group",
    { timeout: 240_000 },
    async () => {
      const leg = await restartSampler();

      const submitted: SubmittedJob[] = [];
      for (const group of GROUPS) {
        for (let n = 1; n <= 3; n += 1) {
          submitted.push(
            await submitAccepted(
              group,
              { steps: 10, stepDelayMs: 1000 },
              `${KEY_PREFIX}${randomUUID()}`,
            ),
          );
        }
      }
      const jobIds = submitted.map((j) => j.jobId);

      await waitFor(
        stack,
        "the one-process plateau: eight jobs running at once",
        { timeoutMs: 45_000 },
        async () => (leg.current === EXECUTION_LIMITS.runningPerWorker ? true : undefined),
      );
      await waitAllTerminal(
        jobIds,
        150_000,
        "all twelve one-process jobs to reach a terminal outcome",
      );
      await leg.stop();

      const record = publish("one-process", {
        peakTotal: leg.peakTotal,
        peakByGroup: peaksByGroup(leg.peakByGroup),
        peakConnections: leg.peakConnections,
        samples: leg.samples,
      });
      oneProcessPeakConnections = leg.peakConnections;

      expect(leg.peakTotal, record).toBe(EXECUTION_LIMITS.runningPerWorker);
      for (const group of GROUPS) {
        expect(leg.peakByGroup.get(groupKey(group)), record).toBe(
          EXECUTION_LIMITS.runningPerAppEnv,
        );
      }
      const rows = await rowsOf(jobIds);
      const notSucceeded = submitted
        .map((j) => `${j.jobId}:${rows.get(j.jobId)?.status ?? "<no record>"}`)
        .filter((entry) => !entry.endsWith(":succeeded"));
      expect(notSucceeded, "every one-process job settled succeeded").toEqual([]);
    },
  );

  test(
    "two jobs processes during rolling overlap reach sixteen in total and four per group, never more",
    { timeout: 300_000 },
    async () => {
      // This replica plays the next revision carrying a lowered server-wide
      // unfinished cap — the cap the next leg refuses new work under. Its
      // execution limits stay at the platform defaults, so this leg measures
      // the plain two-process overlap envelope.
      stack.setServiceEnv("jobsReplica", {
        JOBS_LIMITS: JSON.stringify({ unfinishedPerServer: 4 }),
      });
      await stack.start("jobsReplica");

      const jobsPort = stack.ports.jobs;
      const replicaPort = stack.ports.jobsReplica;
      if (jobsPort === undefined || replicaPort === undefined) {
        throw new Error("the stack never produced the jobs ports");
      }
      for (const [name, port] of [
        ["jobs", jobsPort],
        ["jobsReplica", replicaPort],
      ] as const) {
        await requireJobsHealthy(name, port);
      }

      const before = await storageFootprint();
      const leg = await restartSampler();

      const submitted: SubmittedJob[] = [];
      for (const group of GROUPS) {
        for (let n = 1; n <= 5; n += 1) {
          submitted.push(
            await submitAccepted(
              group,
              { steps: 20, stepDelayMs: 1000 },
              `${KEY_PREFIX}${randomUUID()}`,
            ),
          );
        }
      }
      overlapJobs = submitted;

      const after = await storageFootprint();
      footprintAtAcceptance = after;
      const deltaBytes = after.totalBytes - before.totalBytes;
      const deltaWrapperRows = after.wrapperRows - before.wrapperRows;
      expect(deltaWrapperRows, "the wrapper records the twenty acceptances added").toBe(20);

      await waitFor(
        stack,
        "the two-process overlap plateau: sixteen jobs running at once",
        { timeoutMs: 60_000 },
        async () => (leg.current === 2 * EXECUTION_LIMITS.runningPerWorker ? true : undefined),
      );
      // The plateau holds while the first claims run (~20 s); sample a while
      // longer so the peaks are the plateau's, not one lucky tick's.
      await sleep(2_000);

      const record = publish("two-process", {
        peakTotal: leg.peakTotal,
        peakByGroup: peaksByGroup(leg.peakByGroup),
        peakConnections: leg.peakConnections,
        peakConnectionsOneProcess: oneProcessPeakConnections,
        max_connections: maxConnections,
        storage: {
          beforeBytes: before.totalBytes,
          afterBytes: after.totalBytes,
          deltaBytes,
          bytesPerAcceptedJob: deltaBytes / submitted.length,
          wrapperBytes: { before: before.wrapperBytes, after: after.wrapperBytes },
          runnerJobBytes: { before: before.runnerJobBytes, after: after.runnerJobBytes },
          wrapperRows: {
            before: before.wrapperRows,
            after: after.wrapperRows,
            delta: deltaWrapperRows,
          },
          runnerRows: { before: before.runnerRows, after: after.runnerRows },
          perRelationBytes: { before: before.perRelationBytes, after: after.perRelationBytes },
        },
      });

      expect(leg.peakTotal, record).toBe(2 * EXECUTION_LIMITS.runningPerWorker);
      for (const group of GROUPS) {
        expect(leg.peakByGroup.get(groupKey(group)), record).toBe(
          2 * EXECUTION_LIMITS.runningPerAppEnv,
        );
      }
      expect(leg.peakConnections, record).toBeGreaterThan(oneProcessPeakConnections);
    },
  );

  test(
    "a lowered cap on one process refuses new work while the other still admits; nothing is evicted, and a process leaving mid-run loses no job",
    { timeout: 360_000 },
    async () => {
      if (sampler === undefined) {
        throw new Error("the suite never produced the running occupancy sampler");
      }
      const leg = sampler;

      // The overlap work is still unfinished — the occupancy the lowered cap
      // refuses against, and the work the mid-run exit must not lose.
      const unfinished = await jobsDb.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${JOBS_JOB_RECORD_QUALIFIED}
          WHERE app_id = ANY($1::text[]) AND status = ANY($2::text[])`,
        [[apps.ovl1.app.id, apps.ovl2.app.id], [...NON_TERMINAL]],
      );
      expect(
        unfinished.rows[0]?.n ?? 0,
        "the non-terminal ovl records at the leg's start",
      ).toBeGreaterThanOrEqual(4);

      // The dev gateway joins the replica: its submissions now meet the
      // replica's lowered server-wide unfinished cap.
      stack.setServiceEnv("devGateway", {
        EDGE_JOBS_CONFIG: stack.gatewayJobsConfigFor("jobsReplica"),
      });
      await stack.restart("devGateway");

      const refused = await submitDiagnosticOnce(
        devClients.ovl1,
        { steps: 1 },
        `${KEY_PREFIX}${randomUUID()}`,
      );
      expect(refused.status, `the replica's refusal under its lowered cap: ${refused.text}`).toBe(
        429,
      );
      expect(
        JobRequestErrorSchema.parse(refused.json()).code,
        "the lowered cap's refusal code",
      ).toBe("jobs_capacity_exceeded");

      // The edge still points at the process under the platform's defaults:
      // the same occupied store admits this one.
      const admitted = await submitAccepted(
        { slug: "ovl1", env: "prod" },
        { steps: 1 },
        `${KEY_PREFIX}${randomUUID()}`,
      );

      // The replay recovers the original job before any capacity gate —
      // identical bytes under a retained key, never a second job.
      const replayOf = overlapJobs.find((j) => j.group.slug === "ovl1" && j.group.env === "dev");
      if (replayOf === undefined) {
        throw new Error("the suite never produced the ovl1/dev job to replay");
      }
      const replay = await submitDiagnosticOnce(devClients.ovl1, replayOf.input, replayOf.key);
      expect(replay.status, `the retained-key replay: ${replay.text}`).toBe(202);
      expect(JobAcceptedSchema.parse(replay.json()).jobId, "the replay's job id").toBe(
        replayOf.jobId,
      );

      // The replica leaves mid-run, gracefully. Whichever attempts it held die
      // with it; the surviving process's own supervision and recovery project
      // them back to execution under the retry policy.
      const runningAtStop = await jobsDb.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${JOBS_JOB_RECORD_QUALIFIED}
          WHERE app_id = ANY($1::text[]) AND status = 'running'`,
        [[apps.ovl1.app.id, apps.ovl2.app.id]],
      );
      const stopAt = Date.now();
      const left = await stack.stop("jobsReplica");

      const watched = [...overlapJobs.map((j) => j.jobId), admitted.jobId];
      await waitAllTerminal(
        watched,
        300_000,
        "every overlapped job to reach a terminal outcome after the replica left",
      );
      const elapsedMs = Date.now() - stopAt;

      const rows = await rowsOf(watched);
      const failures = watched
        .map((id) => {
          const r = rows.get(id);
          if (r === undefined) return `${id}:<no record>`;
          return r.status === "succeeded"
            ? null
            : `${r.job_id}:${r.status}/${r.error_code ?? "-"}/attempt=${r.attempt ?? "-"}`;
        })
        .filter((entry): entry is string => entry !== null);
      expect(failures, "every overlapped job settled succeeded after the replica left").toEqual([]);

      const attempts = overlapJobs.map((j) => rows.get(j.jobId)?.attempt ?? 0);
      await leg.stop();

      // Completion releases unfinished capacity, not storage: every runner row
      // and wrapper record the acceptances wrote is still physically stored.
      const atAcceptance = footprintAtAcceptance;
      if (atAcceptance === undefined) {
        throw new Error("the suite never measured the footprint at acceptance");
      }
      const completed = await storageFootprint();
      const record = publish("retire-mid-run", {
        left,
        runningAtStop: runningAtStop.rows[0]?.n ?? 0,
        attempts: {
          max: Math.max(...attempts),
          retried: attempts.filter((a) => a > 1).length,
          of: overlapJobs.length,
        },
        elapsedMs,
        peakTotal: leg.peakTotal,
        peakByGroup: peaksByGroup(leg.peakByGroup),
        storageAfterCompletion: {
          totalBytes: completed.totalBytes,
          wrapperRows: completed.wrapperRows,
          runnerRows: completed.runnerRows,
        },
      });

      expect(completed.wrapperRows, `completion removed no wrapper record — ${record}`).toBe(
        atAcceptance.wrapperRows + 1,
      );
      expect(
        completed.runnerRows,
        `completion removed no runner row — ${record}`,
      ).toBeGreaterThanOrEqual(atAcceptance.runnerRows + 1);

      for (const group of GROUPS) {
        expect(leg.peakByGroup.get(groupKey(group)) ?? 0, record).toBeLessThanOrEqual(
          2 * EXECUTION_LIMITS.runningPerAppEnv,
        );
      }
      expect(leg.peakTotal, record).toBeLessThanOrEqual(2 * EXECUTION_LIMITS.runningPerWorker);
    },
  );

  test(
    "with equal limits on both processes, concurrent admissions through both gateways stop exactly at the server-wide unfinished cap",
    { timeout: 240_000 },
    async () => {
      stack.setServiceEnv("jobs", { JOBS_LIMITS: JSON.stringify({ unfinishedPerServer: 4 }) });
      await stack.restart("jobs");
      // The replica's overrides from the two-process leg stand: the same
      // lowered server-wide cap on both processes.
      await stack.start("jobsReplica");

      const unfinishedBefore = await jobsDb.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE status = ANY($1::text[])`,
        [[...NON_TERMINAL]],
      );
      expect(
        unfinishedBefore.rows[0]?.n ?? 1,
        "the store's non-terminal records before the concurrent admissions",
      ).toBe(0);

      // Ten admissions race through BOTH gateways at once: five to the edge
      // (which forwards to `jobs`), five to the dev gateway (which forwards
      // to the replica). The server-wide unfinished cap is shared through the
      // store; the admission lock serializes the verdicts.
      const submissions: Array<{ group: Group; input: DiagnosticJobInput; key: string }> = [];
      for (const group of [
        { slug: "cross", env: "prod" },
        { slug: "cross", env: "dev" },
      ] as const) {
        for (let n = 1; n <= 5; n += 1) {
          submissions.push({
            group,
            input: { steps: 5, stepDelayMs: 1000 },
            key: `${KEY_PREFIX}${randomUUID()}`,
          });
        }
      }
      const replies = await Promise.all(
        submissions.map((s) => submitDiagnosticOnce(client(s.group), s.input, s.key)),
      );

      const acceptedJobs = replies
        .filter((r) => r.status === 202)
        .map((r) => JobAcceptedSchema.parse(r.json()));
      const refusedReplies = replies.filter((r) => r.status !== 202);

      const record = publish("shared-cap", {
        accepted: acceptedJobs.length,
        refused: refusedReplies.map((r) => r.status),
      });
      expect(acceptedJobs.length, record).toBe(4);
      expect(refusedReplies.length, record).toBe(6);
      for (const refusedReply of refusedReplies) {
        expect(refusedReply.status, `the concurrent refusal: ${refusedReply.text}`).toBe(429);
        expect(
          JobRequestErrorSchema.parse(refusedReply.json()).code,
          "the shared cap's refusal code",
        ).toBe("jobs_capacity_exceeded");
      }
      const crossRecords = await jobsDb.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE app_id = $1`,
        [apps.cross.app.id],
      );
      expect(crossRecords.rows[0]?.n ?? 0, record).toBe(4);

      await waitAllTerminal(
        acceptedJobs.map((j) => j.jobId),
        120_000,
        "the four admitted cross jobs to settle succeeded",
      );
      const crossRows = await rowsOf(acceptedJobs.map((j) => j.jobId));
      expect(
        [...crossRows.values()].map((r) => r.status),
        "the four admitted cross jobs all succeeded",
      ).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);

      // Restore the platform defaults for every process and gateway this
      // suite retuned, and leave the single-process composition running.
      stack.setServiceEnv("jobs", null);
      stack.setServiceEnv("jobsReplica", null);
      stack.setServiceEnv("devGateway", null);
      await stack.stop("jobsReplica");
      await stack.restart("jobs");
      await stack.restart("devGateway");
    },
  );
});
