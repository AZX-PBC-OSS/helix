import { describe, expect, test, vi } from "vitest";

import {
  isJsonValue,
  JOB_STATUSES,
  JOBS_MAX_RESULT_BYTES,
  JOBS_FETCH_QUALIFIED_TYPE,
  resolveJobsCapacityLimits,
} from "@azx-pbc/shared";

import {
  deadlinePassed,
  JobsExecution,
  JobsExecutionError,
  JobsHandlerRegistry,
  JobsSettleResponseUnreadable,
  publicStatus,
  serializeBoundedResult,
  settledAffected,
  storedExecutionError,
} from "./execution.js";

/**
 * The execution seam's pure contracts: the handler registry's screening (only
 * an installed type can register, once), the result bound (a JSON value
 * within the platform's allowance, refused as a distinct reason otherwise),
 * the worker-registration invariant (one live registration per runner
 * instance — the per-process execution allowance is not multipliable), the
 * absolute deadline's boundary judgment, and the stored-value judgments both
 * record readers share (fail-closed on a stored value the wire contract does
 * not carry). The worker's own projections and the claim fencing are the
 * integration suite's, against the real store and the real runner.
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

describe("the worker registration invariant", () => {
  /** The registration surface's calls, counted at the pg-boss boundary. */
  let workCalls = 0;
  let offWorkCalls = 0;
  /** The worker ids the boundary's answered offWork calls took off. */
  const offWorkTargets: string[] = [];

  /**
   * The stub's first N calls of each surface fail — the boundary's own
   * failure, injected where a real instance would fail. A `held` gate keeps
   * the boundary's work answer pending until the test releases it, so an
   * interleaving can be staged deterministically.
   */
  function stubBoss(
    failures: { work?: number; offWork?: number } = {},
    held?: { release(): void },
  ): unknown {
    workCalls = 0;
    offWorkCalls = 0;
    offWorkTargets.length = 0;
    return {
      work: async () => {
        workCalls += 1;
        if (workCalls <= (failures.work ?? 0)) {
          throw new Error("the instance could not take the worker");
        }
        if (held && workCalls === 1) {
          await new Promise<void>((resolve) => {
            held.release = resolve;
          });
        }
        return "worker-1";
      },
      offWork: async (_queue: string, target: { id: string }) => {
        offWorkCalls += 1;
        if (offWorkCalls <= (failures.offWork ?? 0)) {
          throw new Error("the release could not be confirmed");
        }
        offWorkTargets.push(target.id);
      },
    };
  }

  function execution(log = { info: () => {}, warn: () => {}, error: () => {} }): JobsExecution {
    return new JobsExecution({
      databaseUrl: "postgresql://.jobs.unit.test/jobs",
      statementTimeoutMs: 1_000,
      handlers: new JobsHandlerRegistry(),
      limits: resolveJobsCapacityLimits(),
      log,
    });
  }

  test("a second live registration on one instance is refused — a work call spawns its own full worker set, so the per-process allowance would silently multiply", async () => {
    const boss = stubBoss() as never;
    const component = execution();
    await component.registerOn(boss);
    expect(workCalls).toBe(1);
    await expect(component.registerOn(boss)).rejects.toThrow(
      /already holds a live worker registration/,
    );
    expect(workCalls).toBe(1); // the refusal happened before any second work call
  });

  test("the invariant holds across components — whichever component attempts the second live registration is refused", async () => {
    const boss = stubBoss() as never;
    await execution().registerOn(boss);
    await expect(execution().registerOn(boss)).rejects.toThrow(
      /already holds a live worker registration/,
    );
    expect(workCalls).toBe(1);
  });

  test("a released registration frees the instance — one live worker at a time, per instance", async () => {
    const boss = stubBoss() as never;
    const component = execution();
    await component.registerOn(boss);
    await component.releaseOn(boss);
    expect(offWorkCalls).toBe(1);
    await component.registerOn(boss);
    expect(workCalls).toBe(2);
  });

  test("releasing what was never registered is a no-op", async () => {
    const boss = stubBoss() as never;
    await execution().releaseOn(boss);
    expect(offWorkCalls).toBe(0);
  });

  test("a release that fails leaves the registration held — the retry takes the same worker off, and only its answer frees the instance", async () => {
    const boss = stubBoss({ offWork: 1 }) as never;
    const component = execution();
    const workerId = await component.registerOn(boss);
    await expect(component.releaseOn(boss)).rejects.toThrow(/could not be confirmed/);
    // The failed release never freed the slot: a re-registration here would
    // run two live worker sets on one instance.
    await expect(component.registerOn(boss)).rejects.toThrow(
      /already holds a live worker registration/,
    );
    await component.releaseOn(boss);
    expect(offWorkTargets).toEqual([workerId]);
    await component.registerOn(boss);
  });

  test("a failed registration attempt holds nothing — the instance can take its worker once the boundary answers", async () => {
    const boss = stubBoss({ work: 1 }) as never;
    const component = execution();
    // The boundary's own failure propagates — not the guard's refusal: a
    // failed start attempt must not brick the instance's future registrations.
    await expect(component.registerOn(boss)).rejects.toThrow(/could not take the worker/);
    await component.registerOn(boss);
    expect(workCalls).toBe(2);
  });

  test("a landed registration keeps its record when the success report throws — only the release frees the instance", async () => {
    // The runner's own reports are sink-guarded because a sink that throws is
    // a real case (runner.ts's guard rails): here the sink throws AFTER the
    // boundary answered, so the worker set is live. The sink's error still
    // reaches the caller (the runner's failed-start disposition — the
    // instance is discarded), but the record must hold: freeing it here would
    // let a re-registration double the allowance through the guard itself.
    const sink = new Error("the reporting sink is down");
    const boss = stubBoss() as never;
    const component = execution({
      info: () => {
        throw sink;
      },
      warn: () => {},
      error: () => {},
    });
    await expect(component.registerOn(boss)).rejects.toBe(sink);
    await expect(component.registerOn(boss)).rejects.toThrow(
      /already holds a live worker registration/,
    );
    // And the held record still releases what landed.
    await component.releaseOn(boss);
    expect(offWorkCalls).toBe(1);
  });

  test("the invariant is per instance — every instance's own registration stands, and the refusal stays on the doubled one", async () => {
    // Two worker processes in one process is the two-runner composition's
    // shape: the guard counts registrations per instance, never process-wide.
    const instanceA = stubBoss() as never;
    const instanceB = stubBoss() as never;
    await execution().registerOn(instanceA);
    await execution().registerOn(instanceB);
    await expect(execution().registerOn(instanceA)).rejects.toThrow(
      /already holds a live worker registration/,
    );
  });

  test("two overlapping registrations cannot both land — the guard's answer and its record must not straddle the boundary call", async () => {
    // Two overlapping calls must leave exactly one live worker set: if both
    // land, the per-process allowance the guard exists to hold has doubled,
    // and only the recorded set is releasable — the other is an orphan until
    // the instance dies.
    const boss = stubBoss() as never;
    const component = execution();
    const attempts = await Promise.allSettled([
      component.registerOn(boss),
      component.registerOn(boss),
    ]);
    const refused = attempts.filter((attempt) => attempt.status === "rejected");
    expect(
      refused.length,
      `both overlapping registrations landed (${workCalls} work calls answered) — the instance now runs a doubled worker set`,
    ).toBe(1);
    expect(workCalls).toBe(1);
  });

  test("a release landing during an in-flight registration waits it out and releases what landed", async () => {
    // The record holds the registration's own promise, so a release that
    // lands mid-registration can wait for the boundary's answer instead of
    // stranding the worker set that is about to exist.
    const gate = { release: () => {} };
    const boss = stubBoss({}, gate) as never;
    const component = execution();
    const registering = component.registerOn(boss);
    const releasing = component.releaseOn(boss);
    gate.release();
    const [workerId] = await Promise.all([registering, releasing]);
    expect(offWorkTargets).toEqual([workerId]);
    // Freed by that release: the instance's next registration stands.
    await component.registerOn(boss);
  });

  test("a release landing during a registration the boundary refuses carries the refusal and holds nothing", async () => {
    // The failure leg of the wait-out contract: the release waits on a
    // registration that never lands. Nothing is releasable, so no offWork is
    // attempted, the failure carries its cause to both callers, and the
    // record frees — the instance can take its worker once the boundary
    // answers.
    const boss = stubBoss({ work: 1 }) as never;
    const component = execution();
    const registering = component.registerOn(boss);
    const releasing = component.releaseOn(boss);
    await expect(registering).rejects.toThrow(/could not take the worker/);
    await expect(releasing).rejects.toThrow(/could not take the worker/);
    expect(offWorkCalls).toBe(0);
    await component.registerOn(boss);
    expect(workCalls).toBe(2);
  });

  test("a stale overlapping release must not free a newer registration's record — the forget is only valid for the registration it released", async () => {
    // Two releases overlap on one landed registration; the boundary confirms
    // them out of order, and a re-registration lands in the window between
    // the faster release's forget and the slower one's. The slower release
    // released the OLD worker set — if its forget is unconditional it erases
    // the NEW registration's record, and the guard reopens over a live
    // worker set: the next registration doubles the per-process allowance.
    const offWorkResolvers: Array<() => void> = [];
    let registered = 0;
    const takenOff: string[] = [];
    const boss = {
      work: async () => {
        registered += 1;
        return `worker-${registered}`;
      },
      offWork: async (_queue: string, target: { id: string }) => {
        takenOff.push(target.id);
        await new Promise<void>((resolve) => {
          offWorkResolvers.push(resolve);
        });
      },
    } as never;
    const component = execution();
    await component.registerOn(boss); // worker-1 live, record held
    const firstRelease = component.releaseOn(boss);
    const secondRelease = component.releaseOn(boss);
    for (let i = 0; i < 10 && offWorkResolvers.length < 2; i += 1) {
      await Promise.resolve(); // park both releases inside their offWork calls
    }
    const [firstOffWork, secondOffWork] = offWorkResolvers;
    if (!firstOffWork || !secondOffWork) {
      throw new Error("both releases must be parked in their offWork calls");
    }
    secondOffWork(); // the second release's offWork answers first
    await secondRelease; // forgets the record — worker-1 is off, nothing held
    await component.registerOn(boss); // worker-2 lands; the record is its own
    firstOffWork(); // now the stale first release's offWork answers
    await firstRelease; // it released worker-1 — it must not forget worker-2's record
    expect(takenOff).toEqual(["worker-1", "worker-1"]);
    await expect(component.registerOn(boss)).rejects.toThrow(
      /already holds a live worker registration/,
    );
  });
});

