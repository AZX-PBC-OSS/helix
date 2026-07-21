import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL } from "../test/seed.js";
import { PgCounterStore } from "./counterStore.js";

/**
 * The Postgres counter under the real `helix_edge` role — the shared-fleet
 * backing for the anon rate limiter + login throttle (issue #13). Asserts the
 * atomic window upsert and, critically, that concurrent bumps don't lose updates
 * (the property that closes the login-throttle check-then-increment TOCTOU).
 * Skips when the role isn't provisioned (CI without db-init).
 */
function edgeUrl(): string {
  const u = new URL(TEST_DATABASE_URL);
  u.username = "helix_edge";
  u.password = "helix_edge";
  return u.toString();
}

async function available(): Promise<boolean> {
  const pool = new Pool({ connectionString: edgeUrl(), max: 1 });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

let ok = false;
let store: PgCounterStore;
const keys: string[] = [];
function key(): string {
  const k = `test:${randomUUID()}`;
  keys.push(k);
  return k;
}

beforeAll(async () => {
  ok = await available();
  if (ok) store = new PgCounterStore(edgeUrl());
});

afterAll(async () => {
  if (keys.length) {
    const owner = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    await owner.query(`DELETE FROM rate_counters WHERE "bucketKey" = ANY($1)`, [keys]);
    await owner.end();
  }
  await store?.close();
});

describe("PgCounterStore (helix_edge)", () => {
  it("increments within a window and resets on reset()", async () => {
    if (!ok) return;
    const k = key();
    expect(await store.bump(k, 60_000)).toBe(1);
    expect(await store.bump(k, 60_000)).toBe(2);
    await store.reset(k);
    expect(await store.bump(k, 60_000)).toBe(1); // window restarted
  });

  it("restarts the window once resetAt has passed", async () => {
    if (!ok) return;
    const k = key();
    // A 0ms window is already elapsed by the next statement, so each bump restarts.
    expect(await store.bump(k, 0)).toBe(1);
    expect(await store.bump(k, 0)).toBe(1);
  });

  it("sweep() drops expired rows", async () => {
    if (!ok) return;
    const k = key();
    await store.bump(k, 60_000); // live row
    // Force it expired via the owner, then sweep as helix_edge.
    const owner = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    await owner.query(
      `UPDATE rate_counters SET "resetAt" = now() - interval '1 minute' WHERE "bucketKey" = $1`,
      [k],
    );
    await owner.end();
    await store.sweep();
    // Row gone ⇒ next bump starts a fresh window at 1.
    expect(await store.bump(k, 60_000)).toBe(1);
  });

  it("is atomic under concurrency — N parallel bumps yield the counts 1..N with no lost updates", async () => {
    if (!ok) return;
    const k = key();
    const N = 20;
    // Fire N bumps concurrently. If the increment weren't atomic (read-modify-
    // write), two would read the same value and a count would repeat / be lost.
    const counts = await Promise.all(Array.from({ length: N }, () => store.bump(k, 60_000)));
    expect(new Set(counts).size).toBe(N); // all distinct
    expect(Math.max(...counts)).toBe(N); // reached exactly N
  });
});
