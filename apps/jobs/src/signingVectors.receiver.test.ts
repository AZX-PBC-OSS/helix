import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  IDEMPOTENCY_KEY_HEADER,
  INSTRUCTION_HEADER,
  resolveJobsCapacityLimits,
} from "@azx-pbc/shared";
import {
  JOBS_CANCEL_OUTCOMES,
  JOBS_RESULT_OUTCOMES,
  JOBS_SNAPSHOT_OUTCOMES,
  JOBS_SUBMIT_OUTCOMES,
} from "@azx-pbc/shared/telemetry";
import {
  deriveJobsInstructionKey,
  JobsOperations,
  signJobsInstructionClaims,
  type JobsOperationName,
  type JobsSigningDirection,
} from "@azx-pbc/shared/jobsSigning";
import {
  implementJobsVectorTransform,
  JOBS_GOLDEN_TOKEN_VECTORS,
  JOBS_SIGNING_VECTOR_ROOTS,
  JOBS_SIGNING_VECTORS,
  type JobsGoldenTokenVector,
  type JobsSigningVector,
} from "@azx-pbc/shared/jobsSigningVectors";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";

import { buildApp } from "./app.js";
import { createJobsInstructionAuth } from "./instructionAuth.js";
import { JobsStorage } from "./storage.js";
import {
  MemoryAdmission,
  MemoryBurns,
  MemoryCancellation,
  MemoryLifecycle,
  MemoryObservation,
  appliedIntake,
  runningCleanup,
} from "./test/instructions.js";

/** One ended span, as the recording hands them over. */
type RecordedSpan = ReturnType<RecordingTelemetry["spans"]>[number];

/**
 * The jobs receiver judged against the shared signing-vector corpus and the
 * recorded golden tokens, through the real routes: every edge→jobs
 * and portal→jobs vector is presented to a receiver configured exactly as the
 * vector expects — the server it serves, the root it holds, the clock it
 * verifies at — and the receiver's answer must match the corpus's verdict.
 * A durable burn is receiver state the corpus deliberately does not model, so
 * a fresh in-memory store per vector keeps the stateless corpus stateless;
 * the burn's own durability is pinned by `burns.test.ts` and the boot suite.
 *
 * Judgment shape, per vector: an expect-accept vector must reach its
 * operation (the span's `accepted` outcome); an expect-reject vector must
 * fail with the corpus's reason — or be refused even earlier, at the route
 * matrix, where no span exists (a presentation the receiver's method routing
 * cannot serve is the same denial with fewer words). A 500 or a served
 * operation never conforms to either.
 *
 * The fetch direction's vectors belong to the edge callback receiver; this
 * service refuses to serve that direction at all. Those
 * vectors are counted and named here — never silently absorbed.
 */

/** Derive the key one (direction, server) corpus root defines. */
function corpusKey(direction: JobsSigningDirection, server: string): Uint8Array {
  const entry = Object.values(JOBS_SIGNING_VECTOR_ROOTS).find(
    (root) => root.direction === direction && root.server === server,
  );
  if (!entry) throw new Error(`no vector root for ${direction}/${server}`);
  return deriveJobsInstructionKey(entry.root, direction);
}

/** Derive the key a vector root id names — what a receiver "holding" it verifies with. */
function signingKey(keyId: string): Uint8Array {
  const entry = JOBS_SIGNING_VECTOR_ROOTS[keyId];
  if (!entry) throw new Error(`no such vector root: ${keyId}`);
  return deriveJobsInstructionKey(entry.root, entry.direction);
}

interface Receiver {
  app: ReturnType<typeof buildApp>;
  storage: JobsStorage;
  clock: { nowS: number };
  burns: MemoryBurns;
  lifecycle: MemoryLifecycle;
}

const RECEIVERS = new Map<string, Receiver>();

/**
 * A receiver configured as a vector expects: serving `server`, holding the
 * root the vector's `keyId` names for the direction the operation verifies
 * with (the corpus's wrong-root vectors deliberately present receivers
 * holding another direction's derivation), the other direction's key from the
 * corpus's own (direction, server) root.
 */