describe("deadlinePassed", () => {
  test("the deadline instant itself is past — a boundary attempt is refused, one millisecond inside still runs", () => {
    // Both deadline enforcers read this judgment: at the bound exactly, the
    // work is past (recovery never authorizes execution after the deadline);
    // one millisecond inside, the attempt is still authorized.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-16T08:00:00.000Z"));
      const accepted = Date.parse("2026-10-16T07:59:00.000Z");
      expect(deadlinePassed(new Date(accepted), 60)).toBe(true);
      expect(deadlinePassed(new Date(accepted + 1), 60)).toBe(false);
      // A zero-second deadline is past at the acceptance instant itself.
      expect(deadlinePassed(new Date(accepted), 0)).toBe(true);
      // A future instant never reads past.
      expect(deadlinePassed(new Date(accepted + 3_600_000), 60)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the settle response's affected count", () => {
  test("a numeric count is read as is, including 0 for a lapsed claim", () => {
    expect(settledAffected({ jobs: ["a"], requested: 1, affected: 1, settled: ["a"] })).toBe(1);
    expect(settledAffected({ jobs: ["a"], requested: 1, affected: 0 })).toBe(0);
  });

  test("a response without a numeric count throws its own error instead of reading as 0", () => {
    for (const response of [
      {},
      { affected: "1" },
      { affected: null },
      { affected: Number.NaN },
      { count: 1 },
      null,
      undefined,
      1,
    ]) {
      expect(() => settledAffected(response)).toThrow(JobsSettleResponseUnreadable);
    }
  });
});
