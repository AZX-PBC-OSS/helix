import { PgBoss } from "pg-boss";

/** SQLSTATE `admin_shutdown`: Postgres ending a backend for a forced DROP DATABASE or pg_terminate_backend. */
const ADMIN_SHUTDOWN = "57P01";

/**
 * A pg-boss instance for an integration suite.
 *
 * pg-boss re-emits its pool's connection errors as `error` on the instance,
 * and an `error` event with no listener is an uncaught exception that fails
 * the whole vitest run, even when every test passed. The suites drop their
 * scratch database `WITH (FORCE)` after `boss.stop()`, and pg-pool's `end()`
 * can resolve while a client is still closing, so that client receives the
 * termination. That one error is expected and dropped. Any other error is
 * rethrown, so a real instance error still fails the run as before.
 * Production attaches its own listener in the runner's `buildBoss()`.
 */
export function newTestBoss(options: ConstructorParameters<typeof PgBoss>[0]): PgBoss {
  const boss = new PgBoss(options);
  boss.on("error", (error) => {
    if ((error as { code?: unknown }).code === ADMIN_SHUTDOWN) return;
    queueMicrotask(() => {
      throw error;
    });
  });
  return boss;
}