function receiverFor(server: string, operation: JobsOperationName, keyId: string): Receiver {
  const cacheKey = `${server}:${operation}:${keyId}`;
  const existing = RECEIVERS.get(cacheKey);
  if (existing) return existing;
  const operationDirection =
    JobsOperations[operation].direction === "portalToJobs" ? "portalToJobs" : "edgeToJobs";
  const clock = { nowS: 0 };
  const burns = new MemoryBurns();
  const auth = createJobsInstructionAuth({
    serverId: server,
    keys: {
      edgeToJobs:
        operationDirection === "edgeToJobs" ? signingKey(keyId) : corpusKey("edgeToJobs", server),
      portalToJobs:
        operationDirection === "portalToJobs"
          ? signingKey(keyId)
          : corpusKey("portalToJobs", server),
    },
    burns,
    clock: () => clock.nowS,
    log: { warn: () => {} },
  });
  const storage = new JobsStorage({
    databaseUrl: "postgresql://helix_jobs:pw@db:5432/helix_jobs_test",
    statementTimeoutMs: 10_000,
    check: async () => ({ kind: "compatible", schemaVersion: 45 }),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  storage.start();
  const lifecycle = new MemoryLifecycle();
  const app = buildApp({
    storage,
    instructions: auth,
    lifecycle,
    admission: new MemoryAdmission(),
    cancellation: new MemoryCancellation(),
    observation: new MemoryObservation(),
    worker: () => ({ started: true, workerRegistered: true }),
    recovery: () => ({
      started: true,
      passes: 1,
      lastPassAt: new Date().toISOString(),
      lastOkPassAt: new Date().toISOString(),
      reconciled: 0,
      lifecycle: { outstanding: 0, oldestPendingAt: null },
    }),
    cleanup: runningCleanup,
    intake: appliedIntake,
    capacityLimits: resolveJobsCapacityLimits(),
  });
  const receiver: Receiver = { app, storage, clock, burns, lifecycle };
  RECEIVERS.set(cacheKey, receiver);
  return receiver;
}

let recording: RecordingTelemetry;

function lastSpan(): RecordedSpan | undefined {
  return recording.spans().at(-1) as RecordedSpan | undefined;
}

/**
 * Judge the receiver's answer (the last span) against the corpus's
 * expectation: an accept vector must reach its operation; a reject vector
 * must fail with the corpus's reason — or be refused even earlier, at the
 * route matrix, where no span exists (a presentation the receiver's method
 * routing cannot serve is the same denial with fewer words). A served
 * operation never conforms to a rejection, and no outcome never conforms to
 * an acceptance.
 *
 * "Reaching its operation" means the span's final outcome is the operation's
 * own completion vocabulary: every receiving operation is served, and each
 * served path overwrites the verification verdict, so a span still carrying
 * the verifier's "accepted" on a route whose vocabulary does not name that
 * word means the operation never ran — a misparsed-claims refusal answered
 * 500 must not read as an acceptance.
 */
const OPERATION_COMPLETION_OUTCOMES: Record<string, readonly string[]> = {
  "helix.jobs.lifecycle": ["applied", "stale"],
  // Every outcome the submit operation can decide is post-verification: the
  // receiver refused reject vectors long before the admission ran.
  "helix.jobs.submit": [...JOBS_SUBMIT_OUTCOMES],
  // The cancellation's own verdicts — requested, its refusals and its
  // unavailable — all mean the instruction verified and the operation ran.
  "helix.jobs.cancel": [...JOBS_CANCEL_OUTCOMES],
  // The observation reads' own verdicts, on the same terms.
  "helix.jobs.snapshot": [...JOBS_SNAPSHOT_OUTCOMES],
  "helix.jobs.result": [...JOBS_RESULT_OUTCOMES],
};

function conformant(
  vector: { expect: JobsSigningVector["expect"] },
  span: RecordedSpan | undefined,
): boolean {
  const outcome = span?.attributes["helix.outcome"];
  if (vector.expect === "accept") {
    // The operation's own vocabulary, in full — the verification verdict's
    // "accepted" is superseded by every served path, so for the routes whose
    // vocabulary does not carry the word, a final "accepted" is the
    // operation-never-ran refusal, not an acceptance. (The submit
    // vocabulary legitimately carries "accepted" — the admission's own word
    // for new work — so its accept vectors conform through the table.)
    const completions = OPERATION_COMPLETION_OUTCOMES[span?.name ?? ""];
    return completions !== undefined && completions.includes(String(outcome));
  }
  if (outcome === "accepted") return false;
  const reason = span?.attributes["helix.reason"];
  if (typeof reason === "string") return reason === vector.expect.reject;
  // No span: the presentation was refused before the receiver's verification
  // (the route matrix, the body parser) — a refusal, which conforms to any
  // expect-reject vector; the reason classes the span carries are pinned by
  // the vectors that reach the seam.
  return span === undefined;
}

async function judgeVector(vector: JobsSigningVector): Promise<string | null> {
  let token = await signJobsInstructionClaims(
    vector.sign.typ,
    vector.sign.claims,
    signingKey(vector.sign.keyId),
  );
  if (vector.transform) token = implementJobsVectorTransform(token, vector.transform);

  const expected = vector.present.expected;
  const receiver = receiverFor(expected.server, expected.operation, vector.present.keyId);
  receiver.clock.nowS = vector.present.nowS;
  receiver.burns.seen.clear();
  receiver.burns.failBurns = false;
  receiver.lifecycle.apps.clear();

  const headers: Record<string, unknown> = { [INSTRUCTION_HEADER]: token };
  if (typeof expected.idempotencyKeyHeader === "string") {
    headers[IDEMPOTENCY_KEY_HEADER] = expected.idempotencyKeyHeader;
  }
  const hasBody = expected.body.byteLength > 0;
  if (hasBody) headers["content-type"] = "application/json";

  recording.reset();
  await receiver.app.inject({
    method: expected.method as "GET" | "POST" | "DELETE",
    url: expected.resource,
    headers: headers as Record<string, string>,
    ...(hasBody ? { payload: Buffer.from(expected.body) } : {}),
  });
  const span = lastSpan();
  return conformant(vector, span)
    ? null
    : `vector "${vector.name}" — expected ${
        vector.expect === "accept" ? "acceptance" : `rejection "${vector.expect.reject}"`
      }, got outcome "${String(span?.attributes["helix.outcome"])}" reason "${String(
        span?.attributes["helix.reason"],
      )}"`;
}

async function judgeGolden(vector: JobsGoldenTokenVector): Promise<string | null> {
  const receiver = receiverFor(vector.expected.server, vector.expected.operation, vector.keyId);
  receiver.clock.nowS = vector.nowS;
  receiver.burns.seen.clear();
  receiver.burns.failBurns = false;
  receiver.lifecycle.apps.clear();

  const headers: Record<string, unknown> = { [INSTRUCTION_HEADER]: vector.token };
  if (typeof vector.expected.idempotencyKeyHeader === "string") {
    headers[IDEMPOTENCY_KEY_HEADER] = vector.expected.idempotencyKeyHeader;
  }
  const hasBody = vector.expected.body.byteLength > 0;
  if (hasBody) headers["content-type"] = "application/json";

  recording.reset();
  await receiver.app.inject({
    method: vector.expected.method as "GET" | "POST" | "DELETE",
    url: vector.expected.resource,
    headers: headers as Record<string, string>,
    ...(hasBody ? { payload: Buffer.from(vector.expected.body) } : {}),
  });
  const span = lastSpan();
  // The same conformance the corpus's own vectors are judged by — the golden
  // tokens add nothing to the verdict rule, only to the token material.
  return conformant(vector, span)
    ? null
    : `golden token "${vector.name}" — expected ${
        vector.expect === "accept" ? "acceptance" : `rejection "${vector.expect.reject}"`
      }, got outcome "${String(span?.attributes["helix.outcome"])}" reason "${String(
        span?.attributes["helix.reason"],
      )}"`;
}

const RECEIVED_VECTORS = JOBS_SIGNING_VECTORS.filter(
  (v) => v.present.expected.operation !== "fetch",
);
const FETCH_VECTORS = JOBS_SIGNING_VECTORS.length - RECEIVED_VECTORS.length;
const RECEIVED_GOLDEN = JOBS_GOLDEN_TOKEN_VECTORS.filter((v) => v.expected.operation !== "fetch");
const FETCH_GOLDEN = JOBS_GOLDEN_TOKEN_VECTORS.length - RECEIVED_GOLDEN.length;

describe("the jobs receiver against the shared signing vectors", () => {
  beforeAll(() => {
    recording = startRecordingTelemetry();
  });

  afterAll(async () => {
    await recording.restore();
    for (const receiver of RECEIVERS.values()) {
      await receiver.app.close();
      await receiver.storage.stop();
    }
  });

  test("the fetch-direction vectors are counted as the edge receiver's, not absorbed", () => {
    expect(FETCH_VECTORS).toBeGreaterThan(0);
    expect(FETCH_GOLDEN).toBeGreaterThan(0);
  });

  test("every received-direction vector's verdict matches through the real routes", async () => {
    const failures: string[] = [];
    for (const vector of RECEIVED_VECTORS) {
      const failure = await judgeVector(vector);
      if (failure) failures.push(failure);
    }
    expect(failures).toEqual([]);
  });

  test("the recorded golden tokens verify through the real routes", async () => {
    const failures: string[] = [];
    for (const vector of RECEIVED_GOLDEN) {
      const failure = await judgeGolden(vector);
      if (failure) failures.push(failure);
    }
    expect(failures).toEqual([]);
  });
});
