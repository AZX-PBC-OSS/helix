import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { LiveRegistry } from "./listener.js";
import { TEST_DATABASE_URL, deleteApp, seedApp, uniqueSlug, type SeededApp } from "../test/seed.js";

// Against the real test database (migrated by vitest.globalSetup.ts, so the
// portal's NOTIFY trigger is present): proves SQL → projection and the full
// trigger → NOTIFY → LISTEN → reload loop.

const QUIET = { info() {}, warn() {}, error() {} };

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
      visibilityMode: "internal",
      visibilityGroupIds: [],
      passwordHash: null,
      passwordSalt: null,
      llm: null,
      data: null,
      externalOrigins: [],
      fetch: { connections: new Map(), requestsPerDay: null, shim: false },
      offline: null,
      shim: null,
      jobs: null,
      jobsGeneration: "1",
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

  // The fetch grant's binding map carries the manifest's provider
  // bindings (manifest data only — no provider rows cross to the edge), and the
  // existing registry NOTIFY loop refreshes the widened shape without restart.
  it("projects provider-bound fetch origins and refreshes the widened grant on NOTIFY", async () => {
    const app = await seed({
      live: true,
      capabilities: {
        fetch: {
          origins: [
            { origin: "https://api.asana.com", provider: "asana", required: true },
            { origin: "https://api.github.com" },
            { origin: "https://api.stripe.com", connection: "stripe" },
          ],
        },
      },
    });

    // Own LiveRegistry: the shared instance's lifecycle belongs to the test
    // above.
    const live = new LiveRegistry({
      databaseUrl: TEST_DATABASE_URL,
      reconcileIntervalMs: 60_000,
      log: QUIET,
    });
    try {
      await live.start();
      expect(live.getApp(app.slug)?.fetch.connections).toEqual(
        new Map([
          ["https://api.asana.com", { kind: "provider", provider: "asana", required: true }],
          ["https://api.github.com", { kind: "keyless" }],
          ["https://api.stripe.com", { kind: "secret", connection: "stripe" }],
        ]),
      );

      // An updated manifest — the provider binding replaced by a secret
      // binding — must arrive through the same trigger → NOTIFY → reload loop,
      // no restart.
      await pool.query(`UPDATE apps SET capabilities = $1::jsonb WHERE id = $2`, [
        JSON.stringify({
          fetch: { origins: [{ origin: "https://api.asana.com", connection: "asana-prod" }] },
        }),
        app.appId,
      ]);
      await eventually(
        () =>
          live.getApp(app.slug)?.fetch.connections.get("https://api.asana.com")?.kind === "secret",
      );
      expect(live.getApp(app.slug)?.fetch.connections.get("https://api.asana.com")).toEqual({
        kind: "secret",
        connection: "asana-prod",
      });
    } finally {
      await live.stop();
    }
  });

  // The jobs seam (background-jobs-plane design §5): the effective jobs grant
  // and the portal-owned lifecycle generation ride the SAME projection and the
  // SAME trigger → NOTIFY → reload loop — a grant change or an archive
  // transition must be visible to the jobs policy consumers on the next
  // refresh, without restart. The generation is asserted in its shared wire
  // form (the canonical decimal string the signed claims and lifecycle
  // deliveries compare), and the seeder's raw UPDATE mirrors what the portal's
  // transition writes.
  it("projects the jobs grant and lifecycle generation, and refreshes both on NOTIFY", async () => {
    const app = await seed({ live: true, capabilities: { jobs: { types: ["jobs:fetch"] } } });

    const live = new LiveRegistry({
      databaseUrl: TEST_DATABASE_URL,
      reconcileIntervalMs: 60_000,
      log: QUIET,
    });
    try {
      await live.start();
      expect(live.getApp(app.slug)?.jobs).toEqual({ types: ["jobs:fetch"] });
      expect(live.getApp(app.slug)?.jobsGeneration).toBe("1");

      // A grant revocation (the block removed) closes access on the next
      // refresh — revocation must not wait for a restart.
      await pool.query(`UPDATE apps SET capabilities = '{}'::jsonb WHERE id = $1`, [app.appId]);
      await eventually(() => live.getApp(app.slug)?.jobs === null);

      // An archive transition bumps the generation in the same transaction
      // (the portal's lifecycle route); the projection carries it forward.
      await pool.query(
        `UPDATE apps SET "archivedAt" = now(), "jobsGeneration" = "jobsGeneration" + 1
         WHERE id = $1`,
        [app.appId],
      );
      await eventually(() => live.getApp(app.slug)?.jobsGeneration === "2");
      expect(live.getApp(app.slug)?.archived).toBe(true);
    } finally {
      await live.stop();
    }
  });

  // The app-id lookup the signed jobs callback dispatches with: the claims
  // carry the app's id, never a host or slug, so the live projection must
  // resolve the CURRENT entry by id — through the same trigger → NOTIFY →
  // reload loop every other projection change rides, with no restart.
  it("resolves the current entry by app id, and keeps it current through renames and deletes", async () => {
    const app = await seed({ live: true });
    const live = new LiveRegistry({
      databaseUrl: TEST_DATABASE_URL,
      reconcileIntervalMs: 60_000,
      log: QUIET,
    });
    try {
      await live.start();
      // The id and the slug resolve the same served entry.
      expect(live.getAppById(app.appId)).toEqual(live.getApp(app.slug));

      // A slug rename must not orphan the id: the callback resolves by the
      // signed app id, so the current entry follows it.
      const renamed = uniqueSlug("renamed");
      await pool.query(`UPDATE apps SET slug = $1 WHERE id = $2`, [renamed, app.appId]);
      await eventually(() => live.getAppById(app.appId)?.slug === renamed);
      expect(live.getApp(app.slug)).toBeUndefined();

      // And a delete stops the id resolving at all — the callback refuses an
      // unknown app on its next refresh, without a restart.
      await deleteApp(pool, app.appId);
      seeded.splice(seeded.indexOf(app), 1);
      await eventually(() => live.getAppById(app.appId) === undefined);
    } finally {
      await live.stop();
    }
  });

  // A hostile jobs block the portal can never write: the manifest parse refuses
  // an own `__proto__` key (JobsCapabilitySchema is built on strictWireObject
  // for exactly that), so a stored one is reachable only through a direct
  // UPDATE or schema drift — the rows the fail-closed posture exists for. pg
  // delivers jsonb through JSON.parse, which materializes `__proto__` as an
  // own property, so the edge's re-parse really sees the key: the block must be
  // REFUSED (jobs → null, deny) rather than stripped and served, and the
  // whole-blob read (externalOrigins, through CapabilitiesSchema's strict jobs
  // member) must degrade closed with it. The load itself and the row's other
  // fields survive — one drifted row degrades its own grants, nothing else.
  it("refuses a stored jobs block carrying an own __proto__ key, fail-closed", async () => {
    const app = await seed({ live: true });
    await pool.query(
      `UPDATE apps SET capabilities =
         '{"jobs": {"types": ["jobs:fetch"], "__proto__": {"polluted": true}}}'::jsonb
       WHERE id = $1`,
      [app.appId],
    );

    const live = new LiveRegistry({
      databaseUrl: TEST_DATABASE_URL,
      reconcileIntervalMs: 60_000,
      log: QUIET,
    });
    try {
      await live.start();
      expect(live.freshness().consecutiveLoadFailures).toBe(0);
      const entry = live.getApp(app.slug);
      expect(entry?.jobs).toBeNull();
      expect(entry?.externalOrigins).toEqual([]);
      // The hostile capabilities blob degrades only this app's capability
      // grants — the row's other fields still project.
      expect(entry?.jobsGeneration).toBe("1");
      expect(entry?.blobPrefix).toBe(app.blobPrefix);
    } finally {
      await live.stop();
    }
  });
});
