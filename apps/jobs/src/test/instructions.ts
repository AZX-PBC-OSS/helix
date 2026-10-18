import {
  IDEMPOTENCY_KEY_HEADER,
  INSTRUCTION_HEADER,
  JOBS_SERVER_NAME,
  JOBS_FETCH_QUALIFIED_TYPE,
  resolveJobsCapacityLimits,
  type JobsLifecycleUpdate,
} from "@azx-pbc/shared";
import {
  JobsCancelClaimsSchema,
  JobsResultClaimsSchema,
  JobsSnapshotClaimsSchema,
  JobsSubmitClaimsSchema,
  sha256BodyDigest,
  JOBS_EMPTY_BODY,
  type JobsCancelClaims,
  type JobsResultClaims,
  type JobsSnapshotClaims,
  type JobsSubmitClaims,
} from "@azx-pbc/shared/jobsSigning";
import {
  JobsOperations,
  deriveJobsInstructionKey,
  mintJobsInstruction,
  type JobsInstructionMintSpec,
} from "@azx-pbc/shared/jobsSigning";
import type { FastifyInstance } from "fastify";

import type { JobsAdmission, JobsAdmissionRequest, JobsAdmissionResult } from "../acceptance.js";
import type { JobsCancelRequest, JobsCancelVerdict, JobsCancellation } from "../cancellation.js";
import type { JobsCleanupSnapshot } from "../cleanup.js";
import type {
  JobsObservation,
  JobsObservationRequest,
  JobsResultVerdict,
  JobsSnapshotVerdict,
} from "../observation.js";
import type { JobsBurnOutcome, JobsBurnStore } from "../burns.js";
import { createJobsInstructionAuth, type JobsInstructionAuth } from "../instructionAuth.js";
import { buildApp } from "../app.js";
import type { JobsStorageCompatibility } from "../compat.js";
import {
  mergeLifecycleUpdate,
  type JobsLifecycleApplier,
  type JobsLifecycleApplyResult,
} from "../lifecycle.js";
import { JobsStorage } from "../storage.js";

/**
 * Test infrastructure for the signed-operation seams: fixed test roots, an
 * in-memory burn store standing in for the database (the durability contract
 * is pinned against real Postgres in `burns.test.ts` and the boot suite), a
 * controllable clock, and helpers that mint contract-valid instructions
 * through the production mint path.
 */

/** A whole-second instant in the tests' window — the clock the tests set and mint against. */
export const TEST_IAT = 1_800_000_000;

/** Fixed 32-byte test roots for the three signing directions — test data, never deployed. */
const TEST_ROOTS = {
  edgeToJobs: "uFEfLTTVeHJK0+P/dQEWv8ccOyFrkZw7InR0I52V4/0=",
  portalToJobs: "jUwQKa33JNljh0jULeithrh3JOL8dUmxPJknzGCjQBA=",
  jobsToEdge: "1Rd4fAqPTnr9rMBoUaNpau5Bh4Xc3Gh8E0jWxFhO0Sg=",
  /** A fourth root for wrong-key cases. */
  other: "gDZ5bWRVuYC58CVmc4rXPjvCzEtuoQZ4Hn0v2UXPUaU=",
} as const;

export const TEST_KEYS = {
  edgeToJobs: deriveJobsInstructionKey(TEST_ROOTS.edgeToJobs, "edgeToJobs"),
  portalToJobs: deriveJobsInstructionKey(TEST_ROOTS.portalToJobs, "portalToJobs"),
  jobsToEdge: deriveJobsInstructionKey(TEST_ROOTS.jobsToEdge, "jobsToEdge"),
  /** A validly derived key that is neither receiver's — forged-instruction legs. */
  other: deriveJobsInstructionKey(TEST_ROOTS.other, "edgeToJobs"),
} as const;

