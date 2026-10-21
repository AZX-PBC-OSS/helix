import { describe, expect, test } from "vitest";

import { JobsGenerationSchema } from "@azx-pbc/shared";

import { mergeLifecycleUpdate, lifecycleEligibility } from "./lifecycle.js";

/**
 * The lifecycle merge and the admission/start eligibility — the pure heart of
 * the generation authority, pinned exhaustively at the cheapest level: a
 * delivery moves the state forward or is a no-op that acknowledges the
 * highest applied generation, and a claimed generation admits only the
 * applied-and-open one.
 */

describe("merging a delivered lifecycle update", () => {
  test("the first delivery for an app applies as delivered", () => {
    expect(mergeLifecycleUpdate(null, { generation: "1", archived: false })).toEqual({
      state: { generation: "1", archived: false },
      changed: true,
    });
    // An archived first sync (an app already archived when the server is
    // enabled) applies closed — never opened by absence of history.
    expect(mergeLifecycleUpdate(null, { generation: "5", archived: true })).toEqual({
      state: { generation: "5", archived: true },
      changed: true,
    });
  });

  test("a newer delivery applies as delivered", () => {
    const stored = { generation: "3", archived: true };
    expect(mergeLifecycleUpdate(stored, { generation: "4", archived: false })).toEqual({
      state: { generation: "4", archived: false },
      changed: true,
    });
    expect(mergeLifecycleUpdate(stored, { generation: "4", archived: true })).toEqual({
      state: { generation: "4", archived: true },
      changed: true,
    });
  });

  test("an older delivery is a no-op — an out-of-order archive can neither close the newer generation nor reopen its own", () => {
    // The out-of-order leg of the done-when: the unarchive (generation 4)
    // applied before its preceding archive (generation 3) — the archive is
    // stale, the open generation 4 stands, and every generation below 4 is
    // ineligible through the watermark alone.
    const stored = { generation: "4", archived: false };
    expect(mergeLifecycleUpdate(stored, { generation: "3", archived: true })).toEqual({
      state: stored,
      changed: false,
    });
    // And an older OPEN delivery is just as unable to change anything.
    expect(mergeLifecycleUpdate(stored, { generation: "2", archived: false })).toEqual({
      state: stored,
      changed: false,
    });
  });

  test("a redelivery of the newest state is a no-op that keeps it", () => {
    for (const archived of [false, true]) {
      const stored = { generation: "7", archived };
      expect(mergeLifecycleUpdate(stored, { generation: "7", archived })).toEqual({
        state: stored,
        changed: false,
      });
    }
  });

  test("a delivery claiming an applied generation is archived closes it — an archive is never undone at the same generation", () => {
    expect(
      mergeLifecycleUpdate(
        { generation: "7", archived: false },
        { generation: "7", archived: true },
      ),
    ).toEqual({ state: { generation: "7", archived: true }, changed: true });
    // And the closed direction stays closed — a delivery claiming the applied
    // generation open cannot reopen an archived one.
    expect(
      mergeLifecycleUpdate(
        { generation: "7", archived: true },
        { generation: "7", archived: false },
      ),
    ).toEqual({ state: { generation: "7", archived: true }, changed: false });
  });

  test("generations compare numerically, not lexically", () => {
    // "10" > "9" numerically although "10" < "9" lexically — the decimal
    // string's whole point.
    const stored = { generation: "9", archived: false };
    expect(mergeLifecycleUpdate(stored, { generation: "10", archived: false }).changed).toBe(true);
    expect(
      mergeLifecycleUpdate(
        { generation: "10", archived: false },
        { generation: "9", archived: true },
      ).changed,
    ).toBe(false);
  });

  test("a delivery the wire schema refuses cannot launder through the merge — the yielded state is always wire-canonical", () => {
    // The same hole the gate re-checks claims for, on the delivery side: the
    // update type is the schema's unbranded infer, so a non-canonical string
    // is in-type. Whether the merge refuses such a delivery or canonicalizes
    // it, what it yields must parse as a generation — against a stored state
    // AND for an app's first delivery, where the delivered value becomes the
    // whole state. Canonicalization repairs the spelling, not the value:
    // BigInt accepts and the bigint column stores what the wire form forbids.
    for (const delivered of [
      "007",
      "008",
      "0x10",
      "0b1000",
      "0o10",
      "+8",
      " 8",
      "8\n",
      "-1",
      "-0",
    ]) {
      for (const stored of [null, { generation: "7", archived: false }]) {
        let result: ReturnType<typeof mergeLifecycleUpdate> | null = null;
        try {
          result = mergeLifecycleUpdate(stored, { generation: delivered, archived: false });
        } catch {
          // refused outright — the refusal shape of the fix; the leg then passes
        }
        if (result !== null) {
          expect(
            JobsGenerationSchema.safeParse(result.state.generation).success,
            `delivered ${JSON.stringify(delivered)} against ${
              stored === null ? "no state" : "generation 7"
            } yielded state ${JSON.stringify(result.state)}`,
          ).toBe(true);
        }
      }
    }
  });

  test("a canonical newer delivery still applies — the grammar refusal cannot swallow the wire form", () => {
    const merged = mergeLifecycleUpdate(
      { generation: "7", archived: false },
      { generation: "8", archived: false },
    );
    expect(merged).toEqual({
      state: { generation: "8", archived: false },
      changed: true,
    });
  });
});

