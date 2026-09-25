import { Pool, type PoolClient, type PoolConfig } from "pg";

/**
 * Default per-query ceiling for egress Postgres pools — the same ceiling the
 * edge's `createEdgePool` applies (apps/edge/src/db/pool.ts, ADR-0002
 * ISSUE-05 / issue #12). Long enough not to trip a legitimate secret
 * resolution or jti burn, short enough to bound how long any one query can
 * pin a pooled connection. Override per-deploy with
 * `EGRESS_STATEMENT_TIMEOUT_MS`.
 */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;

/**
 * Which of the two windows a pooled-client error surfaced in. `pg-pool` covers
 * neither for us — see {@link createEgressPool} and {@link withPooledClient}.
 */
export type EgressPoolClientErrorPhase = "idle" | "checked-out";

export interface EgressPoolOpts {
  /** Pool size. Defaults to node-postgres' own default when omitted. */
  max?: number;
  /**
   * Per-query `statement_timeout` in ms (a server-side setting node-postgres
   * applies per connection). `0` disables it. Defaults to
   * {@link DEFAULT_STATEMENT_TIMEOUT_MS}.
   */
  statementTimeoutMs?: number;
  /** Which pool this is, for the log event. */
  label?: string;
  /**
   * Called when a pooled client errors: `phase: "idle"` for one sitting in the
   * pool, `"checked-out"` for one held by {@link withPooledClient} (the
   * edge's `onClientError` shape, apps/edge/src/db/pool.ts). Optional: a
   * listener is attached either way, so a caller without a logger still can't
   * crash the process. Never called with a throw escaping.
   */
  onClientError?: (err: unknown, ctx: { phase: EgressPoolClientErrorPhase; label: string }) => void;
  /**
   * Idle-phase-only reporting, kept for the existing call sites
   * (`PgSecretResolver`, `PgBurnStore`). Ignored when `onClientError` is
   * given — one hook for both windows on purpose; two hooks can be
   * half-forwarded and silently drop a phase.
   */
  onIdleError?: (err: unknown) => void;
}

/**
 * Per-pool reporting sink, keyed by the Pool — how {@link withPooledClient}
 * reaches the handler its `createEgressPool` caller supplied.
 * `WeakMap` so an `end()`ed, dropped pool is collectable.
 */
const SINKS = new WeakMap<Pool, (err: unknown, phase: EgressPoolClientErrorPhase) => void>();

/**
 * Create egress pools with server-side query timeouts to prevent exhausted
 * connections. An error listener handles dropped idle clients; without it,
 * Node terminates on pg-pool's unhandled error event.
 *
 * This listener does not cover checked-out clients. Renewal (the one place
 * egress holds a client across a vendor call) uses {@link withPooledClient},
 * which re-attaches reporting for that window.
 */
export function createEgressPool(databaseUrl: string, opts: EgressPoolOpts = {}): Pool {
  const statementTimeoutMs = opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  const config: PoolConfig = {
    connectionString: databaseUrl,
    statement_timeout: statementTimeoutMs,
  };
  if (opts.max !== undefined) config.max = opts.max;
  const pool = new Pool(config);
  const label = opts.label ?? "unlabelled";
  const report = (err: unknown, phase: EgressPoolClientErrorPhase): void => {
    try {
      if (opts.onClientError) {
        opts.onClientError(err, { phase, label });
      } else if (phase === "idle") {
        opts.onIdleError?.(err);
      }
    } catch {
      // The reporting destination is down; the connection drop stays survivable.
    }
  };
  SINKS.set(pool, report);
  pool.on("error", (err) => {
    // Swallow-and-report: an idle-client error is not an in-flight query's
    // error, so there is nothing to fail here — the pool discards the dead
    // client and reconnects on next use.
    report(err, "idle");
  });
  return pool;
}

/**
 * Check a client out of `pool`, run `fn`, release exactly once — the edge's
 * `withPooledClient` (apps/edge/src/db/pool.ts) copied for egress's one
 * checked-out-client consumer, token renewal (I-02 ADR-0007): the advisory
 * lock lives on the CLIENT SESSION, so renewal holds a checked-out client
 * across the vendor call and this bracket owns its lifetime.
 *
 * The checkout window is a hole the pool-level `'error'` listener cannot
 * cover: pg-pool removes its idle `'error'` listener the moment a client is
 * checked out and re-attaches on release, so between `connect()` and
 * `release()` the client has zero `'error'` listeners — and a socket death
 * there would otherwise be an unhandled `'error'` event that kills the
 * process.
 */
export async function withPooledClient<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let checkoutError: Error | undefined;
  const onError = (err: Error): void => {
    // First error wins — that one is the socket death; anything after is its
    // echo. Record and report only: `release()` is called exactly once, in
    // the `finally` below, because pg-pool's `_releaseOnce` throws on a
    // second call (which would mask the real error).
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