/** The identity every test instruction carries. */
export const TEST_IDENTITY = {
  appId: "0b9e8c3e-6f2a-4c9b-9e1f-2a4b6c8d0e2f",
  env: "prod",
  ownerKind: "user",
  ownerOid: "4f7a2b3c-9d1e-4a5b-8c6d-0e2f4a6b8c0d",
  allowedTypes: [JOBS_FETCH_QUALIFIED_TYPE],
} as const;

export const TEST_JOB_ID = "w9QZzaBp4XkR3tYm017c3";
export const TEST_BODY = '{"url":"https://example.com/data.json"}';

/**
 * The in-memory burn store — the `JobsBurnStore` seam's second implementor.
 * Replay semantics match the pg store's (first use proceeds, a second
 * presentation is a replay); a leg can arm `failBurns` to answer
 * `store-unavailable` and pin the fail-closed mapping.
 */
export class MemoryBurns implements JobsBurnStore {
  readonly seen = new Map<string, number>();
  failBurns = false;

  async burn(scope: string, jti: string): Promise<JobsBurnOutcome> {
    if (this.failBurns) {
      return { verdict: "store-unavailable", error: new Error("injected burn-store failure") };
    }
    if (this.seen.has(`${scope}:${jti}`)) return { verdict: "replay" };
    this.seen.set(`${scope}:${jti}`, 1);
    return { verdict: "first-use" };
  }
}

/** A mutable test clock, in whole verification seconds. */
export class TestClock {
  nowS: number = TEST_IAT;
  get = (): number => this.nowS;
}

export interface TestReceiver {
  auth: JobsInstructionAuth;
  burns: MemoryBurns;
  clock: TestClock;
}

/** The receiver seam with an in-memory burn store and a controllable clock. */
export function makeReceiver(serverId: string = JOBS_SERVER_NAME): TestReceiver {
  const burns = new MemoryBurns();
  const clock = new TestClock();
  const auth = createJobsInstructionAuth({
    serverId,
    keys: TEST_KEYS,
    burns,
    clock: clock.get,
    log: { warn: () => {} },
  });
  return { auth, burns, clock };
}

/**
 * A storage lifecycle in the wanted state without a cluster (app.test.ts's
 * shape), so route tests can drive a ready or unavailable service.
 */
