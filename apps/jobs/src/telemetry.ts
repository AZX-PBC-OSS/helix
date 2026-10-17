import {
  metrics,
  trace,
  SpanKind,
  SpanStatusCode,
  type Attributes,
  type Counter,
  type MeterProvider,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import {
  ATTR_OUTCOME,
  ATTR_JOBS_OPERATION,
  INSTR_JOBS_BURN_SWEEPS,
  INSTR_JOBS_CLEANUPS,
  INSTR_JOBS_EXECUTIONS,
  INSTR_JOBS_INSTRUCTIONS,
  INSTR_JOBS_RECOVERIES,
  INSTR_JOBS_STORAGE_PROBES,
  SPAN_JOBS_CLEANUP,
  SPAN_JOBS_EXECUTE,
  SPAN_JOBS_RECOVER,
  type JobsCleanupOutcome,
  type JobsExecuteOutcome,
  type JobsInstructionOutcome,
  type JobsRecoverOutcome,
} from "@azx-pbc/shared/telemetry";
import type { FastifyReply } from "fastify";

import { SERVICE_NAME } from "./serviceName.js";

/**
 * The jobs service's tracer, span helper and instruments — the same shape as
 * the edge's (`apps/edge/src/telemetry.ts`).
 *
 * **This module imports `@opentelemetry/api` and nothing else** — the facade
 * is dependency-free and no-ops when no provider is registered, which is what
 * lets it be reached from inside `buildApp()` without dragging an SDK or an
 * exporter into the test path (ADR-0037 decision 3). The SDK lives in
 * `@azx-pbc/telemetry`, imported only by `server.ts`.
 */

/**
 * Safe at module scope, unlike {@link instruments}: `trace.getTracer()` hands
 * back a `ProxyTracer` that re-resolves its delegate on **every**
 * `startSpan`, so a tracer captured before `startTelemetry()` runs still
 * emits once a provider is registered.
 */
export const tracer: Tracer = trace.getTracer(SERVICE_NAME);

/** Every metric the jobs service writes. One object so a call site can't miss one. */
export interface JobsInstruments {
  /** `outcome` ∈ `JOBS_STORAGE_PROBE_OUTCOMES` — the storage-readiness probes. */
  storageProbes: Counter;
  /** `operation` (the route's own), `outcome` ∈ `JOBS_INSTRUCTION_OUTCOMES` — the signed-instruction verifications. */
  instructions: Counter;
  /** `outcome` ∈ `JOBS_BURN_SWEEP_OUTCOMES` — the burn store's sweep passes. */
  burnSweeps: Counter;
  /** `outcome` ∈ `JOBS_EXECUTE_OUTCOMES` — the worker's execution attempts. */
  executions: Counter;
  /** `outcome` ∈ `JOBS_RECOVER_OUTCOMES` — the recovery sweeper's dispositions. */
  recoveries: Counter;
  /** `outcome` ∈ `JOBS_CLEANUP_OUTCOMES` — the cleanup loop's physical-retention passes. */
  cleanups: Counter;
}

/**
 * The last provider {@link instruments} built against, and what it built.
 *
 * **Not a plain module-level singleton** — `metrics.getMeter()` has no proxy:
 * it resolves the provider immediately, and with nothing registered that is
 * the noop meter whose instruments stay inert forever. ES imports are hoisted,
 * so `server.ts`'s import of `./app.js` evaluates this module *before* the
 * `startTelemetry(SERVICE_NAME)` call on the next line executes; a module-scope
 * meter would bind to the noop provider and **every metric would silently
 * vanish in production while every test passed**. Keying the cache on provider
 * identity makes the ordering irrelevant: the first call after a provider is
 * registered rebuilds against it, and a test that swaps providers gets fresh
 * instruments without a reset hook.
 */
let builtAgainst: MeterProvider | null = null;
let cached: JobsInstruments | null = null;

export function instruments(): JobsInstruments {
  const provider = metrics.getMeterProvider();
  if (cached && builtAgainst === provider) return cached;

  const meter = provider.getMeter(SERVICE_NAME);
  builtAgainst = provider;
  cached = {
    storageProbes: meter.createCounter(INSTR_JOBS_STORAGE_PROBES, {
      description:
        "Jobs storage-readiness probes by outcome. Operational only — a run of " +
        "unavailable with no ok is a store outage, and the health body names the reason for it.",
    }),
    instructions: meter.createCounter(INSTR_JOBS_INSTRUCTIONS, {
      description:
        "Signed internal instructions received, by operation and outcome. An attempt " +
        "counter over every presentation: a run of replayed is a capture-and-replay " +
        "attempt, a run of rejected is a forged or misconfigured minter, and a run of " +
        "unavailable is the burn store failing closed.",
    }),
    burnSweeps: meter.createCounter(INSTR_JOBS_BURN_SWEEPS, {
      description:
        "Burn-store sweep passes by outcome. Operational only — a run of failed with " +
        "no ok is a store that stopped answering its cleanup.",
    }),
    executions: meter.createCounter(INSTR_JOBS_EXECUTIONS, {
      description:
        "Job execution attempts by outcome. An attempt counter over every " +
        "disposition: a run of unavailable is an execution store that stopped " +
        "answering, a run of gate_refused is work whose lifecycle generation " +
        "closed before it could start, a run of deadline_exceeded is work the " +
        "absolute deadline terminated before an attempt, and failed counts " +
        "the attempts a job reported (the reason rides the span, never a " +
        "dimension).",
    }),
    recoveries: meter.createCounter(INSTR_JOBS_RECOVERIES, {
      description:
        "Interrupted jobs the recovery sweeper dispositioned, by outcome. " +
        "A run of crashed is worker loss recovering to its truthful terminal " +
        "outcome, a run of deadline_exceeded is deadline pressure (queue wait " +
        "or retries consuming the acceptance-to-close bound), and a run of " +
        "row_missing is an inconsistent store. The pass cadence itself is " +
        "graded by the jobs_sweeper health check, never a dimension here.",
    }),
    cleanups: meter.createCounter(INSTR_JOBS_CLEANUPS, {
      description:
        "Physical-retention passes the cleanup loop ran, by outcome. Passes " +
        "that remove nothing are routine silence; a run of failed with no ok " +
        "is a store that stopped answering its cleanup, and expired content " +
        "then grows past its removal bound until the jobs_cleanup health " +
        "check's overdue evidence clears.",
    }),
  };
  return cached;
}

/**
 * Count one signed-instruction presentation, at the seam every path passes.
 * The operation dimension is the route's own name; the outcome is the bounded
 * vocabulary — a call site cannot invent either.
 */
export function countInstruction(operation: string, outcome: JobsInstructionOutcome): void {
  instruments().instructions.add(1, {
    [ATTR_JOBS_OPERATION]: operation,
    [ATTR_OUTCOME]: outcome,
  });
}

/**
 * Count one execution attempt's disposition. The outcome is the bounded
 * vocabulary (`JOBS_EXECUTE_OUTCOMES`); the failure reason rides the span's
 * `helix.reason`, never a dimension here.
 */
export function countExecution(outcome: JobsExecuteOutcome): void {
  instruments().executions.add(1, { [ATTR_OUTCOME]: outcome });
}

/**
 * Count one interrupted job the recovery sweeper dispositioned. The outcome
 * is the bounded vocabulary (`JOBS_RECOVER_OUTCOMES`); the projected reason
 * rides the span's `helix.reason`, never a dimension here.
 */
export function countRecovery(outcome: JobsRecoverOutcome): void {
  instruments().recoveries.add(1, { [ATTR_OUTCOME]: outcome });
}

/**
 * Count one physical-retention pass the cleanup loop ran. The outcome is the
 * bounded pass vocabulary (`JOBS_CLEANUP_OUTCOMES`); the pass's removed
 * counts and lag evidence ride the pass span and the health checks, never a
 * dimension here.
 */
export function countCleanup(outcome: JobsCleanupOutcome): void {
  instruments().cleanups.add(1, { [ATTR_OUTCOME]: outcome });
}

/**
 * Record a thrown value on a span and mark it failed.
 *
 * The message reaches the span, which is a retained backend — acceptable
 * here: this plane's errors are our own (no upstream text, no token material —
 * the verifier answers in fixed reasons and nothing records token bytes).
 * Exported for the execution seam's deliberate grading: its `unavailable`
 * disposition (the execution store could not answer) is an infrastructure
 * fault and grades ERROR at every site that decides it.
 */
export function failSpan(span: Span, err: unknown): void {
  span.recordException(err instanceof Error ? err : new Error(String(err)));
  span.setStatus({ code: SpanStatusCode.ERROR });
}

/**
 * Mark a span failed when the response says so, not only when the handler
 * threw. **5xx only — a 4xx stays UNSET**: a 401 from instruction verification
 * is the receiver working exactly as designed (most presentations that fail
 * are noise by volume), and marking those ERROR would bury real faults.
 *
 * Only ever *raises* to ERROR — a span already failed in the `catch` keeps
 * that status even when no response was written.
 */
function gradeFromResponse(span: Span, reply: FastifyReply | undefined): void {
  if (reply && reply.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
}

/**
 * Run a handler inside a fresh **root** server span, ended when the handler
 * settles.
 *
 * `root: true` is the receiver's trust rule, not boilerplate: the caller is
 * not authenticated when the span opens, so the inbound `traceparent` (if any)
 * is unauthenticated metadata and must not choose this trace's parentage.
 * background-jobs-plane §9 permits extraction *after* the instruction
 * verifies — that is the operation handlers' seam as they land, never this
 * wrapper's.
 */
export function withRootSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
  options: { reply?: FastifyReply } = {},
): Promise<T> {
  return tracer.startActiveSpan(
    name,
    { root: true, kind: SpanKind.SERVER, attributes },
    async (span) => {
      try {
        return await fn(span);
      } catch (err) {
        failSpan(span, err);
        throw err;
      } finally {
        gradeFromResponse(span, options.reply);
        span.end();
      }
    },
  );
}

/**
 * Run one execution attempt inside a fresh **root** consumer span. Background
 * work has no inbound request context to continue — nothing is extracted, and
 * "execution links to enqueue" (ADR-0009) is carried by the span's bounded
 * attributes (the app, the qualified type, the job's public id and the attempt
 * number), which is the join an operator can make without a stored trace
 * context.
 *
 * The attempt's disposition sets its own outcome and status on the span; this
 * wrapper only ends it. A failure that escapes without a disposition is the
 * wrapper's own defect — the caller failSpans it explicitly.
 */
export function withExecutionSpan<T>(fn: (span: Span) => Promise<T>): Promise<T> {
  return withRootConsumerSpan(SPAN_JOBS_EXECUTE, fn);
}

/**
 * Run one interrupted job's reconciliation inside a fresh **root** consumer
 * span — one per job the recovery sweeper dispositioned, never for consistent
 * work the pass passes through. Same trust rule as the execution span
 * (background work, nothing extracted); the disposition's bounded outcome and
 * reason are the span's own evidence.
 */
export function withRecoverySpan<T>(fn: (span: Span) => Promise<T>): Promise<T> {
  return withRootConsumerSpan(SPAN_JOBS_RECOVER, fn);
}

/**
 * Run one physical-retention pass inside a fresh **root** consumer span —
 * one per pass, never per row (the burn-sweep/cadence proportionality). The
 * pass's own outcome and its batch-bounded removed counts are the span's
 * evidence; the lag and saturation measurements are the health checks'.
 */
export function withCleanupSpan<T>(fn: (span: Span) => Promise<T>): Promise<T> {
  return withRootConsumerSpan(SPAN_JOBS_CLEANUP, fn);
}

/** The shared mechanism behind both background-work spans: a fresh root consumer span, ended when the work settles. */
function withRootConsumerSpan<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { root: true, kind: SpanKind.CONSUMER }, async (span) => {
    try {
      return await fn(span);
    } finally {
      span.end();
    }
  });
}
