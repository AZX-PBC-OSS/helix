import { describe, expect, test } from "vitest";

import { decideWorkRecovery } from "./recovery.js";

/**
 * The recovery sweeper's reconciliation decision — pure, so the whole state
 * machine is a table here. The real paths against the real store and runner
 * are `recovery.integration.test.ts`; the `jobs_sweeper` grading the
 * snapshot feeds is table-tested in `health.test.ts`.
 */

describe("the reconciliation decision", () => {
  test("the deadline arm decides first and needs no runner row", () => {
    for (const row of [
      { verdict: "missing" },
      { verdict: "found", state: "active", output: null },
      { verdict: "found", state: "created", output: null },
      { verdict: "found", state: "failed", output: { code: "upstream_error" } },
    ] as const) {
      for (const status of ["queued", "running"] as const) {
        expect(
          decideWorkRecovery({ status, pastDeadline: true, cancellationRequested: false, row }),
        ).toEqual({
          outcome: "deadline_exceeded",
          code: "timeout",
        });
      }
    }
  });

  test("a runner row with no answer for a live record is corruption, reported and left", () => {
    expect(
      decideWorkRecovery({
        status: "running",
        pastDeadline: false,
        cancellationRequested: false,
        row: { verdict: "missing" },
      }),
    ).toEqual({ outcome: "row_missing" });
    expect(
      decideWorkRecovery({
        status: "queued",
        pastDeadline: false,
        cancellationRequested: false,
        row: { verdict: "missing" },
      }),
    ).toEqual({ outcome: "row_missing" });
  });

  test("a live claim is consistent work, whatever the record's non-terminal status", () => {
    expect(
      decideWorkRecovery({
        status: "running",
        pastDeadline: false,
        cancellationRequested: false,
        row: { verdict: "found", state: "active", output: null },
      }),
    ).toEqual({ outcome: "unaffected" });
    // A record still `queued` under an active claim is the begin's in-flight
    // window — the begin or the claim's own expiry resolves it.
    expect(
      decideWorkRecovery({
        status: "queued",
        pastDeadline: false,
        cancellationRequested: false,
        row: { verdict: "found", state: "active", output: null },
      }),
    ).toEqual({ outcome: "unaffected" });
  });

  test("a waiting row and a queued record agree — nothing to reconcile", () => {
    for (const state of ["created", "retry"] as const) {
      expect(
        decideWorkRecovery({
          status: "queued",
          pastDeadline: false,
          cancellationRequested: false,
          row: { verdict: "found", state, output: null },
        }),
      ).toEqual({ outcome: "unaffected" });
    }
  });

  test("a waiting row under a record still reading running is requeued, with the claim expiry's reason", () => {
    for (const state of ["created", "retry"] as const) {
      expect(
        decideWorkRecovery({
          status: "running",
          pastDeadline: false,
          cancellationRequested: false,
          row: { verdict: "found", state, output: { value: { message: "job timed out" } } },
        }),
      ).toEqual({ outcome: "requeued", code: "timeout" });
    }
  });

  test("a waiting row whose settle carried a worker-reported code requeues with that code", () => {
    expect(
      decideWorkRecovery({
        status: "running",
        pastDeadline: false,
        cancellationRequested: false,
        row: { verdict: "found", state: "retry", output: { code: "upstream_error" } },
      }),
    ).toEqual({ outcome: "requeued", code: "upstream_error" });
  });

  test("a terminally failed row projects the worker's own reported failure when the settle output carries it", () => {
    // The worker settled the claim (its fail's output names the reason) and
    // the wrapper projection was lost — an execution-store outage during the
    // attempt. The reported reason is what the record finally carries.
    expect(
      decideWorkRecovery({
        status: "running",
        pastDeadline: false,
        cancellationRequested: false,
        row: { verdict: "found", state: "failed", output: { code: "result_too_large" } },
      }),
    ).toEqual({ outcome: "failed", code: "result_too_large" });
    expect(
      decideWorkRecovery({
        status: "queued",
        pastDeadline: false,
        cancellationRequested: false,
        row: { verdict: "found", state: "failed", output: { code: "timeout" } },
      }),
    ).toEqual({ outcome: "failed", code: "timeout" });
  });

  test("a terminally failed row the worker never settled projects crashed — execution lost, no attempt left", () => {
    // The dependency's own expiry shapes: a claim timeout, a heartbeat
    // timeout, a shutdown string — and the serialized-error shape its own
    // handler-failure path stores (the begin-side store-outage disposition,
    // which carries a name and a message but never a worker-reported code) —
    // none is a worker report.
    for (const output of [
      { value: { message: "job timed out" } },
      { value: { message: "job heartbeat timeout" } },
      { value: "pg-boss shut down while active" },
      { name: "JobsStoreUnavailable", message: "the execution store could not answer the attempt" },
      "pg-boss shut down while active",
      null,
      undefined,
      { unrelated: true },
      { code: "not-a-public-code" },
    ]) {
      expect(
        decideWorkRecovery({
          status: "running",
          pastDeadline: false,
          cancellationRequested: false,
          row: { verdict: "found", state: "failed", output },
        }),
      ).toEqual({ outcome: "crashed", code: "platform_error" });
    }
  });

  test("a completed row under a non-terminal record projects crashed — the result is lost, never fabricated", () => {
    expect(
      decideWorkRecovery({
        status: "running",
        pastDeadline: false,
        cancellationRequested: false,
        row: { verdict: "found", state: "completed", output: null },
      }),
    ).toEqual({ outcome: "crashed", code: "platform_error" });
    expect(
      decideWorkRecovery({
        status: "queued",
        pastDeadline: false,
        cancellationRequested: false,
        row: { verdict: "found", state: "completed", output: null },
      }),
    ).toEqual({ outcome: "crashed", code: "platform_error" });
  });

  test("a cancelled row projects the cancellation — recovery never reissues cancelled work", () => {
    expect(
      decideWorkRecovery({
        status: "running",
        pastDeadline: false,
        cancellationRequested: false,
        row: { verdict: "found", state: "cancelled", output: null },
      }),
    ).toEqual({ outcome: "cancelled", code: "cancelled", resumeCancel: false });
    expect(
      decideWorkRecovery({
        status: "queued",
        pastDeadline: false,
        cancellationRequested: false,
        row: { verdict: "found", state: "cancelled", output: null },
      }),
    ).toEqual({ outcome: "cancelled", code: "cancelled", resumeCancel: false });
  });

  test("a pending cancellation on a waiting row re-drives the runner cancel and projects the intent's outcome", () => {
    // The intent's own runner drive never landed (a crash between the intent
    // write and the drive, or a runner outage): the row must be cancelled
    // before it can ever dispatch, and the record must reach the intent's
    // terminal outcome — never a retry of cancelled work.
    for (const state of ["created", "retry"] as const) {
      for (const status of ["queued", "running"] as const) {
        expect(
          decideWorkRecovery({
            status,
            pastDeadline: false,
            cancellationRequested: true,
            row: { verdict: "found", state, output: null },
          }),
        ).toEqual({ outcome: "cancelled", code: "cancelled", resumeCancel: true });
      }
    }
  });

  test("a pending cancellation on a live claim re-drives the fenced cancel and leaves the projection to the row's own state", () => {
    // An active row cannot be projected over truthfully: the pass re-drives
    // the cancel (whose answer the apply confirms) and the next pass reads
    // the row's own `cancelled` state.
    for (const status of ["queued", "running"] as const) {
      expect(
        decideWorkRecovery({
          status,
          pastDeadline: false,
          cancellationRequested: true,
          row: { verdict: "found", state: "active", output: null },
        }),
      ).toEqual({ outcome: "cancelled", code: "cancelled", resumeCancel: true });
    }
  });

  test("a pending cancellation loses to the deadline, to a worker-reported failure, and to a completed row", () => {
    // The deadline is the first terminal outcome to commit: whatever the
    // intent wanted, the timeout is the truthful answer past it.
    expect(
      decideWorkRecovery({
        status: "queued",
        pastDeadline: true,
        cancellationRequested: true,
        row: { verdict: "found", state: "created", output: null },
      }),
    ).toEqual({ outcome: "deadline_exceeded", code: "timeout" });
    // A worker-reported code is the job's own answer — a real failure that
    // ran and reported — not the cancellation fence's artifact: it outranks
    // the intent.
    expect(
      decideWorkRecovery({
        status: "running",
        pastDeadline: false,
        cancellationRequested: true,
        row: { verdict: "found", state: "completed", output: null },
      }),
    ).toEqual({ outcome: "crashed", code: "platform_error" });
    expect(
      decideWorkRecovery({
        status: "running",
        pastDeadline: false,
        cancellationRequested: true,
        row: { verdict: "found", state: "failed", output: { code: "upstream_error" } },
      }),
    ).toEqual({ outcome: "failed", code: "upstream_error" });
  });

  test("a code-less failed settle under a pending intent reaches cancelled — the fence's own signature, never a crash", () => {
    // The row failed because the cancellation's fence refused its claim (the
    // intent committed inside the gate's begin, or the drive was lost and
    // the claim expired): the work never produced an outcome. The owner was
    // acknowledged; the crashed disposition would contradict the recorded
    // cancellation and page operators for an owner-initiated stop.
    expect(
      decideWorkRecovery({
        status: "running",
        pastDeadline: false,
        cancellationRequested: true,
        row: { verdict: "found", state: "failed", output: null },
      }),
    ).toEqual({ outcome: "cancelled", code: "cancelled", resumeCancel: false });
    // Without the intent the same row is the runner's own expiry machinery's
    // settle — execution lost through a platform interruption.
    expect(
      decideWorkRecovery({
        status: "running",
        pastDeadline: false,
        cancellationRequested: false,
        row: { verdict: "found", state: "failed", output: null },
      }),
    ).toEqual({ outcome: "crashed", code: "platform_error" });
  });

  test("every code-less settle artifact the dependency writes reaches cancelled under a pending intent — not only the null output", () => {
    // The fence's signature is "no worker-reported code", not "no output":
    // the claim-expiry and shutdown settles the dependency writes for a lost
    // claim (the drive-lost crash window's own producer) carry its artifact
    // shapes, the begin-side store-outage disposition carries a name and a
    // message, and a code-shaped value outside the public vocabulary is not
    // a worker report either. Under a pending intent each is a cancelled
    // outcome — the work never produced an answer — and none is a crash.
    // The intent is the discriminator on every shape: the same outputs
    // without one reach crashed (the table above).
    for (const output of [
      { value: { message: "job timed out" } },
      { value: { message: "job heartbeat timeout" } },
      "pg-boss shut down while active",
      { name: "JobsStoreUnavailable", message: "the execution store could not answer the attempt" },
      { code: "not-a-public-code" },
      undefined,
    ]) {
      expect(
        decideWorkRecovery({
          status: "running",
          pastDeadline: false,
          cancellationRequested: true,
          row: { verdict: "found", state: "failed", output },
        }),
      ).toEqual({ outcome: "cancelled", code: "cancelled", resumeCancel: false });
    }
  });

  test("a pending intent never outranks the runner row's own absence or its already-cancelled state", () => {
    // A missing row is corruption regardless of the intent — the corruption
    // arm's report comes first, never a cancellation projected over an
    // unexplained absence.
    expect(
      decideWorkRecovery({
        status: "running",
        pastDeadline: false,
        cancellationRequested: true,
        row: { verdict: "missing" },
      }),
    ).toEqual({ outcome: "row_missing" });
    // A row READ cancelled settles the arm with the drive skipped even while
    // the intent is pending: `resumeCancel` rides the row's own state, so the
    // apply never re-drives a row the pass already read terminal.
    expect(
      decideWorkRecovery({
        status: "queued",
        pastDeadline: false,
        cancellationRequested: true,
        row: { verdict: "found", state: "cancelled", output: null },
      }),
    ).toEqual({ outcome: "cancelled", code: "cancelled", resumeCancel: false });
  });
});
