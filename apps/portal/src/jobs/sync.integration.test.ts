import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ATTR_JOBS_LIFECYCLE_SYNC_ENQUEUED,
  ATTR_JOBS_SERVER,
  SPAN_JOBS_LIFECYCLE_SYNC,
} from "@azx-pbc/shared/telemetry";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";
import { createPrismaClient, type PrismaClient } from "../db/client.js";
import { createScratchPortalDatabase } from "../test/scratchPortalDatabase.js";
import {
  JobsLifecycleDelivery,
  jobsLifecycleDeliveryCheck,
  JOBS_DELIVERY_OVERDUE_MS,
  lifecycleUpdateBytes,
  type JobsDeliveryTargetSync,
  type LifecycleDeliveryAnswer,
  type LifecycleDeliveryAttempt,
} from "./delivery.js";

/**
 * The sender's per-target synchronization step against real Postgres, on a
 * scratch database of its own: the step reads the whole `apps` table, so the
 * suite needs a cluster-isolated database it can truncate per test. The
 * transport is the true boundary — a stand-in over the same verdicts,
 * capturing what it was handed.
 */

let scratchUrl: string;
let dropScratch: (() => Promise<void>) | null = null;
let prisma: PrismaClient;

beforeAll(async () => {
  const scratch = await createScratchPortalDatabase("helix_portal_sync");
  scratchUrl = scratch.url;
  dropScratch = scratch.drop;
  prisma = createPrismaClient(scratchUrl);
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
  await dropScratch?.();
}, 30_000);

/** Each test owns its scratch database, so it starts from empty tables. */
beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE "apps", "jobs_lifecycle_outbox" CASCADE`);
});

const quietLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** A capture point standing in for the signed HTTP hop, answering per attempt. */
class FakeTransport {
  attempts: LifecycleDeliveryAttempt[] = [];

  constructor(
    readonly answer: (
      attempt: LifecycleDeliveryAttempt,
    ) => LifecycleDeliveryAnswer | Promise<LifecycleDeliveryAnswer>,
  ) {}

  readonly deliver = async (
    attempt: LifecycleDeliveryAttempt,
  ): Promise<LifecycleDeliveryAnswer> => {
    this.attempts.push(attempt);
    return this.answer(attempt);
  };
}

/** Acknowledge every attempt with its own generation — a receiver that applies what it is sent. */
const ackOwn = (attempt: LifecycleDeliveryAttempt): LifecycleDeliveryAnswer => ({
  kind: "acknowledged",
  appliedGeneration: JSON.parse(Buffer.from(attempt.body).toString()).generation,
});

const TARGETS = new Map<string, { endpoint: string; portalToJobsKey: Uint8Array }>([
  ["jobs", { endpoint: "http://jobs.internal", portalToJobsKey: new Uint8Array(32) }],
  ["other", { endpoint: "http://jobs.internal", portalToJobsKey: new Uint8Array(32) }],
]);

function makeSender(
  transport: FakeTransport,
  targets: ReadonlyMap<string, { endpoint: string; portalToJobsKey: Uint8Array }> = TARGETS,
): JobsLifecycleDelivery {
  return new JobsLifecycleDelivery({
    prisma,
    targets,
    transport: transport.deliver,
    log: quietLog,
  });
}

/** One app row, seeded directly (the sync step is what must discover it). */
async function seedApp(opts: { generation?: number; archived?: boolean } = {}): Promise<string> {
  const app = await prisma.app.create({
    data: {
      slug: `sync-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      displayName: "Sync",
      visibilityMode: "internal",
      ...(opts.generation !== undefined ? { jobsGeneration: opts.generation } : {}),
      ...(opts.archived ? { archivedAt: new Date() } : {}),
    },
  });
  return app.id;
}

async function rowsOf(appId: string) {
  return prisma.jobsLifecycleOutbox.findMany({
    where: { appId },
    orderBy: [{ generation: "asc" }, { server: "asc" }],
  });
}

/** The transport's view of one attempt, reduced to what the lifecycle bytes carry. */
const seen = (
  attempt: LifecycleDeliveryAttempt,
): { server: string; generation: string; archived: boolean } => ({
  server: attempt.server,
  ...(JSON.parse(Buffer.from(attempt.body).toString()) as {
    generation: string;
    archived: boolean;
  }),
});

