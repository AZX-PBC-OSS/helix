import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  JOBS_FETCH_QUALIFIED_TYPE,
  resolveJobsCapacityLimits,
  type Env,
  type JobsCapacityLimits,
} from "@azx-pbc/shared";

import { JobsExecution, JobsHandlerRegistry, type JobsHandler } from "./execution.js";
import { JobsLifecycleStore } from "./lifecycle.js";
import { migrateJobsStorage } from "./migrate.js";
import {
  JOBS_JOB_RECORD_QUALIFIED,
  JOBS_PGBOSS_SCHEMA,
  JOBS_QUEUE_NAME,
  JOBS_RUNTIME_ROLE,
  jobTypePolicy,
  jobsAppEnvGroupId,
  jobsRuntimeBossOptions,
} from "./policy.js";
import { JobsRunner } from "./runner.js";
import { createPgbossEnqueuer, JobsAcceptanceStore } from "./acceptance.js";
import { applyRolesProvisioning } from "../../portal/src/test/provisionDatabases.js";
import { submitClaims, TEST_IDENTITY } from "./test/instructions.js";

/**
 * The per-process execution allowance, measured (design §6, ADR-0008): one
 * worker process must respect the adopted total (`runningPerWorker`, 8) and
 * per-app/environment (`runningPerAppEnv`, 2) concurrency across installed
 * types, with independent environment groups; two overlapping worker
 * processes — the rolling-deployment shape — may reach the documented
 * envelope (sixteen total, four per app/environment) and nothing more.
 *
 * Every leg runs the real chain against the real store and the real role
 * split: admission through the real acceptance transaction (which scopes each
 * job to its trusted `(appId, env)` group), a real supervised runner per
 * worker process, and the real worker registration. The handlers hold their
 * executions open on a gate, so the probe sees the concurrency the worker
 * machinery actually delivers — peaks measured from handler starts and ends,
 * never from queue rows. The overlap leg also reads the database's own
 * connection count at saturation — the figure a deployment's overlap budget
 * must size.
 *
 * The published measurements are emitted as one structured
 * `[jobs fairness]` line per leg, and the observed envelope is recorded in
 * this package's README (design §6: "test and document actual
 * overlap/recovery behavior").
 *
 * Cross-type scope: the allowance lives on the ONE queue all installed types
 * share (`jobsWorkOptions` is queue-level, and registration is guarded to one
 * live worker per process), so this suite's legs — run against the only
 * installed type — measure the same mechanism that will bound any future
 * type; a second catalogue type is a baseline change this initiative does not
 * make.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

const SCRATCH_DB = `helix_jobs_fairness_${randomUUID().replaceAll("-", "")}`;

function urlFor(database: string, role?: string): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  if (role) {
    url.username = role;
    url.password = role;
  }
  return url.toString();
}

const RUNTIME_DSN = urlFor(SCRATCH_DB, JOBS_RUNTIME_ROLE);

const LOG = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const LIMITS: JobsCapacityLimits = resolveJobsCapacityLimits();

/** Bounded wait for a store state the worker's own cadence produces. */
async function waitFor(what: string, probe: () => Promise<boolean>): Promise<void> {
  const by = Date.now() + 45_000;
  while (Date.now() < by) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

let boss: PgBoss;
let acceptance: JobsAcceptanceStore;
let lifecycle: JobsLifecycleStore;
let direct: Pool;

beforeAll(async () => {
  await applyRolesProvisioning(SCRATCH_DB);
  await migrateJobsStorage(urlFor(SCRATCH_DB, "helix_jobs_migrate"));
  // The admission store's enqueue rides this suite's own started instance —
  // the same borrowed-transaction adapter production composes. The worker
  // processes under measurement are separate runners, started per leg.
  boss = new PgBoss({ connectionString: RUNTIME_DSN, ...jobsRuntimeBossOptions() });
  await boss.start();
  acceptance = new JobsAcceptanceStore({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    limits: LIMITS,
    accepting: true,
    enqueuer: createPgbossEnqueuer(boss),
    log: LOG,
  });
  acceptance.start();
  lifecycle = new JobsLifecycleStore({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    log: LOG,
  });
  lifecycle.start();
  direct = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
}, 60_000);

afterAll(async () => {
  await direct.end();
  await acceptance.stop();
  await lifecycle.stop();
  await boss.stop({ graceful: true, timeout: 5_000 }).catch(() => {});
  const pool = new Pool({ connectionString: urlFor("postgres"), max: 1 });
  await pool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
  await pool.end();
}, 30_000);

// ── The execution probe ──────────────────────────────────────────────────────

/** One worker process's measured executions, keyed by the tag it was built with. */
interface ProcessProbe {
  inFlight: number;
  peakTotal: number;
  peakByGroup: Map<string, number>;
  inFlightByGroup: Map<string, number>;
}

const probes = new Map<string, ProcessProbe>();
let globalInFlight = 0;
let globalPeak = 0;
const globalInFlightByGroup = new Map<string, number>();
const globalPeakByGroup = new Map<string, number>();

function resetProbes(): void {
  probes.clear();
  globalInFlight = 0;
  globalPeak = 0;
  globalInFlightByGroup.clear();
  globalPeakByGroup.clear();
}

/** The release gate every fixture handler holds on; re-armed per leg. */
let gate: Promise<void> = Promise.resolve();
let openGate: () => void = () => {};

function armGate(): void {
  let release: () => void = () => {};
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  openGate = release;
}

/**
 * The fixture handler for one worker process: the input's URL carries the
 * identity pair admission scoped the job to, so the probe counts executions
 * by the same group spelling the send site used. Each execution holds until
 * the leg releases it — the probe's peaks are the concurrency the worker
 * machinery delivered, not the queue's row counts.
 */
function handlerFor(tag: string): JobsHandler {
  return async (context) => {
    const input = context.input as { url?: unknown };
    const match =
      typeof input.url === "string"
        ? /^https:\/\/fixtures\.invalid\/group\/([^/]+)\/([^/]+)\/\d+$/.exec(input.url)
        : null;
    const appId = match?.[1];
    const env = match?.[2];
    if (!appId || !env) {
      throw new Error(
        `the fairness fixture's input does not carry its identity pair: ${JSON.stringify(input.url)}`,
      );
    }
    const group = jobsAppEnvGroupId(appId, env);
    const probe = probes.get(tag);
    if (!probe) throw new Error(`no probe registered for worker process "${tag}"`);

    probe.inFlight += 1;
    probe.peakTotal = Math.max(probe.peakTotal, probe.inFlight);
    const inGroup = (probe.inFlightByGroup.get(group) ?? 0) + 1;
    probe.inFlightByGroup.set(group, inGroup);
    probe.peakByGroup.set(group, Math.max(probe.peakByGroup.get(group) ?? 0, inGroup));
    globalInFlight += 1;
    globalPeak = Math.max(globalPeak, globalInFlight);
    const globalInGroup = (globalInFlightByGroup.get(group) ?? 0) + 1;
    globalInFlightByGroup.set(group, globalInGroup);
    globalPeakByGroup.set(group, Math.max(globalPeakByGroup.get(group) ?? 0, globalInGroup));
    try {
      await gate;
      return null;
    } finally {
      probe.inFlight -= 1;
      probe.inFlightByGroup.set(group, (probe.inFlightByGroup.get(group) ?? 1) - 1);
      globalInFlight -= 1;
      globalInFlightByGroup.set(group, (globalInFlightByGroup.get(group) ?? 1) - 1);
    }
  };
}

function probeFor(tag: string): ProcessProbe {
  const probe = probes.get(tag);
  if (!probe) throw new Error(`no probe registered for worker process "${tag}"`);
  return probe;
}

// ── The real per-process composition ─────────────────────────────────────────

/** One worker process: a supervised runner whose registration hook is a tagged execution component. */
interface WorkerProcess {
  stop(): Promise<void>;
}

async function startWorkerProcess(tag: string): Promise<WorkerProcess> {
  probes.set(tag, {
    inFlight: 0,
    peakTotal: 0,
    peakByGroup: new Map<string, number>(),
    inFlightByGroup: new Map<string, number>(),
  });
  const registry = new JobsHandlerRegistry();
  registry.register(JOBS_FETCH_QUALIFIED_TYPE, handlerFor(tag));
  const component = new JobsExecution({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    handlers: registry,
    limits: LIMITS,
    log: LOG,
  });
  component.start();
  const runner = new JobsRunner({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    registerWorker: async (bossInstance) => {
      await component.registerOn(bossInstance);
    },
    log: LOG,
  });
  runner.start();
  await waitFor(
    `${tag}'s runner to register its worker`,
    async () => runner.snapshot.workerRegistered,
  );
  return {
    stop: async () => {
      await runner.stop();
      await component.stop();
    },
  };
}

// ── Admission fixtures ───────────────────────────────────────────────────────

/** Deliver one app's open generation through the real lifecycle store. */
async function deliverGeneration(appId: string): Promise<void> {
  await lifecycle.apply(appId, { generation: "1", archived: false });
}

/** The fixture URL carrying one job's identity pair to the handler's probe. */
function fixtureUrl(appId: string, env: Env, n: number): string {
  return `https://fixtures.invalid/group/${appId}/${env}/${n}`;
}

/** One admission through the real acceptance store, under this identity — a refusal fails the leg. */
async function admit(appId: string, env: Env, url: string): Promise<string> {
  const result = await acceptance.admit({
    claims: submitClaims({
      generation: "1",
      idempotencyKey: null,
      identity: { ...TEST_IDENTITY, appId, env },
    }),
    body: new TextEncoder().encode(JSON.stringify({ url })),
  });
  if (result.outcome !== "accepted") {
    throw new Error(
      `the admission refused (${result.outcome}) for ${jobsAppEnvGroupId(appId, env)}`,
    );
  }
  return result.jobId;
}

/** Admit one group's jobs; return their public ids. */
async function admitGroup(appId: string, env: Env, count: number): Promise<string[]> {
  const jobIds: string[] = [];
  for (let n = 1; n <= count; n += 1) {
    jobIds.push(await admit(appId, env, fixtureUrl(appId, env, n)));
  }
  return jobIds;
}

/** Hold until the worker machinery has delivered the expected total concurrently. */
async function holdUntilPeak(expectedTotal: number, what: string): Promise<void> {
  const by = Date.now() + 45_000;
  while (Date.now() < by) {
    if (globalPeak >= expectedTotal) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `the execution plateau never reached ${expectedTotal} (${what}): peak ${globalPeak}, in flight ${globalInFlight}`,
  );
}

/** Every one of the leg's jobs reached its durable success. */
async function allSucceeded(jobIds: string[]): Promise<void> {
  await waitFor("every admitted job to reach succeeded", async () => {
    const { rows } = await direct.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${JOBS_JOB_RECORD_QUALIFIED}
        WHERE status <> 'succeeded' AND job_id = ANY($1::text[])`,
      [jobIds],
    );
    return (rows[0]?.n ?? 1) === 0;
  });
}

/** The database's own connection count — the overlap footprint a deployment sizes. */
async function databaseConnections(): Promise<number> {
  const { rows } = await direct.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1`,
    [SCRATCH_DB],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Publish one leg's observed measurements and return the record's text —
 * the run's structured evidence line. The text also rides the leg's
 * load-bearing assertion messages, so a failing run publishes the full
 * observation in its own diagnostics (the default test runner suppresses a
 * passing test's console output; a failing one must not suppress the
 * measurements that explain it).
 */
function publish(leg: string, observed: Record<string, unknown>): string {
  const record = JSON.stringify({
    leg,
    limits: {
      runningPerWorker: LIMITS.runningPerWorker,
      runningPerAppEnv: LIMITS.runningPerAppEnv,
    },
    observed,
  });
  console.info(`[jobs fairness] ${record}`);
  return record;
}

/** Peaks as plain objects, for the assertions and the published record. */
function peaksByGroup(probe: ProcessProbe): Record<string, number> {
  return Object.fromEntries([...probe.peakByGroup.entries()].sort());
}

describe("the per-process execution allowance, measured", () => {
  test(
    "one worker delivers the full adopted allowance — eight total, two per app/environment, all four groups independent (one app's prod and dev among them)",
    { timeout: 120_000 },
    async () => {
      resetProbes();
      armGate();
      // Four groups: two apps × both environments. Six jobs each — past both
      // caps, so each cap is exercised rather than merely untested.
      const appA = randomUUID();
      const appB = randomUUID();
      await deliverGeneration(appA);
      await deliverGeneration(appB);
      const groups: Array<[string, Env]> = [
        [appA, "prod"],
        [appA, "dev"],
        [appB, "prod"],
        [appB, "dev"],
      ];
      const jobIds: string[] = [];
      for (const [appId, env] of groups) {
        jobIds.push(...(await admitGroup(appId, env, 6)));
      }

      const process1 = await startWorkerProcess("p1");
      try {
        await holdUntilPeak(LIMITS.runningPerWorker, "the one-worker plateau");
        openGate();
        await allSucceeded(jobIds);

        const record = publish("one-worker", {
          peakTotal: probeFor("p1").peakTotal,
          peakPerGroup: peaksByGroup(probeFor("p1")),
          jobs: jobIds.length,
        });
        // The adopted total, delivered in full — and never more. The
        // published record rides the assertions: a regression reprints it.
        expect(probeFor("p1").peakTotal, record).toBe(LIMITS.runningPerWorker);
        // Every group ran at its own cap at the same time — a group's
        // allowance is its own, so no group (and neither environment of one
        // app) starved another.
        for (const [appId, env] of groups) {
          const group = jobsAppEnvGroupId(appId, env);
          expect(probeFor("p1").peakByGroup.get(group), record).toBe(LIMITS.runningPerAppEnv);
        }
        // The group caps are what made the total: four groups at two each.
        expect(globalPeak, record).toBe(LIMITS.runningPerWorker);
      } finally {
        await process1.stop();
      }
    },
  );

  test(
    "the execution cap binds below the storage caps — five accepted for one group, two running while three stay queued",
    { timeout: 60_000 },
    async () => {
      resetProbes();
      armGate();
      // Five jobs, one group: far inside the unfinished/retained occupancy
      // caps, so every admission is accepted (the suite's own admit throws on
      // a capacity refusal) — the cap that then binds execution is the
      // fairness allowance, not transactional capacity.
      const appC = randomUUID();
      await deliverGeneration(appC);
      const jobIds = await admitGroup(appC, "prod", 5);

      const process1 = await startWorkerProcess("p1");
      try {
        await holdUntilPeak(LIMITS.runningPerAppEnv, "the one-group plateau");
        // At the plateau — while every execution still holds — exactly the
        // group's allowance runs and the rest wait, queued.
        const { rows } = await direct.query<{ status: string; n: number }>(
          `SELECT status, count(*)::int AS n FROM ${JOBS_JOB_RECORD_QUALIFIED}
            WHERE app_id = $1 GROUP BY status`,
          [appC],
        );
        expect(Object.fromEntries(rows.map((r) => [r.status, r.n]))).toEqual({
          running: LIMITS.runningPerAppEnv,
          queued: jobIds.length - LIMITS.runningPerAppEnv,
        });

        openGate();
        await allSucceeded(jobIds);

        const record = publish("one-group-below-storage-caps", {
          peakTotal: probeFor("p1").peakTotal,
          jobs: jobIds.length,
          unfinishedPerAppEnv: LIMITS.unfinishedPerAppEnv,
        });
        expect(probeFor("p1").peakTotal, record).toBe(LIMITS.runningPerAppEnv);
        expect(globalPeak, record).toBe(LIMITS.runningPerAppEnv);
      } finally {
        await process1.stop();
      }
    },
  );

  test(
    "two overlapping worker processes reach the documented rolling-overlap envelope — sixteen total and four per app/environment, never more, with the database connections measured at saturation",
    { timeout: 180_000 },
    async () => {
      resetProbes();
      armGate();
      // Four groups × eight jobs: enough work for each process to fill its
      // whole total (four groups at its two-per-group cap) and for both
      // processes to overlap on the same groups — the envelope's both
      // figures at once.
      const apps = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      for (const appId of apps) await deliverGeneration(appId);
      const jobIds: string[] = [];
      for (const appId of apps) {
        jobIds.push(...(await admitGroup(appId, "prod", 8)));
      }

      const process1 = await startWorkerProcess("p1");
      const process2 = await startWorkerProcess("p2");
      try {
        await holdUntilPeak(2 * LIMITS.runningPerWorker, "the two-process plateau");

        // The overlap measured where it matters: the database's own
        // connection count at saturation — the figure a deployment's overlap
        // budget must carry (design §4/§8).
        const connectionsAtSaturation = await databaseConnections();

        openGate();
        await allSucceeded(jobIds);

        const record = publish("two-process-overlap", {
          peakTotalGlobal: globalPeak,
          peakTotalByProcess: { p1: probeFor("p1").peakTotal, p2: probeFor("p2").peakTotal },
          peakPerGroupGlobal: Object.fromEntries([...globalPeakByGroup.entries()].sort()),
          databaseConnectionsAtSaturation: connectionsAtSaturation,
          jobs: jobIds.length,
        });
        // Each process respected its own allowance, and each delivered it in
        // full.
        for (const tag of ["p1", "p2"]) {
          expect(probeFor(tag).peakTotal, record).toBe(LIMITS.runningPerWorker);
          for (const [group, peak] of probeFor(tag).peakByGroup) {
            expect(peak, `${tag} group ${group}`).toBeLessThanOrEqual(LIMITS.runningPerAppEnv);
          }
        }
        // The documented rolling-overlap envelope, reached: twice the total,
        // and both processes' group allowances overlapping on the same
        // app/environment — four per group, never more.
        expect(globalPeak, record).toBe(2 * LIMITS.runningPerWorker);
        for (const appId of apps) {
          const group = jobsAppEnvGroupId(appId, "prod");
          expect(globalPeakByGroup.get(group), record).toBe(2 * LIMITS.runningPerAppEnv);
        }
        // A pool blowup would show here; the ceiling is loose by design —
        // the published count is the sizing evidence, the bound only fails
        // on a runaway.
        expect(connectionsAtSaturation, record).toBeLessThan(40);
      } finally {
        await process1.stop();
        await process2.stop();
      }
    },
  );
});

describe("app payloads cannot override the execution policy", () => {
  // Last on purpose: its accepted jobs stay queued on the scratch store (no
  // worker is registered after this point), so no later leg's worker can
  // claim them into its own measurements.
  test(
    "the same body under two identities lands in each identity's own fairness group with the platform's policy columns, and an override-shaped body is refused without creating work",
    { timeout: 60_000 },
    async () => {
      const appP = randomUUID();
      const appQ = randomUUID();
      await deliverGeneration(appP);
      await deliverGeneration(appQ);

      // The EXACT same body bytes — the body carries no identity and no
      // policy; the signed claims and the installed policy decide everything.
      const body = new TextEncoder().encode(
        JSON.stringify({ url: "https://fixtures.invalid/policy-probe" }),
      );
      const admitted: Array<{ appId: string; env: string; jobId: string }> = [];
      for (const [appId, env] of [
        [appP, "prod"],
        [appQ, "dev"],
      ] as Array<[string, Env]>) {
        const result = await acceptance.admit({
          claims: submitClaims({
            generation: "1",
            idempotencyKey: null,
            identity: { ...TEST_IDENTITY, appId, env },
          }),
          body,
        });
        if (result.outcome !== "accepted") {
          throw new Error(`the admission refused (${result.outcome})`);
        }
        admitted.push({ appId, env, jobId: result.jobId });
      }

      // Each runner row: the trusted pair's own group, the platform's own
      // numbers — whichever identity submitted.
      for (const { appId, env, jobId } of admitted) {
        const { rows } = await direct.query<Record<string, unknown>>(
          `SELECT r.* FROM ${JOBS_PGBOSS_SCHEMA}.job r
             JOIN ${JOBS_JOB_RECORD_QUALIFIED} w ON w.runner_job_id = r.id::text
            WHERE w.job_id = $1`,
          [jobId],
        );
        const row = rows[0];
        if (!row) throw new Error(`no runner row for job ${jobId}`);
        // The policy expectation is the installed policy itself, not a
        // second copy of its numbers.
        const policy = jobTypePolicy(JOBS_FETCH_QUALIFIED_TYPE);
        expect(row.name).toBe(JOBS_QUEUE_NAME);
        expect(row.group_id).toBe(jobsAppEnvGroupId(appId, env));
        expect(row.retry_limit).toBe(policy.retryLimit);
        expect(row.expire_seconds).toBe(policy.expireInSeconds);
      }

      // A body shaped like an execution-policy override is refused before
      // anything is created: no wrapper record, no runner row, no group.
      const hostile = new TextEncoder().encode(
        JSON.stringify({
          url: "https://fixtures.invalid/hostile",
          localConcurrency: 99,
          localGroupConcurrency: 99,
          group: { id: "hijacked-group" },
          retryLimit: 9,
          expireInSeconds: 999_999,
          deadlineSeconds: 999_999,
        }),
      );
      const refused = await acceptance.admit({
        claims: submitClaims({
          generation: "1",
          idempotencyKey: null,
          identity: { ...TEST_IDENTITY, appId: appP, env: "prod" },
        }),
        body: hostile,
      });
      expect(refused.outcome).toBe("invalid_input");
      const { rows } = await direct.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE app_id = $1`,
        [appP],
      );
      // appP's only record is the one legitimate admission above.
      expect(rows[0]?.n).toBe(1);
    },
  );
});
