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
  /**
   * Called when an **idle** pooled client errors (see the note in
   * {@link createEdgePool}). Optional: the handler is attached either way, so a
   * caller without a logger still can't crash the process. Must not throw.
   */
  onIdleError?: (err: unknown) => void;
}

/**
 * The single place edge Postgres pools are built. Every edge pool gets a
 * `statement_timeout` so a slow or stuck query can't hold a pooled connection
 * open indefinitely and, in aggregate, exhaust the pool — a DoS the edge (the
 * exposed, untrusted-traffic plane) must be resilient to (ADR-0002 ISSUE-05 /
 * issue #12). The timeout is enforced by Postgres itself, not a client-side
 * timer, so it survives even if the event loop is starved.
 *
 * **Every pool also gets an `'error'` listener, and that is load-bearing.** When
 * an *idle* pooled connection drops — a DB restart or failover, a severed
 * network path, a pooler reaping an idle session — `pg-pool` re-emits the error
 * on the Pool itself. With no listener, Node treats it as an unhandled `'error'`
 * event and **kills the process**. That turns the exact fault the edge is
 * designed to ride out (architecture §7: serve stale from the cached projection)
 * into a hard crash, and takes the sessions, metering and app-data pools down
 * with it. Attached here rather than per-caller so no store can forget it.
 */
export function createEdgePool(databaseUrl: string, opts: EdgePoolOpts = {}): Pool {
  const statementTimeoutMs = opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  const config: PoolConfig = {
    connectionString: databaseUrl,
    statement_timeout: statementTimeoutMs,
  };
  if (opts.max !== undefined) config.max = opts.max;
  const pool = new Pool(config);
  pool.on("error", (err) => {
    // Swallow-and-report: an idle-client error is not an in-flight query's
    // error (those reject their own `query()` call), so there is nothing to fail
    // here. The pool discards the dead client and reconnects on next use.
    opts.onIdleError?.(err);
  });
  return pool;
}
