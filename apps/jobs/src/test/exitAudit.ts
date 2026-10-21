/**
 * A test-only preload (`NODE_OPTIONS=--import=<this file>`) that turns a
 * service's own `process.exit` into evidence about what the process still
 * holds.
 *
 * Every Helix service ends its shutdown, and its failed-startup path, with an
 * explicit `process.exit`. That call ends the process whatever is still open,
 * so the exit code alone cannot show that the teardown released its pools,
 * timers, sockets and workers. With this preload the requested exit becomes
 * `process.exitCode` and the event loop is left to drain:
 *
 * - When nothing is left, the process ends naturally and the `exit` handler
 *   writes `{"outcome":"drained",...}`.
 * - When something still holds the loop after `HELIX_EXIT_AUDIT_SETTLE_MS`
 *   (default 3000), the preload writes `{"outcome":"held","resources":[...]}`
 *   with `process.getActiveResourcesInfo()` and ends the process with
 *   97.
 *
 * Each line starts with `[helix-exit-audit]`. The file uses only erasable
 * TypeScript so Node loads it without the tsx loader.
 */

// Tests match these literals: importing this file would patch the importer's
// own process.exit, so it exports nothing.
const EXIT_AUDIT_MARKER = "[helix-exit-audit]";
/** The exit code of a process whose loop was still held after its own exit request. */
const HELD_EXIT_CODE = 97;

const realExit = process.exit.bind(process);
let requested: number | undefined;

const write = (record: Record<string, unknown>): void => {
  process.stderr.write(`${EXIT_AUDIT_MARKER} ${JSON.stringify(record)}\n`);
};

process.exit = ((code?: number | string | null): never => {
  if (requested === undefined) {
    requested = typeof code === "number" ? code : Number(code ?? 0);
    process.exitCode = requested;
    const settleMs = Number(process.env.HELIX_EXIT_AUDIT_SETTLE_MS ?? "3000");
    // Unref'd: this timer fires only while something else still holds the loop.
    setTimeout(() => {
      write({ outcome: "held", requested, resources: process.getActiveResourcesInfo() });
      realExit(HELD_EXIT_CODE);
    }, settleMs).unref();
  }
  return undefined as never;
}) as typeof process.exit;

process.on("exit", (code) => {
  if (code === HELD_EXIT_CODE) return;
  write({ outcome: requested === undefined ? "exited" : "drained", code, requested });
});

export {};
