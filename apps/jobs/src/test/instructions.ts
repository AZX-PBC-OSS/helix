import {
  IDEMPOTENCY_KEY_HEADER,
  INSTRUCTION_HEADER,
  JOBS_SERVER_NAME,
  JOBS_FETCH_QUALIFIED_TYPE,
  type JobsLifecycleUpdate,
} from "@azx-pbc/shared";
import {
  deriveJobsInstructionKey,
  mintJobsInstruction,
  type JobsInstructionMintSpec,
} from "@azx-pbc/shared/jobsSigning";
import type { FastifyInstance } from "fastify";

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

/** Fixed 32-byte test roots for the two receiving directions — test data, never deployed. */
const TEST_ROOTS = {
  edgeToJobs: "uFEfLTTVeHJK0+P/dQEWv8ccOyFrkZw7InR0I52V4/0=",
  portalToJobs: "jUwQKa33JNljh0jULeithrh3JOL8dUmxPJknzGCjQBA=",
  /** A third root for wrong-key cases. */
  other: "gDZ5bWRVuYC58CVmc4rXPjvCzEtuoQZ4Hn0v2UXPUaU=",
} as const;

export const TEST_KEYS = {
  edgeToJobs: deriveJobsInstructionKey(TEST_ROOTS.edgeToJobs, "edgeToJobs"),
  portalToJobs: deriveJobsInstructionKey(TEST_ROOTS.portalToJobs, "portalToJobs"),
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
    return { appliedGeneration: merged.state.generation, changed: merged.changed };
  }
}

/**
 * A built app with a ready store, the receiver seam, and nothing else wired.
 * The lifecycle seam rides along as the in-memory applier — the lifecycle
 * route's accepted path against the REAL store is covered in
 * `lifecycle.integration.test.ts` and the boot suite.
 */
export async function appWithReceiver(receiver: TestReceiver): Promise<{
  app: FastifyInstance;
  storage: JobsStorage;
}> {
  const { app, storage } = await appWithLifecycle(receiver, new MemoryLifecycle());
  return { app, storage };
}

/** A built app whose lifecycle seam is the given applier. */
export async function appWithLifecycle(
  receiver: TestReceiver,
  lifecycle: JobsLifecycleApplier,
): Promise<{
  app: FastifyInstance;
  storage: JobsStorage;
}> {
  const storage = await storageIn("ready");
  const app = buildApp({ storage, instructions: receiver.auth, lifecycle });
  return { app, storage };
}

/** Mint one contract-valid instruction through the production mint path. */
export async function mint(spec: JobsInstructionMintSpec, key?: Uint8Array): Promise<string> {
  const direction = spec.operation === "lifecycle" ? "portalToJobs" : "edgeToJobs";
  return mintJobsInstruction(
    spec,
    key ?? (direction === "edgeToJobs" ? TEST_KEYS.edgeToJobs : TEST_KEYS.portalToJobs),
  );
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
