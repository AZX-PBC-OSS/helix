import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterEach, describe, expect, test, vi } from "vitest";

import { newTestBoss } from "./boss.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

function urlFor(database: string): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("newTestBoss", () => {
  test("drops the forced-drop termination and rethrows every other instance error", () => {
    const deferred: Array<() => void> = [];
    vi.spyOn(globalThis, "queueMicrotask").mockImplementation((fn) => {
      deferred.push(fn);
    });
    const boss = newTestBoss({ connectionString: urlFor("never_started") });

    boss.emit("error", Object.assign(new Error("terminating connection"), { code: "57P01" }));
    expect(deferred).toHaveLength(0);

    const other = Object.assign(new Error("something else"), { code: "53300" });
    boss.emit("error", other);
    expect(deferred).toHaveLength(1);
    expect(() => deferred[0]?.()).toThrow(other);
  });

  test(
    "a database force-dropped under a live instance does not fail the run",
    { timeout: 30_000 },
    async () => {
      const database = `helix_jobs_boss_${randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString: urlFor("postgres"), max: 1 });
      await admin.query(`CREATE DATABASE "${database}"`);
      const boss = newTestBoss({ connectionString: urlFor(database), schedule: false });
      const seen: unknown[] = [];
      boss.on("error", (error) => seen.push((error as { code?: unknown }).code));
      try {
        await boss.start();
        await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
        // The termination reaches the instance's pooled clients asynchronously.
        const by = Date.now() + 10_000;
        while (!seen.includes("57P01") && Date.now() < by) {
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(seen, "the forced drop terminated a live pg-boss connection").toContain("57P01");
      } finally {
        await boss.stop({ graceful: false, timeout: 1_000 }).catch(() => {});
        await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
        await admin.end();
      }
    },
  );
});
