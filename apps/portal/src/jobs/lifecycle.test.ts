import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ATTR_APP_ID,
  ATTR_JOBS_ARCHIVED,
  ATTR_JOBS_GENERATION,
  ATTR_JOBS_LIFECYCLE_TARGETS,
  SPAN_JOBS_LIFECYCLE_OUTBOX,
} from "@azx-pbc/shared/telemetry";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";
import type { PrismaClient } from "../db/client.js";
import { isUniqueViolation } from "../db/errors.js";
import { lifecycleTargets } from "./lifecycle.js";
import {
  authHeader,
  buildTestApp,
  createTestPrisma,
  uniqueSlug,
  type TestApp,
} from "../test/harness.js";
import { withEnv } from "../test/env.js";

/**
 * The lifecycle seam's observable contract (background-jobs-plane design §5,
 * ADR-0007): creation, archive and unarchive commit app state, the generation
 * and the per-target outbox intents together or not at all — driven through
 * the real routes against the real Postgres, because the guarantees under test
 * are the store's, not the helper's.
 */

let t: TestApp;

beforeAll(async () => {
  t = buildTestApp();
  await t.app.ready();
});

afterAll(async () => {
  await t.close();
});

/** One serving server (the production fetch type) plus one retiring entry. */
const TWO_SERVERS = JSON.stringify({
  servers: {
    jobs: { state: "serving", types: ["jobs:fetch"] },
    legacy: { state: "retiring", types: [] },
  },
});

const createApp = (payload: Record<string, unknown>) =>
  t.app.inject({
    method: "POST",
    url: "/api/v1/apps",
    headers: authHeader(),
    payload,
  });

const archive = (slug: string) =>
  t.app.inject({
    method: "POST",
    url: `/api/v1/apps/${slug}/archive`,
    headers: authHeader(),
  });

const unarchive = (slug: string) =>
  t.app.inject({
    method: "POST",
    url: `/api/v1/apps/${slug}/unarchive`,
    headers: authHeader(),
  });

async function rowOf(slug: string) {
  return t.prisma.app.findUniqueOrThrow({ where: { slug } });
}

/** The app's outbox rows, ordered (generation, server) for stable assertions. */
async function intentsOf(appId: string) {
  const rows = await t.prisma.jobsLifecycleOutbox.findMany({
    where: { appId },
    orderBy: [{ generation: "asc" }, { server: "asc" }],
  });
  return rows.map((r) => ({
    server: r.server,
    generation: r.generation,
    archived: r.archived,
    deliveredAt: r.deliveredAt,
  }));
}

describe("lifecycle targets", () => {
  it("names every configured server — serving and retiring alike", async () => {
    await withEnv({ PORTAL_JOBS_CATALOGUE: TWO_SERVERS }, async () => {
      expect(lifecycleTargets().sort()).toEqual(["jobs", "legacy"]);
    });
  });

  it("is empty while jobs is fully disabled", async () => {
    await withEnv({ PORTAL_JOBS_CATALOGUE: undefined }, async () => {
      expect(lifecycleTargets()).toEqual([]);
    });
  });

  it("propagates a misconfigured source as the resolver's platform failure", async () => {
    await withEnv({ PORTAL_JOBS_CATALOGUE: "not json" }, async () => {
      expect(() => lifecycleTargets()).toThrow(/PORTAL_JOBS_CATALOGUE/);
    });
  });
});

