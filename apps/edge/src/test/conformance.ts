import type { FastifyInstance } from "fastify";
import {
  appContracts,
  conformanceRecorder,
  type ConformanceRecorder,
  type RecorderReply,
  type RecorderRequest,
} from "@azx-pbc/shared/contracts";

/**
 * Response conformance for the edge's `/_api/*` routes (ADR-0054 decision 4).
 *
 * A test builder calls {@link recordConformance} on the app it builds, and the
 * test file registers `afterEach(assertConformance)`. Violations are collected
 * per file (vitest isolates modules per file) and reported by the hook after
 * the test that caused them, so no test case has to close its app for the
 * check to run.
 *
 * A hijacked SSE stream never reaches `onSend`, so it is not checked. A
 * fetch-proxy passthrough is streamed: its status and media type are checked
 * against the contract's `default` response, and its body is not.
 */

const recorders: ConformanceRecorder[] = [];
const reported = new WeakMap<ConformanceRecorder, number>();

/** Check every response `app` sends against its route contract. Call right after building it. */
export function recordConformance<T extends FastifyInstance>(app: T): T {
  const recorder = conformanceRecorder(appContracts);
  recorders.push(recorder);
  app.addHook("onSend", async (req, reply, payload) =>
    recorder.onSend(req as RecorderRequest, reply as RecorderReply, payload),
  );
  return app;
}

/** Throw if any recorded response broke its contract since the last call. */
export function assertConformance(): void {
  const violations: string[] = [];
  for (const recorder of recorders) {
    const seen = reported.get(recorder) ?? 0;
    violations.push(...recorder.violations.slice(seen));
    reported.set(recorder, recorder.violations.length);
  }
  if (violations.length > 0) {
    throw new Error(`responses broke their route contracts:\n  ${violations.join("\n  ")}`);
  }
}
