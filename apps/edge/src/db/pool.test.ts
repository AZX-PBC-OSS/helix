import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { createEdgePool, DEFAULT_STATEMENT_TIMEOUT_MS, withPooledClient } from "./pool.js";

// node-postgres exposes the resolved client config on `pool.options`; constructing
// a Pool does not connect (that happens lazily on the first query), so these are
// pure unit tests. `options` isn't in the public typings — read it through a cast.
function options(pool: Pool): { statement_timeout?: number | false; max?: number } {
  return (pool as unknown as { options: { statement_timeout?: number | false; max?: number } })
    .options;
}

describe("createEdgePool", () => {
  const pools: Pool[] = [];
  const track = (pool: Pool): Pool => {
    pools.push(pool);
    return pool;
  };

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((p) => p.end().catch(() => {})));
  });

  it("applies the default statement_timeout so a stuck query can't pin a connection", () => {
    const pool = track(createEdgePool("postgresql://unused"));
    expect(options(pool).statement_timeout).toBe(DEFAULT_STATEMENT_TIMEOUT_MS);
  });

  it("honors an explicit statementTimeoutMs and max", () => {
    const pool = track(createEdgePool("postgresql://unused", { statementTimeoutMs: 2500, max: 3 }));
    expect(options(pool).statement_timeout).toBe(2500);
    expect(options(pool).max).toBe(3);
  });

  it("allows disabling the timeout with 0 (explicit opt-out)", () => {
    const pool = track(createEdgePool("postgresql://unused", { statementTimeoutMs: 0 }));
    expect(options(pool).statement_timeout).toBe(0);
  });

  // Regression: with no 'error' listener on the Pool, an *idle* pooled client
  // dropping (DB restart/failover, severed path, a pooler reaping the session)
  // is an unhandled 'error' event and Node kills the process — turning the fault
  // the edge is built to ride out (serve stale, architecture §7) into a crash.
  it("survives an idle-client error instead of crashing the process", () => {
    const seen: Array<{ phase: string; label: string }> = [];
    const pool = track(
      createEdgePool("postgresql://unused", {
        label: "sessions",
        onClientError: (_e, ctx) => seen.push(ctx),
      }),
    );
    const boom = new Error("connection terminated unexpectedly");
    // `emit` returns false when nothing is listening — which is exactly the
    // state that makes Node rethrow. Assert a handler is attached.
    expect(pool.emit("error", boom)).toBe(true);
    expect(seen).toEqual([{ phase: "idle", label: "sessions" }]);
  });

  it("attaches the handler even when the caller passes no onClientError", () => {
    const pool = track(createEdgePool("postgresql://unused"));
    // No callback, but the listener must still exist — otherwise a store that
    // forgets to pass one reintroduces the crash.
    expect(() => pool.emit("error", new Error("boom"))).not.toThrow();
    expect(pool.listenerCount("error")).toBe(1);
  });

  it("contains a throwing report sink rather than re-creating the crash", () => {
    const pool = track(
      createEdgePool("postgresql://unused", {
        onClientError: () => {
          throw new Error("log destination is down");
        },
      }),
    );
    expect(() => pool.emit("error", new Error("boom"))).not.toThrow();
  });
});

/**
 * The checkout window (`pool.connect()` → `release()`), which the Pool-level
 * listener above structurally cannot cover: pg-pool strips the client's idle
 * `'error'` listener for the duration of a checkout, and `pg` emits `'error'`
 * synchronously on a socket death. Faked with a real `EventEmitter` so an
 * unhandled `'error'` throws exactly as it does on a real `pg.Client`.
 */
class FakeClient extends EventEmitter {
  released = 0;
  releaseArg: unknown = "not-called";
  release = (err?: unknown): void => {
    this.released += 1;
    this.releaseArg = err;
  };
}

/** A bare pool object — no `createEdgePool`, so no report sink is registered. */
function rawPool(client: FakeClient): Pool {
  return { connect: async () => client } as unknown as Pool;
}

describe("withPooledClient", () => {
  it("covers the window pg-pool leaves listener-less", async () => {
    const client = new FakeClient();
    const boom = new Error("socket died mid-transaction");
    let listenersInside = -1;

    await expect(
      withPooledClient(rawPool(client), async (c) => {
        listenersInside = (c as unknown as FakeClient).listenerCount("error");
        // Synchronous emit, as pg does — this THREW before the fix.
        (c as unknown as FakeClient).emit("error", boom);
        // pg defers the query rejection to nextTick, so model that ordering:
        // the emit lands first, then the awaited query rejects.
        await Promise.resolve();
        throw boom;
      }),
    ).rejects.toThrow("socket died mid-transaction");

    expect(listenersInside).toBe(1); // pre-fix: 0
    expect(client.listenerCount("error")).toBe(0); // removed, so it can't accumulate
    // Released once, WITH the error, so pg-pool destroys the dead client instead
    // of parking it in the idle set for the next caller.
    expect(client.released).toBe(1);
    expect(client.releaseArg).toBe(boom);
  });

  it("releases cleanly when nothing went wrong", async () => {
    const client = new FakeClient();
    await expect(withPooledClient(rawPool(client), async () => "ok")).resolves.toBe("ok");
    expect(client.released).toBe(1);
    expect(client.releaseArg).toBeUndefined();
    expect(client.listenerCount("error")).toBe(0);
  });

  it("keeps the first error when the socket emits more than once", async () => {
    const client = new FakeClient();
    const first = new Error("first");
    await withPooledClient(rawPool(client), async (c) => {
      (c as unknown as FakeClient).emit("error", first);
      (c as unknown as FakeClient).emit("error", new Error("echo"));
    });
    // The first is the socket death; the rest are its echo.
    expect(client.releaseArg).toBe(first);
  });

  it("reports a checked-out error through the pool's own sink", async () => {
    const seen: Array<{ phase: string; label: string }> = [];
    const pool = createEdgePool("postgresql://unused", {
      label: "app-data",
      onClientError: (_e, ctx) => seen.push(ctx),
    });
    const client = new FakeClient();
    // Stub the checkout; the sink lookup is keyed on the real pool object.
    (pool as unknown as { connect: () => Promise<FakeClient> }).connect = async () => client;
    await withPooledClient(pool, async (c) => {
      (c as unknown as FakeClient).emit("error", new Error("boom"));
    });
    expect(seen).toEqual([{ phase: "checked-out", label: "app-data" }]);
    await pool.end().catch(() => {});
  });

  it("is still crash-safe for a pool built outside createEdgePool", async () => {
    const client = new FakeClient();
    // No sink registered — the listener must still exist so the emit is absorbed.
    await expect(
      withPooledClient(rawPool(client), async (c) => {
        (c as unknown as FakeClient).emit("error", new Error("boom"));
        return "survived";
      }),
    ).resolves.toBe("survived");
  });
});
