import { describe, expect, test, vi } from "vitest";

import { JOBS_DIAGNOSTIC_QUALIFIED_TYPE } from "@azx-pbc/shared";

import {
  DIAGNOSTIC_MAX_STEP_DELAY_MS,
  DIAGNOSTIC_MAX_STEPS,
  DIAGNOSTIC_PROGRESS_LABEL,
  DiagnosticJobInputSchema,
  JOBS_DIAGNOSTIC_TYPE_POLICY,
  makeDiagnosticJobHandler,
} from "./diagnostics.js";
import {
  JobsExecutionError,
  type JobsExecutionContext,
  type JobsProgressInput,
} from "./execution.js";
import type { JobsAttemptRecord } from "./execution.js";

/**
 * The diagnostic fixture's own contracts, against the handler directly: the
 * step walk and its reports, the retryable failure, the abort semantics
 * (nothing left behind), and the strict input schema.
 */

function aRecord(): JobsAttemptRecord {
  return {
    server: "jobs",
    jobId: "job-1",
    type: JOBS_DIAGNOSTIC_QUALIFIED_TYPE,
    appId: "0b9e8c3e-6f2a-4c9b-9e1f-2a4b6c8d0e2f",
    env: "dev",
    ownerKind: "dev",
    ownerOid: "4f7a2b3c-9d1e-4a5b-8c6d-0e2f4a6b8c0d",
    generation: "1",
  };
}

function fakeContext(over: {
  input: unknown;
  signal: AbortSignal;
  attempt?: number;
  report?: (progress: JobsProgressInput) => Promise<"persisted" | "refused">;
}): JobsExecutionContext & { reports: JobsProgressInput[] } {
  const reports: JobsProgressInput[] = [];
  return {
    input: over.input,
    attempt: over.attempt ?? 1,
    record: aRecord(),
    signal: over.signal,
    report:
      over.report ??
      (async (progress: JobsProgressInput) => {
        reports.push(progress);
        return "persisted";
      }),
    reports,
  };
}

function errorCode(error: unknown): unknown {
  expect(error).toBeInstanceOf(JobsExecutionError);
  return (error as JobsExecutionError).code;
}

describe("the diagnostic handler's step walk", () => {
  test("the happy path reports every step in order and resolves with the result", async () => {
    const handler = makeDiagnosticJobHandler();
    const context = fakeContext({
      input: { steps: 3 },
      attempt: 2,
      signal: new AbortController().signal,
    });
    const result = await handler(context);
    expect(context.reports).toEqual([
      { step: 1, of: 3, label: DIAGNOSTIC_PROGRESS_LABEL },
      { step: 2, of: 3, label: DIAGNOSTIC_PROGRESS_LABEL },
      { step: 3, of: 3, label: DIAGNOSTIC_PROGRESS_LABEL },
    ]);
    expect(result).toEqual({ completedSteps: 3, attempt: 2 });
  });

  test("a refused progress report does not fail the work", async () => {
    const handler = makeDiagnosticJobHandler();
    const context = fakeContext({
      input: { steps: 2 },
      signal: new AbortController().signal,
      report: async () => "refused",
    });
    await expect(handler(context)).resolves.toEqual({ completedSteps: 2, attempt: 1 });
  });

  test("failAtStep fails the attempt with the retryable upstream_error after the earlier steps' reports", async () => {
    const handler = makeDiagnosticJobHandler();
    const context = fakeContext({
      input: { steps: 3, failAtStep: 2 },
      signal: new AbortController().signal,
    });
    try {
      await handler(context);
      expect.unreachable("the fixture's simulated failure must throw");
    } catch (error) {
      expect(errorCode(error)).toBe("upstream_error");
    }
    expect(context.reports).toEqual([{ step: 1, of: 3, label: DIAGNOSTIC_PROGRESS_LABEL }]);
  });
});

