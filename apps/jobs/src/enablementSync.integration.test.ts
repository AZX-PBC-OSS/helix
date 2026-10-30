import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { JOBS_SERVER_NAME } from "@azx-pbc/shared";
import { deriveJobsInstructionKey } from "@azx-pbc/shared/jobsSigning";

import {
  JobsLifecycleStore,
  lifecycleEligibilityInTx,
  type JobsGenerationEligibility,
} from "./lifecycle.js";
import { createJobsInstructionAuth } from "./instructionAuth.js";
import { migrateJobsStorage } from "./migrate.js";
import {
  JOBS_APP_LIFECYCLE_QUALIFIED,
  JOBS_JOB_RECORD_QUALIFIED,
  JOBS_RUNTIME_ROLE,
  jobsRuntimeBossOptions,
} from "./policy.js";
import type { JobsStorage } from "./storage.js";
import { appWithLifecycle, MemoryBurns } from "./test/instructions.js";
import { seedRunnerJobWithRecord } from "./test/recordSeed.js";
import { applyRolesProvisioning } from "../../portal/src/test/provisionDatabases.js";
import { createPrismaClient, type PrismaClient } from "../../portal/src/db/client.js";
import { createScratchPortalDatabase } from "../../portal/src/test/scratchPortalDatabase.js";
import {
  JOBS_DELIVERY_OVERDUE_MS,
  JobsLifecycleDelivery,
  jobsLifecycleDeliveryCheck,
} from "../../portal/src/jobs/delivery.js";
import { HttpLifecycleDelivery } from "../../portal/src/jobs/deliveryHttp.js";

/**
 * The enablement synchronization journey end to end (ADR-0007, ADR-0009,
 * background-jobs-plane design §5): the REAL portal sender over a REAL
 * scratch portal database, the REAL production transport, and the REAL jobs
 * receiver route over the REAL durable lifecycle store on a REAL scratch
 * jobs database. There are no stand-ins on the delivery path — both planes
 * and both stores are real, and the network socket between them is the only
 * boundary. The admission/start gate is judged with the production read
 * (`lifecycleEligibilityInTx`) inside a real transaction on the runtime-role
 * pool. The legs prove: unknown state is retryable unavailability until a
 * synchronization pass delivers it; an interrupted synchronization resumes
 * against the same store with the outstanding work visible to health; apps
 * created during synchronization by a writer without the target cannot fall
 * through; and re-enablement reconciles transitions made while the server
 * was absent and cancels retained work under the closed generations.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

const SCRATCH_DB = `helix_jobs_enablement_${randomUUID().replaceAll("-", "")}`;

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

/** The portal→jobs signing root for both ends of the one hop under test — test data, never deployed. */
const PORTAL_TO_JOBS_ROOT = "jUwQKa33JNljh0jULeithrh3JOL8dUmxPJknzGCjQBA=";
const KEY = deriveJobsInstructionKey(PORTAL_TO_JOBS_ROOT, "portalToJobs");

const LOG = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface Receiver {
  app: FastifyInstance;
  storage: JobsStorage;
  store: JobsLifecycleStore;
  base: string;
}

let prisma: PrismaClient;
let dropPortalScratch: (() => Promise<void>) | null = null;
let boss: PgBoss;
let direct: Pool;
let receiver: Receiver | null = null;
let sender: JobsLifecycleDelivery;
const senders: JobsLifecycleDelivery[] = [];
let existingApps: { open1: string; archived2: string; open3: string };

