import { Pool, type PoolClient } from "pg";

/**
 * The jobs service's pooled-client discipline — the edge's and egress's
 * (`apps/edge/src/db/pool.ts`, `apps/egress/src/pool.ts`) copied for this
 * service's private stores, because pg-pool's checkout window is a hole the
 * pool-level `'error'` listener cannot cover:
 *
 * - `pg-pool` **removes** its idle `'error'` listener from a client the
 *   moment it is checked out (`_acquireClient`, `pg-pool/index.js:344`) and
 *   re-attaches it on release (`_release`, `:385`). So between `connect()`
 *   and `release()` the client has **zero** `'error'` listeners.
 *   `Pool.query()` plugs that with its own temporary `client.once('error', …)`
 *   for the checkout window; a bare `pool.connect()` plugs nothing.
 * - `pg.Client#_handleErrorEvent` (`pg/lib/client.js`) emits `'error'`
 *   **synchronously** on a socket death, but defers the in-flight query's
 *   rejection to `process.nextTick`. So on a mid-transaction drop the
 *   unhandled `'error'` throws out of the socket read callback — no
 *   `try`/`catch` of ours is on that stack — and the process dies **before**
 *   the awaited `client.query()` ever rejects and the store's own failure
 *   contract (the route's retryable unavailability) can run.
 *
 * Together those mean a Postgres failover landing while any store holds a
 * checked-out client would kill the whole service. The two halves here close
 * the two windows: {@link createJobsPool} covers idle clients (the pool-level
 * listener — and nothing else), and {@link withJobsClient} covers checked-out
 * ones. Bare `pool.connect()` is banned for this service by
 * `eslint.config.mjs`; this module holds the one sanctioned checkout.
 */

/** Which of the two windows a pooled-client error surfaced in. */
export type JobsPoolClientErrorPhase = "idle" | "checked-out";

export interface JobsPoolOptions {
  databaseUrl: string;
  /** Per-query `statement_timeout`, applied server-side; also the connect bound. */
  statementTimeoutMs: number;
  /** Pool size. Omitted means node-postgres' own default. */
  max?: number;
  /**
   * Called when a pooled client errors: `phase: "idle"` for one sitting in
   * the pool, `"checked-out"` for one held by {@link withJobsClient}.
   *
   * **One hook for both windows on purpose** (the edge's reasoning, copied):
   * two hooks can be half-forwarded, and a listener is attached either way,
   * so a caller without a logger still cannot crash the process. Never
   * called with a throw escaping (the sink runs inside a try/catch).
   */
  onClientError: (err: unknown, phase: JobsPoolClientErrorPhase) => void;
}

/** Per-pool reporting sink, keyed by the Pool — how {@link withJobsClient} reaches the hook its `createJobsPool` caller supplied. `WeakMap` so an `end()`ed, dropped pool is collectable. */
const SINKS = new WeakMap<Pool, (err: unknown, phase: JobsPoolClientErrorPhase) => void>();

/**
 * Build one of the service's private-store pools: the per-query
 * `statement_timeout` (and connect bound) applied, and the pool-level
 * `'error'` listener attached. **The listener covers idle clients only** —
 * the ones sitting in the pool; a checked-out client's error belongs to its
 * holder, and that window is {@link withJobsClient}'s. The pool discards a
 * dead idle client and reconnects on next use; an idle-client error is not
 * an in-flight query's error (those reject their own `query()` call), so
 * there is nothing to fail here — the hook reports, and the process lives.
 */
export function createJobsPool(options: JobsPoolOptions): Pool {
  const pool = new Pool({
    connectionString: options.databaseUrl,
    ...(options.max !== undefined ? { max: options.max } : {}),
    connectionTimeoutMillis: options.statementTimeoutMs,
    statement_timeout: options.statementTimeoutMs,
  });
  const report = (err: unknown, phase: JobsPoolClientErrorPhase): void => {
    try {
      options.onClientError(err, phase);
    } catch {
      // A reporting sink must never turn a survivable connection drop into a
      // throw on the socket's error path — that is the exact crash all of
      // this exists to prevent.
    }
  };
  SINKS.set(pool, report);
  pool.on("error", (err) => {
    report(err, "idle");
  });
  return pool;
}

/**
 * Check a client out of `pool`, run `fn`, release exactly once — the only
 * sanctioned `pool.connect()` in this service (enforced by a
 * `no-restricted-syntax` rule in `eslint.config.mjs`).
 *
 * The client-level listener covers the checkout window (pg-pool has stripped
 * its own listener at acquire): the first socket death is recorded and
 * reported `checked-out`, and `release()` is called exactly once, in the
 * `finally` — pg-pool's `_releaseOnce` throws on a second call, which would
 * mask the real error. Note `Pool.query`'s own handler *does* release, so it
 * is not a shape to copy.
 */
export async function withJobsClient<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let checkoutError: Error | undefined;
  const onError = (err: Error): void => {
    // First error wins — that one is the socket death; anything after is its
    // echo. Record and report only: the release happens once, below.
    checkoutError ??= err;
    SINKS.get(pool)?.(err, "checked-out");
  };
  client.on("error", onError);
  try {
    return await fn(client);
  } finally {
    // Remove BEFORE releasing: `_release` re-attaches pg-pool's idle
    // listener, and a per-checkout listener left behind accumulates on a
    // long-lived pooled client until `MaxListenersExceededWarning` — a
    // hot-path leak.
    client.removeListener("error", onError);
    // Pass the error along: pg-pool's `_release` treats a truthy `err` as
    // destroy (the socket-dead client is dropped, never parked in the idle
    // set for the next caller to inherit).
    client.release(checkoutError);
  }
}