const enqueuedFor = (sync: JobsDeliveryTargetSync[], server: string): number =>
  sync.find((entry) => entry.server === server)?.enqueued ?? -1;

describe("the per-target synchronization step", () => {
  it("existing apps are synchronized, archived included", async () => {
    const open = await seedApp({ generation: 1 });
    const archived = await seedApp({ generation: 2, archived: true });
    const open3 = await seedApp({ generation: 3 });
    const transport = new FakeTransport(ackOwn);
    const sender = makeSender(transport);

    await sender.runPass();

    const generations = new Map([
      [open, { generation: 1, archived: false }],
      [archived, { generation: 2, archived: true }],
      [open3, { generation: 3, archived: false }],
    ]);
    for (const server of ["jobs", "other"]) {
      const seenFor = transport.attempts.filter((a) => a.server === server).map(seen);
      expect(seenFor).toHaveLength(3);
      for (const [appId, state] of generations) {
        expect(seenFor).toContainEqual({
          server,
          generation: String(state.generation),
          archived: state.archived,
        });
        const rows = await rowsOf(appId);
        const row = rows.find((r) => r.server === server && r.generation === state.generation);
        expect(row?.deliveredAt).not.toBeNull();
      }
    }
    // Every attempt carried the exact wire bytes for its app's current state.
    for (const attempt of transport.attempts) {
      const state = generations.get(attempt.appId)!;
      expect(Buffer.from(attempt.body).toString()).toEqual(
        Buffer.from(lifecycleUpdateBytes(state)).toString(),
      );
    }
    const sync = sender.snapshot().synchronization;
    expect(
      sync?.map((entry) => ({
        server: entry.server,
        synchronized: entry.synchronized,
        enqueued: entry.enqueued,
      })),
    ).toEqual([
      { server: "jobs", synchronized: true, enqueued: 3 },
      { server: "other", synchronized: true, enqueued: 3 },
    ]);
  });

  it("unknown state stays pending, never assumed delivered; an interrupted synchronization resumes after restart", async () => {
    await seedApp({ generation: 1 });
    await seedApp({ generation: 2, archived: true });
    await seedApp({ generation: 3 });
    const transport = new FakeTransport((attempt) =>
      attempt.server === "jobs"
        ? { kind: "unreachable", error: new Error("down") }
        : ackOwn(attempt),
    );
    const sender = makeSender(transport);
    // Started, so the health grading below reads a running sender; runPass
    // coalesces into the started pass, and awaiting it waits for completion.
    sender.start();
    await sender.runPass();

    const pending = await prisma.jobsLifecycleOutbox.findMany({
      where: { deliveredAt: null, server: "jobs" },
    });
    expect(pending).toHaveLength(3);
    const deliveredOther = await prisma.jobsLifecycleOutbox.findMany({
      where: { deliveredAt: null, server: "other" },
    });
    expect(deliveredOther).toHaveLength(0);

    const snapshot = sender.snapshot();
    const sync = snapshot.synchronization;
    expect(sync?.find((entry) => entry.server === "jobs")?.synchronized).toBe(false);
    expect(sync?.find((entry) => entry.server === "other")?.synchronized).toBe(true);
    const backlog = snapshot.backlog?.find((entry) => entry.server === "jobs");
    expect(backlog?.outstanding).toBe(3);

    // Young pending work for a target that is not synchronized yet: ok, with
    // the target named and its pending count in the detail.
    const young = jobsLifecycleDeliveryCheck(snapshot);
    expect(young.status).toBe("ok");
    expect(young.detail).toMatch(/jobs: 3 pending/);
    // The same state past the contract's 60-second bound: degraded.
    const overdue = jobsLifecycleDeliveryCheck(snapshot, {
      nowMs: Date.parse(backlog!.oldestPendingAt!) + JOBS_DELIVERY_OVERDUE_MS + 1_000,
      staleAfterMs: 3_600_000,
    });
    expect(overdue.status).toBe("degraded");

    // A restart over the same database: the pending rows are still there, the
    // synchronization enqueues nothing new, and delivering them completes.
    await sender.stop();
    const restarted = makeSender(new FakeTransport(ackOwn));
    await restarted.runPass();

    expect(await prisma.jobsLifecycleOutbox.findMany({ where: { deliveredAt: null } })).toEqual([]);
    const restartedSync = restarted.snapshot().synchronization;
    expect(restartedSync?.every((entry) => entry.synchronized)).toBe(true);
    expect(enqueuedFor(restartedSync ?? [], "jobs")).toBe(0);
    expect(enqueuedFor(restartedSync ?? [], "other")).toBe(0);
  });

  it("is idempotent and safe under two replicas", async () => {
    await seedApp({ generation: 1 });
    await seedApp({ generation: 1 });
    const transportA = new FakeTransport(ackOwn);
    const transportB = new FakeTransport(ackOwn);
    const a = makeSender(transportA);
    const b = makeSender(transportB);

    await Promise.all([a.runPass(), b.runPass()]);

    const rows = await prisma.jobsLifecycleOutbox.findMany({});
    expect(rows).toHaveLength(4); // 2 apps x 2 targets, one row per triple
    expect(rows.every((row) => row.deliveredAt !== null)).toBe(true);
    // Only the sender whose conditional write actually cleared a row counts it.
    expect(a.snapshot().delivered + b.snapshot().delivered).toBe(4);

    // A further pass enqueues nothing and delivers nothing new.
    const transport2 = new FakeTransport(ackOwn);
    const further = makeSender(transport2);
    await further.runPass();
    expect(transport2.attempts).toEqual([]);
    expect(further.snapshot().synchronization?.every((entry) => entry.enqueued === 0)).toBe(true);
    expect(further.snapshot().delivered).toBe(0);
  });

  it("an app created during synchronization by a writer without the target is caught by the next pass", async () => {
    await seedApp({ generation: 1 });
    const transport = new FakeTransport(ackOwn);
    const sender = makeSender(transport);
    await sender.runPass();
    const enqueuedAfterFirst = sender.snapshot().synchronization?.map((entry) => ({
      server: entry.server,
      enqueued: entry.enqueued,
    }));

    // What a portal replica whose config lacks the targets writes: the app
    // row, no outbox rows at all.
    await seedApp({ generation: 1 });

    await sender.runPass();

    expect(
      sender.snapshot().synchronization?.map((entry) => ({
        server: entry.server,
        enqueued: entry.enqueued,
      })),
    ).toEqual([
      { server: "jobs", enqueued: (enqueuedAfterFirst?.[0]?.enqueued ?? 0) + 1 },
      { server: "other", enqueued: (enqueuedAfterFirst?.[1]?.enqueued ?? 0) + 1 },
    ]);
    expect(await prisma.jobsLifecycleOutbox.findMany({ where: { deliveredAt: null } })).toEqual([]);
    expect(sender.snapshot().synchronization?.every((entry) => entry.synchronized)).toBe(true);
  });

  it("a transition racing the scan cannot be lost or reopen old state", async () => {
    const appId = await seedApp({ generation: 1 });
    const transport = new FakeTransport(ackOwn);
    const sender = makeSender(transport);

    // A transition holding the app row's lock, uncommitted: the pass's plain
    // read under MVCC must not block on it.
    const client = new Client({ connectionString: scratchUrl });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE apps SET "archivedAt" = now(), "jobsGeneration" = 2 WHERE id = $1`,
        [appId],
      );
      await sender.runPass();
      await client.query("COMMIT");
    } finally {
      await client.end();
    }

    // The pass enqueued and delivered the state it saw: generation 1, open.
    expect(transport.attempts.map(seen)).toEqual([
      { server: "jobs", generation: "1", archived: false },
      { server: "other", generation: "1", archived: false },
    ]);

    // The transition committed without writing its own outbox row (the
    // stale-replica case): the next pass catches the new current state up.
    await sender.runPass();

    expect(transport.attempts.map(seen)).toEqual([
      { server: "jobs", generation: "1", archived: false },
      { server: "other", generation: "1", archived: false },
      { server: "jobs", generation: "2", archived: true },
      { server: "other", generation: "2", archived: true },
    ]);
    expect(await prisma.jobsLifecycleOutbox.findMany({ where: { deliveredAt: null } })).toEqual([]);
    expect(sender.snapshot().synchronization?.every((entry) => entry.synchronized)).toBe(true);
  });

  it("a racing transition that wrote its own outbox rows is delivered once and not re-enqueued", async () => {
    const appId = await seedApp({ generation: 1 });
    const transport = new FakeTransport(ackOwn);
    const sender = makeSender(transport);

    const client = new Client({ connectionString: scratchUrl });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE apps SET "archivedAt" = now(), "jobsGeneration" = 2 WHERE id = $1`,
        [appId],
      );
      await sender.runPass();
      // The transition's own replica lists the targets: it writes its rows.
      await client.query(
        `INSERT INTO jobs_lifecycle_outbox ("appId", "generation", "server", "archived")
         VALUES ($1, 2, 'jobs', true), ($1, 2, 'other', true)`,
        [appId],
      );
      await client.query("COMMIT");
    } finally {
      await client.end();
    }

    await sender.runPass();

    // The committed rows satisfied the scan (nothing enqueued) and delivered
    // generation 2 once per target.
    expect(transport.attempts.map(seen)).toEqual([
      { server: "jobs", generation: "1", archived: false },
      { server: "other", generation: "1", archived: false },
      { server: "jobs", generation: "2", archived: true },
      { server: "other", generation: "2", archived: true },
    ]);
    expect(await prisma.jobsLifecycleOutbox.findMany({ where: { deliveredAt: null } })).toEqual([]);
    expect(sender.snapshot().synchronization?.every((entry) => entry.synchronized)).toBe(true);
  });

  it("a database failure fails the pass, not silently passes it", async () => {
    const broken = createPrismaClient(
      `postgresql://helix:helix@db:5432/does_not_exist_${randomUUID().replaceAll("-", "")}`,
    );
    try {
      const sender = new JobsLifecycleDelivery({
        prisma: broken,
        targets: TARGETS,
        transport: new FakeTransport(ackOwn).deliver,
        log: quietLog,
      });
      await seedApp({ generation: 1 });
      await sender.runPass();
      const snapshot = sender.snapshot();
      expect(snapshot.lastOkPassAt).toBeNull();
      expect(snapshot.synchronization).toBeNull();
      expect(jobsLifecycleDeliveryCheck(snapshot).status).not.toBe("ok");
    } finally {
      await broken.$disconnect();
    }
  });

  it("a fully disabled installation creates no rows and synchronizes nothing", async () => {
    await seedApp({ generation: 1 });
    await seedApp({ generation: 1 });
    const transport = new FakeTransport(ackOwn);
    const sender = makeSender(transport, new Map());

    await sender.runPass();

    expect(await prisma.jobsLifecycleOutbox.findMany({})).toEqual([]);
    expect(sender.snapshot().synchronization).toEqual([]);
  });
});