describe("the diagnostic handler's abort semantics", () => {
  test("an abort mid-wait rejects cancelled promptly and leaves no timer behind", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const handler = makeDiagnosticJobHandler();
      const context = fakeContext({
        input: { steps: 3, stepDelayMs: 1_000 },
        signal: controller.signal,
      });
      const done = handler(context);
      const settled = expect(done).rejects.toSatisfy(
        (error: unknown) => errorCode(error) === "cancelled",
      );
      await vi.advanceTimersByTimeAsync(50);
      controller.abort();
      await vi.advanceTimersByTimeAsync(1);
      await settled;
      // The interrupted wait cleared its timer: nothing pending survives the
      // handler's exit.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an already-aborted signal throws cancelled before any report", async () => {
    const controller = new AbortController();
    controller.abort();
    const handler = makeDiagnosticJobHandler();
    const context = fakeContext({ input: { steps: 3 }, signal: controller.signal });
    try {
      await handler(context);
      expect.unreachable("an aborted attempt must not run");
    } catch (error) {
      expect(errorCode(error)).toBe("cancelled");
    }
    expect(context.reports).toEqual([]);
  });

  test("ignoreAbort keeps the handler running through an abort mid-run", async () => {
    const controller = new AbortController();
    const handler = makeDiagnosticJobHandler();
    const context = fakeContext({
      input: { steps: 2, stepDelayMs: 100, ignoreAbort: true },
      signal: controller.signal,
    });
    const done = handler(context);
    setTimeout(() => controller.abort(), 30);
    await expect(done).resolves.toEqual({ completedSteps: 2, attempt: 1 });
    expect(context.reports).toEqual([
      { step: 1, of: 2, label: DIAGNOSTIC_PROGRESS_LABEL },
      { step: 2, of: 2, label: DIAGNOSTIC_PROGRESS_LABEL },
    ]);
  });

  test("a zero step delay leaves no timer at all", async () => {
    const handler = makeDiagnosticJobHandler();
    const context = fakeContext({ input: { steps: 2 }, signal: new AbortController().signal });
    await expect(handler(context)).resolves.toEqual({ completedSteps: 2, attempt: 1 });
  });
});

describe("the diagnostic input schema", () => {
  const parse = (value: unknown) => DiagnosticJobInputSchema.safeParse(value);

  test("refuses unknown fields — including the platform-control spellings a fixture must never grow", () => {
    for (const bad of [
      { steps: 1, exit: true },
      { steps: 1, crash: true },
      { steps: 1, diagnostics: true },
    ]) {
      expect(parse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  test("refuses out-of-range and fractional values", () => {
    for (const bad of [
      { steps: 0 },
      { steps: DIAGNOSTIC_MAX_STEPS + 1 },
      { steps: 1, stepDelayMs: 1.5 },
      { steps: 1, stepDelayMs: DIAGNOSTIC_MAX_STEP_DELAY_MS + 1 },
      { steps: 1, stepDelayMs: -1 },
      { steps: 2, failAtStep: 3 },
    ]) {
      expect(parse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  test("refuses an own __proto__ key, like every wire object", () => {
    expect(parse(JSON.parse('{"steps":1,"__proto__":{}}')).success).toBe(false);
  });

  test("accepts the documented shapes", () => {
    expect(parse({ steps: 1 }).success).toBe(true);
    expect(
      parse({
        steps: DIAGNOSTIC_MAX_STEPS,
        stepDelayMs: DIAGNOSTIC_MAX_STEP_DELAY_MS,
        failAtStep: DIAGNOSTIC_MAX_STEPS,
        ignoreAbort: true,
      }).success,
    ).toBe(true);
  });
});

describe("the diagnostic type policy", () => {
  test("three attempts, a one-minute claim bound, a five-minute deadline, the fixture's input contract", () => {
    expect(JOBS_DIAGNOSTIC_TYPE_POLICY.retryLimit).toBe(2);
    expect(JOBS_DIAGNOSTIC_TYPE_POLICY.expireInSeconds).toBe(60);
    expect(JOBS_DIAGNOSTIC_TYPE_POLICY.deadlineSeconds).toBe(300);
    expect(JOBS_DIAGNOSTIC_TYPE_POLICY.inputSchema).toBe(DiagnosticJobInputSchema);
  });
});