/** The real receiver: the real route + verifier (real clock) over the real durable store, on a live port. */
async function startReceiver(): Promise<Receiver> {
  const store = new JobsLifecycleStore({
    databaseUrl: RUNTIME_DSN,
    statementTimeoutMs: 10_000,
    log: LOG,
  });
  store.start();
  // The receiver verifies on the real clock — the sender's transport mints at
  // real time, so a pinned test clock would refuse every token as expired.
  const receiverSeam = {
    auth: createJobsInstructionAuth({
      serverId: JOBS_SERVER_NAME,
      keys: {
        edgeToJobs: deriveJobsInstructionKey(PORTAL_TO_JOBS_ROOT, "edgeToJobs"),
        portalToJobs: KEY,
      },
      burns: new MemoryBurns(),
      clock: () => Math.floor(Date.now() / 1_000),
      log: { warn: () => {} },
    }),
    burns: new MemoryBurns(),
    clock: { nowS: 0, get: () => Math.floor(Date.now() / 1_000) },
  };
  const built = await appWithLifecycle(receiverSeam, store);
  await built.app.ready();
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  const address = built.app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the receiver's listener never bound a port");
  }
  return {
    app: built.app,
    storage: built.storage,
    store,
    base: `http://127.0.0.1:${address.port}`,
  };
}

async function stopReceiver(active: Receiver): Promise<void> {
  await active.app.close();
  await active.storage.stop();
  await active.store.stop();
}

/** A real sender over the real transport, pointed at one endpoint. */
function makeSender(endpoint: string): JobsLifecycleDelivery {
  const transport = new HttpLifecycleDelivery({ timeoutMs: 5_000 });
  const started = new JobsLifecycleDelivery({
    prisma,
    targets: new Map([[JOBS_SERVER_NAME, { endpoint, portalToJobsKey: KEY }]]),
    transport: (attempt) => transport.deliver(attempt),
    log: LOG,
  });
  senders.push(started);
  return started;
}

