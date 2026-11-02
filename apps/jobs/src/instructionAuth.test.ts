import { describe, expect, test } from "vitest";

import { JOBS_SERVER_NAME } from "@azx-pbc/shared";
import { JobsOperations } from "@azx-pbc/shared/jobsSigning";

import { createJobsInstructionAuth } from "./instructionAuth.js";
import {
  makeReceiver,
  MemoryBurns,
  mint,
  submitSpec,
  TEST_BODY,
  TEST_IAT,
  TEST_KEYS,
  TestClock,
} from "./test/instructions.js";

/**
 * The receiver seam's own contract, below the HTTP layer: every denial is
 * classified (outcome for the counter, reason for the span and log), the
 * verdicts are bounded, and a token is spent exactly once. The route-level
 * behavior these verdicts produce is `operations.test.ts`.
 */

describe("the instruction receiver seam", () => {
  test("a missing or unusable instruction header is classified, and consumes nothing", async () => {
    const { auth, burns } = makeReceiver();
    await expect(
      auth.authenticate("submit", {
        url: "/internal/jobs/v1/jobs",
        params: {},
        body: new TextEncoder().encode(TEST_BODY),
        instructionHeader: undefined,
      }),
    ).resolves.toMatchObject({ ok: false, status: 401, outcome: "rejected", reason: "missing" });

    await expect(
      auth.authenticate("submit", {
        url: "/internal/jobs/v1/jobs",
        params: {},
        body: new TextEncoder().encode(TEST_BODY),
        instructionHeader: ["not", "a", "token"],
      }),
    ).resolves.toMatchObject({ ok: false, status: 401, outcome: "rejected", reason: "malformed" });

    // An empty header value is the same "no instruction" presentation.
    await expect(
      auth.authenticate("submit", {
        url: "/internal/jobs/v1/jobs",
        params: {},
        body: new TextEncoder().encode(TEST_BODY),
        instructionHeader: "",
      }),
    ).resolves.toMatchObject({ ok: false, status: 401, outcome: "rejected", reason: "missing" });
    expect(burns.seen.size).toBe(0);
  });

  test("the verifier's reject reasons pass through as the denial's reason", async () => {
    const { auth, clock } = makeReceiver();
    const token = await mint(submitSpec());
    clock.nowS = TEST_IAT + 36; // past lifetime + tolerance: expired
    await expect(
      auth.authenticate("submit", {
        url: "/internal/jobs/v1/jobs",
        params: {},
        body: new TextEncoder().encode(TEST_BODY),
        instructionHeader: token,
        idempotencyKeyHeader: "retry-key-1",
      }),
    ).resolves.toMatchObject({ ok: false, outcome: "rejected", reason: "expired" });

    clock.nowS = TEST_IAT - 6; // before iat - tolerance: not yet valid
    await expect(
      auth.authenticate("submit", {
        url: "/internal/jobs/v1/jobs",
        params: {},
        body: new TextEncoder().encode(TEST_BODY),
        instructionHeader: token,
        idempotencyKeyHeader: "retry-key-1",
      }),
    ).resolves.toMatchObject({ ok: false, outcome: "rejected", reason: "not_yet_valid" });

    // A token signed under neither receiver's key.
    clock.nowS = TEST_IAT;
    const forged = await mint(submitSpec(), TEST_KEYS.other);
    await expect(
      auth.authenticate("submit", {
        url: "/internal/jobs/v1/jobs",
        params: {},
        body: new TextEncoder().encode(TEST_BODY),
        instructionHeader: forged,
        idempotencyKeyHeader: "retry-key-1",
      }),
    ).resolves.toMatchObject({ ok: false, outcome: "rejected", reason: "signature" });
  });

  test("a verified replay is classified as replayed, not rejected", async () => {
    const { auth, burns } = makeReceiver();
    const token = await mint(submitSpec());
    const request = {
      url: "/internal/jobs/v1/jobs",
      params: {},
      body: new TextEncoder().encode(TEST_BODY),
      instructionHeader: token,
      idempotencyKeyHeader: "retry-key-1",
    };
    await expect(auth.authenticate("submit", request)).resolves.toMatchObject({ ok: true });
    await expect(auth.authenticate("submit", request)).resolves.toMatchObject({
      ok: false,
      status: 401,
      outcome: "replayed",
    });
    expect(burns.seen.size).toBe(1);
  });

  test("a burn store that cannot answer is the unavailable outcome, mapped to 503", async () => {
    const receiver = makeReceiver();
    receiver.burns.failBurns = true;
    const token = await mint(submitSpec());
    await expect(
      receiver.auth.authenticate("submit", {
        url: "/internal/jobs/v1/jobs",
        params: {},
        body: new TextEncoder().encode(TEST_BODY),
        instructionHeader: token,
        idempotencyKeyHeader: "retry-key-1",
      }),
    ).resolves.toMatchObject({ ok: false, status: 503, outcome: "unavailable" });
    expect(receiver.burns.seen.size).toBe(0);
  });

  test("a claim the header contradicts is the idempotency_key rejection", async () => {
    const { auth } = makeReceiver();
    const token = await mint(submitSpec()); // signs "retry-key-1"
    await expect(
      auth.authenticate("submit", {
        url: "/internal/jobs/v1/jobs",
        params: {},
        body: new TextEncoder().encode(TEST_BODY),
        instructionHeader: token,
        idempotencyKeyHeader: "retry-key-2",
      }),
    ).resolves.toMatchObject({ ok: false, outcome: "rejected", reason: "idempotency_key" });
  });

  test("a burn store that cannot record the nonce logs the burn_failed event, with no token material", async () => {
    // The store-down arm's HTTP observable (the retryable 503) is the route
    // tests'; this is the operator's only explanation for a total denial
    // outage — the documented `jobs.instruction.burn_failed` event, carrying
    // the store's error and nothing about the presentation that hit it.
    const warnings: Array<Record<string, unknown>> = [];
    const burns = new MemoryBurns();
    const clock = new TestClock();
    const auth = createJobsInstructionAuth({
      serverId: JOBS_SERVER_NAME,
      keys: TEST_KEYS,
      burns,
      clock: clock.get,
      log: { warn: (obj) => warnings.push(obj) },
    });
    burns.failBurns = true;

    const token = await mint(submitSpec());
    await expect(
      auth.authenticate("submit", {
        url: "/internal/jobs/v1/jobs",
        params: {},
        body: new TextEncoder().encode(TEST_BODY),
        instructionHeader: token,
        idempotencyKeyHeader: "retry-key-1",
      }),
    ).resolves.toMatchObject({ ok: false, status: 503, outcome: "unavailable" });

    expect(warnings.map((w) => w.event)).toEqual(["jobs.instruction.burn_failed"]);
    expect(warnings[0]?.err).toBeInstanceOf(Error);
    // The same bounded-evidence rule the other denial events carry.
    const serialized = JSON.stringify(warnings);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("retry-key-1");
    expect(serialized).not.toContain(TEST_BODY);
  });

  test("the receiver never serves the jobs→edge callback direction", () => {
    const { auth } = makeReceiver();
    // The fetch operation's receiver is the edge; registering it here would be
    // a wiring defect, refused at the seam rather than miskeyed.
    expect(() =>
      auth.authenticate("fetch", {
        url: "/internal/jobs/v1/fetch",
        params: {},
        body: new Uint8Array(0),
        instructionHeader: "anything",
      }),
    ).rejects.toThrow(/receiver is the edge/);
    expect(JobsOperations.fetch.direction).toBe("jobsToEdge");
  });

  test("the denial log carries bounded evidence only — the event and the reason, never token or retry-key material", async () => {
    const warnings: Array<Record<string, unknown>> = [];
    const burns = new MemoryBurns();
    const clock = new TestClock();
    const auth = createJobsInstructionAuth({
      serverId: JOBS_SERVER_NAME,
      keys: TEST_KEYS,
      burns,
      clock: clock.get,
      log: { warn: (obj) => warnings.push(obj) },
    });

    const token = await mint(submitSpec());
    const request = {
      url: "/internal/jobs/v1/jobs",
      params: {},
      body: new TextEncoder().encode(TEST_BODY),
      instructionHeader: token,
      idempotencyKeyHeader: "retry-key-1",
    };
    await auth.authenticate("submit", request); // accepted — the log stays silent
    await auth.authenticate("submit", request); // replayed

    const forged = await mint(submitSpec(), TEST_KEYS.other);
    await auth.authenticate("submit", {
      ...request,
      instructionHeader: forged,
    }); // rejected — reason "signature"

    expect(warnings.map((w) => w.event)).toEqual([
      "jobs.instruction.replayed",
      "jobs.instruction.rejected",
    ]);
    expect(warnings[1]?.reason).toBe("signature");
    // The log is a retained store the same way the spans are: whatever the
    // presentation carried, the evidence is the bounded vocabulary only.
    const serialized = JSON.stringify(warnings);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(forged);
    expect(serialized).not.toContain("retry-key-1");
    expect(serialized).not.toContain(TEST_BODY);
  });
});
