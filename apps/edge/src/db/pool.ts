import { Pool, type PoolClient, type PoolConfig } from "pg";

/**
 * Default per-query ceiling for edge Postgres pools. Long enough not to trip a
 * legitimate registry reload or metering aggregation, short enough to bound how
 * long any one query can pin a pooled connection. Override per-deploy with
 * `EDGE_STATEMENT_TIMEOUT_MS`.
 */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;

/**
 * Which of the two windows a pooled-client error surfaced in. `pg-pool` covers
 * neither for us — see {@link createEdgePool} and {@link withPooledClient}.
 */
export type PoolClientErrorPhase = "idle" | "checked-out";

export interface EdgePoolOpts {
  /** Pool size. Defaults to node-postgres' own default when omitted. */
  max?: number;
  /**
   * Per-query `statement_timeout` in ms (a server-side setting node-postgres
   * applies per connection). `0` disables it. Defaults to
   * {@link DEFAULT_STATEMENT_TIMEOUT_MS}.
   */
  statementTimeoutMs?: number;
  /** Which pool this is, for the log event — `"sessions"`, `"app-data"`, … */
  label?: string;
  /**
   * Called when a pooled client errors: `phase: "idle"` for one sitting in the
   * pool, `"checked-out"` for one held by {@link withPooledClient}.
   *
   * **One hook for both windows on purpose.** Two hooks can be half-forwarded,
   * and this codebase has already proved that happens — five of six stores used
   * to rebuild the opts object field-by-field and silently dropped the previous
   * idle-only hook. Optional: a listener is attached either way, so a caller
   * without a logger still can't crash the process. Never called with a throw
   * escaping (the sink runs inside a try/catch).
   */
  onClientError?: (err: unknown, ctx: { phase: PoolClientErrorPhase; label: string }) => void;
}

/**
 * Per-pool reporting sink, keyed by the Pool. This is how
 * {@link withPooledClient} reaches the handler its `createEdgePool` caller
 * supplied without threading a logger through every `withPartition` call site
 * (15 of them today). `WeakMap` so an `end()`ed, dropped pool is collectable.
 */
const SINKS = new WeakMap<Pool, (err: unknown, phase: PoolClientErrorPhase) => void>();

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
 * with it.
 *
 * **This listener covers idle clients only.** A client checked out via
 * `pool.connect()` is a second, separate window that `pool.on('error')`
 * structurally cannot see — use {@link withPooledClient}, which is the only
 * sanctioned way to check one out (enforced in `eslint.config.mjs`).
 */
export function createEdgePool(databaseUrl: string, opts: EdgePoolOpts = {}): Pool {
  const statementTimeoutMs = opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  const config: PoolConfig = {
    connectionString: databaseUrl,
    statement_timeout: statementTimeoutMs,
  };
  if (opts.max !== undefined) config.max = opts.max;
  const pool = new Pool(config);
  const label = opts.label ?? "unlabelled";
  const report = (err: unknown, phase: PoolClientErrorPhase): void => {
    try {
      opts.onClientError?.(err, { phase, label });
    } catch {
      // A reporting sink must never turn a survivable connection drop into a
      // throw on the socket's error path — that is the exact crash all of this
      // exists to prevent.
    }
  };
  SINKS.set(pool, report);
  pool.on("error", (err) => {
    // Swallow-and-report: an idle-client error is not an in-flight query's
    // error (those reject their own `query()` call), so there is nothing to fail
    // here. The pool discards the dead client and reconnects on next use.
    report(err, "idle");
  });
  return pool;
}

/**
 * Check a client out of `pool`, run `fn`, release exactly once.
 *
 * **The only sanctioned `pool.connect()` in the edge** (enforced by a
 * `no-restricted-syntax` rule in `eslint.config.mjs`), because the checkout
 * window is a hole the pool-level `'error'` listener cannot cover:
 *
 * - `pg-pool` **removes** its idle `'error'` listener from a client the moment
 *   it is checked out (`_acquireClient`, `pg-pool/index.js:344`) and re-attaches
 *   it on release (`_release`, `:385`). So between `connect()` and `release()`
 *   the client has **zero** `'error'` listeners. `Pool.query()` plugs that with
 *   its own temporary `client.once('error', …)` (`:464`); `Pool.connect()` plugs
 *   nothing.
 * - `pg.Client#_handleErrorEvent` (`pg/lib/client.js:411`) emits `'error'`
 *   **synchronously** on a socket death, but defers the in-flight query's
 *   rejection to `process.nextTick`. So on a mid-transaction drop the unhandled
 *   `'error'` throws out of the socket read callback — no `try`/`catch` of ours
 *   is on that stack, and the repo installs no `uncaughtException` handler — and
 *   the process dies **before** the awaited `client.query()` ever rejects.
 *
 * Together those mean a DB failover landing while any request holds a
 * partitioned transaction would kill the replica.
 */
export async function withPooledClient<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let checkoutError: Error | undefined;
  const onError = (err: Error): void => {
    // First error wins — that one is the socket death; anything after is its
    // echo. Record and report only: `release()` is called exactly once, in the
    // `finally` below, because pg-pool's `_releaseOnce` throws on a second call
    // (which would mask the real error). Note `Pool.query`'s own handler *does*
    // release, so it is not a shape to copy here.
    checkoutError ??= err;
    SINKS.get(pool)?.(err, "checked-out");
  };
  client.on("error", onError);
  try {
    return await fn(client);
  } finally {
    // Remove BEFORE releasing: `_release` re-attaches pg-pool's idle listener,
    // and a per-checkout listener left behind accumulates on a long-lived
    // pooled client until `MaxListenersExceededWarning` — a hot-path leak.
    client.removeListener("error", onError);
    // Pass the error along: pg-pool's `_release` treats a truthy `err` as
    // destroy (`_remove()` ends the socket and drops the client), rather than
    // parking a socket-dead connection in the idle set for the next caller to
    // inherit.
    client.release(checkoutError);
  }
}
