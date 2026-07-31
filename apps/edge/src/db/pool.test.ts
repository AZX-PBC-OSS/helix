import { afterEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { createEdgePool, DEFAULT_STATEMENT_TIMEOUT_MS } from "./pool.js";

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

  // Regression: with no 'error' listener on the Pool, an idle pooled client
  // dropping (DB restart/failover, severed path, a pooler reaping the session)
  // is an unhandled 'error' event and Node kills the process — turning the fault
  // the edge is built to ride out (serve stale, architecture §7) into a crash.
  // Reproduced against a live DB by severing the connection: pre-fix the process
  // died, post-fix it degraded /health and recovered.
  it("survives an idle-client error instead of crashing the process", () => {
    const seen: unknown[] = [];
    const pool = track(createEdgePool("postgresql://unused", { onIdleError: (e) => seen.push(e) }));
    const boom = new Error("connection terminated unexpectedly");
    // `emit` returns false when nothing is listening — which is exactly the
    // state that makes Node rethrow. Assert a handler is attached.
    expect(pool.emit("error", boom)).toBe(true);
    expect(seen).toEqual([boom]);
  });

  it("attaches the handler even when the caller passes no onIdleError", () => {
    const pool = track(createEdgePool("postgresql://unused"));
    // No callback, but the listener must still exist — otherwise a store that
    // forgets to pass one reintroduces the crash.
    expect(() => pool.emit("error", new Error("boom"))).not.toThrow();
    expect(pool.listenerCount("error")).toBe(1);
  });
});
