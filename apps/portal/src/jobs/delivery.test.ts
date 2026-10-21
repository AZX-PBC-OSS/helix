import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ATTR_APP_ID,
  ATTR_JOBS_ARCHIVED,
  ATTR_JOBS_GENERATION,
  ATTR_JOBS_SERVER,
  ATTR_OUTCOME,
  SPAN_JOBS_LIFECYCLE_DELIVER,
} from "@azx-pbc/shared/telemetry";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";
import { createPrismaClient, type PrismaClient } from "../db/client.js";
import { buildTestApp } from "../test/harness.js";
import { createScratchPortalDatabase } from "../test/scratchPortalDatabase.js";
import type { PortalJobsDeliveryTarget } from "../deployment.js";
import {
  ackCoversGeneration,
  JobsLifecycleDelivery,
  jobsLifecycleDeliveryCheck,
  JOBS_DELIVERY_BATCH,
  JOBS_DELIVERY_OVERDUE_MS,
  JOBS_DELIVERY_STALE_AFTER_MS,
  lifecycleUpdateBytes,
  type JobsDeliverySnapshot,
  type LifecycleDeliveryAnswer,
  type LifecycleDeliveryAttempt,
} from "./delivery.js";

/**
 * The supervised portal sender's observable contract (ADR-0007, ADR-0009,
 * background-jobs-plane design §5), driven through its real pass against the
 * real Postgres outbox — because the guarantees under test are the store's
 * conditional writes and the loop's own accounting, not a helper's shape. The
 * transport is the one true boundary: a stand-in over the same verdicts,
 * capturing what it was handed. The production transport's mint/verify/classify
 * contract is `deliveryHttp.test.ts`'s, over a real socket.
 *
 * These passes run against their OWN scratch database: every pass's
 * synchronization step reads the whole `apps` table and enqueues outbox rows
 * for every app it finds, so a shared test database would have this suite's
 * passes writing rows under other suites' apps.
 */

let scratchUrl: string;
let dropScratch: (() => Promise<void>) | null = null;

/** A quiet sink — the sender's log lines are noise to these tests. */
const quietLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** A capture point standing in for the signed HTTP hop. */
class FakeTransport {
  /** Every attempt it was handed, in order. */
  attempts: LifecycleDeliveryAttempt[] = [];
  /** The verdict the NEXT attempt answers with, popped per attempt. */
  answers: LifecycleDeliveryAnswer[] = [];
  /** App ids the transport throws for instead of answering (a poisoned row). */
  throwFor = new Set<string>();

  /** Queue answers; the last one repeats for any further attempts. */
  queue(...answers: LifecycleDeliveryAnswer[]): void {
    this.answers.push(...answers);
  }

  readonly deliver = async (
    attempt: LifecycleDeliveryAttempt,
  ): Promise<LifecycleDeliveryAnswer> => {
    this.attempts.push(attempt);
    if (this.throwFor.has(attempt.appId)) {
      throw new Error("the transport could not carry this attempt");
    }
    const answer = this.answers.shift();
    if (answer) return answer;
    throw new Error("the fake transport was handed an attempt it has no answer queued for");
  };
}

let prisma: PrismaClient;

beforeAll(async () => {
  const scratch = await createScratchPortalDatabase("helix_portal_delivery");
  scratchUrl = scratch.url;
  dropScratch = scratch.drop;
  prisma = createPrismaClient(scratchUrl);
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
  await dropScratch?.();
});

/**
 * Outbox rows are cleaned up per test, scoped to THIS test's app ids — the
 * table is shared with the route suites running in parallel, so an unscoped
 * delete would remove a concurrent suite's fixtures.
 */
const scopedAppIds = new Set<string>();

