import { Pool, type PoolConfig } from "pg";

/**
 * Default per-query ceiling for egress Postgres pools — the same ceiling the
 * edge's `createEdgePool` applies (apps/edge/src/db/pool.ts, ADR-0002
 * ISSUE-05 / issue #12). Long enough not to trip a legitimate secret
 * resolution or jti burn, short enough to bound how long any one query can
 * pin a pooled connection. Override per-deploy with
 * `EGRESS_STATEMENT_TIMEOUT_MS`.
 */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;

export interface EgressPoolOpts {
  /** Pool size. Defaults to node-postgres' own default when omitted. */
  max?: number;
  /**
   * Per-query `statement_timeout` in ms (a server-side setting node-postgres
   * applies per connection). `0` disables it. Defaults to
   * {@link DEFAULT_STATEMENT_TIMEOUT_MS}.
   */
  statementTimeoutMs?: number;
  /**
   * Called when a pooled client sitting idle in the pool errors (a DB
   * restart or failover, a severed network path, a pooler reaping the
   * session). Never called for an in-flight query — those reject their own
   * `query()` call.
   */
  onIdleError?: (err: unknown) => void;
}

/**
 * The single place egress Postgres pools are built (`PgBurnStore`,
 * `PgSecretResolver`). Egress is the mechanism plane — the only component
 * holding plaintext connection secrets — so a slow or stuck query must not be
 * able to hold a pooled connection open indefinitely and, in aggregate,
 * exhaust the pool. The timeout is enforced by Postgres itself, not a
 * client-side timer, so it survives even if the event loop is starved.
 *
 * **Every pool also gets an `'error'` listener, and that is load-bearing.**
 * When an *idle* pooled connection drops, `pg-pool` re-emits the error on the
 * Pool itself; with no listener Node treats it as an unhandled `'error'`
 * event and kills the process — turning a DB restart the service should ride
 * out into a fetch-proxy outage. The listener covers idle clients only; a
 * checked-out client is a second window this listener structurally cannot
 * see. Egress deliberately never calls `pool.connect()` (enforced in
 * `eslint.config.mjs`) — `Pool.query()` plugs its own temporary handler for
 * the checkout window.
 */
export function createEgressPool(databaseUrl: string, opts: EgressPoolOpts = {}): Pool {
  const statementTimeoutMs = opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  const config: PoolConfig = {
    connectionString: databaseUrl,
    statement_timeout: statementTimeoutMs,
  };
  if (opts.max !== undefined) config.max = opts.max;
  const pool = new Pool(config);
  pool.on("error", (err) => {
    // Swallow-and-report: an idle-client error is not an in-flight query's
    // error, so there is nothing to fail here — the pool discards the dead
    // client and reconnects on next use. The sink runs inside a try/catch: a
    // reporting hook must never turn a survivable connection drop into a
    // throw on the socket's error path.
    try {
      opts.onIdleError?.(err);
    } catch {
      // The reporting destination is down; the connection drop stays survivable.
    }
  });
  return pool;
}
