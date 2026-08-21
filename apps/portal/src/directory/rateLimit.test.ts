import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestPrisma } from "../test/harness.js";
import type { PrismaClient } from "../db/client.js";
import { bumpSearchLimit, sweepSearchLimits } from "./rateLimit.js";

/**
 * Real Postgres, because the property under test is the atomicity of the upsert —
 * an in-memory double would assert the shape of the code rather than the
 * behaviour of the statement, which is the only part that can be wrong.
 */
describe("directory search rate limit", () => {
  let prisma: PrismaClient;
  const actor = () => `rl-${randomUUID()}`;

  beforeAll(() => {
    prisma = createTestPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("counts up and refuses past the limit", async () => {
    const sub = actor();
    for (let i = 1; i <= 3; i += 1) {
      await expect(bumpSearchLimit(prisma, sub, 3)).resolves.toEqual({ allowed: true, count: i });
    }
    await expect(bumpSearchLimit(prisma, sub, 3)).resolves.toEqual({ allowed: false, count: 4 });
  });

  it("counts per actor, so one principal cannot exhaust another's budget", async () => {
    const a = actor();
    const b = actor();
    await bumpSearchLimit(prisma, a, 1);
    await bumpSearchLimit(prisma, a, 1);
    await expect(bumpSearchLimit(prisma, b, 1)).resolves.toEqual({ allowed: true, count: 1 });
  });

  it("restarts the window once it has elapsed", async () => {
    const sub = actor();
    // A zero-length window is already elapsed by the next statement.
    await expect(bumpSearchLimit(prisma, sub, 1, 0)).resolves.toMatchObject({ count: 1 });
    await expect(bumpSearchLimit(prisma, sub, 1, 0)).resolves.toMatchObject({
      allowed: true,
      count: 1,
    });
  });

  /**
   * The reason this is one statement rather than read-then-write: concurrent
   * requests must not both read the same count and both decide they're under the
   * limit. Ten parallel bumps against a limit of 5 must yield exactly 5 allowed —
   * a check-then-increment race would let more through, and that is precisely the
   * TOCTOU the edge's login throttle had before issue #13.
   */
  it("is atomic under concurrency — no check-then-increment race", async () => {
    const sub = actor();
    const verdicts = await Promise.all(
      Array.from({ length: 10 }, () => bumpSearchLimit(prisma, sub, 5)),
    );
    expect(verdicts.filter((v) => v.allowed)).toHaveLength(5);
    expect(verdicts.map((v) => v.count).sort((x, y) => x - y)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it("sweeps elapsed windows, and only its own keys", async () => {
    const sub = actor();
    await bumpSearchLimit(prisma, sub, 1, 0); // already elapsed
    const foreign = `otherpurpose:${randomUUID()}`;
    await prisma.portalRateCounter.create({
      data: { bucketKey: foreign, count: 1, resetAt: new Date(0) },
    });

    await sweepSearchLimits(prisma);

    expect(
      await prisma.portalRateCounter.findUnique({ where: { bucketKey: `dirsearch:${sub}` } }),
    ).toBeNull();
    // A future counter with a different purpose keeps its rows — the sweep is
    // prefix-scoped so it cannot silently reset something it does not own.
    expect(
      await prisma.portalRateCounter.findUnique({ where: { bucketKey: foreign } }),
    ).not.toBeNull();
    await prisma.portalRateCounter.delete({ where: { bucketKey: foreign } });
  });
});