/** One pending intent for a synthetic app id (the outbox has no FK to `apps`). */
async function seedIntent(opts: {
  appId?: string;
  generation: number;
  server: string;
  archived: boolean;
  createdAt?: Date;
}): Promise<string> {
  const appId = opts.appId ?? randomUUID();
  scopedAppIds.add(appId);
  await prisma.jobsLifecycleOutbox.create({
    data: {
      appId,
      generation: opts.generation,
      server: opts.server,
      archived: opts.archived,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
  return appId;
}

async function pendingOf(appId: string) {
  const rows = await prisma.jobsLifecycleOutbox.findMany({
    where: { appId },
    orderBy: [{ generation: "asc" }],
  });
  return rows.map((r) => ({
    server: r.server,
    generation: r.generation,
    archived: r.archived,
    deliveredAt: r.deliveredAt,
  }));
}

afterEach(async () => {
  await prisma.jobsLifecycleOutbox.deleteMany({ where: { appId: { in: [...scopedAppIds] } } });
  scopedAppIds.clear();
});

const ACK = (appliedGeneration: string): LifecycleDeliveryAnswer => ({
  kind: "acknowledged",
  appliedGeneration,
});

const TARGETS = (
  servers: string[],
): ReadonlyMap<string, { endpoint: string; portalToJobsKey: Uint8Array }> =>
  new Map(
    servers.map((server) => [
      server,
      { endpoint: `http://${server}.internal:3003`, portalToJobsKey: new Uint8Array(32) },
    ]),
  );

function makeSender(
  targets: ReadonlyMap<string, PortalJobsDeliveryTarget>,
  transport: FakeTransport,
  opts: { intervalMs?: number } = {},
): JobsLifecycleDelivery {
  return new JobsLifecycleDelivery({
    prisma,
    targets,
    transport: transport.deliver,
    log: quietLog,
    ...opts,
  });
}

describe("delivering pending intents", () => {
  it("delivers the exact {generation, archived} bytes under a fresh instruction and clears the row on a covering ack", async () => {
    const appId = await seedIntent({ generation: 3, server: "delivery-spec", archived: true });
    const transport = new FakeTransport();
    transport.queue(ACK("3"));
    const sender = makeSender(TARGETS(["delivery-spec"]), transport);

    await sender.runPass();

    // The row is cleared only by a covering acknowledgement.
    expect(await pendingOf(appId)).toEqual([
      { server: "delivery-spec", generation: 3, archived: true, deliveredAt: expect.any(Date) },
    ]);
    expect(transport.attempts).toHaveLength(1);
    const attempt = transport.attempts[0]!;
    expect(attempt.server).toBe("delivery-spec");
    expect(attempt.appId).toBe(appId);
    // The body is the wire's canonical decimal generation over the row's
    // integer authority — the bytes the receiver parses and the instruction
    // binds.
    expect(JSON.parse(Buffer.from(attempt.body).toString())).toEqual({
      generation: "3",
      archived: true,
    });
    const snapshot = sender.snapshot();
    expect(snapshot.delivered).toBe(1);
    expect(snapshot.failedDeliveries).toBe(0);
  });

  it("a brief archive's two pending intents each deliver, in generation order", async () => {
    // Generation 2 archived, generation 3 opened: both pend per target. Each
    // row earns its own delivery and its own covering ack — delivering the
    // older one first clears it (and anything older still pending for the
    // app), and the newer one follows in the same pass, since both were in
    // the batch the pass read. Neither delivery can reopen the archive: the
    // receiver's watermark closes every older generation for good.
    const appId = await seedIntent({ generation: 2, server: "delivery-spec", archived: true });
    await seedIntent({ appId, generation: 3, server: "delivery-spec", archived: false });
    const transport = new FakeTransport();
    transport.queue(ACK("2"), ACK("3"));
    const sender = makeSender(TARGETS(["delivery-spec"]), transport);

    await sender.runPass();

    expect(transport.attempts).toHaveLength(2);
    expect(JSON.parse(Buffer.from(transport.attempts[0]!.body).toString())).toEqual({
      generation: "2",
      archived: true,
    });
    expect(await pendingOf(appId)).toEqual([
      { server: "delivery-spec", generation: 2, archived: true, deliveredAt: expect.any(Date) },
      { server: "delivery-spec", generation: 3, archived: false, deliveredAt: expect.any(Date) },
    ]);
    expect(sender.snapshot().delivered).toBe(2);
  });

  it("delivers in generation order within an app — the older intent first", async () => {
    const appId = await seedIntent({ generation: 2, server: "delivery-spec", archived: true });
    await seedIntent({ appId, generation: 3, server: "delivery-spec", archived: false });
    const transport = new FakeTransport();
    transport.queue(ACK("2"), ACK("3"));
    const sender = makeSender(TARGETS(["delivery-spec"]), transport);

    await sender.runPass();

    expect(transport.attempts).toHaveLength(2);
    expect(JSON.parse(Buffer.from(transport.attempts[0]!.body).toString())).toEqual({
      generation: "2",
      archived: true,
    });
    expect(JSON.parse(Buffer.from(transport.attempts[1]!.body).toString())).toEqual({
      generation: "3",
      archived: false,
    });
    expect(sender.snapshot().delivered).toBe(2);
  });

  it("never clears on a stale acknowledgement — the ack must cover the row", async () => {
    const appId = await seedIntent({ generation: 5, server: "delivery-spec", archived: false });
    const transport = new FakeTransport();
    transport.queue(ACK("4"));
    const sender = makeSender(TARGETS(["delivery-spec"]), transport);

    await sender.runPass();

    // The row stays pending: a stale ack cannot clear newer pending work.
    expect(await pendingOf(appId)).toEqual([
      { server: "delivery-spec", generation: 5, archived: false, deliveredAt: null },
    ]);
    expect(sender.snapshot().delivered).toBe(0);
    expect(sender.snapshot().failedDeliveries).toBe(1);
  });

  it("acknowledgements above the row's generation cover it", () => {
    expect(ackCoversGeneration("5", 5)).toBe(true);
    expect(ackCoversGeneration("6", 5)).toBe(true);
    expect(ackCoversGeneration("4", 5)).toBe(false);
    // The comparison is numeric over the wire's decimal strings, never
    // lexicographic — "10" sorts before "9", and only the numeric reading
    // answers true here.
    expect(ackCoversGeneration("10", 9)).toBe(true);
    // A past-2^53 acknowledgement is a legal wire value and still covers a
    // small row — BigInt, not a float64 narrowing, is what the comparison
    // runs on.
    expect(ackCoversGeneration("9007199254740993", 3)).toBe(true);
  });
});

describe("per-target independence", () => {
  it("an unavailable target does not block another target's delivery", async () => {
    // The per-server windows are attempted in the target map's order:
    // delivery-spec's row gets the queued unanswerable ending, and
    // delivery-spec2's delivery then succeeds anyway — the failed server's
    // window never touches the other target's.
    const appIdJobs = await seedIntent({
      generation: 1,
      server: "delivery-spec",
      archived: false,
    });
    const appIdLegacy = await seedIntent({
      generation: 1,
      server: "delivery-spec2",
      archived: false,
      createdAt: new Date(Date.now() - 2_000),
    });
    const transport = new FakeTransport();
    transport.queue({ kind: "unreachable", error: new Error("connection refused") }, ACK("1"));
    const sender = makeSender(TARGETS(["delivery-spec", "delivery-spec2"]), transport);

    await sender.runPass();

    // delivery-spec's window is attempted first and gets the unanswerable
    // ending; delivery-spec2's delivery succeeds anyway.
    expect(await pendingOf(appIdJobs)).toEqual([
      { server: "delivery-spec", generation: 1, archived: false, deliveredAt: null },
    ]);
    expect(await pendingOf(appIdLegacy)).toEqual([
      { server: "delivery-spec2", generation: 1, archived: false, deliveredAt: expect.any(Date) },
    ]);
    expect(sender.snapshot().failedDeliveries).toBe(1);
    expect(sender.snapshot().delivered).toBe(1);
  });

  it("a server-level failure ends that server's attempts for the pass without touching the others", async () => {
    // Two rows for `jobs` (the first answers unreachable), one for `legacy`
    // (acknowledged). The pass must not spend its remaining attempts on the
    // dead server — but must still deliver legacy's. createdAt makes the
    // attempt order deterministic (same-millisecond creates tie on
    // `generation` too, and the scan's order between tied rows is
    // unspecified): jobs' gen-1 row is strictly oldest, so it is attempted
    // first and gets the queued unanswerable ending.
    const appIdJobs1 = await seedIntent({
      generation: 1,
      server: "delivery-spec",
      archived: false,
      createdAt: new Date(Date.now() - 2_000),
    });
    const appIdJobs2 = await seedIntent({ generation: 2, server: "delivery-spec", archived: true });
    const appIdLegacy = await seedIntent({
      generation: 1,
      server: "delivery-spec2",
      archived: false,
    });
    const transport = new FakeTransport();
    transport.queue({ kind: "unreachable", error: new Error("connection refused") }, ACK("1"));
    const sender = makeSender(TARGETS(["delivery-spec", "delivery-spec2"]), transport);

    await sender.runPass();

    const attemptedServers = transport.attempts.map((a) => a.server);
    // legacy is attempted (its own delivery ran); jobs' second row was not —
    // one failed attempt per unavailable server per pass.
    expect(attemptedServers).toEqual(["delivery-spec", "delivery-spec2"]);
    expect((await pendingOf(appIdJobs1))[0]!.deliveredAt).toBeNull();
    expect(await pendingOf(appIdJobs2)).toEqual([
      { server: "delivery-spec", generation: 2, archived: true, deliveredAt: null },
    ]);
    expect(await pendingOf(appIdLegacy)).toEqual([
      { server: "delivery-spec2", generation: 1, archived: false, deliveredAt: expect.any(Date) },
    ]);
  });

  it("an unavailable server's full backlog window cannot starve a healthy target's delivery", async () => {
    // Criterion 50: "one unavailable server neither acknowledges nor blocks
    // another server's delivery." The pass's batch window is per server — a
    // GLOBAL take across servers (the oldest 100 pending rows, whatever
    // server they belong to) is the shape that breaks this: a dead server
    // holding a full window of older rows would occupy every pass's whole
    // batch, mark itself unavailable, and leave the healthy row never
    // attempted — for as long as the outage keeps the dead backlog above the
    // cap. The per-server window is what makes the starvation
    // unrepresentable, and this test fails if a global take returns.
    const deadRows: Promise<string>[] = [];
    for (let i = 0; i < JOBS_DELIVERY_BATCH; i += 1) {
      deadRows.push(
        seedIntent({
          generation: 1,
          server: "starve-dead",
          archived: false,
          createdAt: new Date(Date.now() - 60_000),
        }),
      );
    }
    await Promise.all(deadRows);
    const appIdLive = await seedIntent({
      generation: 1,
      server: "starve-live",
      archived: false,
    });
    const transport = new FakeTransport();
    transport.queue({ kind: "unreachable", error: new Error("connection refused") }, ACK("1"));
    const sender = makeSender(TARGETS(["starve-dead", "starve-live"]), transport);

    await sender.runPass();

    const attemptedServers = new Set(transport.attempts.map((a) => a.server));
    expect(attemptedServers).toContain("starve-live");
    expect(await pendingOf(appIdLive)).toEqual([
      { server: "starve-live", generation: 1, archived: false, deliveredAt: expect.any(Date) },
    ]);
  });

  it("a row-level refusal leaves that row pending and keeps attempting the server's other rows", async () => {
    // The refused row is the NEWEST pending one — nothing delivered after it
    // covers it, so it stays pending for the next pass.
    const appId = await seedIntent({ generation: 1, server: "delivery-spec", archived: false });
    await seedIntent({ appId, generation: 2, server: "delivery-spec", archived: true });
    const transport = new FakeTransport();
    transport.queue(ACK("1"), {
      kind: "refused",
      status: 400,
      error: { code: "payload_invalid", message: "x" },
    });
    const sender = makeSender(TARGETS(["delivery-spec"]), transport);

    await sender.runPass();

    expect(transport.attempts).toHaveLength(2);
    const rows = await pendingOf(appId);
    expect(rows[0]!.deliveredAt).not.toBeNull();
    expect(rows[1]!.deliveredAt).toBeNull();
  });

  it("a newer generation's covering ack clears an older row whose own delivery was refused", async () => {
    // The receiver refused the generation-1 delivery outright — but its
    // generation-2 acknowledgement proves it durably applied state that
    // closes every older generation's intent (the watermark). The refusal
    // said "this delivery was not processed"; the later ack says the intent
    // is settled anyway. Clearing it here is the covering write's job, and
    // the refused row is not left to age as backlog.
    const appId = await seedIntent({ generation: 1, server: "delivery-spec", archived: false });
    await seedIntent({ appId, generation: 2, server: "delivery-spec", archived: true });
    const transport = new FakeTransport();
    transport.queue(
      { kind: "refused", status: 400, error: { code: "payload_invalid", message: "x" } },
      ACK("2"),
    );
    const sender = makeSender(TARGETS(["delivery-spec"]), transport);

    await sender.runPass();

    expect(transport.attempts).toHaveLength(2);
    const rows = await pendingOf(appId);
    expect(rows).toEqual([
      { server: "delivery-spec", generation: 1, archived: false, deliveredAt: expect.any(Date) },
      { server: "delivery-spec", generation: 2, archived: true, deliveredAt: expect.any(Date) },
    ]);
    expect(sender.snapshot().delivered).toBe(2);
    expect(sender.snapshot().failedDeliveries).toBe(1);
  });

  it("a receiver's 5xx refusal is a server-level ending — its remaining rows skip the pass", async () => {
    const appId1 = await seedIntent({ generation: 1, server: "delivery-spec", archived: false });
    const appId2 = await seedIntent({ generation: 2, server: "delivery-spec", archived: true });
    const transport = new FakeTransport();
    transport.queue(
      { kind: "refused", status: 503, error: { code: "jobs_unavailable", message: "x" } },
      ACK("2"),
    );
    const sender = makeSender(TARGETS(["delivery-spec"]), transport);

    await sender.runPass();

    expect(transport.attempts).toHaveLength(1);
    expect((await pendingOf(appId1))[0]!.deliveredAt).toBeNull();
    expect((await pendingOf(appId2))[0]!.deliveredAt).toBeNull();
  });

  it("a stale acknowledgement is not a server-level ending — the receiver's other rows still deliver", async () => {
    // The complement of the 5xx ending: a receiver that answered with an
    // OLDER generation is behind, not down — the ending implicates the one
    // row's coverage, never the target's reachability. The pass must keep
    // spending its window on that server: the server's next row (a second
    // app, so its covering ack cannot clear the stale-acked row's intent)
    // is still attempted and cleared, while the stale-acked row stays
    // pending. Marking the server unavailable here would starve a
    // merely-behind receiver's remaining rows for the pass.
    const staleId = await seedIntent({ generation: 5, server: "delivery-spec", archived: false });
    const nextId = await seedIntent({ generation: 6, server: "delivery-spec", archived: true });
    const transport = new FakeTransport();
    transport.queue(ACK("4"), ACK("6"));
    const sender = makeSender(TARGETS(["delivery-spec"]), transport);

    await sender.runPass();

    expect(transport.attempts).toHaveLength(2);
    expect(await pendingOf(staleId)).toEqual([
      { server: "delivery-spec", generation: 5, archived: false, deliveredAt: null },
    ]);
    expect(await pendingOf(nextId)).toEqual([
      { server: "delivery-spec", generation: 6, archived: true, deliveredAt: expect.any(Date) },
    ]);
    expect(sender.snapshot().delivered).toBe(1);
    expect(sender.snapshot().failedDeliveries).toBe(1);
  });

  it("an attempt that throws out of its own transport is that row's failure, not the pass's", async () => {
    // A row the transport cannot even carry (the production transport's mint
    // refuses a malformed app id; the stand-in throws here) must not abort
    // the pass: the poisoned row stays pending, the failure is counted, and
    // the other rows still deliver.
    const poisonId = await seedIntent({ generation: 1, server: "delivery-spec", archived: false });
    const goodId = await seedIntent({ generation: 2, server: "delivery-spec", archived: true });
    const transport = new FakeTransport();
    transport.throwFor.add(poisonId);
    transport.queue(ACK("2"));
    const sender = makeSender(TARGETS(["delivery-spec"]), transport);

    await sender.runPass();

    expect((await pendingOf(goodId))[0]!.deliveredAt).not.toBeNull();
    expect((await pendingOf(poisonId))[0]!.deliveredAt).toBeNull();
    expect(sender.snapshot().failedDeliveries).toBe(1);
    expect(sender.snapshot().delivered).toBe(1);
  });

  it("rows for a server the portal no longer delivers to stay pending and are never attempted", async () => {
    const appId = await seedIntent({ generation: 1, server: "ghost", archived: false });
    const transport = new FakeTransport();
    const sender = makeSender(TARGETS(["delivery-spec"]), transport);

    await sender.runPass();

    expect(transport.attempts).toEqual([]);
    expect(await pendingOf(appId)).toEqual([
      { server: "ghost", generation: 1, archived: false, deliveredAt: null },
    ]);
    // The backlog measurement still carries the ghost's rows — the evidence
    // that something was written for a target with no delivery path.
    const ghost = sender.snapshot().backlog?.find((entry) => entry.server === "ghost");
    expect(ghost?.outstanding).toBeGreaterThanOrEqual(1);
  });

  it("the pass names a pending row's unknown server", async () => {
    await seedIntent({ generation: 1, server: "ghost", archived: false });
    const events: string[] = [];
    const sender = new JobsLifecycleDelivery({
      prisma,
      targets: TARGETS(["delivery-spec"]),
      transport: new FakeTransport().deliver,
      log: {
        info: () => {},
        warn: () => {},
        error: (fields: Record<string, unknown>) => {
          events.push(String(fields["event"]));
        },
      },
    });

    await sender.runPass();

    expect(events).toContain("jobs.delivery.target_unknown");
  });

  it("a throwing report of an unknown server never gates the deliveries", async () => {
    // The pass's work and its reporting are separately failable: a report
    // that throws rejects the pass (this module's own contract), but only
    // AFTER the deliveries it owed have been attempted and cleared — the
    // report is the pass's evidence, never a gate on the pass's work.
    const ghostId = await seedIntent({ generation: 1, server: "ghost", archived: false });
    const goodId = await seedIntent({ generation: 1, server: "delivery-spec", archived: false });
    const transport = new FakeTransport();
    transport.queue(ACK("1"));
    const sender = new JobsLifecycleDelivery({
      prisma,
      targets: TARGETS(["delivery-spec"]),
      transport: transport.deliver,
      log: {
        info: () => {},
        warn: () => {},
        error: () => {
          throw new Error("the reporting sink is down");
        },
      },
    });

    await expect(sender.runPass()).rejects.toThrow("the reporting sink is down");

    expect((await pendingOf(goodId))[0]!.deliveredAt).not.toBeNull();
    expect((await pendingOf(ghostId))[0]!.deliveredAt).toBeNull();
  });
});

describe("the supervision state", () => {
  it("coalesces a pass that arrives while another is running", async () => {
    const transport = new FakeTransport();
    const sender = makeSender(TARGETS([]), transport);
    const first = sender.runPass();
    const second = sender.runPass();
    expect(second).toBe(first);
    await Promise.all([first, second]);
  });

  it("a stopped sender reports stopped and does not restart", async () => {
    const sender = makeSender(TARGETS([]), new FakeTransport());
    sender.start();
    expect(sender.snapshot().started).toBe(true);
    await sender.stop();
    expect(sender.snapshot().started).toBe(false);
    sender.start();
    expect(sender.snapshot().started).toBe(false);
  });

  it("stop() awaits the in-flight pass and releases the cadence — on the success path and the failure path", async () => {
    for (const queue of [
      [ACK("1")],
      // The failure path: the pass fails (its store cannot answer) and the
      // release must still wait for it to settle.
      [{ kind: "unreachable", error: new Error("down") }],
    ]) {
      const appId = await seedIntent({ generation: 1, server: "delivery-spec", archived: false });
      const transport = new FakeTransport();
      transport.queue(...(queue as LifecycleDeliveryAnswer[]));
      const sender = makeSender(TARGETS(["delivery-spec"]), transport, { intervalMs: 10 });

      sender.start();
      // The first pass is immediate; let it begin, then stop underneath it.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await sender.stop();
      // After the release, the cadence is gone: a further pass is only a
      // caller's explicit request, and the snapshot reports stopped.
      expect(sender.snapshot().started).toBe(false);
      await prisma.jobsLifecycleOutbox.deleteMany({ where: { appId } });
      scopedAppIds.delete(appId);
    }
  });

  it("the timer keeps the cadence on its own — through a failing pass, through a pass whose own reporting threw, and not one pass past stop", async () => {
    // The reschedule arms are the loop's whole point: start() runs the first
    // pass immediately, and EVERY settlement half — a settled pass on the
    // success arm, a pass whose own failure reporting threw on the fault arm
    // — must schedule the next one. Every other test drives runPass()
    // manually or stops within the first interval, so this is the only test
    // that lets the timer itself prove the cadence: a store that always
    // fails (the harness's broken-client pattern) and a sink that throws on
    // its FIRST error report make pass 1 reject out of its own reporting —
    // only the fault arm can have scheduled pass 2, and only the success
    // arm passes 3 and beyond. If the reschedule arms were lost, the loop
    // would die silently after one pass and every manual-runPass test above
    // would stay green.
    let errorReports = 0;
    const throwingOnce = {
      info: () => {},
      warn: () => {},
      error: () => {
        errorReports += 1;
        if (errorReports === 1) throw new Error("the reporting sink is down");
      },
    };
    const broken = createPrismaClient(scratchUrl).$extends({
      query: {
        jobsLifecycleOutbox: {
          $allOperations() {
            throw new Error("outbox unavailable");
          },
        },
      },
    }) as unknown as PrismaClient;
    const sender = new JobsLifecycleDelivery({
      prisma: broken,
      targets: TARGETS(["delivery-spec"]),
      transport: new FakeTransport().deliver,
      log: throwingOnce,
      intervalMs: 5,
    });

    sender.start();
    // Wait for the passes rather than for a fixed slice of wall clock: each
    // pass opens the broken client's store, and on a loaded runner the first
    // one alone can outlast any small fixed sleep. The 5 ms cadence is what is
    // under test, so the bound only has to be generous, not tight.
    await vi.waitFor(
      () => {
        // Pass 1 was the timer's own (no runPass call in this test), pass 2
        // could only exist through the fault arm's reschedule after pass 1's
        // rejection, pass 3+ through the success arm after failed passes.
        expect(sender.snapshot().passes).toBeGreaterThanOrEqual(3);
        // The first report threw; the loop's later passes still reported —
        // the rejection ended neither the reporting nor the cadence.
        expect(errorReports).toBeGreaterThanOrEqual(3);
      },
      { timeout: 15_000, interval: 5 },
    );
    const snapshot = sender.snapshot();
    expect(snapshot.started).toBe(true);
    expect(snapshot.lastOkPassAt).toBeNull();

    await sender.stop();
    const stoppedAt = sender.snapshot();
    expect(stoppedAt.started).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Not one pass past the stop: the timer is gone and nothing rescheduled.
    expect(sender.snapshot().passes).toBe(stoppedAt.passes);
    await broken.$disconnect();
  }, 30_000);

  it("the batch cap bounds one pass's attempts", async () => {
    const transport = new FakeTransport();
    for (let i = 0; i < JOBS_DELIVERY_BATCH + 5; i += 1) {
      await seedIntent({ generation: 1, server: "delivery-spec", archived: false });
    }
    transport.queue(...Array.from({ length: JOBS_DELIVERY_BATCH }, () => ACK("1")));
    const sender = makeSender(TARGETS(["delivery-spec"]), transport);

    await sender.runPass();

    expect(transport.attempts).toHaveLength(JOBS_DELIVERY_BATCH);
    expect(sender.snapshot().delivered).toBe(JOBS_DELIVERY_BATCH);
    // The remainder waits for the next pass, which re-scans oldest-first.
    const remaining = await prisma.jobsLifecycleOutbox.count({
      where: { appId: { in: [...scopedAppIds] }, deliveredAt: null },
    });
    expect(remaining).toBe(5);
  });
});

describe("two replicas running the loop together", () => {
  it("a concurrent duplicate's clear is a no-op — the row is acknowledged once", async () => {
    // Two processes run the same scan against one pending row: both may
    // deliver it (the receiver's watermark answers both), but only the
    // sender whose conditional write actually cleared the row may count the
    // acknowledgement — the other's `deliveredAt: null` predicate matches
    // nothing. The replicas' counts never double-report one intent.
    const appId = await seedIntent({ generation: 1, server: "delivery-spec", archived: false });
    const transportA = new FakeTransport();
    transportA.queue(ACK("1"));
    const transportB = new FakeTransport();
    transportB.queue(ACK("1"));
    const a = makeSender(TARGETS(["delivery-spec"]), transportA);
    const b = makeSender(TARGETS(["delivery-spec"]), transportB);

    await Promise.all([a.runPass(), b.runPass()]);

    expect(a.snapshot().delivered + b.snapshot().delivered).toBe(1);
    expect(a.snapshot().failedDeliveries + b.snapshot().failedDeliveries).toBe(0);
    expect(await pendingOf(appId)).toEqual([
      { server: "delivery-spec", generation: 1, archived: false, deliveredAt: expect.any(Date) },
    ]);
  });
});

describe("a pass whose own failure reporting throws", () => {
  /**
   * A pass can reject only through its own failure reporting — a log sink
   * that threw. The same contract the jobs recovery loop's release tests
   * pin, executed on this loop: the in-flight guard clears on the rejection
   * (the next pass runs instead of coalescing into the settled one), the
   * passes stay counted, and stop() must resolve over a rejected pass or
   * the shutdown that stops this sender never releases what it acquired.
   * The store leg is the harness's gated-write pattern: a query extension
   * that throws on the outbox model (a disconnected client would just
   * reconnect on the next query).
   */
  let base: PrismaClient;
  let broken: PrismaClient;

  beforeAll(() => {
    base = createPrismaClient(scratchUrl);
    broken = base.$extends({
      query: {
        jobsLifecycleOutbox: {
          $allOperations() {
            throw new Error("outbox unavailable");
          },
        },
      },
    }) as unknown as PrismaClient;
  });

  afterAll(async () => {
    await base.$disconnect();
    await broken.$disconnect();
  });

  it("rejects to the caller, clears the in-flight guard, and the next pass still runs", async () => {
    let errorReports = 0;
    const throwingOnce = {
      info: () => {},
      warn: () => {},
      error: () => {
        errorReports += 1;
        if (errorReports === 1) throw new Error("the reporting sink is down");
      },
    };
    const sender = new JobsLifecycleDelivery({
      prisma: broken,
      targets: TARGETS(["delivery-spec"]),
      transport: new FakeTransport().deliver,
      log: throwingOnce,
    });

    // The pass's own failure report threw — the rejection reaches the caller.
    await expect(sender.runPass()).rejects.toThrow("the reporting sink is down");
    // The guard cleared on the rejection: this is a NEW pass, not the settled
    // one — its report succeeds, and both passes are counted.
    await sender.runPass();
    expect(errorReports).toBe(2);
    expect(sender.snapshot().passes).toBe(2);
    expect(sender.snapshot().lastOkPassAt).toBeNull();
  });

  it("stop() releases through a rejected pass — the release chain survives", async () => {
    const events: Array<Record<string, unknown>> = [];
    const brokenSink = {
      info: () => {},
      warn: () => {},
      error: (fields: Record<string, unknown>): void => {
        events.push(fields);
        throw new Error("the reporting sink is down");
      },
    };
    await seedIntent({ generation: 1, server: "delivery-spec", archived: false });
    let entered!: () => void;
    const inAttempt = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let failAttempt!: (error: Error) => void;
    const attemptGate = new Promise<never>((_, reject) => {
      failAttempt = reject;
    });
    const sender = new JobsLifecycleDelivery({
      prisma,
      targets: TARGETS(["delivery-spec"]),
      transport: async () => {
        entered();
        return attemptGate;
      },
      log: brokenSink,
      intervalMs: 3_600_000,
    });
    sender.start();
    await inAttempt;
    const stopping = sender.stop();
    failAttempt(new Error("the transport died mid-flight"));
    try {
      await expect(stopping).resolves.toBeUndefined();
      // The rejection was reported through the sink-guarded release event,
      // and the snapshot reports the stop.
      expect(events.some((e) => e["event"] === "jobs.delivery.pass_rejected")).toBe(true);
      expect(sender.snapshot().started).toBe(false);
    } finally {
      await sender.stop().catch(() => {});
    }
  });
});

describe("backlog evidence", () => {
  it("measures per-server outstanding counts and the oldest pending instant", async () => {
    const old = new Date(Date.now() - 90_000);
    await seedIntent({ generation: 1, server: "delivery-spec", archived: false, createdAt: old });
    await seedIntent({ generation: 2, server: "delivery-spec", archived: true });
    const transport = new FakeTransport();
    const sender = makeSender(TARGETS(["delivery-spec1"]), transport);

    await sender.runPass();

    const entry = sender.snapshot().backlog?.find((e) => e.server === "delivery-spec");
    expect(entry?.outstanding).toBeGreaterThanOrEqual(2);
    expect(entry?.oldestPendingAt).toBeDefined();
    // The oldest instant this test contributed is at least the 90s-old row's.
    expect(Date.parse(entry!.oldestPendingAt!)).toBeLessThanOrEqual(old.getTime());
  });

  it("a failed pass keeps the cadence and the failure is counted", async () => {
    // A sender whose own store cannot answer: the pass fails, is counted, and
    // the loop's next caller still runs its own pass. The failing client is
    // the harness's gated-write pattern — a query extension that throws on
    // the outbox model — because a disconnected Prisma client would just
    // reconnect on the next query.
    const broken = createPrismaClient(scratchUrl).$extends({
      query: {
        jobsLifecycleOutbox: {
          $allOperations() {
            throw new Error("outbox unavailable");
          },
        },
      },
    }) as unknown as PrismaClient;
    const sender = new JobsLifecycleDelivery({
      prisma: broken,
      targets: TARGETS(["delivery-spec"]),
      transport: new FakeTransport().deliver,
      log: quietLog,
    });
    await sender.runPass();
    await sender.runPass();
    expect(sender.snapshot().passes).toBe(2);
    expect(sender.snapshot().lastOkPassAt).toBeNull();
  });

  it("a store failure mid-scan keeps the cleared rows and reports their count on the failed pass", async () => {
    // The per-server scan queries the store once per target: a transient
    // failure on a LATER server's batch query fails the pass after earlier
    // servers' deliveries already cleared rows. The pass fails as a whole
    // (the documented contract), but the work done before the failure must
    // not vanish from the record: the cleared rows stay cleared, and the
    // failed pass's snapshot still counts them as delivered — an accounting
    // that dropped the accumulators on the failure path would under-report
    // every partially-completed pass exactly when the store is flaky. The
    // failing client is the harness's gated-write pattern, throwing on the
    // SECOND batch query only (server-b's), so server-a's deliveries run.
    let findManyCalls = 0;
    const flaky = createPrismaClient(scratchUrl).$extends({
      query: {
        jobsLifecycleOutbox: {
          async $allOperations({ operation, args, query }) {
            if (operation === "findMany") {
              findManyCalls += 1;
              if (findManyCalls === 2) throw new Error("outbox unavailable");
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    const appIdA = await seedIntent({ generation: 1, server: "scan-a", archived: false });
    const appIdB = await seedIntent({ generation: 1, server: "scan-b", archived: false });
    const transport = new FakeTransport();
    transport.queue(ACK("1"));
    const sender = new JobsLifecycleDelivery({
      prisma: flaky,
      targets: TARGETS(["scan-a", "scan-b"]),
      transport: transport.deliver,
      log: quietLog,
    });

    await sender.runPass();

    // Server-a's delivery happened and stays durable; the pass that lost
    // server-b's query still reports it.
    expect(await pendingOf(appIdA)).toEqual([
      { server: "scan-a", generation: 1, archived: false, deliveredAt: expect.any(Date) },
    ]);
    expect(await pendingOf(appIdB)).toEqual([
      { server: "scan-b", generation: 1, archived: false, deliveredAt: null },
    ]);
    const snapshot = sender.snapshot();
    expect(snapshot.passes).toBe(1);
    expect(snapshot.delivered).toBe(1);
    // No delivery ATTEMPT failed — the store did. The pass reads failed.
    expect(snapshot.failedDeliveries).toBe(0);
    expect(snapshot.lastOkPassAt).toBeNull();
    await flaky.$disconnect();
  });
});

describe("telemetry (AGENTS.md §Telemetry ships with the change)", () => {
  // One recording for the describe, reset between tests: a module-scope
  // ProxyTracer does not follow providers swapped mid-file (the testing
  // package's own lifecycle note), so each test here re-registers a fresh
  // recorder only by sharing one.
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

  it("emits one root consumer span per delivery attempt with the bounded attributes", async () => {
    const appId = await seedIntent({ generation: 4, server: "delivery-spec", archived: true });
    const transport = new FakeTransport();
    transport.queue(ACK("4"));
    const sender = makeSender(TARGETS(["delivery-spec"]), transport);
    await sender.runPass();

    const spans = recording.spans().filter((s) => s.name === SPAN_JOBS_LIFECYCLE_DELIVER);
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.attributes[ATTR_APP_ID]).toBe(appId);
    expect(span.attributes[ATTR_JOBS_SERVER]).toBe("delivery-spec");
    expect(span.attributes[ATTR_JOBS_GENERATION]).toBe(4);
    expect(span.attributes[ATTR_JOBS_ARCHIVED]).toBe(true);
    expect(span.attributes[ATTR_OUTCOME]).toBe("acknowledged");
  });

  it("the span carries the refusal's bounded code, never the endpoint or an error's text", async () => {
    await seedIntent({ generation: 1, server: "delivery-spec", archived: false });
    const transport = new FakeTransport();
    transport.queue({
      kind: "refused",
      status: 503,
      error: { code: "jobs_unavailable", message: "x" },
    });
    const sender = makeSender(TARGETS(["delivery-spec"]), transport);
    await sender.runPass();

    const spans = recording.spans().filter((s) => s.name === SPAN_JOBS_LIFECYCLE_DELIVER);
    expect(spans).toHaveLength(1);
    const attributes = spans[0]!.attributes;
    expect(attributes[ATTR_OUTCOME]).toBe("refused");
    const values = JSON.stringify(attributes);
    expect(values).not.toMatch(/jobs\.internal|endpoint|unavailable-store-detail/);
  });

  it("a stale acknowledgement is its own span outcome, logged with the row's and the ack's generations", async () => {
    // stale_ack is the one outcome the SENDER computes — the transport said
    // `acknowledged`; the coverage decision downgraded it. The evidence an
    // operator joins on is the span outcome plus the error-level event
    // naming both generations, so a misrouted receiver is diagnosable from
    // either signal alone.
    const appId = await seedIntent({ generation: 5, server: "delivery-spec", archived: false });
    const events: Array<Record<string, unknown>> = [];
    const capturing = {
      info: () => {},
      warn: () => {},
      error: (fields: Record<string, unknown>): void => {
        events.push(fields);
      },
    };
    const transport = new FakeTransport();
    transport.queue(ACK("4"));
    const sender = new JobsLifecycleDelivery({
      prisma,
      targets: TARGETS(["delivery-spec"]),
      transport: transport.deliver,
      log: capturing,
    });
    await sender.runPass();

    const spans = recording.spans().filter((s) => s.name === SPAN_JOBS_LIFECYCLE_DELIVER);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes[ATTR_OUTCOME]).toBe("stale_ack");
    const stale = events.find((e) => e["event"] === "jobs.delivery.stale_ack");
    expect(stale).toMatchObject({
      appId,
      server: "delivery-spec",
      generation: 5,
      appliedGeneration: "4",
    });
  });
});

describe("the delivery loop's bounds", () => {
  it("the staleness bound is three cadences, strictly inside the contract's overdue bound", () => {
    // The house shape for loop-graded checks — the recovery sweeper's and
    // cleanup loop's suites pin the same relationship on their own
    // constants, against the cadence's literal value: a cadence resize must
    // fail here and force the staleness decision to be made consciously,
    // rather than dragging the bound along silently. The second
    // relationship is what the three-cadence choice exists for: a stalled
    // loop must degrade through the stale arm BEFORE the backlog arm's
    // 60-second reading degrades it anyway — an interval resized past a
    // third of the overdue bound would let every stall read overdue
    // instead, and the distinct, earlier stall signal goes silent.
    expect(JOBS_DELIVERY_STALE_AFTER_MS).toBe(3 * 15_000);
    expect(JOBS_DELIVERY_STALE_AFTER_MS).toBeLessThan(JOBS_DELIVERY_OVERDUE_MS);
  });
});

describe("jobsLifecycleDeliveryCheck (the health grading)", () => {
  const baseSnapshot = (over: Partial<JobsDeliverySnapshot>): JobsDeliverySnapshot => ({
    started: true,
    passes: 3,
    lastPassAt: new Date(Date.now() - 1_000).toISOString(),
    lastOkPassAt: new Date(Date.now() - 1_000).toISOString(),
    delivered: 0,
    failedDeliveries: 0,
    backlog: [],
    synchronization: [],
    ...over,
  });
  const NOW = Date.now();

  it("never reads healthy without evidence: not started and no pass are errors", () => {
    const stopped = jobsLifecycleDeliveryCheck(baseSnapshot({ started: false }), { nowMs: NOW });
    expect(stopped.status).toBe("error");
    expect(stopped.name).toBe("jobs_lifecycle_delivery");
    const neverRan = jobsLifecycleDeliveryCheck(
      baseSnapshot({ lastOkPassAt: null, lastPassAt: null }),
      { nowMs: NOW },
    );
    expect(neverRan.status).toBe("error");
  });

  it("a stalled loop degrades well inside the 60-second backlog bound", () => {
    const check = jobsLifecycleDeliveryCheck(
      baseSnapshot({
        lastOkPassAt: new Date(NOW - JOBS_DELIVERY_STALE_AFTER_MS - 1).toISOString(),
      }),
      { nowMs: NOW },
    );
    expect(check.status).toBe("degraded");
    expect(check.detail).toMatch(/last successful pass/);
  });

  it("pending work older than 60 seconds degrades, with the per-server breakdown", () => {
    const oldest = new Date(NOW - JOBS_DELIVERY_OVERDUE_MS - 5_000).toISOString();
    const check = jobsLifecycleDeliveryCheck(
      baseSnapshot({
        backlog: [
          { server: "delivery-spec", outstanding: 2, oldestPendingAt: oldest },
          {
            server: "delivery-spec2",
            outstanding: 1,
            oldestPendingAt: new Date(NOW - 1_000).toISOString(),
          },
        ],
      }),
      { nowMs: NOW },
    );
    expect(check.status).toBe("degraded");
    expect(check.metrics?.outstanding).toBe(3);
    expect(check.detail).toMatch(/delivery-spec: 2 pending/);
    expect(check.detail).toMatch(/delivery-spec2: 1 pending/);
  });

  it("degrades exactly at the 60-second bound — the age is not rounded past the contract's line", () => {
    // Criterion 52: "Pending work older than 60 seconds makes the
    // corresponding health check degraded." The grading rounds the age to
    // whole seconds before comparing, so work aged 60.4s — older than the
    // contract's bound — rounds to 60 and reads ok. The bound is 60s, not
    // 61s: the comparison must see the milliseconds the store carries.
    const check = jobsLifecycleDeliveryCheck(
      baseSnapshot({
        backlog: [
          {
            server: "delivery-spec",
            outstanding: 1,
            oldestPendingAt: new Date(NOW - 60_400).toISOString(),
          },
        ],
      }),
      { nowMs: NOW },
    );
    expect(check.status).toBe("degraded");
  });

  it("work aged exactly the bound, or a millisecond under, still reads ok — 'older than 60 seconds' is strict", () => {
    // The other edge of the same comparison: criterion 52 degrades work
    // OLDER than 60 seconds, so an entry aged exactly 60,000 ms (and one
    // aged 59,999) is not yet overdue. A comparison that read `>=` — or one
    // that floored to seconds and compared that — would cross this line.
    for (const ageMs of [JOBS_DELIVERY_OVERDUE_MS, JOBS_DELIVERY_OVERDUE_MS - 1]) {
      const check = jobsLifecycleDeliveryCheck(
        baseSnapshot({
          backlog: [
            {
              server: "delivery-spec",
              outstanding: 1,
              oldestPendingAt: new Date(NOW - ageMs).toISOString(),
            },
          ],
        }),
        { nowMs: NOW },
      );
      expect(check.status, `aged ${ageMs}ms`).toBe("ok");
    }
  });

  it("young backlog and an empty backlog read ok, with the counts as metrics", () => {
    const young = jobsLifecycleDeliveryCheck(
      baseSnapshot({
        backlog: [
          {
            server: "delivery-spec",
            outstanding: 1,
            oldestPendingAt: new Date(NOW - 2_000).toISOString(),
          },
        ],
      }),
      { nowMs: NOW },
    );
    expect(young.status).toBe("ok");
    expect(young.metrics?.outstanding).toBe(1);
    expect(jobsLifecycleDeliveryCheck(baseSnapshot({ backlog: [] }), { nowMs: NOW }).status).toBe(
      "ok",
    );
  });

  it("a fresh loop whose pass carried no measurement refuses the healthy reading", () => {
    const check = jobsLifecycleDeliveryCheck(baseSnapshot({ backlog: null }), { nowMs: NOW });
    expect(check.status).toBe("error");
    expect(check.detail).toMatch(/no backlog measurement/);
  });

  it("a fresh loop whose pass carried no synchronization reading refuses the healthy reading", () => {
    const check = jobsLifecycleDeliveryCheck(baseSnapshot({ synchronization: null }), {
      nowMs: NOW,
    });
    expect(check.status).toBe("error");
    expect(check.detail).toMatch(/no synchronization reading/);
  });

  it("every target synchronized reads ok without a detail, with the target counts as metrics", () => {
    const check = jobsLifecycleDeliveryCheck(
      baseSnapshot({
        synchronization: [
          {
            server: "delivery-spec",
            synchronized: true,
            synchronizedAt: new Date(NOW).toISOString(),
            enqueued: 3,
          },
          {
            server: "delivery-spec2",
            synchronized: true,
            synchronizedAt: new Date(NOW).toISOString(),
            enqueued: 0,
          },
        ],
      }),
      { nowMs: NOW },
    );
    expect(check.status).toBe("ok");
    expect(check.detail).toBeUndefined();
    expect(check.metrics?.targets).toBe(2);
    expect(check.metrics?.synchronizedTargets).toBe(2);
  });

  it("an unsynchronized target that is not overdue stays ok, naming the target and its pending count", () => {
    const check = jobsLifecycleDeliveryCheck(
      baseSnapshot({
        backlog: [
          {
            server: "delivery-spec",
            outstanding: 3,
            oldestPendingAt: new Date(NOW - 2_000).toISOString(),
          },
        ],
        synchronization: [
          { server: "delivery-spec", synchronized: false, synchronizedAt: null, enqueued: 3 },
          {
            server: "delivery-spec2",
            synchronized: true,
            synchronizedAt: new Date(NOW).toISOString(),
            enqueued: 0,
          },
        ],
      }),
      { nowMs: NOW },
    );
    expect(check.status).toBe("ok");
    expect(check.detail).toMatch(
      /lifecycle synchronization in progress — delivery-spec: 3 pending/,
    );
    expect(check.detail).toMatch(
      /a server admits an app's new jobs only after that app's lifecycle state is acknowledged/,
    );
    expect(check.metrics?.targets).toBe(2);
    expect(check.metrics?.synchronizedTargets).toBe(1);
  });
});

describe("lifecycleUpdateBytes", () => {
  it("builds the wire's canonical decimal generation over the row's integer authority", () => {
    expect(Buffer.from(lifecycleUpdateBytes({ generation: 1, archived: false })).toString()).toBe(
      '{"generation":"1","archived":false}',
    );
    expect(Buffer.from(lifecycleUpdateBytes({ generation: 12, archived: true })).toString()).toBe(
      '{"generation":"12","archived":true}',
    );
  });
});

describe("/health wiring", () => {
  it("carries the delivery check's degradation in the body when the sender is wired", async () => {
    const sender: JobsLifecycleDelivery = makeSender(TARGETS([]), new FakeTransport());
    const t = buildTestApp({ jobsDelivery: () => sender.snapshot() });
    await t.app.ready();
    try {
      const res = await t.app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("error"); // the sender has not started — never healthy
      expect(body.checks).toHaveLength(1);
      expect(body.checks[0].name).toBe("jobs_lifecycle_delivery");
    } finally {
      await t.close();
    }
  });

  it("rolls a degraded delivery check into the body's status — overdue backlog reads degraded, still 200", async () => {
    // Criterion 52's reading through the real wiring: pending work older than
    // the 60-second bound degrades the check, and the worst-state roll-up
    // carries that into the body's status — while the answer stays HTTP 200
    // in every state (the body carries the degradation, never the code).
    const snapshot: JobsDeliverySnapshot = {
      started: true,
      passes: 3,
      lastPassAt: new Date(Date.now() - 1_000).toISOString(),
      lastOkPassAt: new Date(Date.now() - 1_000).toISOString(),
      delivered: 0,
      failedDeliveries: 0,
      backlog: [
        {
          server: "delivery-spec",
          outstanding: 2,
          oldestPendingAt: new Date(Date.now() - JOBS_DELIVERY_OVERDUE_MS - 5_000).toISOString(),
        },
      ],
      synchronization: [
        { server: "delivery-spec", synchronized: false, synchronizedAt: null, enqueued: 2 },
      ],
    };
    const t = buildTestApp({ jobsDelivery: () => snapshot });
    await t.app.ready();
    try {
      const res = await t.app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("degraded");
      expect(body.checks).toHaveLength(1);
      expect(body.checks[0].status).toBe("degraded");
      expect(body.checks[0].name).toBe("jobs_lifecycle_delivery");
    } finally {
      await t.close();
    }
  });

  it("reports liveness only when no sender is wired — fully disabled jobs implies no jobs dependency", async () => {
    const t = buildTestApp();
    await t.app.ready();
    try {
      const res = await t.app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("ok");
      expect(res.json().checks).toBeUndefined();
    } finally {
      await t.close();
    }
  });
});
