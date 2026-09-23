/**
 * Graceful shutdown for the platform's server entrypoints.
 *
 * Node's default handler for `SIGTERM`/`SIGINT` exits the process immediately:
 * before this module existed, nothing in any `onClose` hook ever ran — pools
 * were dropped unended, the final telemetry batch was lost, and every open
 * connection was cut mid-byte (on the edge, a truncated LLM stream for every
 * user mid-request on each revision swap). Fastify installs no signal handler
 * of its own, so the wiring lives in each `server.ts`, next to the boot code it
 * protects, through the one helper here.
 *
 * The shape is deliberate, in the order the graceful-shutdown TODO prescribed:
 *
 * 1. **A hard deadline is not optional.** Fastify 5 defaults
 *    `forceCloseConnections: 'idle'`, so `close()` drops idle keep-alives at
 *    once but *waits* on any connection with a request in flight — and the edge
 *    holds long-lived upstream SSE streams that will not finish under any
 *    grace period we would choose. Without the deadline, a 100 ms exit becomes
 *    a hang until the orchestrator `SIGKILL`s.
 * 2. **The deadline sits well inside the platform's documented window.** Azure
 *    Container Apps gives a stopped container 30 s from SIGTERM to SIGKILL —
 *    a documented, stable default — and its issue tracker shows it cannot be
 *    trusted with more (grace periods ignored on some paths, SIGTERM
 *    occasionally undelivered entirely). The default
 *    {@link DEFAULT_SHUTDOWN_GRACE_MS} is a third of that: the process exits
 *    before platform flakiness can intervene, and shortening the window is the
 *    only direction the platform honours reliably. Pinning
 *    `terminationGracePeriodSeconds` in `infra/azure` would be optional
 *    hardening — never a prerequisite for this to work.
 * 3. **The batch interval, not the handler, is the crash hedge.** A deadline
 *    covers only stops the process gets to react to; `BatchSpanProcessor`'s
 *    lowered `scheduledDelayMillis` (see `@azx-pbc/telemetry`) covers crashes,
 *    SIGKILL and never-delivered signals, which no handler can.
 *
 * Node-only (signals, timers, `process.exit`): exported as the
 * `@azx-pbc/shared/lifecycle` subpath, deliberately outside the browser-consumed
 * barrel — the same pattern as `./logging` and `./bodyCap`.
 */

/** Structural logger — the pino surface, without importing Fastify. */
export interface ShutdownLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** Structural Fastify instance — `app.close()`, nothing else. */
export interface ShutdownTarget {
  close(): Promise<void>;
}

/**
 * 10 s — a third of Container Apps' documented 30 s SIGTERM-to-SIGKILL window.
 * Generous for the drain's real beneficiary (short requests: assets, `/_api/*`
 * data calls, auth callbacks — all well under a second) and for the `onClose`
 * teardown chain, while bounded enough that a deploy costs seconds, not tens.
 * Long-lived SSE streams are cut at the deadline either way: no sane value
 * saves them, which is exactly why the deadline is hard rather than advisory.
 */
export const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;

const SIGNALS = ["SIGTERM", "SIGINT"] as const;

/**
 * Resolve `SHUTDOWN_GRACE_MS`, or the {@link DEFAULT_SHUTDOWN_GRACE_MS}.
 *
 * Thrown, not coerced, on garbage — the same stance as every other validated
 * boot duration in the platform: every comparison against `NaN` is false, so a
 * mistyped value would otherwise silently disable the deadline, turning the
 * drain hang the deadline exists to prevent into the default behaviour again.
 */
export function resolveShutdownGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SHUTDOWN_GRACE_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_SHUTDOWN_GRACE_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `SHUTDOWN_GRACE_MS must be a positive number of milliseconds (got ${JSON.stringify(raw)})`,
    );
  }
  return value;
}

export interface GracefulShutdownOptions {
  /** Overrides `SHUTDOWN_GRACE_MS` from `env`; defaults to {@link resolveShutdownGraceMs}. */
  graceMs?: number;
  /** Injectable for tests; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests; defaults to `SIGTERM` + `SIGINT`. */
  signals?: readonly NodeJS.Signals[];
}

/**
 * Install `SIGTERM`/`SIGINT` handlers that drain `target` under a hard
 * deadline, then exit. Call once from each `server.ts`, after `buildApp()` has
 * produced the logger and before or after `listen` — the teardown hooks are
 * guarded, so a signal during boot is as safe as one at rest.
 *
 * On a signal: log, start the (unref'd) deadline, `close()`, exit 0 — including
 * when `close()` rejects. A second signal during the drain is a no-op; forcing
 * past a stuck drain is SIGKILL's job, and the orchestrator has it.
 */
export function installGracefulShutdown(
  target: ShutdownTarget,
  log: ShutdownLogger,
  options: GracefulShutdownOptions = {},
): void {
  const graceMs = options.graceMs ?? resolveShutdownGraceMs(options.env ?? process.env);
  const signals = options.signals ?? SIGNALS;

  let stopping = false;
  /**
   * Yield one macrotask turn before exiting so the async stdout destination
   * flushes the line just written — pino buffers, and a `process.exit` in the
   * same tick as the write loses it. Queued immediates are ref-holding, so
   * this turn always runs.
   */
  const exitSoon = (): void => {
    setImmediate(() => process.exit(0));
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    log.info(
      { event: "shutdown.signal", signal, graceMs },
      `${signal} received — draining in-flight requests (hard deadline ${graceMs} ms)`,
    );
    const deadline = setTimeout(() => {
      // The unref below means this fires only while the event loop is still
      // alive on real work (in-flight sockets); a loop that drained on its own
      // exits without us, which is the same outcome.
      log.warn(
        { event: "shutdown.timeout", graceMs },
        "shutdown deadline exceeded — in-flight work did not finish; exiting",
      );
      exitSoon();
    }, graceMs);
    deadline.unref(); // the drain must never be what holds the process open
    void target
      .close()
      .catch((err: unknown) => {
        // A hook that fails mid-teardown must not change the exit story: the
        // replica is being replaced regardless. Log and go.
        log.error({ event: "shutdown.error", err }, "close failed during shutdown");
      })
      .finally(() => {
        clearTimeout(deadline);
        log.info({ event: "shutdown.exit" }, "drain complete — exiting");
        exitSoon();
      });
  };

  for (const signal of signals) process.once(signal, onSignal);
}
