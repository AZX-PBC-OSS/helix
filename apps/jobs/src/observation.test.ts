import { describe, expect, test } from "vitest";

import { JOBS_RECORD_TTL_SECONDS, JOBS_RESULT_TTL_SECONDS } from "./policy.js";
import {
  projectedPublicStatus,
  recordExpiresAtIso,
  recordHorizonPassed,
  resultExpiresAtIso,
  resultHorizonPassed,
  type JobRecordHorizonRow,
} from "./observation.js";

/**
 * The logical public-read horizons — the pure projection every reader of the
 * record's public state consumes (the observation routes, the cancellation
 * seam's terminal classification, the acceptance transaction's retained-key
 * comparison). The boundary instants are pinned inclusive: at exactly seven
 * days the result reads expired, at exactly thirty days the record reads
 * unknown — "remain readable FOR seven days" ends at the boundary.
 */

function row(over: Partial<JobRecordHorizonRow> = {}): JobRecordHorizonRow {
  return { status: "queued", terminal_at: null, ...over };
}

const NOW = new Date("2026-10-17T12:00:00.000Z");
const justUnder = (ms: number): Date => new Date(NOW.getTime() - ms + 1);
const exactly = (ms: number): Date => new Date(NOW.getTime() - ms);

describe("the record horizon", () => {
  test("a non-terminal record is never expired by age", () => {
    const ancient = row({ status: "queued", terminal_at: null });
    expect(recordHorizonPassed(ancient, NOW)).toBe(false);
    expect(projectedPublicStatus(ancient, NOW)).toBe("queued");
  });

  test("a terminal record passes its horizon at exactly thirty days, not before", () => {
    const terminal = row({
      status: "failed",
      terminal_at: exactly(JOBS_RECORD_TTL_SECONDS * 1_000),
    });
    expect(recordHorizonPassed(terminal, NOW)).toBe(true);
    const fresh = row({
      status: "failed",
      terminal_at: justUnder(JOBS_RECORD_TTL_SECONDS * 1_000),
    });
    expect(recordHorizonPassed(fresh, NOW)).toBe(false);
  });

  test("the record horizon applies to every terminal outcome, success included", () => {
    for (const status of ["succeeded", "failed", "crashed", "cancelled", "expired"] as const) {
      const terminal = row({
        status,
        terminal_at: exactly(JOBS_RECORD_TTL_SECONDS * 1_000),
      });
      expect(recordHorizonPassed(terminal, NOW), status).toBe(true);
    }
  });

  test("the projected record expiry instant is terminal_at plus thirty days; an unfinished job has none", () => {
    const terminalAt = new Date("2026-10-01T00:00:00.000Z");
    expect(recordExpiresAtIso(row({ status: "failed", terminal_at: terminalAt }))).toBe(
      "2026-10-31T00:00:00.000Z",
    );
    expect(recordExpiresAtIso(row({ status: "queued", terminal_at: null }))).toBeNull();
  });
});

describe("the result horizon", () => {
  test("a successful result passes its horizon at exactly seven days, not before", () => {
    const atBoundary = row({
      status: "succeeded",
      terminal_at: exactly(JOBS_RESULT_TTL_SECONDS * 1_000),
    });
    expect(resultHorizonPassed(atBoundary, NOW)).toBe(true);
    const within = row({
      status: "succeeded",
      terminal_at: justUnder(JOBS_RESULT_TTL_SECONDS * 1_000),
    });
    expect(resultHorizonPassed(within, NOW)).toBe(false);
  });

  test("a row the cleanup already projected expired stays expired", () => {
    const projected = row({
      status: "expired",
      terminal_at: exactly(JOBS_RESULT_TTL_SECONDS * 1_000),
    });
    expect(resultHorizonPassed(projected, NOW)).toBe(true);
    expect(projectedPublicStatus(projected, NOW)).toBe("expired");
  });

  test("only a formerly successful result expires — every other status keeps its own", () => {
    for (const status of ["queued", "running", "failed", "crashed", "cancelled"] as const) {
      const terminal = row({
        status,
        terminal_at: exactly(JOBS_RECORD_TTL_SECONDS * 1_000),
      });
      expect(resultHorizonPassed(terminal, NOW), status).toBe(false);
    }
  });

  test("the projected status is expired at the boundary, however delayed the physical cleanup", () => {
    const past = row({
      status: "succeeded",
      terminal_at: exactly(JOBS_RESULT_TTL_SECONDS * 1_000),
    });
    expect(projectedPublicStatus(past, NOW)).toBe("expired");
    const within = row({
      status: "succeeded",
      terminal_at: justUnder(JOBS_RESULT_TTL_SECONDS * 1_000),
    });
    expect(projectedPublicStatus(within, NOW)).toBe("succeeded");
  });

  test("the projected result expiry instant is the success instant plus seven days", () => {
    const succeededAt = new Date("2026-10-01T00:00:00.000Z");
    expect(resultExpiresAtIso(row({ status: "succeeded", terminal_at: succeededAt }))).toBe(
      "2026-10-08T00:00:00.000Z",
    );
    // The same clock the expired projection keeps: expiry never restarts the
    // record's own lifetime.
    expect(resultExpiresAtIso(row({ status: "expired", terminal_at: succeededAt }))).toBe(
      "2026-10-08T00:00:00.000Z",
    );
    expect(resultExpiresAtIso(row({ status: "failed", terminal_at: succeededAt }))).toBeNull();
  });
});

describe("the expiry derivations' defect guard", () => {
  test("a successful record carrying no terminal instant is a defect thrown — never read as an absent horizon", () => {
    // The store's own CHECK (a terminal row is always dated) makes this
    // state unrepresentable at write time; the derivation throws so a store
    // that evaded it surfaces as the caller's failure contract, never as a
    // snapshot whose result expiry reads null while the result is readable.
    const undated = row({ status: "succeeded", terminal_at: null });
    expect(() => resultExpiresAtIso(undated)).toThrow(/no terminal instant/);
  });
});

describe("the projected status's stored-vocabulary guard", () => {
  test("a stored status the wire contract does not carry is a defect, thrown — never read as a state", () => {
    const corrupt = row({ status: "pending", terminal_at: null });
    expect(() => projectedPublicStatus(corrupt, NOW)).toThrow(/not a public status/);
  });

  test("every terminal outcome keeps its own status until its result horizon gives it expired", () => {
    const withinBoth = row({
      status: "succeeded",
      terminal_at: justUnder(JOBS_RESULT_TTL_SECONDS * 1_000),
    });
    expect(projectedPublicStatus(withinBoth, NOW)).toBe("succeeded");
    for (const status of ["failed", "crashed", "cancelled"] as const) {
      const terminal = row({ status, terminal_at: justUnder(JOBS_RECORD_TTL_SECONDS * 1_000) });
      expect(projectedPublicStatus(terminal, NOW), status).toBe(status);
    }
  });
});
