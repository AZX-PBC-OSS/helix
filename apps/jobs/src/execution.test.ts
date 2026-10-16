import { describe, expect, test } from "vitest";

import {
  isJsonValue,
  JOB_STATUSES,
  JOBS_MAX_RESULT_BYTES,
  JOBS_FETCH_QUALIFIED_TYPE,
} from "@azx-pbc/shared";

import {
  JobsExecutionError,
  JobsHandlerRegistry,
  publicStatus,
  serializeBoundedResult,
  storedExecutionError,
} from "./execution.js";

/**
 * The execution seam's pure contracts: the handler registry's screening (only
 * an installed type can register, once), the result bound (a JSON value
 * within the platform's allowance, refused as a distinct reason otherwise),
 * and the stored-value judgments both record readers share (fail-closed on a
 * stored value the wire contract does not carry). The worker's own projections
 * and the claim fencing are the integration suite's, against the real store
 * and the real runner.
 */

describe("JobsHandlerRegistry", () => {
  test("a registered installed type resolves to its handler", () => {
    const handlers = new JobsHandlerRegistry();
    const handler = async () => null;
    handlers.register(JOBS_FETCH_QUALIFIED_TYPE, handler);
    expect(handlers.handler(JOBS_FETCH_QUALIFIED_TYPE)).toBe(handler);
  });

  test("a type with no installed policy cannot register — production registration is the catalogue's", () => {
    const handlers = new JobsHandlerRegistry();
    expect(() => handlers.register("synthetic:fixture", async () => null)).toThrow(
      /no execution policy is installed/,
    );
    expect(handlers.handler("synthetic:fixture")).toBeUndefined();
  });

  test("a second registration of one type is refused, never a silent replacement", () => {
    const handlers = new JobsHandlerRegistry();
    handlers.register(JOBS_FETCH_QUALIFIED_TYPE, async () => "first");
    expect(() => handlers.register(JOBS_FETCH_QUALIFIED_TYPE, async () => "second")).toThrow(
      /already registered/,
    );
  });
});

