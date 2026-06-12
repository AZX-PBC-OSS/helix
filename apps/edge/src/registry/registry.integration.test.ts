import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { LiveRegistry } from "./listener.js";
import { TEST_DATABASE_URL, deleteApp, seedApp, type SeededApp } from "../test/seed.js";

// Against the real test database (migrated by vitest.globalSetup.ts, so the
// portal's NOTIFY trigger is present): proves SQL → projection and the full
// trigger → NOTIFY → LISTEN → reload loop.

const QUIET = { info() {}, warn() {} };

let pool: pg.Pool;
let registry: LiveRegistry;
const seeded: SeededApp[] = [];

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  registry = new LiveRegistry({
    databaseUrl: TEST_DATABASE_URL,
    reconcileIntervalMs: 60_000,
    log: QUIET,
  });
});

afterEach(async () => {
  while (seeded.length) await deleteApp(pool, seeded.pop()!.appId);
});

afterAll(async () => {
  await registry.stop();
  await pool.end();
});

async function seed(opts: Parameters<typeof seedApp>[1]) {
  const app = await seedApp(pool, opts);
  seeded.push(app);
  return app;
}

/** Poll until `check` passes — NOTIFY delivery is fast but asynchronous. */
async function eventually(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("LiveRegistry against the test database", () => {
  it("loads seeded apps on start and refreshes via the NOTIFY trigger", async () => {
    const live = await seed({ live: true });
    const preview = await seed({ live: false });

    await registry.start();
    expect(registry.isLoaded()).toBe(true);

    const entry = registry.getApp(live.slug);
    expect(entry).toEqual({
      appId: live.appId,
      slug: live.slug,
      archived: false,
      blobPrefix: live.blobPrefix,
      visibilityMode: "private",
      visibilityGroupId: null,
    });
    // Preview-only app: known, but nothing live to serve.
    expect(registry.getApp(preview.slug)?.blobPrefix).toBeNull();

    // A write through a *different* connection must reach the projection via
    // trigger → NOTIFY → LISTEN → reload, with no manual load() call.
    await pool.query(`UPDATE apps SET "archivedAt" = now() WHERE id = $1`, [live.appId]);
    await eventually(() => registry.getApp(live.slug)?.archived === true);

    // Pointer flips (promote) also arrive: point the preview app live.
    await pool.query(`UPDATE apps SET "currentVersionId" = $1 WHERE id = $2`, [
      preview.versionId,
      preview.appId,
    ]);
    await eventually(() => registry.getApp(preview.slug)?.blobPrefix === preview.blobPrefix);

    // New apps appear...
    const late = await seed({ live: true });
    await eventually(() => registry.getApp(late.slug) !== undefined);

    // ...and deleted apps disappear.
    await deleteApp(pool, late.appId);
    seeded.splice(seeded.indexOf(late), 1);
    await eventually(() => registry.getApp(late.slug) === undefined);
  });
});
