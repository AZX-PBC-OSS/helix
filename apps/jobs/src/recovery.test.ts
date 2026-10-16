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
        expect(decideWorkRecovery({ status, pastDeadline: true, row })).toEqual({
          outcome: "deadline_exceeded",
          code: "timeout",
        });
      }
    }
  });

  test("a runner row with no answer for a live record is corruption, reported and left", () => {
    expect(
      decideWorkRecovery({ status: "running", pastDeadline: false, row: { verdict: "missing" } }),
    ).toEqual({ outcome: "row_missing" });
    expect(
      decideWorkRecovery({ status: "queued", pastDeadline: false, row: { verdict: "missing" } }),
    ).toEqual({ outcome: "row_missing" });
  });

  test("a live claim is consistent work, whatever the record's non-terminal status", () => {
    expect(
      decideWorkRecovery({
        status: "running",
        pastDeadline: false,
        row: { verdict: "found", state: "active", output: null },
      }),
    ).toEqual({ outcome: "unaffected" });
    // A record still `queued` under an active claim is the begin's in-flight
    // window — the begin or the claim's own expiry resolves it.
    expect(
      decideWorkRecovery({
        status: "queued",
        pastDeadline: false,
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
        row: { verdict: "found", state: "failed", output: { code: "result_too_large" } },
      }),
    ).toEqual({ outcome: "failed", code: "result_too_large" });
    expect(
      decideWorkRecovery({
        status: "queued",
        pastDeadline: false,
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
        row: { verdict: "found", state: "completed", output: null },
      }),
    ).toEqual({ outcome: "crashed", code: "platform_error" });
    expect(
      decideWorkRecovery({
        status: "queued",
        pastDeadline: false,
        row: { verdict: "found", state: "completed", output: null },
      }),
    ).toEqual({ outcome: "crashed", code: "platform_error" });
  });

  test("a cancelled row projects the cancellation — recovery never reissues cancelled work", () => {
    expect(
      decideWorkRecovery({
        status: "running",
        pastDeadline: false,
        row: { verdict: "found", state: "cancelled", output: null },
      }),
    ).toEqual({ outcome: "cancelled", code: "cancelled" });
    expect(
      decideWorkRecovery({
        status: "queued",
        pastDeadline: false,
        row: { verdict: "found", state: "cancelled", output: null },
      }),
    ).toEqual({ outcome: "cancelled", code: "cancelled" });
  });
});
