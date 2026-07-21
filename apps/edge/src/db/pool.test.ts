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
});
