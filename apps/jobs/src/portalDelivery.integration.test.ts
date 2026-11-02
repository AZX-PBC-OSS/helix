import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MemoryBurns, MemoryLifecycle, appWithLifecycle } from "./test/instructions.js";
import { createJobsInstructionAuth } from "./instructionAuth.js";
import { deriveJobsInstructionKey } from "@azx-pbc/shared/jobsSigning";
import { HttpLifecycleDelivery } from "../../portal/src/jobs/deliveryHttp.js";
import { lifecycleUpdateBytes } from "../../portal/src/jobs/delivery.js";

/**
 * The lifecycle-delivery hop's two real ends, over a real socket: the portal
 * sender's production transport presents a freshly minted portal→jobs
 * instruction to the REAL jobs receiver (its own route, verification, burn
 * store and body parse — `appWithLifecycle`), and the sender classifies the
 * receiver's real acknowledgement. The doubles are the receiver's own seams
 * (in-memory burns, the in-memory applier over the production merge) — the
 * durable halves of those seams are pinned in this package's suites; what
 * this file pins is that the two planes' WIRE halves meet: the mint the
 * receiver verifies, the bytes it applies, and the ack the sender accepts.
 * The composed end-to-end journey (enablement, real processes) is the
 * enablement ticket's assembly.
 */

const SERVER = "jobs";
/** The shared test root for the portal→jobs direction — test data, never deployed. */
const PORTAL_TO_JOBS_ROOT = "jUwQKa33JNljh0jULeithrh3JOL8dUmxPJknzGCjQBA=";
const KEY = deriveJobsInstructionKey(PORTAL_TO_JOBS_ROOT, "portalToJobs");

let app: FastifyInstance;
let lifecycle: MemoryLifecycle;
let base: string;

beforeAll(async () => {
  lifecycle = new MemoryLifecycle();
  // The receiver's verification runs on the real clock — the sender's
  // transport mints at real time, so the pinned test clock would refuse every
  // token as expired. The burns stay the in-memory seam (first-use/replay).
  const receiver = {
    auth: createJobsInstructionAuth({
      serverId: SERVER,
      keys: {
        edgeToJobs: deriveJobsInstructionKey(PORTAL_TO_JOBS_ROOT, "edgeToJobs"),
        portalToJobs: KEY,
      },
      burns: new MemoryBurns(),
      clock: () => Math.floor(Date.now() / 1_000),
      log: { warn: () => {} },
    }),
    burns: new MemoryBurns(),
    clock: { nowS: 0, get: () => Math.floor(Date.now() / 1_000) },
  };
  const built = await appWithLifecycle(receiver, lifecycle);
  app = built.app;
  await app.ready();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the receiver's listener never bound a port");
  }
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app?.close();
});

describe("the portal sender's transport against the real jobs receiver", () => {
  it("delivers a lifecycle change the receiver verifies, applies and acknowledges", async () => {
    const appId = randomUUID();
    const transport = new HttpLifecycleDelivery({ timeoutMs: 5_000 });

    const answer = await transport.deliver({
      server: SERVER,
      endpoint: base,
      key: KEY,
      appId,
      body: lifecycleUpdateBytes({ generation: 3, archived: true }),
    });

    // The receiver's apply-before-acknowledge contract, observed from the
    // sender's side: the acknowledged generation is the one durably applied.
    expect(answer).toEqual({ kind: "acknowledged", appliedGeneration: "3" });
    expect(lifecycle.apps.get(appId)).toEqual({ generation: "3", archived: true });
  });

  it("a redelivery is harmless: the receiver answers stale and the ack still covers the row", async () => {
    const appId = randomUUID();
    const transport = new HttpLifecycleDelivery({ timeoutMs: 5_000 });
    const body = lifecycleUpdateBytes({ generation: 1, archived: false });
    const attempt = {
      server: SERVER,
      endpoint: base,
      key: KEY,
      appId,
      body,
    };

    expect(await transport.deliver(attempt)).toEqual({
      kind: "acknowledged",
      appliedGeneration: "1",
    });
    // At-least-once delivery: the same intent arrives again (a lost first
    // ack), the receiver's watermark answers without changing state, and the
    // sender still reads an acknowledgement covering the row.
    expect(await transport.deliver(attempt)).toEqual({
      kind: "acknowledged",
      appliedGeneration: "1",
    });
    expect(lifecycle.apps.get(appId)).toEqual({ generation: "1", archived: false });
  });

  it("a delivery the receiver cannot apply answers the retryable refusal, never a fabricated ack", async () => {
    const appId = randomUUID();
    lifecycle.failApplies = true;
    try {
      const answer = await new HttpLifecycleDelivery({ timeoutMs: 5_000 }).deliver({
        server: SERVER,
        endpoint: base,
        key: KEY,
        appId,
        body: lifecycleUpdateBytes({ generation: 2, archived: false }),
      });
      expect(answer.kind).toBe("refused");
      if (answer.kind === "refused") {
        expect(answer.status).toBe(503);
        expect(answer.error.code).toBe("jobs_unavailable");
      }
      expect(lifecycle.apps.has(appId)).toBe(false);
    } finally {
      lifecycle.failApplies = false;
    }
  });
});