export async function storageIn(state: "pending" | "ready" | "unavailable"): Promise<JobsStorage> {
  const compatible: JobsStorageCompatibility = { kind: "compatible", schemaVersion: 45 };
  const storage = new JobsStorage({
    databaseUrl: "postgresql://helix_jobs:pw@db:5432/helix_jobs_test",
    statementTimeoutMs: 10_000,
    check: async () => (state === "ready" ? compatible : { kind: "schema_missing" }),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  if (state !== "pending") {
    storage.start();
    await new Promise((resolve) => setImmediate(resolve));
  }
  return storage;
}

/**
 * The in-memory lifecycle applier — the `JobsLifecycleApplier` seam's second
 * implementor, over the same pure merge the durable store commits (its
 * durability contract is pinned against real Postgres in
 * `lifecycle.integration.test.ts` and the boot suite). A leg can arm
 * `failApplies` to answer every apply with a thrown error and pin the
 * route's fail-closed mapping.
 */
export class MemoryLifecycle implements JobsLifecycleApplier {
  readonly apps = new Map<string, { generation: string; archived: boolean }>();
  failApplies = false;

  async apply(appId: string, update: JobsLifecycleUpdate): Promise<JobsLifecycleApplyResult> {
    if (this.failApplies) {
      throw new Error("injected lifecycle-store failure");
    }
    const stored = this.apps.get(appId) ?? null;
    const merged = mergeLifecycleUpdate(stored, update);
    this.apps.set(appId, merged.state);
    // The in-memory double holds no job records, so a real apply's stamping
    // arm has nothing to reach here — the durable stamping's own semantics
    // are pinned against real Postgres in `lifecycle.integration.test.ts`.
    return { appliedGeneration: merged.state.generation, changed: merged.changed, stamped: 0 };
  }
}

/**
 * The in-memory admission seam — the `JobsAdmission` seam's second
 * implementor, for the ROUTE's tests: the route's contract is mapping an
 * admission outcome onto the protocol's responses and span vocabulary, and a
 * leg arms the outcome it wants answered (or `failAdmits` to pin the
 * store-failure mapping). The admission transaction's own semantics — the
 * keyed recovery, the rollback, the enqueue — are pinned against real
 * Postgres and the real runner in `acceptance.integration.test.ts`.
 */
export class MemoryAdmission implements JobsAdmission {
  calls = 0;
  lastRequest: JobsAdmissionRequest | null = null;
  failAdmits = false;
  outcome: JobsAdmissionResult = { outcome: "accepted", jobId: TEST_JOB_ID, status: "queued" };

  async admit(request: JobsAdmissionRequest): Promise<JobsAdmissionResult> {
    this.calls += 1;
    this.lastRequest = request;
    if (this.failAdmits) {
      throw new Error("injected admission-store failure");
    }
    return this.outcome;
  }
}

/**
 * The in-memory cancellation seam — the `JobsCancellation` seam's second
 * implementor, for the ROUTE's tests: the route's contract is mapping a
 * cancellation verdict onto the protocol's responses and span vocabulary,
 * and a leg arms the verdict it wants answered (or `failRequests` to pin the
 * store-failure mapping). The durable intent's own semantics — the
 * conditional write, the ownership/grant refusals, the runner drive — are
 * pinned against real Postgres and the real runner in
 * `cancellation.integration.test.ts`.
 */
export class MemoryCancellation implements JobsCancellation {
  calls = 0;
  lastRequest: JobsCancelRequest | null = null;
  failRequests = false;
  verdict: JobsCancelVerdict = { outcome: "requested" };

  async requestCancel(request: JobsCancelRequest): Promise<JobsCancelVerdict> {
    this.calls += 1;
    this.lastRequest = request;
    if (this.failRequests) {
      throw new Error("injected cancellation-store failure");
    }
    return this.verdict;
  }
}

/**
 * The in-memory observation seam — the `JobsObservation` seam's second
 * implementor, for the ROUTE's tests: the routes' contract is mapping a
 * snapshot/result verdict onto the protocol's responses and span vocabulary,
 * and a leg arms the verdict it wants answered (or `failReads` to pin the
 * store-failure mapping). The durable reads' own semantics — the
 * authorization classification, the logical horizons, the raw-bytes result —
 * are pinned against real Postgres in `observation.integration.test.ts`.
 */
export class MemoryObservation implements JobsObservation {
  calls = 0;
  lastRequest: JobsObservationRequest | null = null;
  failReads = false;
  snapshotVerdict: JobsSnapshotVerdict = { outcome: "not_found" };
  resultVerdict: JobsResultVerdict = { outcome: "not_found" };

  async snapshot(request: JobsObservationRequest): Promise<JobsSnapshotVerdict> {
    return this.read(request, this.snapshotVerdict);
  }

  async result(request: JobsObservationRequest): Promise<JobsResultVerdict> {
    return this.read(request, this.resultVerdict);
  }

  private async read<T>(request: JobsObservationRequest, verdict: T): Promise<T> {
    this.calls += 1;
    this.lastRequest = request;
    if (this.failReads) {
      throw new Error("injected observation-store failure");
    }
    return verdict;
  }
}

/** The supervision state of a serving cleanup loop: mid-cadence, its last pass fresh and clear. */
export function runningCleanup(): JobsCleanupSnapshot {
  return {
    started: true,
    passes: 1,
    lastPassAt: new Date().toISOString(),
    lastOkPassAt: new Date().toISOString(),
    resultsRemoved: 0,
    recordsRetired: 0,
    evidence: {
      retainedServer: 0,
      unfinishedServer: 0,
      overdueResults: 0,
      overdueRecords: 0,
    },
  };
}

/**
 * A built app with a ready store, the receiver seam, and nothing else wired.
 * The lifecycle, admission, cancellation and observation seams ride along as
 * in-memory doubles — the lifecycle route's accepted path against the REAL
 * store is covered in `lifecycle.integration.test.ts` and the boot suite; the
 * submit route's is covered in `acceptance.integration.test.ts`; the cancel
 * route's is covered in `cancellation.integration.test.ts`; the snapshot and
 * result routes' are covered in `observation.integration.test.ts`.
 */
export async function appWithReceiver(receiver: TestReceiver): Promise<{
  app: FastifyInstance;
  storage: JobsStorage;
  admission: MemoryAdmission;
  cancellation: MemoryCancellation;
  observation: MemoryObservation;
}> {
  const admission = new MemoryAdmission();
  const cancellation = new MemoryCancellation();
  const observation = new MemoryObservation();
  const { app, storage } = await appWithLifecycle(
    receiver,
    new MemoryLifecycle(),
    admission,
    cancellation,
    observation,
  );
  return { app, storage, admission, cancellation, observation };
}

/** A built app whose lifecycle seam is the given applier. */
export async function appWithLifecycle(
  receiver: TestReceiver,
  lifecycle: JobsLifecycleApplier,
  admission: JobsAdmission = new MemoryAdmission(),
  cancellation: JobsCancellation = new MemoryCancellation(),
  observation: JobsObservation = new MemoryObservation(),
  cleanup: () => JobsCleanupSnapshot = runningCleanup,
): Promise<{
  app: FastifyInstance;
  storage: JobsStorage;
}> {
  const storage = await storageIn("ready");
  const app = buildApp({
    storage,
    instructions: receiver.auth,
    lifecycle,
    admission,
    cancellation,
    observation,
    // The route suites exercise the receiver's routes, not the worker, the
    // sweeper or the cleanup loop; the supervision states they report are the
    // registered composition's, with the sweeper's last pass fresh and the
    // cleanup loop's evidence fresh and clear.
    worker: () => ({ started: true, workerRegistered: true }),
    recovery: () => ({
      started: true,
      passes: 1,
      lastPassAt: new Date().toISOString(),
      lastOkPassAt: new Date().toISOString(),
      reconciled: 0,
      lifecycle: { outstanding: 0, oldestPendingAt: null },
    }),
    cleanup,
    capacityLimits: resolveJobsCapacityLimits(),
  });
  return { app, storage };
}

/** Mint one contract-valid instruction through the production mint path. */
export async function mint(spec: JobsInstructionMintSpec, key?: Uint8Array): Promise<string> {
  // The direction comes from the operation matrix — the edge→jobs and
  // jobs→edge directions both mint from this file's fixtures, so a fixed
  // two-way guess would silently mint a fetch instruction with the wrong
  // family's key.
  const direction = JobsOperations[spec.operation].direction;
  return mintJobsInstruction(spec, key ?? TEST_KEYS[direction]);
}

/** The instruction header for a minted token, plus the retry-key header when the submission carried one. */
export function instructionHeaders(token: string, retryKey?: string): Record<string, string> {
  const headers: Record<string, string> = { [INSTRUCTION_HEADER]: token };
  if (retryKey !== undefined) headers[IDEMPOTENCY_KEY_HEADER] = retryKey;
  return headers;
}

/** A submit spec over the shared fixed world. */
export function submitSpec(
  over: Partial<Extract<JobsInstructionMintSpec, { operation: "submit" }>> = {},
): JobsInstructionMintSpec {
  return {
    operation: "submit",
    server: JOBS_SERVER_NAME,
    identity: { ...TEST_IDENTITY },
    type: JOBS_FETCH_QUALIFIED_TYPE,
    generation: "7",
    idempotencyKey: "retry-key-1",
    body: new TextEncoder().encode(TEST_BODY),
    iatS: TEST_IAT,
    ...over,
  };
}

/**
 * A submit-claims object as the receiver's verification produces it — the
 * trusted input the admission seam consumes. Callers of the admission store
 * directly (the integration suite) build these instead of minting tokens;
 * the claims' own schema conformance is the signing vectors' seam. The build
 * is parsed against the claims schema so a malformed fixture fails here,
 * never downstream as a silently-trusted input.
 */
export function submitClaims(
  over: Partial<Extract<JobsInstructionMintSpec, { operation: "submit" }>> = {},
): JobsSubmitClaims {
  const spec = submitSpec(over);
  if (spec.operation !== "submit") throw new Error("unreachable");
  return JobsSubmitClaimsSchema.parse({
    server: spec.server,
    operation: "submit",
    method: "POST",
    resource: "/internal/jobs/v1/jobs",
    bodySha256: "0".repeat(64),
    appId: spec.identity.appId,
    env: spec.identity.env,
    ownerKind: spec.identity.ownerKind,
    ownerOid: spec.identity.ownerOid,
    allowedTypes: [...spec.identity.allowedTypes],
    type: spec.type,
    generation: spec.generation,
    idempotencyKey: spec.idempotencyKey,
  });
}

/** A cancel spec over the shared fixed world (the bodyless operation binds the empty digest). */
export function cancelSpec(
  over: Partial<
    Extract<JobsInstructionMintSpec, { operation: "snapshot" | "result" | "cancel" }>
  > = {},
): Extract<JobsInstructionMintSpec, { operation: "snapshot" | "result" | "cancel" }> {
  return {
    operation: "cancel",
    server: JOBS_SERVER_NAME,
    identity: { ...TEST_IDENTITY },
    jobId: TEST_JOB_ID,
    iatS: TEST_IAT,
    ...over,
  };
}

/**
 * A cancel-claims object as the receiver's verification produces it — the
 * trusted input the cancellation seam consumes. Callers of the cancellation
 * store directly (the integration suite) build these instead of minting
 * tokens; the schema conformance is the signing vectors' seam. The digest is
 * the bodyless operation's real one (SHA-256 of empty), so the fixture is
 * exactly the claims a verified cancel instruction would carry.
 */
export function cancelClaims(
  over: Partial<
    Extract<JobsInstructionMintSpec, { operation: "snapshot" | "result" | "cancel" }>
  > = {},
): JobsCancelClaims {
  const spec = cancelSpec(over);
  return JobsCancelClaimsSchema.parse({
    server: spec.server,
    operation: "cancel",
    method: "DELETE",
    resource: `/internal/jobs/v1/jobs/${spec.jobId}`,
    bodySha256: sha256BodyDigest(JOBS_EMPTY_BODY),
    appId: spec.identity.appId,
    env: spec.identity.env,
    ownerKind: spec.identity.ownerKind,
    ownerOid: spec.identity.ownerOid,
    allowedTypes: [...spec.identity.allowedTypes],
  });
}

/**
 * A snapshot or result claims object as the receiver's verification produces
 * it — the trusted input the observation seam consumes, built exactly like
 * {@link cancelClaims} over the same bodyless identity shape.
 */
export function recordReadClaims(
  operation: "snapshot" | "result",
  over: Partial<
    Extract<JobsInstructionMintSpec, { operation: "snapshot" | "result" | "cancel" }>
  > = {},
): JobsSnapshotClaims | JobsResultClaims {
  const spec = cancelSpec({ operation, ...over });
  const shape = {
    server: spec.server,
    operation,
    method: "GET",
    resource: `/internal/jobs/v1/jobs/${spec.jobId}${operation === "result" ? "/result" : ""}`,
    bodySha256: sha256BodyDigest(JOBS_EMPTY_BODY),
    appId: spec.identity.appId,
    env: spec.identity.env,
    ownerKind: spec.identity.ownerKind,
    ownerOid: spec.identity.ownerOid,
    allowedTypes: [...spec.identity.allowedTypes],
  };
  return operation === "snapshot"
    ? JobsSnapshotClaimsSchema.parse(shape)
    : JobsResultClaimsSchema.parse(shape);
}