describe("the admission/start eligibility", () => {
  test("an unknown app is unseen — the portal has not delivered this app's state", () => {
    expect(lifecycleEligibility(null, "1")).toEqual({ verdict: "unseen", appliedGeneration: null });
  });

  test("the applied and open generation admits", () => {
    expect(lifecycleEligibility({ generation: "3", archived: false }, "3")).toEqual({
      verdict: "admit",
    });
  });

  test("an older generation is closed — final, not waiting on delivery", () => {
    expect(lifecycleEligibility({ generation: "4", archived: false }, "3")).toEqual({
      verdict: "closed",
      appliedGeneration: "4",
    });
    // Closed whether the applied generation is open or archived.
    expect(lifecycleEligibility({ generation: "4", archived: true }, "1")).toEqual({
      verdict: "closed",
      appliedGeneration: "4",
    });
  });

  test("the applied generation under an archive is closed", () => {
    expect(lifecycleEligibility({ generation: "4", archived: true }, "4")).toEqual({
      verdict: "closed",
      appliedGeneration: "4",
    });
  });

  test("a newer generation is unseen — temporary, waiting for the portal's delivery, never opened here", () => {
    expect(lifecycleEligibility({ generation: "4", archived: false }, "5")).toEqual({
      verdict: "unseen",
      appliedGeneration: "4",
    });
  });

  test("an unreadable claimed generation fails closed", () => {
    // Unreachable through the routes (the claim schema refuses it first);
    // the gate's own answer for a value it cannot compare is closed.
    expect(lifecycleEligibility({ generation: "4", archived: false }, "not-a-generation")).toEqual({
      verdict: "closed",
      appliedGeneration: "4",
    });
  });

  test("a claim BigInt parses but the wire schema refuses fails closed, not admits", () => {
    // The fail-closed branch exists for claims that should never have reached
    // the gate — but BigInt's string grammar is strictly wider than
    // JobsGenerationSchema's: hex/binary/octal prefixes, an explicit sign and
    // surrounding whitespace all convert. A claim that is not a wire
    // generation must close even when it is numerically equal to the applied
    // one; admitting it would let a value the boundary refuses open work.
    for (const claim of ["0x4", "0b100", "0o4", "+4", " 4", "4\n"]) {
      expect(
        JobsGenerationSchema.safeParse(claim).success,
        `wire refuses ${JSON.stringify(claim)}`,
      ).toBe(false);
      expect(
        lifecycleEligibility({ generation: "4", archived: false }, claim),
        `claim ${JSON.stringify(claim)}`,
      ).toEqual({ verdict: "closed", appliedGeneration: "4" });
    }
  });

  test("generations compare numerically at the gate too", () => {
    expect(lifecycleEligibility({ generation: "10", archived: false }, "9")).toMatchObject({
      verdict: "closed",
    });
    expect(lifecycleEligibility({ generation: "9", archived: false }, "10")).toMatchObject({
      verdict: "unseen",
    });
  });
});