describe("creation intents", () => {
  it("records an open intent per target with the app row", async () => {
    const slug = uniqueSlug();
    await withEnv({ PORTAL_JOBS_CATALOGUE: TWO_SERVERS }, async () => {
      const created = await createApp({ slug, displayName: "Born" });
      expect(created.statusCode).toBe(201);
      const appId = created.json().id;
      // Both servers — the retiring one included — hold the open intent, still
      // pending; the app's generation is the initial one.
      expect(await intentsOf(appId)).toEqual([
        { server: "jobs", generation: 1, archived: false, deliveredAt: null },
        { server: "legacy", generation: 1, archived: false, deliveredAt: null },
      ]);
      expect((await rowOf(slug)).jobsGeneration).toBe(1);
    });
  });

  it("creates no delivery backlog while jobs is fully disabled", async () => {
    const slug = uniqueSlug();
    await withEnv({ PORTAL_JOBS_CATALOGUE: undefined }, async () => {
      const created = await createApp({ slug, displayName: "Born disabled" });
      expect(created.statusCode).toBe(201);
      expect(await intentsOf(created.json().id)).toEqual([]);
      expect((await rowOf(slug)).jobsGeneration).toBe(1);
    });
  });
});

describe("archive and unarchive generations", () => {
  it("archive closes a generation per target; a repeat is the idempotent no-op", async () => {
    const slug = uniqueSlug();
    await withEnv({ PORTAL_JOBS_CATALOGUE: TWO_SERVERS }, async () => {
      const created = await createApp({ slug, displayName: "Archivable" });
      const appId = created.json().id;

      const archived = await archive(slug);
      expect(archived.statusCode).toBe(200);
      // The response is the registry record and nothing else: it claims no
      // cancellation and carries no lifecycle/delivery state (criterion 50 —
      // archive acknowledgement does not imply execution has stopped).
      expect(JSON.stringify(archived.json())).not.toMatch(/jobs|cancel|generation/i);

      expect((await rowOf(slug)).jobsGeneration).toBe(2);
      expect(await intentsOf(appId)).toEqual([
        { server: "jobs", generation: 1, archived: false, deliveredAt: null },
        { server: "legacy", generation: 1, archived: false, deliveredAt: null },
        { server: "jobs", generation: 2, archived: true, deliveredAt: null },
        { server: "legacy", generation: 2, archived: true, deliveredAt: null },
      ]);

      // Idempotent: no second transition, no second set of intents, one audit.
      const again = await archive(slug);
      expect(again.statusCode).toBe(200);
      expect((await rowOf(slug)).jobsGeneration).toBe(2);
      expect(await intentsOf(appId)).toHaveLength(4);
      const events = await t.prisma.auditEvent.findMany({
        where: { appId, action: "app.archive" },
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.metadata).toEqual({
        jobsGeneration: 2,
        lifecycleTargets: ["jobs", "legacy"],
      });
    });
  });

  it("unarchive opens a new generation and never clears the closed one's intents", async () => {
    const slug = uniqueSlug();
    await withEnv({ PORTAL_JOBS_CATALOGUE: TWO_SERVERS }, async () => {
      const created = await createApp({ slug, displayName: "Briefly archived" });
      const appId = created.json().id;
      await archive(slug);
      const unarchived = await unarchive(slug);
      expect(unarchived.statusCode).toBe(200);

      expect((await rowOf(slug)).jobsGeneration).toBe(3);
      // The generation-2 archive intents REMAIN pending: the unarchive opened
      // generation 3, it did not supersede the cancellation intent for the
      // pre-archive work — that is what a brief archive may not lose.
      expect(await intentsOf(appId)).toEqual([
        { server: "jobs", generation: 1, archived: false, deliveredAt: null },
        { server: "legacy", generation: 1, archived: false, deliveredAt: null },
        { server: "jobs", generation: 2, archived: true, deliveredAt: null },
        { server: "legacy", generation: 2, archived: true, deliveredAt: null },
        { server: "jobs", generation: 3, archived: false, deliveredAt: null },
        { server: "legacy", generation: 3, archived: false, deliveredAt: null },
      ]);
    });
  });

  it("archive and unarchive still advance updatedAt — the registry record changed", async () => {
    const slug = uniqueSlug();
    await withEnv({ PORTAL_JOBS_CATALOGUE: TWO_SERVERS }, async () => {
      const created = await createApp({ slug, displayName: "Timestamped" });
      expect(created.statusCode).toBe(201);
      const before = (await rowOf(slug)).updatedAt;
      // Cross the TIMESTAMP(3) millisecond precision so a real bump is visible.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const archived = await archive(slug);
      expect(archived.statusCode).toBe(200);
      const after = (await rowOf(slug)).updatedAt;
      expect(after.getTime()).toBeGreaterThan(before.getTime());
      expect(archived.json().updatedAt).toBe(after.toISOString());
    });
  });

  it("an unarchive of a never-archived app is the no-op it always was", async () => {
    const slug = uniqueSlug();
    await withEnv({ PORTAL_JOBS_CATALOGUE: TWO_SERVERS }, async () => {
      const created = await createApp({ slug, displayName: "Never archived" });
      const appId = created.json().id;
      const res = await unarchive(slug);
      expect(res.statusCode).toBe(200);
      expect(res.json().archivedAt).toBeNull();
      expect((await rowOf(slug)).jobsGeneration).toBe(1);
      expect(await intentsOf(appId)).toHaveLength(2); // only the birth intents
      const events = await t.prisma.auditEvent.findMany({
        where: { appId, action: "app.unarchive" },
      });
      expect(events).toHaveLength(0);
    });
  });

  it("the generation authority keeps working while jobs is fully disabled — transitions bump it and audit with no targets", async () => {
    // The generation is the app model's own authority, not the deployment's:
    // a disabled posture removes the targets (no backlog), never the counting.
    // If the increment ever moved under the targets-existing branch, disabled
    // installs would stop advancing and the per-server enablement sync would
    // later collide with a generation the app believes was already used.
    const slug = uniqueSlug();
    await withEnv({ PORTAL_JOBS_CATALOGUE: undefined }, async () => {
      await createApp({ slug, displayName: "Disabled transitions" });
      expect((await archive(slug)).statusCode).toBe(200);
      expect((await unarchive(slug)).statusCode).toBe(200);

      const row = await rowOf(slug);
      expect(row.jobsGeneration).toBe(3);
      expect(await intentsOf(row.id)).toEqual([]);
      // The transitions were real: both audited, with the empty target list —
      // "informed nobody", not "recorded nothing".
      const events = await t.prisma.auditEvent.findMany({
        where: { appId: row.id, action: { in: ["app.archive", "app.unarchive"] } },
      });
      expect(events).toHaveLength(2);
      const byAction = new Map(events.map((e) => [e.action, e.metadata]));
      expect(byAction.get("app.archive")).toEqual({ jobsGeneration: 2, lifecycleTargets: [] });
      expect(byAction.get("app.unarchive")).toEqual({ jobsGeneration: 3, lifecycleTargets: [] });
    });
  });
});

describe("concurrent lifecycle transitions", () => {
  /**
   * A client whose first `apps` updateMany is parked until released — the
   * harness's gated-write pattern. The park sits BEFORE the statement runs, so
   * the parked transaction holds no row lock; the racing request commits
   * freely, and releasing the gate replays the exact interleaving where the
   * parked request's decision was made on a pre-image the commit invalidated.
   */
  function gatedAppWrite() {
    let reachedItsWrite!: () => void;
    const atTheWrite = new Promise<void>((resolve) => {
      reachedItsWrite = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parked = false;
    const prisma = createTestPrisma().$extends({
      query: {
        app: {
          async updateMany({ args, query }) {
            if (parked) return query(args);
            parked = true;
            reachedItsWrite();
            await gate;
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    return { prisma, atTheWrite, release };
  }

  it("records a generation exactly once when two archives race", async () => {
    const slug = uniqueSlug();
    await withEnv({ PORTAL_JOBS_CATALOGUE: TWO_SERVERS }, async () => {
      const created = await createApp({ slug, displayName: "Contended" });
      const appId = created.json().id;

      // A parks before its conditional write; B commits a full archive
      // underneath it. A's UPDATE then runs against B's committed state.
      const gated = gatedAppWrite();
      const slow = buildTestApp({ prisma: gated.prisma });
      await slow.app.ready();
      try {
        const losingArchive = (async () =>
          slow.app.inject({
            method: "POST",
            url: `/api/v1/apps/${slug}/archive`,
            headers: authHeader(),
          }))();
        await gated.atTheWrite; // A is parked at its conditional write
        const winner = await archive(slug);
        expect(winner.statusCode).toBe(200);
        gated.release();
        const loser = await losingArchive;
        expect(loser.statusCode).toBe(200);

        // Exactly one transition: one generation bump, one intent set, one
        // audit event. The guard lived in the WRITE — A's pre-image read a
        // live app, and the store, not the check, refused the repeat.
        expect((await rowOf(slug)).jobsGeneration).toBe(2);
        expect(await intentsOf(appId)).toEqual([
          { server: "jobs", generation: 1, archived: false, deliveredAt: null },
          { server: "legacy", generation: 1, archived: false, deliveredAt: null },
          { server: "jobs", generation: 2, archived: true, deliveredAt: null },
          { server: "legacy", generation: 2, archived: true, deliveredAt: null },
        ]);
        const events = await t.prisma.auditEvent.findMany({
          where: { appId, action: "app.archive" },
        });
        expect(events).toHaveLength(1);
      } finally {
        await slow.close();
      }
    });
  });

  it("an unarchive parked behind a committed archive still records both generations", async () => {
    const slug = uniqueSlug();
    await withEnv({ PORTAL_JOBS_CATALOGUE: TWO_SERVERS }, async () => {
      const created = await createApp({ slug, displayName: "Brief archive race" });
      const appId = created.json().id;

      // The unarchive parks before its conditional write (its decision read
      // the archived pre-image); the archive then commits underneath it.
      // Releasing the gate must not lose the archive: the parked write
      // re-evaluates its WHERE and increments from the committed generation.
      const gated = gatedAppWrite();
      const slow = buildTestApp({ prisma: gated.prisma });
      await slow.app.ready();
      try {
        const parkedUnarchive = (async () =>
          slow.app.inject({
            method: "POST",
            url: `/api/v1/apps/${slug}/unarchive`,
            headers: authHeader(),
          }))();
        await gated.atTheWrite; // the unarchive is parked at its conditional write
        const archiveRes = await archive(slug);
        expect(archiveRes.statusCode).toBe(200);
        gated.release();
        const unarchiveRes = await parkedUnarchive;
        expect(unarchiveRes.statusCode).toBe(200);

        expect((await rowOf(slug)).jobsGeneration).toBe(3);
        // Both intents survive: the archive's cancellation rows AND the
        // unarchive's open rows, each pending per target.
        expect(await intentsOf(appId)).toEqual([
          { server: "jobs", generation: 1, archived: false, deliveredAt: null },
          { server: "legacy", generation: 1, archived: false, deliveredAt: null },
          { server: "jobs", generation: 2, archived: true, deliveredAt: null },
          { server: "legacy", generation: 2, archived: true, deliveredAt: null },
          { server: "jobs", generation: 3, archived: false, deliveredAt: null },
          { server: "legacy", generation: 3, archived: false, deliveredAt: null },
        ]);
      } finally {
        await slow.close();
      }
    });
  });
});

describe("promotion and rollback neutrality", () => {
  it("moving the live pointer changes neither the generation nor the outbox", async () => {
    const slug = uniqueSlug();
    await withEnv({ PORTAL_JOBS_CATALOGUE: TWO_SERVERS }, async () => {
      const created = await createApp({ slug, displayName: "Deployed" });
      const appId = created.json().id;
      const before = await intentsOf(appId);

      const version1 = await t.prisma.version.create({
        data: { appId, number: 1, blobPrefix: `apps/${appId}/1/` },
      });
      await t.prisma.version.create({
        data: { appId, number: 2, blobPrefix: `apps/${appId}/2/` },
      });
      const promoted = await t.app.inject({
        method: "POST",
        url: `/api/v1/apps/${slug}/versions/1/promote`,
        headers: authHeader(),
      });
      expect(promoted.statusCode).toBe(200);
      // Promote the second version (archiving the first) so the rollback has a
      // previous live version to return to.
      const promoted2 = await t.app.inject({
        method: "POST",
        url: `/api/v1/apps/${slug}/versions/2/promote`,
        headers: authHeader(),
      });
      expect(promoted2.statusCode).toBe(200);
      const rolledBack = await t.app.inject({
        method: "POST",
        url: `/api/v1/apps/${slug}/rollback`,
        headers: authHeader(),
        payload: {},
      });
      expect(rolledBack.statusCode).toBe(200);
      expect(rolledBack.json().currentVersionId).toBe(version1.id);

      expect((await rowOf(slug)).jobsGeneration).toBe(1);
      expect(await intentsOf(appId)).toEqual(before);
    });
  });
});

describe("failure atomicity", () => {
  it("an outbox failure rolls the archive back — state, generation, audit, all of it", async () => {
    const slug = uniqueSlug();
    // Born on the disabled posture (no intents), archived against a configured
    // one whose intent write always fails.
    await createApp({ slug, displayName: "Atomic" });
    const failing = createTestPrisma().$extends({
      query: {
        jobsLifecycleOutbox: {
          createMany() {
            throw new Error("outbox unavailable");
          },
        },
      },
    }) as unknown as PrismaClient;
    const bad = buildTestApp({ prisma: failing });
    await bad.app.ready();
    try {
      await withEnv({ PORTAL_JOBS_CATALOGUE: TWO_SERVERS }, async () => {
        const res = await bad.app.inject({
          method: "POST",
          url: `/api/v1/apps/${slug}/archive`,
          headers: authHeader(),
        });
        expect(res.statusCode).toBe(500);
      });
      const row = await rowOf(slug);
      expect(row.archivedAt).toBeNull();
      expect(row.jobsGeneration).toBe(1);
      expect(await t.prisma.jobsLifecycleOutbox.findMany({ where: { appId: row.id } })).toEqual([]);
      const events = await t.prisma.auditEvent.findMany({
        where: { appId: row.id, action: "app.archive" },
      });
      expect(events).toEqual([]);
    } finally {
      await bad.close();
    }
  });

  it("an outbox failure at creation leaves no app row behind", async () => {
    const slug = uniqueSlug();
    const failing = createTestPrisma().$extends({
      query: {
        jobsLifecycleOutbox: {
          createMany() {
            throw new Error("outbox unavailable");
          },
        },
      },
    }) as unknown as PrismaClient;
    const bad = buildTestApp({ prisma: failing });
    await bad.app.ready();
    try {
      await withEnv({ PORTAL_JOBS_CATALOGUE: TWO_SERVERS }, async () => {
        const res = await bad.app.inject({
          method: "POST",
          url: "/api/v1/apps",
          headers: authHeader(),
          payload: { slug, displayName: "Never born" },
        });
        expect(res.statusCode).toBe(500);
      });
      const got = await t.app.inject({
        method: "GET",
        url: `/api/v1/apps/${slug}`,
        headers: authHeader(),
      });
      expect(got.statusCode).toBe(404);
    } finally {
      await bad.close();
    }
  });

  it("a misconfigured catalogue source at archive time commits nothing (500, not a partial write)", async () => {
    const slug = uniqueSlug();
    await createApp({ slug, displayName: "Misconfigured" });
    await withEnv({ PORTAL_JOBS_CATALOGUE: "not json" }, async () => {
      const res = await archive(slug);
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe("internal");
    });
    const row = await rowOf(slug);
    expect(row.archivedAt).toBeNull();
    expect(row.jobsGeneration).toBe(1);
  });
});

describe("the outbox schema's own guarantees", () => {
  /**
   * The two decisions the migration makes deliberately (design §5), asserted
   * against the real engine because they are the schema's, not the code's:
   * the intents outlive the app row (no FK — a future hard-delete flow must
   * be able to deliver the cancellation tombstone after the app row is gone),
   * and the `(appId, generation, server)` composite key is the one-intent-per-
   * target backstop no code path can violate by retrying a write.
   */
  it("deleting the app row leaves its intents in place — the schema cannot cascade a tombstone away", async () => {
    const app = await t.prisma.app.create({
      data: { slug: uniqueSlug(), displayName: "Doomed", visibilityMode: "internal" },
    });
    await t.prisma.jobsLifecycleOutbox.create({
      data: { appId: app.id, generation: 1, server: "jobs", archived: false },
    });

    await t.prisma.app.delete({ where: { id: app.id } });

    const left = await t.prisma.jobsLifecycleOutbox.findMany({ where: { appId: app.id } });
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ generation: 1, server: "jobs", archived: false });
    await t.prisma.jobsLifecycleOutbox.deleteMany({ where: { appId: app.id } });
  });

  it("one intent per (app, generation, server) — the composite key refuses a duplicate", async () => {
    const app = await t.prisma.app.create({
      data: { slug: uniqueSlug(), displayName: "Keyed", visibilityMode: "internal" },
    });
    const intent = { appId: app.id, generation: 1, server: "jobs", archived: false };
    await t.prisma.jobsLifecycleOutbox.create({ data: intent });
    const attempted = await t.prisma.jobsLifecycleOutbox.create({ data: intent }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(attempted, "a duplicate (appId, generation, server) intent was accepted").not.toBeNull();
    expect(isUniqueViolation(attempted)).toBe(true);
    await t.prisma.jobsLifecycleOutbox.deleteMany({ where: { appId: app.id } });
    await t.prisma.app.delete({ where: { id: app.id } });
  });
});

describe("telemetry (AGENTS.md §Telemetry ships with the change)", () => {
  it("emits one outbox span per transition with the bounded lifecycle attributes", async () => {
    const recording: RecordingTelemetry = startRecordingTelemetry();
    try {
      const slug = uniqueSlug();
      await withEnv({ PORTAL_JOBS_CATALOGUE: TWO_SERVERS }, async () => {
        const created = await createApp({ slug, displayName: "Spanned" });
        await archive(slug);
        const appId: string = created.json().id;

        const spans = recording.spans().filter((s) => s.name === SPAN_JOBS_LIFECYCLE_OUTBOX);
        expect(spans).toHaveLength(2); // the birth intent + the archive intent
        const archiveSpan = spans.find((s) => s.attributes[ATTR_JOBS_GENERATION] === 2);
        expect(archiveSpan).toBeDefined();
        expect(archiveSpan?.attributes[ATTR_APP_ID]).toBe(appId);
        expect(archiveSpan?.attributes[ATTR_JOBS_ARCHIVED]).toBe(true);
        expect(archiveSpan?.attributes[ATTR_JOBS_LIFECYCLE_TARGETS]).toBe(2);
      });
    } finally {
      await recording.restore();
    }
  });

  it("no span is emitted for a transition with nothing to inform", async () => {
    const recording: RecordingTelemetry = startRecordingTelemetry();
    try {
      const slug = uniqueSlug();
      await withEnv({ PORTAL_JOBS_CATALOGUE: undefined }, async () => {
        await createApp({ slug, displayName: "Quiet" });
        await archive(slug);
        expect(recording.spans().map((s) => s.name)).not.toContain(SPAN_JOBS_LIFECYCLE_OUTBOX);
      });
    } finally {
      await recording.restore();
    }
  });
});