/** Seed one existing installation's app row directly — the generation authority's current state. */
async function seedPortalApp(opts: { generation: number; archived?: boolean }): Promise<string> {
  const id = randomUUID();
  await prisma.app.create({
    data: {
      id,
      slug: `enable-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      displayName: "Enablement",
      visibilityMode: "internal",
      jobsGeneration: opts.generation,
      ...(opts.archived ? { archivedAt: new Date() } : {}),
    },
  });
  return id;
}

/** The admission/start gate: the production read inside a BEGIN…COMMIT on the runtime-role pool. */
async function gate(appId: string, generation: number): Promise<JobsGenerationEligibility> {
  const client = await direct.connect();
  try {
    await client.query("BEGIN");
    try {
      const verdict = await lifecycleEligibilityInTx(client, appId, String(generation));
      await client.query("COMMIT");
      return verdict;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  } finally {
    client.release();
  }
}

/** The durable lifecycle rows, read directly — the store's whole state. */
async function storedLifecycleRows(): Promise<
  Map<string, { generation: string; archived: boolean }>
> {
  const result = await direct.query<{ app_id: string; generation: string; archived: boolean }>(
    `SELECT app_id, generation, archived FROM ${JOBS_APP_LIFECYCLE_QUALIFIED} ORDER BY app_id`,
  );
  return new Map(
    result.rows.map((row) => [row.app_id, { generation: row.generation, archived: row.archived }]),
  );
}

/** An endpoint whose port was bound and released — connecting is refused. */
async function closedPortEndpoint(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    throw new Error("the port probe never bound a port");
  }
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

beforeAll(async () => {
  await applyRolesProvisioning(SCRATCH_DB);
  await migrateJobsStorage(urlFor(SCRATCH_DB, "helix_jobs_migrate"));
  const scratch = await createScratchPortalDatabase("helix_portal_enablement");
  dropPortalScratch = scratch.drop;
  prisma = createPrismaClient(scratch.url);
  boss = new PgBoss({ connectionString: RUNTIME_DSN, ...jobsRuntimeBossOptions() });
  await boss.start();
  direct = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
  receiver = await startReceiver();
}, 120_000);

afterAll(async () => {
  for (const started of senders) await started.stop();
  if (receiver) await stopReceiver(receiver);
  await boss?.stop({ graceful: true, timeout: 5_000 }).catch(() => {});
  await direct?.end();
  await prisma?.$disconnect();
  await dropPortalScratch?.();
  const pool = new Pool({ connectionString: urlFor("postgres"), max: 1 });
  await pool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
  await pool.end();
}, 30_000);

describe("the enablement synchronization journey through both real planes", () => {
  test(
    "unknown state is retryable unavailability until synchronization delivers it",
    { timeout: 60_000 },
    async () => {
      // An existing installation: an open app at generation 1, an archived
      // app at generation 2, and an app archived then unarchived (open at
      // generation 3) — none ever delivered to this jobs server.
      const open1 = await seedPortalApp({ generation: 1 });
      const archived2 = await seedPortalApp({ generation: 2, archived: true });
      const open3 = await seedPortalApp({ generation: 3 });
      existingApps = { open1, archived2, open3 };

      // Before any pass the store holds nothing: every current claim is
      // retryable unavailability, never closed, never admit.
      await expect(gate(open1, 1)).resolves.toEqual({ verdict: "unseen", appliedGeneration: null });
      await expect(gate(archived2, 2)).resolves.toEqual({
        verdict: "unseen",
        appliedGeneration: null,
      });
      await expect(gate(open3, 3)).resolves.toEqual({ verdict: "unseen", appliedGeneration: null });

      sender = makeSender(receiver!.base);
      await sender.runPass();

      await expect(gate(open1, 1)).resolves.toEqual({ verdict: "admit" });
      await expect(gate(archived2, 2)).resolves.toEqual({
        verdict: "closed",
        appliedGeneration: "2",
      });
      await expect(gate(open3, 3)).resolves.toEqual({ verdict: "admit" });
      // An older generation never reopens: the applied 3 closes it.
      await expect(gate(open3, 2)).resolves.toEqual({ verdict: "closed", appliedGeneration: "3" });

      // The store holds exactly the three apps' current states.
      expect(await storedLifecycleRows()).toEqual(
        new Map([
          [open1, { generation: "1", archived: false }],
          [archived2, { generation: "2", archived: true }],
          [open3, { generation: "3", archived: false }],
        ]),
      );

      // Every intent for the target is acknowledged on the portal side.
      const pending = await prisma.jobsLifecycleOutbox.findMany({
        where: { server: JOBS_SERVER_NAME, deliveredAt: null },
      });
      expect(pending).toEqual([]);
      const rows = await prisma.jobsLifecycleOutbox.findMany({
        where: { server: JOBS_SERVER_NAME },
      });
      expect(rows).toHaveLength(3);

      const sync = sender
        .snapshot()
        .synchronization?.find((entry) => entry.server === JOBS_SERVER_NAME);
      expect(sync?.synchronized).toBe(true);
    },
  );

  test(
    "interrupted synchronization resumes against the same store, and the outstanding work is visible",
    { timeout: 60_000 },
    async () => {
      // Delivery unreachable: the endpoint's port was bound and released.
      const interrupted = makeSender(await closedPortEndpoint());
      const appD = await seedPortalApp({ generation: 1 });
      interrupted.start();
      await interrupted.runPass();

      // The intent is durable and pending; the snapshot says so.
      const pending = await prisma.jobsLifecycleOutbox.findMany({
        where: { server: JOBS_SERVER_NAME, deliveredAt: null },
      });
      expect(pending).toHaveLength(1);
      expect(pending[0]?.appId).toBe(appD);

      const snapshot = interrupted.snapshot();
      const sync = snapshot.synchronization?.find((entry) => entry.server === JOBS_SERVER_NAME);
      expect(sync?.synchronized).toBe(false);
      const jobsBacklog = snapshot.backlog?.find((entry) => entry.server === JOBS_SERVER_NAME);
      expect(jobsBacklog?.outstanding).toBeGreaterThanOrEqual(1);
      expect(jobsBacklog?.oldestPendingAt ?? null).not.toBeNull();

      // Young pending work: ok, with the target named; past the 60-second
      // bound the same evidence reads degraded.
      const young = jobsLifecycleDeliveryCheck(snapshot);
      expect(young.status).toBe("ok");
      expect(young.detail).toMatch(JOBS_SERVER_NAME);
      const oldestPendingAt = jobsBacklog?.oldestPendingAt;
      expect(oldestPendingAt).not.toBeNull();
      const overdue = jobsLifecycleDeliveryCheck(snapshot, {
        nowMs: Date.parse(oldestPendingAt ?? "") + JOBS_DELIVERY_OVERDUE_MS + 1_000,
        staleAfterMs: 3_600_000,
      });
      expect(overdue.status).toBe("degraded");
      // The gate still cannot admit: nothing was delivered.
      await expect(gate(appD, 1)).resolves.toEqual({ verdict: "unseen", appliedGeneration: null });
      await interrupted.stop();

      // The restart: a NEW store over the SAME jobs DSN, a NEW receiver app,
      // a NEW sender at the live receiver — the interrupted synchronization
      // resumes from the durable rows.
      await stopReceiver(receiver!);
      receiver = await startReceiver();
      sender = makeSender(receiver.base);
      await sender.runPass();

      await expect(gate(appD, 1)).resolves.toEqual({ verdict: "admit" });
      // The earlier apps' state is unchanged by the resume.
      expect(await storedLifecycleRows()).toEqual(
        new Map([
          [existingApps.open1, { generation: "1", archived: false }],
          [existingApps.archived2, { generation: "2", archived: true }],
          [existingApps.open3, { generation: "3", archived: false }],
          [appD, { generation: "1", archived: false }],
        ]),
      );
      expect(await prisma.jobsLifecycleOutbox.findMany({ where: { deliveredAt: null } })).toEqual(
        [],
      );
    },
  );

  test(
    "apps created during synchronization by a writer without the target cannot fall through",
    { timeout: 60_000 },
    async () => {
      // What a portal replica whose configuration does not yet list the
      // target writes: the app row, no outbox rows at all.
      const appE = await seedPortalApp({ generation: 1 });

      await expect(gate(appE, 1)).resolves.toEqual({ verdict: "unseen", appliedGeneration: null });

      await sender.runPass();

      await expect(gate(appE, 1)).resolves.toEqual({ verdict: "admit" });
    },
  );

  test(
    "re-enable reconciles transitions made while the server was absent, and cancels retained work",
    { timeout: 60_000 },
    async () => {
      // A synchronized app, with retained active work under its open
      // generation, held off-claim so only the leg's own timing claims it.
      const appF = await seedPortalApp({ generation: 1 });
      await sender.runPass();
      await expect(gate(appF, 1)).resolves.toEqual({ verdict: "admit" });
      const jobId = await seedRunnerJobWithRecord(boss, direct, {
        appId: appF,
        data: { url: "https://example.com/data.json" },
        generation: "1",
        startAfterSeconds: 3_600,
      });

      // With no sender running — the server absent from the portal's
      // configuration — the transition writes the app row only: generation
      // 3, open (archived then unarchived), no outbox rows.
      await prisma.app.update({
        where: { id: appF },
        data: { jobsGeneration: 3, archivedAt: null },
      });

      // The gate judges against the stale delivered state: unseen, not closed.
      await expect(gate(appF, 3)).resolves.toEqual({ verdict: "unseen", appliedGeneration: "1" });

      // Re-enablement: a new pass enqueues the missed transition and delivers it.
      await sender.runPass();

      await expect(gate(appF, 3)).resolves.toEqual({ verdict: "admit" });
      await expect(gate(appF, 1)).resolves.toEqual({ verdict: "closed", appliedGeneration: "3" });

      // The retained generation-1 work now carries durable cancellation intent.
      const record = await direct.query<{ cancellation_requested: boolean }>(
        `SELECT cancellation_requested FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE job_id = $1`,
        [jobId],
      );
      expect(record.rows[0]?.cancellation_requested).toBe(true);
    },
  );
});