describe("serializeBoundedResult", () => {
  test("a JSON value round-trips — scalars, null, objects and arrays", () => {
    expect(serializeBoundedResult(null)).toBeNull();
    expect(serializeBoundedResult(42)).toBe(42);
    expect(serializeBoundedResult("text")).toBe("text");
    expect(serializeBoundedResult({ a: [1, "x", { b: false }] })).toEqual({
      a: [1, "x", { b: false }],
    });
  });

  test("a value JSON cannot carry is result_invalid — never a silently altered store", () => {
    // Infinity serializes to null: the stored value would differ from the
    // returned one, so the judge refuses it before anything is written.
    expect(() => serializeBoundedResult(Infinity)).toThrow(JobsExecutionError);
    expect(() => serializeBoundedResult(undefined)).toThrow(JobsExecutionError);
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    try {
      serializeBoundedResult(circular);
      expect.unreachable("a circular result must be refused");
    } catch (error) {
      expect((error as JobsExecutionError).code).toBe("result_invalid");
    }
  });

  test("a result over the inclusive byte allowance is result_too_large — never stored partially", () => {
    const atCap = "x".repeat(JOBS_MAX_RESULT_BYTES - 2); // two quotes bring it to exactly the cap
    expect(JSON.stringify(atCap).length).toBe(JOBS_MAX_RESULT_BYTES);
    expect(serializeBoundedResult(atCap)).toBe(atCap);

    const overCap = `${atCap}x`;
    try {
      serializeBoundedResult(overCap);
      expect.unreachable("an oversized result must be refused");
    } catch (error) {
      expect((error as JobsExecutionError).code).toBe("result_too_large");
    }
  });

  test("a refusal's reason is the fixed sanitized error — no value text rides it", () => {
    // The message is the wrapper's own fixed text: whatever the handler
    // returned (here, a value whose serialization the bound refuses), the
    // error never quotes it.
    const oversized = { padding: "x".repeat(JOBS_MAX_RESULT_BYTES) };
    try {
      serializeBoundedResult(oversized);
      expect.unreachable("an oversized result must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(JobsExecutionError);
      expect((error as Error).message).not.toContain("padding");
      expect((error as Error).message).toMatch(/^the job's execution failed with reason/);
    }
  });

  test("the allowance counts UTF-8 bytes, not characters", () => {
    // Two-byte characters: 40 000 of them serialize to 40 002 characters —
    // comfortably under the cap counted in characters — but 80 002 bytes,
    // over it. A character-count bound would store what the byte bound
    // refuses, so the two readings must be distinguishable here.
    const overInBytes = "é".repeat(40_000);
    expect(overInBytes.length).toBeLessThan(JOBS_MAX_RESULT_BYTES);
    try {
      serializeBoundedResult(overInBytes);
      expect.unreachable("a result over the byte allowance must be refused");
    } catch (error) {
      expect((error as JobsExecutionError).code).toBe("result_too_large");
    }

    // The inclusive boundary is the byte count: exactly at it with the same
    // two-byte characters, the value is accepted unchanged.
    const atByteCap = "é".repeat((JOBS_MAX_RESULT_BYTES - 2) / 2);
    expect(atByteCap.length).toBeLessThan(JOBS_MAX_RESULT_BYTES);
    expect(serializeBoundedResult(atByteCap)).toBe(atByteCap);
  });

  test("a wire-legal result at the byte cap's maximum legal depth round-trips — the bound stores what the judge accepts", () => {
    // The inclusive cap lets a result nest 32,766 deep ("[" repeated 32,766 +
    // "null" + "]" repeated 32,766 = exactly 65,536 bytes) — the depth the
    // shared result contract judges wire-legal, and JSON.parse produces it
    // from an upstream body without complaint. The shared judge answers for
    // that depth iteratively; the bound's own serialization step must too.
    const depth = (JOBS_MAX_RESULT_BYTES - 4) / 2;
    const wire = "[".repeat(depth) + "null" + "]".repeat(depth);
    expect(wire.length).toBe(JOBS_MAX_RESULT_BYTES);
    const deep: unknown = JSON.parse(wire);
    expect(isJsonValue(deep)).toBe(true);

    let stored: unknown;
    expect(() => {
      stored = serializeBoundedResult(deep);
    }).not.toThrow();

    // The stored shape, verified iteratively (a recursive deep-equality would
    // hit the same engine stack limit the bound's serializer must not): the
    // round-trip preserves the nesting and its terminal value.
    let node: unknown = stored;
    let remaining = depth;
    while (remaining > 0) {
      expect(Array.isArray(node)).toBe(true);
      node = (node as unknown[])[0];
      remaining -= 1;
    }
    expect(node).toBeNull();
  });
});

describe("the stored-value judgments both record readers share", () => {
  test("every public status parses — the store CHECK's vocabulary and the wire enum cannot drift", () => {
    // The execution projection and the acceptance conflict reader go through
    // this one judgment: narrowed here, the schema dropping a status the
    // store's CHECK still accepts would surface as a throw on live rows.
    for (const status of JOB_STATUSES) {
      expect(publicStatus(status)).toBe(status);
    }
  });

  test("a stored status the contract does not carry is a defect answered by a throw, never a malformed body", () => {
    try {
      publicStatus("shipped");
      expect.unreachable("a non-public stored status must be refused");
    } catch (error) {
      expect((error as Error).message).toMatch(/not a public status: "shipped"/);
    }
  });

  test("a stored error code the contract does not carry is a defect answered by a throw", () => {
    try {
      storedExecutionError("upstream_erro");
      expect.unreachable("a non-public stored error code must be refused");
    } catch (error) {
      expect((error as Error).message).toMatch(/not a public code: "upstream_erro"/);
    }
  });
});
