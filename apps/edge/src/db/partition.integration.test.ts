import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import type { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { createEdgePool, withPooledClient, type PoolClientErrorPhase } from "./pool.js";
import { withPartition } from "./partition.js";
import { TEST_DATABASE_URL } from "../test/seed.js";

/**
 * Against the real test database: proves a **mid-transaction socket death**
 * doesn't kill the process (ADR-0025 review finding 1).
 *
 * Why this needs a real DB and a real socket. `pg-pool` strips a checked-out
 * client's `'error'` listener, and `pg.Client#_handleErrorEvent` emits `'error'`
 * **synchronously** while deferring the in-flight query's rejection to
 * `process.nextTick`. So the throw escapes from the socket read callback, where
 * no `try`/`catch` of ours is on the stack. **Before the fix this test does not
 * merely fail its assertions — it takes down the vitest worker with an
 * unhandled error.** That is the point; don't "fix" it by softening it.
 *
 * `stream.destroy(err)` is the deterministic repro. `pg_terminate_backend` is
 * NOT: that sends an ErrorResponse, which rejects the active query through the
 * normal path and never reaches `_handleErrorEvent`.
 */

const pools: Pool[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end().catch(() => {})));
});

/** Reach the underlying socket — not in pg's public typings. */
function socketOf(client: unknown): Socket {
  return (client as { connection: { stream: Socket } }).connection.stream;
}

describe("withPartition against a dying connection", () => {
  it("survives a socket death mid-transaction and reports it", async () => {
    const seen: PoolClientErrorPhase[] = [];
    const pool = createEdgePool(TEST_DATABASE_URL, {
      max: 1,
      label: "partition-test",
      onClientError: (_err, ctx) => seen.push(ctx.phase),
    });
    pools.push(pool);

    await expect(
      withPartition(pool, randomUUID(), null, "prod", async (client) => {
        // In flight, so the client is checked out and mid-statement.
        const pending = client.query("SELECT pg_sleep(5)");
        socketOf(client).destroy(new Error("socket died mid-transaction"));
        await pending;
      }),
    ).rejects.toThrow();

    // The caller saw a rejection AND the drop was reported — not swallowed.
    expect(seen).toEqual(["checked-out"]);
    // The dead client was destroyed rather than parked in the idle set for the
    // next request to inherit (that's `client.release(err)` doing its job).
    expect(pool.totalCount).toBe(0);
    expect(pool.idleCount).toBe(0);
    // And the pool still works: a fresh connection is established on demand.
    const after = await pool.query<{ ok: number }>("SELECT 1 AS ok");
    expect(after.rows[0]?.ok).toBe(1);
  });

  it("leaves no listener behind on a client that survives its checkout", async () => {
    const pool = createEdgePool(TEST_DATABASE_URL, { max: 1, label: "partition-test" });
    pools.push(pool);
    // Reuse the same pooled client across several checkouts; a per-checkout
    // listener that outlived its release would accumulate here and eventually
    // trip MaxListenersExceededWarning on a hot path.
    for (let i = 0; i < 5; i++) {
      await withPooledClient(pool, async (client) => {
        expect(client.listenerCount("error")).toBe(1);
        await client.query("SELECT 1");
      });
    }
    const client = await pool.connect();
    try {
      // Back in the pool, pg-pool's own idle listener is the only one attached.
      expect(client.listenerCount("error")).toBeLessThanOrEqual(1);
    } finally {
      client.release();
    }
  });
});