describe("synchronization telemetry", () => {
  let recording: RecordingTelemetry;

  beforeAll(() => {
    recording = startRecordingTelemetry();
  });

  afterEach(() => {
    recording.reset();
  });

  afterAll(async () => {
    await recording.restore();
  });

  it("one sync span per target per pass, with only the bounded attributes", async () => {
    const appIdA = await seedApp({ generation: 1 });
    const appIdB = await seedApp({ generation: 1 });
    const transport = new FakeTransport(ackOwn);
    const sender = makeSender(transport);

    await sender.runPass();

    const spans = recording.spans().filter((span) => span.name === SPAN_JOBS_LIFECYCLE_SYNC);
    expect(spans).toHaveLength(2);
    expect(spans.map((span) => span.attributes[ATTR_JOBS_SERVER]).sort()).toEqual([
      "jobs",
      "other",
    ]);
    for (const span of spans) {
      expect(Object.keys(span.attributes).sort()).toEqual(
        [ATTR_JOBS_LIFECYCLE_SYNC_ENQUEUED, ATTR_JOBS_SERVER].sort(),
      );
      expect(span.attributes[ATTR_JOBS_LIFECYCLE_SYNC_ENQUEUED]).toBe(2);
      // Bounded, non-personal attributes only — never an app id.
      expect(JSON.stringify(span.attributes)).not.toContain(appIdA);
      expect(JSON.stringify(span.attributes)).not.toContain(appIdB);
    }

    // A second pass finds nothing missing: the enqueued count is 0.
    await sender.runPass();
    const second = recording.spans().filter((span) => span.name === SPAN_JOBS_LIFECYCLE_SYNC);
    expect(second).toHaveLength(4);
    for (const span of second.slice(2)) {
      expect(span.attributes[ATTR_JOBS_LIFECYCLE_SYNC_ENQUEUED]).toBe(0);
    }
  });
});
