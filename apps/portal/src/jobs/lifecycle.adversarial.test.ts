import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../db/client.js";
import {
  authHeader,
  buildTestApp,
  createTestPrisma,
  uniqueSlug,
  type TestApp,
} from "../test/harness.js";
import { withEnv } from "../test/env.js";

/**
 * Adversarial pass over the lifecycle seam's transaction boundary and no-op
 * path (`lifecycle.ts`), attacking the two failure interleavings and one
 * ordering assumption the main suite does not:
 *
 * 1. The boundary's LAST statement (the audit write) failing — the main
 *    suite fails only the outbox statement, so "the already-written intents
 *    roll back" is never observed there. If the audit write were ever moved
 *    outside the transaction (the shape creation had before the lifecycle
 *    work), these tests go red: the state change would commit and answer 500.
 * 2. The count-0 idempotent no-op reading no per-call configuration — a
 *    repeat is answered from committed state alone, so hoisting the targets
 *    read above the guard (a plausible refactor) must turn this red.
 */

let t: TestApp;

beforeAll(async () => {
  t = buildTestApp();
  await t.app.ready();
});

afterAll(async () => {
  await t.close();
});

/** One serving server plus one retiring entry — two targets per transition. */
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

const archiveOn = (app: TestApp, slug: string) =>
  app.app.inject({
    method: "POST",
    url: `/api/v1/apps/${slug}/archive`,
    headers: authHeader(),
  });

async function rowOf(slug: string) {
  return t.prisma.app.findUniqueOrThrow({ where: { slug } });
}

/** The app's outbox rows, projected to the fields the transition controls. */
async function intentsOf(appId: string) {
  const rows = await t.prisma.jobsLifecycleOutbox.findMany({
    where: { appId },
    orderBy: [{ generation: "asc" }, { server: "asc" }],
  });
  return rows.map((r) => ({ server: r.server, generation: r.generation, archived: r.archived }));
}

/**
 * A client whose `auditEvent.create` always throws, capturing the appId of
 * the write it refused — the failed birth's outbox rows are scoping-keyed by
 * it, since the app row that would name them never commits.
 */
function failingAuditWrites() {
  const refused: string[] = [];
  const prisma = createTestPrisma().$extends({
    query: {
      auditEvent: {
        create({ args }) {
          const data = (args as { data?: { appId?: string } }).data;
          if (data?.appId) refused.push(data.appId);
          throw new Error("audit unavailable");
        },
      },
    },
  }) as unknown as PrismaClient;
  return { prisma, refused };
}

describe("the audit write failing inside the lifecycle boundary", () => {
  it("rolls the already-written archive intents back with state and generation", async () => {
    const slug = uniqueSlug();
    await withEnv({ PORTAL_JOBS_CATALOGUE: TWO_SERVERS }, async () => {
      const created = await createApp({ slug, displayName: "Audited" });
      const appId: string = created.json().id;
      const birthIntents = await intentsOf(appId);
      expect(birthIntents).toHaveLength(2);

      const { prisma, refused } = failingAuditWrites();
      const bad = buildTestApp({ prisma });
      await bad.app.ready();
      try {
        const res = await archiveOn(bad, slug);
        expect(res.statusCode).toBe(500);
      } finally {
        await bad.close();
      }
      expect(refused).toEqual([appId]);

      // The transition never happened: state and generation unchanged, and the
      // archive intents written moments before the audit threw are GONE — a
      // backlog for a transition that never committed must not survive.
      const row = await rowOf(slug);
      expect(row.archivedAt).toBeNull();
      expect(row.jobsGeneration).toBe(1);
      expect(await intentsOf(appId)).toEqual(birthIntents);
      const events = await t.prisma.auditEvent.findMany({
        where: { appId, action: "app.archive" },
      });
      expect(events).toEqual([]);
    });
  });

  it("at creation leaves neither an app row nor orphaned intents behind", async () => {
    const slug = uniqueSlug();
    // The intents are written BEFORE the audit throws, and the outbox has no
    // FK to apps — a rollback that missed them would leave rows nothing can
    // ever name or deliver. The refused appId is the only handle on them.
    const { prisma, refused } = failingAuditWrites();
    const bad = buildTestApp({ prisma });
    await bad.app.ready();
    try {
      await withEnv({ PORTAL_JOBS_CATALOGUE: TWO_SERVERS }, async () => {
        const res = await bad.app.inject({
          method: "POST",
          url: "/api/v1/apps",
          headers: authHeader(),
          payload: { slug, displayName: "Unborn" },
        });
        expect(res.statusCode).toBe(500);
      });
      expect(refused).toHaveLength(1);
      const appId = refused[0];
      expect(appId).toBeTruthy();
      expect(await t.prisma.app.findUnique({ where: { slug } })).toBeNull();
      expect(await t.prisma.jobsLifecycleOutbox.findMany({ where: { appId } })).toEqual([]);
    } finally {
      await bad.close();
    }
  });
});

describe("the idempotent no-op path", () => {
  it("answers a repeat from committed state alone — a broken targets source stays unread", async () => {
    const slug = uniqueSlug();
    await withEnv({ PORTAL_JOBS_CATALOGUE: TWO_SERVERS }, async () => {
      await createApp({ slug, displayName: "Already archived" });
      const first = await archive(slug);
      expect(first.statusCode).toBe(200);

      // The repeat must not depend on configuration the (already committed)
      // transition needed: the count-0 short-circuit precedes the targets read.
      await withEnv({ PORTAL_JOBS_CATALOGUE: "not json" }, async () => {
        const repeat = await archive(slug);
        expect(repeat.statusCode).toBe(200);
        expect(repeat.json().archivedAt).toBe(first.json().archivedAt);
      });

      const row = await rowOf(slug);
      expect(row.jobsGeneration).toBe(2);
      expect(await intentsOf(row.id)).toEqual([
        { server: "jobs", generation: 1, archived: false },
        { server: "legacy", generation: 1, archived: false },
        { server: "jobs", generation: 2, archived: true },
        { server: "legacy", generation: 2, archived: true },
      ]);
    });
  });
});
