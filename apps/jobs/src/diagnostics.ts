import {
  JOB_TYPE_CATALOGUE,
  JOB_TYPE_DIAGNOSTIC_CATALOGUE,
  JOBS_DIAGNOSTIC_QUALIFIED_TYPE,
  strictWireObject,
} from "@azx-pbc/shared";
import { z } from "zod";

import { JobsExecutionError, type JobsExecutionContext, type JobsHandler } from "./execution.js";
import {
  JOBS_TYPE_POLICIES,
  screenTypePolicies,
  type JobsTypePolicies,
  type JobsTypePolicy,
} from "./policy.js";

/**
 * The non-production diagnostic job — a test-owned fixture, not a public
 * contract. Its one behaviour is to walk a bounded number of steps, reporting
 * progress through the real execution paths, so the local/test stack can
 * deterministically exercise progress across attempts, retry exhaustion,
 * worker interruption (the TEST kills the process), cancellation and fenced
 * late completion. The input schema and result shape live here, beside the
 * handler, for the same reason: they are not a platform contract and must not
 * drift into one.
 *
 * Registered only when the deployment's `JOBS_DIAGNOSTICS` knob is on, and
 * impossible to enable in production (the config loader refuses it, and the
 * production catalogue never carries the type). No process controls of any
 * kind: a fixture that could exit or crash the worker would be a remote
 * control pointed at the service.
 */

/** The step-count ceiling. */
export const DIAGNOSTIC_MAX_STEPS = 20;
/** The per-step wait ceiling, in whole milliseconds. */
export const DIAGNOSTIC_MAX_STEP_DELAY_MS = 1_000;
/** The platform-authored progress label (byte-bounded by the shared progress schema). */
export const DIAGNOSTIC_PROGRESS_LABEL = "Diagnostic step";

export const DiagnosticJobInputSchema = strictWireObject({
  steps: z.int().min(1).max(DIAGNOSTIC_MAX_STEPS),
  /** Whole milliseconds only — a fractional delay is refused, never coerced. */
  stepDelayMs: z.int().min(0).max(DIAGNOSTIC_MAX_STEP_DELAY_MS).optional(),
  /** A retryable failure raised at this step on EVERY attempt. */
  failAtStep: z.int().min(1).max(DIAGNOSTIC_MAX_STEPS).optional(),
  /** Keep running after the attempt's abort — the fenced-late-completion case. */
  ignoreAbort: z.boolean().optional(),
}).superRefine((input, ctx) => {
  if (
    typeof input.steps === "number" &&
    typeof input.failAtStep === "number" &&
    input.failAtStep > input.steps
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["failAtStep"],
      message: "failAtStep must not exceed steps",
    });
  }
});
export type DiagnosticJobInput = z.infer<typeof DiagnosticJobInputSchema>;

export interface DiagnosticJobResult {
  completedSteps: number;
  attempt: number;
}

/**
 * The diagnostic type's execution policy: three attempts, a one-minute
 * per-attempt claim bound, and the platform-default five-minute deadline —
 * screened against the diagnostic catalogue where the type is installed.
 */
export const JOBS_DIAGNOSTIC_TYPE_POLICY: JobsTypePolicy = {
  retryLimit: 2,
  expireInSeconds: 60,
  deadlineSeconds: 300,
  inputSchema: DiagnosticJobInputSchema,
};

/**
 * The policy set a composition installs: the production set itself when
 * diagnostics are off; otherwise a new frozen set that adds the diagnostic
 * policy, screened against the production plus diagnostic catalogues. The
 * production set is never mutated.
 */
export function jobsInstalledTypePolicies(options: { diagnostics: boolean }): JobsTypePolicies {
  if (!options.diagnostics) return JOBS_TYPE_POLICIES;
  return Object.freeze(
    screenTypePolicies(
      {
        ...JOBS_TYPE_POLICIES,
        [JOBS_DIAGNOSTIC_QUALIFIED_TYPE]: JOBS_DIAGNOSTIC_TYPE_POLICY,
      },
      [...JOB_TYPE_CATALOGUE, ...JOB_TYPE_DIAGNOSTIC_CATALOGUE],
    ),
  );
}

/**
 * Resolve after `ms`, or early with `true` when the signal aborts first. The
 * timer is cleared and the abort listener removed on every exit path — no
 * timer or listener may outlive the attempt it served.
 */
function waitInterruptibly(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(true);
      return;
    }
    const onAbort = () => done(true);
    const timer = setTimeout(() => done(false), ms);
    function done(aborted: boolean) {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(aborted);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** An uninterruptible wait — for `ignoreAbort`, whose wait is not cut short. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The diagnostic handler: walk steps 1..`steps`, reporting each, failing
 * retryably at `failAtStep`, honouring the attempt's abort signal unless
 * `ignoreAbort`. A refused progress report does not fail the work — the
 * attempt's settlement is fenced either way.
 */
export function makeDiagnosticJobHandler(): JobsHandler {
  return async (context: JobsExecutionContext): Promise<unknown> => {
    const input: DiagnosticJobInput = DiagnosticJobInputSchema.parse(context.input);
    const stepDelayMs = input.stepDelayMs ?? 0;
    const ignoreAbort = input.ignoreAbort === true;

    for (let step = 1; step <= input.steps; step++) {
      if (!ignoreAbort && context.signal.aborted) {
        throw new JobsExecutionError("cancelled");
      }
      if (stepDelayMs > 0) {
        if (ignoreAbort) {
          await delay(stepDelayMs);
        } else if (await waitInterruptibly(stepDelayMs, context.signal)) {
          throw new JobsExecutionError("cancelled");
        }
      }
      if (!ignoreAbort && context.signal.aborted) {
        throw new JobsExecutionError("cancelled");
      }
      if (step === input.failAtStep) {
        throw new JobsExecutionError("upstream_error");
      }
      await context.report({ step, of: input.steps, label: DIAGNOSTIC_PROGRESS_LABEL });
    }
    return { completedSteps: input.steps, attempt: context.attempt } satisfies DiagnosticJobResult;
  };
}
