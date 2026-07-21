import { Pool, type PoolConfig } from "pg";

/**
 * Default per-query ceiling for edge Postgres pools. Long enough not to trip a
 * legitimate registry reload or metering aggregation, short enough to bound how
 * long any one query can pin a pooled connection. Override per-deploy with
 * `EDGE_STATEMENT_TIMEOUT_MS`.
 */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;

export interface EdgePoolOpts {
  /** Pool size. Defaults to node-postgres' own default when omitted. */
  max?: number;
  /**
   * Per-query `statement_timeout` in ms (a server-side setting node-postgres
   * applies per connection). `0` disables it. Defaults to
   * {@link DEFAULT_STATEMENT_TIMEOUT_MS}.
   */
  statementTimeoutMs?: number;
}

/**
 * The single place edge Postgres pools are built. Every edge pool gets a
 * `statement_timeout` so a slow or stuck query can't hold a pooled connection
 * open indefinitely and, in aggregate, exhaust the pool — a DoS the edge (the
 * exposed, untrusted-traffic plane) must be resilient to (ADR-0002 ISSUE-05 /
 * issue #12). The timeout is enforced by Postgres itself, not a client-side
 * timer, so it survives even if the event loop is starved.
 */
export function createEdgePool(databaseUrl: string, opts: EdgePoolOpts = {}): Pool {
  const statementTimeoutMs = opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  const config: PoolConfig = {
    connectionString: databaseUrl,
    statement_timeout: statementTimeoutMs,
  };
  if (opts.max !== undefined) config.max = opts.max;
  return new Pool(config);
}
