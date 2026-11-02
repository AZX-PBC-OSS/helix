import type {
  JobsInstructionExpectation,
  JobsInstructionRejectReason,
  JobsSigningDirection,
} from "./jobsSigning.js";
import {
  buildJobsInternalResource,
  JobsOperations,
  JobsSigningDomains,
  JOBS_EMPTY_BODY,
  sha256BodyDigest,
} from "./jobsSigning.js";

/**
 * The executable signing vectors for the internal jobs instructions
 * (background-jobs-plane design §3) — the common positive and negative
 * examples every signer and receiver of the three directions must agree on:
 * exact operation/method/resource/body/server binding, mandatory claims,
 * direction-specific authority, and the declared lifetime and
 * clock-tolerance boundaries.
 *
 * The list is data, judged through the {@link JobsSigningVectorHarness} seam —
 * this package's reference implementation runs it in
 * `jobsSigning.test.ts`, and any future non-TypeScript service implements the
 * same sign/transform/verify surface and is judged by the identical corpus
 * before adoption.
 * Tokens are minted from fully specified claim bags over fixed public test
 * roots, so the corpus is deterministic and carries no secret; a vector never
 * depends on wall-clock time (the clock is part of the vector) or on any
 * receiver state. In particular the corpus is stateless by design: replay
 * *burning* is a receiver's durable store (`jti`, retention of at least
 * `JOBS_INSTRUCTION_BURN_RETENTION_SECONDS`) and is verified by the
 * receiver-side suites, not here — a token replaying within its validity
 * window still verifies identically, which is exactly why the burn must exist.
 *
 * The minted corpus proves self-agreement, not conformance, so it is
 * complemented by the recorded golden tokens at the foot of this file
 * (`JOBS_GOLDEN_TOKEN_VECTORS`): literal wire bytes pinning the derivation
 * info, header profile and claim encoding per direction.
 *
 * Every vector judges the composed `verifyJobsInstruction` and the two-phase
 * path (`verifyJobsInstructionHeader`, then `confirmJobsInstructionBody`)
 * alike: the verdict and reason must agree, a reason in
 * `JOBS_INSTRUCTION_BODY_PHASE_REJECT_REASONS` must come from the body phase
 * after the header phase passed, and every other reason from the header
 * phase. The body-binding vectors are the ones that pass the header phase
 * and fail the body phase.
 */

/** A fixed public root per (direction, server) pair — test data, never deployed. */
export interface JobsSigningVectorRoot {
  readonly direction: JobsSigningDirection;
  readonly server: string;
  readonly root: string;
}

export const JOBS_SIGNING_VECTOR_ROOTS: Record<string, JobsSigningVectorRoot> = {
  "edge-to-jobs.jobs": {
    direction: "edgeToJobs",
    server: "jobs",
    root: "q8DSPdnLJdVMREaGet6xJy3J7YhGflOniK+LgxqOd8E=",
  },
  "edge-to-jobs.ml-jobs": {
    direction: "edgeToJobs",
    server: "ml-jobs",
    root: "Ur1NuLX+qQNAVyc3bkmBqunq9bwXkJQ6iJR4NZuzFes=",
  },
  "jobs-to-edge.jobs": {
    direction: "jobsToEdge",
    server: "jobs",
    root: "RxUZ3ghkc/VtqeiAOg3pN8DEdaOJgSWBkHNvsocW/tQ=",
  },
  "jobs-to-edge.ml-jobs": {
    direction: "jobsToEdge",
    server: "ml-jobs",
    root: "xU5Kgx1H/Jj8MwbOMokc2zJ4S0kVho4ZAL9dosUXP7k=",
  },
  "portal-to-jobs.jobs": {
    direction: "portalToJobs",
    server: "jobs",
    root: "LRaxU+Q8roAg3sH9iFKZ0eaWskoWV+r5ErtfJLZROMI=",
  },
  "portal-to-jobs.ml-jobs": {
    direction: "portalToJobs",
    server: "ml-jobs",
    root: "awbgO3d59G1+8eOEKuwunBWe5wV1kW4wSY9w1us1kZI=",
  },
};

/** A post-signing token mutation a vector can demand, expressed declaratively. */
export type JobsVectorTokenTransform =
  | "flip-signature-char"
  | "flip-payload-char"
  | "append-segment"
  | "empty-signature-segment";

export interface JobsVectorSignSpec {
  /** The JWT `typ` header the token carries — overridable to express forged families. */
  readonly typ: string;
  /** Which fixed vector root signs the token. */
  readonly keyId: string;
  /** The full payload bag, registered claims included — signed exactly as given. */
  readonly claims: Record<string, unknown>;
}

export interface JobsVectorPresentation {
  /** The receiver's root — which may deliberately differ from the signing one. */
  readonly keyId: string;
  readonly expected: JobsInstructionExpectation;
  /** The verification clock, in seconds. */
  readonly nowS: number;
}

export interface JobsSigningVector {
  readonly name: string;
  readonly why: string;
  readonly sign: JobsVectorSignSpec;
  readonly present: JobsVectorPresentation;
  readonly transform?: JobsVectorTokenTransform;
  readonly expect: "accept" | { readonly reject: JobsInstructionRejectReason };
}

export interface JobsVectorVerdict {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * The seam a verifiable implementation must satisfy: sign a raw bag under the
 * profile, present a token to a receiver, and apply the token transforms. The
 * reference implementation in `./jobsSigning.ts` supplies all three; a mirror
 * implements the same surface and is judged by the same corpus.
 */
export interface JobsSigningVectorHarness {
  sign(spec: JobsVectorSignSpec): Promise<string>;
  transform(token: string, kind: JobsVectorTokenTransform): string;
  verify(input: {
    token: string;
    keyId: string;
    expected: JobsInstructionExpectation;
    nowS: number;
  }): Promise<JobsVectorVerdict>;
}

/**
 * Apply a vector's token transform. Both character flips substitute inside the
 * base64url alphabet and always change the decoded byte, so the flip is a
 * signature break, never a parse accident.
 */
export function implementJobsVectorTransform(
  token: string,
  kind: JobsVectorTokenTransform,
): string {
  const flip = (value: string, index: number): string => {
    const char = value[index];
    const flipped = char === "a" ? "b" : "a";
    return value.slice(0, index) + flipped + value.slice(index + 1);
  };
  switch (kind) {
    case "flip-signature-char": {
      const last = token.lastIndexOf(".");
      return token.slice(0, last + 1) + flip(token.slice(last + 1), 0);
    }
    case "flip-payload-char": {
      const first = token.indexOf(".");
      const second = token.indexOf(".", first + 1);
      return (
        token.slice(0, first + 1) + flip(token.slice(first + 1, second), 0) + token.slice(second)
      );
    }
    case "append-segment":
      return `${token}.extra`;
    case "empty-signature-segment":
      return token.slice(0, token.lastIndexOf(".") + 1);
  }
}

// ── The fixed world every vector shares ──────────────────────────────────────

const IAT = 1_800_000_000;
const SERVER = "jobs";
const OTHER_SERVER = "ml-jobs";
const APP_ID = "0b9e8c3e-6f2a-4c9b-9e1f-2a4b6c8d0e2f";
const OTHER_APP_ID = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const OWNER_OID = "4f7a2b3c-9d1e-4a5b-8c6d-0e2f4a6b8c0d";
const JOB_ID = "w9QZzaBp4XkR3tYm017c3";
const OTHER_JOB_ID = "SecondJobId99";
const RETRY_KEY = "retry-key-1";

const utf8 = new TextEncoder();
const SUBMIT_BODY = '{"url":"https://example.com/data.json"}';
const OTHER_SUBMIT_BODY = '{"url":"https://example.com/other.json"}';
const ARCHIVE_BODY = '{"generation":"8","archived":true}';
const OPEN_BODY = '{"generation":"9","archived":false}';

const TYP = {
  edgeToJobs: JobsSigningDomains.edgeToJobs.jwtTyp,
  jobsToEdge: JobsSigningDomains.jobsToEdge.jwtTyp,
  portalToJobs: JobsSigningDomains.portalToJobs.jwtTyp,
} as const;

const without = (
  bag: Record<string, unknown>,
  ...keys: readonly string[]
): Record<string, unknown> =>
  Object.fromEntries(Object.entries(bag).filter(([entryKey]) => !keys.includes(entryKey)));

const submitClaims = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: "helix-edge",
  aud: "helix-jobs:jobs",
  server: SERVER,
  operation: "submit",
  method: JobsOperations.submit.method,
  resource: buildJobsInternalResource("submit"),
  bodySha256: sha256BodyDigest(utf8.encode(SUBMIT_BODY)),
  jti: "vector-submit-jti",
  iat: IAT,
  exp: IAT + 30,
  appId: APP_ID,
  env: "prod",
  ownerKind: "user",
  ownerOid: OWNER_OID,
  allowedTypes: ["jobs:fetch"],
  type: "jobs:fetch",
  generation: "7",
  idempotencyKey: RETRY_KEY,
  ...over,
});

const snapshotClaims = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: "helix-edge",
  aud: "helix-jobs:jobs",
  server: SERVER,
  operation: "snapshot",
  method: JobsOperations.snapshot.method,
  resource: buildJobsInternalResource("snapshot", { jobId: JOB_ID }),
  bodySha256: sha256BodyDigest(JOBS_EMPTY_BODY),
  jti: "vector-snapshot-jti",
  iat: IAT,
  exp: IAT + 30,
  appId: APP_ID,
  env: "prod",
  ownerKind: "user",
  ownerOid: OWNER_OID,
  allowedTypes: ["jobs:fetch"],
  ...over,
});

const fetchClaims = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: "helix-jobs:jobs",
  aud: "helix-edge-jobs-callback:jobs",
  server: SERVER,
  operation: "fetch",
  method: JobsOperations.fetch.method,
  resource: buildJobsInternalResource("fetch"),
  bodySha256: sha256BodyDigest(utf8.encode(SUBMIT_BODY)),
  jti: "vector-fetch-jti",
  iat: IAT,
  exp: IAT + 30,
  appId: APP_ID,
  env: "prod",
  ownerKind: "user",
  ownerOid: OWNER_OID,
  type: "jobs:fetch",
  jobId: JOB_ID,
  generation: "7",
  ...over,
});

const lifecycleClaims = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: "helix-portal",
  aud: "helix-jobs-lifecycle:jobs",
  server: SERVER,
  operation: "lifecycle",
  method: JobsOperations.lifecycle.method,
  resource: buildJobsInternalResource("lifecycle", { appId: APP_ID }),
  bodySha256: sha256BodyDigest(utf8.encode(ARCHIVE_BODY)),
  jti: "vector-lifecycle-jti",
  iat: IAT,
  exp: IAT + 30,
  ...over,
});

const submitExpectation = (
  over: Partial<JobsInstructionExpectation> = {},
): JobsInstructionExpectation => ({
  server: SERVER,
  operation: "submit",
  method: JobsOperations.submit.method,
  resource: buildJobsInternalResource("submit"),
  body: utf8.encode(SUBMIT_BODY),
  idempotencyKeyHeader: RETRY_KEY,
  ...over,
});

const snapshotExpectation = (
  over: Partial<JobsInstructionExpectation> = {},
): JobsInstructionExpectation => ({
  server: SERVER,
  operation: "snapshot",
  method: JobsOperations.snapshot.method,
  resource: buildJobsInternalResource("snapshot", { jobId: JOB_ID }),
  body: JOBS_EMPTY_BODY,
  ...over,
});

const resultExpectation = (
  over: Partial<JobsInstructionExpectation> = {},
): JobsInstructionExpectation => ({
  server: SERVER,
  operation: "result",
  method: JobsOperations.result.method,
  resource: buildJobsInternalResource("result", { jobId: JOB_ID }),
  body: JOBS_EMPTY_BODY,
  ...over,
});

const cancelExpectation = (
  over: Partial<JobsInstructionExpectation> = {},
): JobsInstructionExpectation => ({
  server: SERVER,
  operation: "cancel",
  method: JobsOperations.cancel.method,
  resource: buildJobsInternalResource("cancel", { jobId: JOB_ID }),
  body: JOBS_EMPTY_BODY,
  ...over,
});

const fetchExpectation = (
  over: Partial<JobsInstructionExpectation> = {},
): JobsInstructionExpectation => ({
  server: SERVER,
  operation: "fetch",
  method: JobsOperations.fetch.method,
  resource: buildJobsInternalResource("fetch"),
  body: utf8.encode(SUBMIT_BODY),
  ...over,
});

const lifecycleExpectation = (
  over: Partial<JobsInstructionExpectation> = {},
): JobsInstructionExpectation => ({
  server: SERVER,
  operation: "lifecycle",
  method: JobsOperations.lifecycle.method,
  resource: buildJobsInternalResource("lifecycle", { appId: APP_ID }),
  body: utf8.encode(ARCHIVE_BODY),
  ...over,
});

// ── The corpus ───────────────────────────────────────────────────────────────

const MISSING_SUBMIT_CLAIMS: readonly { readonly key: string; readonly why: string }[] = [
  {
    key: "jti",
    why: "jti is the replay-burn key — a receiver cannot burn what is absent, so it is mandatory",
  },
  { key: "iat", why: "iat anchors the validity window; absence must fail, never default" },
  { key: "exp", why: "exp bounds the lifetime; absence must fail, never default" },
  { key: "operation", why: "the operation claim is what the receiver serves against" },
  { key: "method", why: "an unbound method would verify on any verb" },
  { key: "resource", why: "an unbound resource would verify on any route" },
  { key: "bodySha256", why: "an unbound body digest would verify with any payload" },
  {
    key: "server",
    why: "the server claim is mandatory on every instruction, including lifecycle and callbacks",
  },
  {
    key: "appId",
    why: "identity claims have no defaults — attribution travels signed on every user operation",
  },
  { key: "env", why: "no default environment is permitted — the tier travels signed" },
  { key: "ownerKind", why: "the principal kind is signed, never inferred from the id's shape" },
  { key: "ownerOid", why: "the owner is mandatory — jobs compares record ownership against it" },
  { key: "allowedTypes", why: "the current grants travel signed on every user operation" },
  { key: "type", why: "submit binds the selected qualified type" },
  { key: "generation", why: "submit binds the app's lifecycle generation for admission fencing" },
  {
    key: "idempotencyKey",
    why: "the retry key is bound explicitly — absent is not the signed null",
  },
];

export const JOBS_SIGNING_VECTORS: readonly JobsSigningVector[] = [
  // ── Matching instructions verify, per operation and direction ─────────────
  {
    name: "a keyed submit instruction verifies",
    why: "the canonical edge→jobs instruction: every claim bound, retry key signed",
    sign: { typ: TYP.edgeToJobs, keyId: "edge-to-jobs.jobs", claims: submitClaims() },
    present: {
      keyId: "edge-to-jobs.jobs",
      expected: submitExpectation(),
      nowS: IAT,
    },
    expect: "accept",
  },
  {
    name: "a keyless submit binds the explicit null",
    why: "no retry key is signed as null — an unsigned header can never supply one",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: submitClaims({ idempotencyKey: null }),
    },
    present: {
      keyId: "edge-to-jobs.jobs",
      expected: submitExpectation({ idempotencyKeyHeader: null }),
      nowS: IAT,
    },
    expect: "accept",
  },
  {
    name: "a dev-tier submit verifies",
    why: "the dev gateway mints the same contract with the dev environment and dev principal",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: submitClaims({ env: "dev", ownerKind: "dev", generation: "3" }),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: "accept",
  },
  {
    name: "a snapshot instruction verifies",
    why: "bodyless user operation — binds the empty digest and the exact job resource",
    sign: { typ: TYP.edgeToJobs, keyId: "edge-to-jobs.jobs", claims: snapshotClaims() },
    present: { keyId: "edge-to-jobs.jobs", expected: snapshotExpectation(), nowS: IAT + 10 },
    expect: "accept",
  },
  {
    name: "a result instruction verifies",
    why: "the result route is its own resource, distinct from the snapshot route",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: snapshotClaims({
        operation: "result",
        resource: buildJobsInternalResource("result", { jobId: JOB_ID }),
      }),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: resultExpectation(), nowS: IAT },
    expect: "accept",
  },
  {
    name: "a cancel instruction verifies",
    why: "DELETE is the cancellation verb and binds the job resource",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: snapshotClaims({
        operation: "cancel",
        method: "DELETE",
        resource: buildJobsInternalResource("cancel", { jobId: JOB_ID }),
      }),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: cancelExpectation(), nowS: IAT + 20 },
    expect: "accept",
  },
  {
    name: "a prod fetch callback verifies",
    why: "jobs→edge: the job's immutable identity plus its id and admission generation, bound to the {url} body",
    sign: { typ: TYP.jobsToEdge, keyId: "jobs-to-edge.jobs", claims: fetchClaims() },
    present: { keyId: "jobs-to-edge.jobs", expected: fetchExpectation(), nowS: IAT },
    expect: "accept",
  },
  {
    name: "a dev fetch callback verifies",
    why: "the signed tier travels in the identity — the dev callback route receives it, the prod route refuses it",
    sign: {
      typ: TYP.jobsToEdge,
      keyId: "jobs-to-edge.jobs",
      claims: fetchClaims({ env: "dev" }),
    },
    present: { keyId: "jobs-to-edge.jobs", expected: fetchExpectation(), nowS: IAT },
    expect: "accept",
  },
  {
    name: "an archive lifecycle delivery verifies",
    why: "portal→jobs: the change is bound by body digest and the target app by resource",
    sign: { typ: TYP.portalToJobs, keyId: "portal-to-jobs.jobs", claims: lifecycleClaims() },
    present: { keyId: "portal-to-jobs.jobs", expected: lifecycleExpectation(), nowS: IAT },
    expect: "accept",
  },
  {
    name: "an unarchive lifecycle delivery verifies",
    why: "opening a new generation is a different body digest — the binding distinguishes them",
    sign: {
      typ: TYP.portalToJobs,
      keyId: "portal-to-jobs.jobs",
      claims: lifecycleClaims({ bodySha256: sha256BodyDigest(utf8.encode(OPEN_BODY)) }),
    },
    present: {
      keyId: "portal-to-jobs.jobs",
      expected: lifecycleExpectation({ body: utf8.encode(OPEN_BODY) }),
      nowS: IAT,
    },
    expect: "accept",
  },
  {
    name: "multiple allowed types bind",
    why: "allowedTypes is the server's current grant list — more than one qualified type travels",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: submitClaims({ allowedTypes: ["jobs:fetch", "jobs:report"] }),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: "accept",
  },
  {
    name: "another server's namespace verifies at its own receiver",
    why: "the contract is server-agnostic: same claims, its own root, its own audience and type prefix",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.ml-jobs",
      claims: submitClaims({
        server: OTHER_SERVER,
        aud: "helix-jobs:ml-jobs",
        allowedTypes: ["ml-jobs:fetch"],
        type: "ml-jobs:fetch",
      }),
    },
    present: {
      keyId: "edge-to-jobs.ml-jobs",
      expected: submitExpectation({ server: OTHER_SERVER }),
      nowS: IAT,
    },
    expect: "accept",
  },
  {
    name: "the last second inside the expiry tolerance verifies",
    why: "the receiver's clock may trail the token's expiry by the tolerance — the boundary is inclusive",
    sign: { typ: TYP.edgeToJobs, keyId: "edge-to-jobs.jobs", claims: submitClaims() },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT + 35 },
    expect: "accept",
  },
  {
    name: "the first second inside the start tolerance verifies",
    why: "the receiver's clock may lead the token's iat by the tolerance — the boundary is inclusive",
    sign: { typ: TYP.edgeToJobs, keyId: "edge-to-jobs.jobs", claims: submitClaims() },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT - 5 },
    expect: "accept",
  },

  // ── Wrong roots and direction isolation ───────────────────────────────────
  {
    name: "another server's root does not verify",
    why: "roots are independently generated per server and direction — a signature from one server's root is a forgery at another's",
    sign: { typ: TYP.edgeToJobs, keyId: "edge-to-jobs.ml-jobs", claims: submitClaims() },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "signature" },
  },
  {
    name: "the callback root does not verify an edge→jobs instruction",
    why: "each direction derives its key from its own root with its own HKDF info — never interchangeable",
    sign: { typ: TYP.edgeToJobs, keyId: "jobs-to-edge.jobs", claims: submitClaims() },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "signature" },
  },
  {
    name: "the lifecycle root does not verify an edge→jobs instruction",
    why: "portal authority and edge authority are different credentials, not different scopes of one",
    sign: { typ: TYP.edgeToJobs, keyId: "portal-to-jobs.jobs", claims: submitClaims() },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "signature" },
  },
  {
    name: "a lifecycle token does not verify at the callback receiver",
    why: "even signed over the callback's own root, the portal direction's typ is not the callback's",
    sign: { typ: TYP.portalToJobs, keyId: "jobs-to-edge.jobs", claims: lifecycleClaims() },
    present: { keyId: "jobs-to-edge.jobs", expected: fetchExpectation(), nowS: IAT },
    expect: { reject: "token_type" },
  },
  {
    name: "lifecycle authority cannot authorize a user operation over a shared root",
    why: "simulating a misconfigured shared root: the signature verifies, the typ still refuses",
    sign: { typ: TYP.portalToJobs, keyId: "edge-to-jobs.jobs", claims: lifecycleClaims() },
    present: { keyId: "edge-to-jobs.jobs", expected: snapshotExpectation(), nowS: IAT },
    expect: { reject: "token_type" },
  },
  {
    name: "lifecycle claims cannot pass as user-operation claims even with the typ forged",
    why: "with root and typ both compromised, the strict claim schemas still refuse — lifecycle authority ends at the typ layer",
    sign: { typ: TYP.edgeToJobs, keyId: "edge-to-jobs.jobs", claims: lifecycleClaims() },
    present: { keyId: "edge-to-jobs.jobs", expected: snapshotExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "callback authority cannot authorize a user operation even with the typ forged",
    why: "a fetch instruction's claim set has no submit identity — the submit schema refuses it",
    sign: { typ: TYP.edgeToJobs, keyId: "edge-to-jobs.jobs", claims: fetchClaims() },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "user-operation authority cannot authorize the callback even with the typ forged",
    why: "a submit claim set carries no job id or admission generation — the fetch schema refuses it",
    sign: { typ: TYP.jobsToEdge, keyId: "jobs-to-edge.jobs", claims: submitClaims() },
    present: { keyId: "jobs-to-edge.jobs", expected: fetchExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },

  // ── Wrong-server tokens ───────────────────────────────────────────────────
  {
    name: "a token for another server reads as the wrong audience",
    why: "the audience names server and direction — a valid instruction for ml-jobs never redeems at jobs",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.ml-jobs",
      claims: submitClaims({
        server: OTHER_SERVER,
        aud: "helix-jobs:ml-jobs",
        allowedTypes: ["ml-jobs:fetch"],
        type: "ml-jobs:fetch",
      }),
    },
    present: {
      keyId: "edge-to-jobs.ml-jobs",
      expected: submitExpectation({ server: SERVER }),
      nowS: IAT,
    },
    expect: { reject: "audience" },
  },
  {
    name: "the server claim is rechecked even under the receiver's own audience",
    why: "a claimed server of ml-jobs under a jobs audience is inconsistent — the claim is verified, not inferred from the audience",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: submitClaims({
        server: OTHER_SERVER,
        allowedTypes: ["ml-jobs:fetch"],
        type: "ml-jobs:fetch",
      }),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "server" },
  },
  {
    name: "the callback rejects another server's audience",
    why: "the callback audience is server-scoped the same way — one server's callback never redeems at another's",
    sign: {
      typ: TYP.jobsToEdge,
      keyId: "jobs-to-edge.ml-jobs",
      claims: fetchClaims({
        server: OTHER_SERVER,
        aud: "helix-edge-jobs-callback:ml-jobs",
        type: "ml-jobs:fetch",
      }),
    },
    present: {
      keyId: "jobs-to-edge.ml-jobs",
      expected: fetchExpectation({ server: SERVER }),
      nowS: IAT,
    },
    expect: { reject: "audience" },
  },
  {
    name: "a lifecycle delivery for another server is refused",
    why: "lifecycle targets are per server; a delivery addressed to ml-jobs never applies at jobs",
    sign: {
      typ: TYP.portalToJobs,
      keyId: "portal-to-jobs.ml-jobs",
      claims: lifecycleClaims({ server: OTHER_SERVER, aud: "helix-jobs-lifecycle:ml-jobs" }),
    },
    present: {
      keyId: "portal-to-jobs.ml-jobs",
      expected: lifecycleExpectation({ server: SERVER }),
      nowS: IAT,
    },
    expect: { reject: "audience" },
  },

  // ── Issuer ────────────────────────────────────────────────────────────────
  {
    name: "a foreign issuer fails",
    why: "the issuer names the minting plane — a token claiming the portal's issuer is not an edge instruction",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: submitClaims({ iss: "helix-portal" }),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "issuer" },
  },
  {
    name: "a missing issuer fails",
    why: "iss is mandatory on every instruction",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: without(submitClaims(), "iss"),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "issuer" },
  },
  {
    name: "a missing audience fails",
    why: "aud names the server-scoped trust domain — absence is not a match, never a default",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: without(submitClaims(), "aud"),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "audience" },
  },
  {
    name: "the callback requires the server-scoped issuer",
    why: "jobs mints as helix-jobs:<server> — another server's issuer name is a wrong-server token",
    sign: {
      typ: TYP.jobsToEdge,
      keyId: "jobs-to-edge.jobs",
      claims: fetchClaims({ iss: "helix-jobs:ml-jobs" }),
    },
    present: { keyId: "jobs-to-edge.jobs", expected: fetchExpectation(), nowS: IAT },
    expect: { reject: "issuer" },
  },
  {
    name: "the callback rejects the plane issuer",
    why: "the edge's issuer is not the jobs issuer — the direction's issuer is part of the domain",
    sign: {
      typ: TYP.jobsToEdge,
      keyId: "jobs-to-edge.jobs",
      claims: fetchClaims({ iss: "helix-edge" }),
    },
    present: { keyId: "jobs-to-edge.jobs", expected: fetchExpectation(), nowS: IAT },
    expect: { reject: "issuer" },
  },

  // ── Missing mandatory claims ──────────────────────────────────────────────
  ...MISSING_SUBMIT_CLAIMS.map(
    ({ key, why }): JobsSigningVector => ({
      name: `a submit instruction without ${key}`,
      why,
      sign: {
        typ: TYP.edgeToJobs,
        keyId: "edge-to-jobs.jobs",
        claims: without(submitClaims(), key),
      },
      present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
      expect: { reject: "claims" as const },
    }),
  ),
  {
    name: "a fetch callback without jobId",
    why: "the fetch resource carries no job id — the signed claim is the only binding for it",
    sign: {
      typ: TYP.jobsToEdge,
      keyId: "jobs-to-edge.jobs",
      claims: without(fetchClaims(), "jobId"),
    },
    present: { keyId: "jobs-to-edge.jobs", expected: fetchExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "a fetch callback without generation",
    why: "the admission generation is what the callback generation fence checks — it must travel signed",
    sign: {
      typ: TYP.jobsToEdge,
      keyId: "jobs-to-edge.jobs",
      claims: without(fetchClaims(), "generation"),
    },
    present: { keyId: "jobs-to-edge.jobs", expected: fetchExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "a fetch callback without the job's type",
    why: "the callback acts with the job's qualified type as authority — unsigned type is no authority",
    sign: {
      typ: TYP.jobsToEdge,
      keyId: "jobs-to-edge.jobs",
      claims: without(fetchClaims(), "type"),
    },
    present: { keyId: "jobs-to-edge.jobs", expected: fetchExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "a lifecycle claim bag carrying identity",
    why: "lifecycle authority authorizes nothing about a user operation or callback — it binds no identity claims",
    sign: {
      typ: TYP.portalToJobs,
      keyId: "portal-to-jobs.jobs",
      claims: lifecycleClaims({ appId: APP_ID }),
    },
    present: { keyId: "portal-to-jobs.jobs", expected: lifecycleExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "a submit instruction carrying the superseded admission id",
    why: "the admission machinery was removed — an admissionId claim must fail, never be ignored",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: submitClaims({ admissionId: "adm_123" }),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "a submit instruction carrying the superseded admission day",
    why: "there is no admission day or accounting-day claim — an unknown claim fails the strict parse",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: submitClaims({ admissionDay: "2026-10-13" }),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },

  // ── Claim shape violations ────────────────────────────────────────────────
  {
    name: "an uppercase body digest",
    why: "digests are lowercase SHA-256 hex — canonical form only",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: submitClaims({
        bodySha256: sha256BodyDigest(utf8.encode(SUBMIT_BODY)).toUpperCase(),
      }),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "a truncated body digest",
    why: "a SHA-256 hex digest is 64 characters",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: submitClaims({ bodySha256: "deadbeef" }),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "a zero-padded generation",
    why: 'generations are canonical decimal strings — "007" is a second wire form of 7, so it is malformed',
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: submitClaims({ generation: "007" }),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "a numeric generation",
    why: "identifiers are never coerced — the generation is a decimal string",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: submitClaims({ generation: 7 }),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "an empty jti",
    why: "the burn key must be non-empty to be burnable",
    sign: { typ: TYP.edgeToJobs, keyId: "edge-to-jobs.jobs", claims: submitClaims({ jti: "" }) },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "an oversized jti",
    why: "the burn key is bounded at 128 characters",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: submitClaims({ jti: "j".repeat(129) }),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "a string iat",
    why: "timestamps are numeric seconds — a string is malformed, not coerced",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: submitClaims({ iat: String(IAT) }),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "a fractional exp",
    why: "timestamps are whole seconds",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: submitClaims({ exp: IAT + 30.5 }),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "a resource without a leading slash",
    why: "the bound resource is the concrete internal path",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: submitClaims({ resource: "internal/jobs/v1/jobs" }),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "a resource carrying a query string",
    why: "internal instructions carry no query strings — the binding cannot encode one",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: submitClaims({ resource: `${buildJobsInternalResource("submit")}?x=1` }),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "an unlisted method",
    why: "methods are the matrix's GET, POST and DELETE",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: submitClaims({ method: "PATCH" }),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "an allowed type prefixed for another server",
    why: "the bound grant list is restricted to this server — a foreign qualified type fails",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: submitClaims({ allowedTypes: ["ml-jobs:generate"] }),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "a bare type in the allowed list",
    why: "there is no bare-type alias — grants are qualified",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: submitClaims({ allowedTypes: ["fetch"] }),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "a submit type prefixed for another server",
    why: "the qualified type's prefix must equal the instruction's server",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: submitClaims({ type: "ml-jobs:fetch", allowedTypes: ["ml-jobs:fetch"] }),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "a fetch callback type prefixed for another server",
    why: "the callback's authority is the job's type on THIS server",
    sign: {
      typ: TYP.jobsToEdge,
      keyId: "jobs-to-edge.jobs",
      claims: fetchClaims({ type: "ml-jobs:fetch" }),
    },
    present: { keyId: "jobs-to-edge.jobs", expected: fetchExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "a callback operation on an edge→jobs instruction",
    why: "each direction carries only its own operations — fetch is not an edge→jobs operation",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: submitClaims({ operation: "fetch" }),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "a user operation on a jobs→edge instruction",
    why: "submit is not a callback operation — the direction's claim schema refuses it",
    sign: {
      typ: TYP.jobsToEdge,
      keyId: "jobs-to-edge.jobs",
      claims: fetchClaims({ operation: "submit" }),
    },
    present: { keyId: "jobs-to-edge.jobs", expected: fetchExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "an anonymous owner kind",
    why: "only user and dev principals own jobs — the claim schema carries the restricted vocabulary",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: submitClaims({ ownerKind: "anon" }),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "a preview environment",
    why: "production and development are the only tiers — preview is not a third environment",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: submitClaims({ env: "preview" }),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "an uppercase server claim",
    why: "server ids are lowercase — a coerced case would be a different namespace accepted by mistake",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: submitClaims({ server: "Jobs", aud: "helix-jobs:Jobs" }),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "a malformed app id in the identity",
    why: "the identity's app id is the registry app schema's shape — anything else is a forged attribution",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: submitClaims({ appId: "not-a-uuid" }),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },

  // ── Binding mismatches: a valid token presented as something it is not ────
  {
    name: "a submit instruction does not verify at the snapshot route",
    why: "the operation binding is exact — a captured submit token replayed against a read is refused before effects",
    sign: { typ: TYP.edgeToJobs, keyId: "edge-to-jobs.jobs", claims: submitClaims() },
    present: { keyId: "edge-to-jobs.jobs", expected: snapshotExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "a snapshot instruction does not verify at the result route",
    why: "result is its own operation and resource — a read cannot stand in for another",
    sign: { typ: TYP.edgeToJobs, keyId: "edge-to-jobs.jobs", claims: snapshotClaims() },
    present: { keyId: "edge-to-jobs.jobs", expected: resultExpectation(), nowS: IAT },
    expect: { reject: "claims" },
  },
  {
    name: "the bound method is exact",
    why: "a token bound to POST never authorizes the same resource over GET",
    sign: { typ: TYP.edgeToJobs, keyId: "edge-to-jobs.jobs", claims: submitClaims() },
    present: {
      keyId: "edge-to-jobs.jobs",
      expected: submitExpectation({ method: "GET" }),
      nowS: IAT,
    },
    expect: { reject: "method" },
  },
  {
    name: "the bound resource is exact",
    why: "a token for one job never authorizes another — equal-shaped ids included",
    sign: { typ: TYP.edgeToJobs, keyId: "edge-to-jobs.jobs", claims: snapshotClaims() },
    present: {
      keyId: "edge-to-jobs.jobs",
      expected: snapshotExpectation({
        resource: buildJobsInternalResource("snapshot", { jobId: OTHER_JOB_ID }),
      }),
      nowS: IAT,
    },
    expect: { reject: "resource" },
  },
  {
    name: "a query string on the resource breaks the binding",
    why: "the claim binds the path built from the route — anything appended is a different resource",
    sign: { typ: TYP.edgeToJobs, keyId: "edge-to-jobs.jobs", claims: snapshotClaims() },
    present: {
      keyId: "edge-to-jobs.jobs",
      expected: snapshotExpectation({
        resource: `${buildJobsInternalResource("snapshot", { jobId: JOB_ID })}?verbose=1`,
      }),
      nowS: IAT,
    },
    expect: { reject: "resource" },
  },
  {
    name: "the bound body is exact",
    why: "the digest binds the exact bytes — a different input is a different instruction",
    sign: { typ: TYP.edgeToJobs, keyId: "edge-to-jobs.jobs", claims: submitClaims() },
    present: {
      keyId: "edge-to-jobs.jobs",
      expected: submitExpectation({ body: utf8.encode(OTHER_SUBMIT_BODY) }),
      nowS: IAT,
    },
    expect: { reject: "body" },
  },
  {
    name: "a bodyless operation binds empty bytes",
    why: "a snapshot instruction presented over a body is not the instruction that was signed",
    sign: { typ: TYP.edgeToJobs, keyId: "edge-to-jobs.jobs", claims: snapshotClaims() },
    present: {
      keyId: "edge-to-jobs.jobs",
      expected: snapshotExpectation({ body: utf8.encode(SUBMIT_BODY) }),
      nowS: IAT,
    },
    expect: { reject: "body" },
  },
  {
    name: "the callback body is bound exactly",
    why: "the {url} body is the outbound target — swapping it redirects the job's GET",
    sign: { typ: TYP.jobsToEdge, keyId: "jobs-to-edge.jobs", claims: fetchClaims() },
    present: {
      keyId: "jobs-to-edge.jobs",
      expected: fetchExpectation({ body: utf8.encode(OTHER_SUBMIT_BODY) }),
      nowS: IAT,
    },
    expect: { reject: "body" },
  },
  {
    name: "a callback presented with no body is refused on the body binding",
    why: "the header phase passes on the token alone — an empty body is still not the signed {url}, and only the body phase may say so",
    sign: { typ: TYP.jobsToEdge, keyId: "jobs-to-edge.jobs", claims: fetchClaims() },
    present: {
      keyId: "jobs-to-edge.jobs",
      expected: fetchExpectation({ body: JOBS_EMPTY_BODY }),
      nowS: IAT,
    },
    expect: { reject: "body" },
  },
  {
    name: "the lifecycle change is bound exactly",
    why: "the {generation, archived} body is the change — swapping archive for reopen is a different instruction",
    sign: { typ: TYP.portalToJobs, keyId: "portal-to-jobs.jobs", claims: lifecycleClaims() },
    present: {
      keyId: "portal-to-jobs.jobs",
      expected: lifecycleExpectation({ body: utf8.encode(OPEN_BODY) }),
      nowS: IAT,
    },
    expect: { reject: "body" },
  },
  {
    name: "an expired callback with a swapped body reports the header verdict",
    why: "the header phase runs first — a token that fails on its own never reaches the body comparison, so the reason is the header's",
    sign: {
      typ: TYP.jobsToEdge,
      keyId: "jobs-to-edge.jobs",
      claims: fetchClaims({ iat: IAT - 60, exp: IAT - 30 }),
    },
    present: {
      keyId: "jobs-to-edge.jobs",
      expected: fetchExpectation({ body: utf8.encode(OTHER_SUBMIT_BODY) }),
      nowS: IAT,
    },
    expect: { reject: "expired" },
  },
  {
    name: "a callback for another resource with a swapped body reports the resource",
    why: "the resource binding is the header phase's last check and the body the body phase's first — the order holds across the split",
    sign: {
      typ: TYP.jobsToEdge,
      keyId: "jobs-to-edge.jobs",
      claims: fetchClaims({ resource: "/internal/jobs/v1/fetch-other" }),
    },
    present: {
      keyId: "jobs-to-edge.jobs",
      expected: fetchExpectation({ body: utf8.encode(OTHER_SUBMIT_BODY) }),
      nowS: IAT,
    },
    expect: { reject: "resource" },
  },
  {
    name: "a submit with a swapped body and a swapped retry key reports the body",
    why: "the body comparison precedes the retry-key comparison inside the body phase",
    sign: { typ: TYP.edgeToJobs, keyId: "edge-to-jobs.jobs", claims: submitClaims() },
    present: {
      keyId: "edge-to-jobs.jobs",
      expected: submitExpectation({
        body: utf8.encode(OTHER_SUBMIT_BODY),
        idempotencyKeyHeader: "retry-key-2",
      }),
      nowS: IAT,
    },
    expect: { reject: "body" },
  },
  {
    name: "a lifecycle instruction for another app is refused",
    why: "the target app is bound in the resource — one app's archive never applies at another's",
    sign: { typ: TYP.portalToJobs, keyId: "portal-to-jobs.jobs", claims: lifecycleClaims() },
    present: {
      keyId: "portal-to-jobs.jobs",
      expected: lifecycleExpectation({
        resource: buildJobsInternalResource("lifecycle", { appId: OTHER_APP_ID }),
      }),
      nowS: IAT,
    },
    expect: { reject: "resource" },
  },
  {
    name: "a header value cannot override the signed null retry key",
    why: "an unsigned Idempotency-Key header never supplements an instruction bound to no key",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: submitClaims({ idempotencyKey: null }),
    },
    present: {
      keyId: "edge-to-jobs.jobs",
      expected: submitExpectation({ idempotencyKeyHeader: RETRY_KEY }),
      nowS: IAT,
    },
    expect: { reject: "idempotency_key" },
  },
  {
    name: "a dropped header cannot redeem a keyed instruction",
    why: "the signed retry key must arrive as the header — absence is a different request",
    sign: { typ: TYP.edgeToJobs, keyId: "edge-to-jobs.jobs", claims: submitClaims() },
    present: {
      keyId: "edge-to-jobs.jobs",
      expected: submitExpectation({ idempotencyKeyHeader: null }),
      nowS: IAT,
    },
    expect: { reject: "idempotency_key" },
  },
  {
    name: "a different header value cannot redeem a keyed instruction",
    why: "the header must equal the signed key — a substituted key is a replay of someone else's identity",
    sign: { typ: TYP.edgeToJobs, keyId: "edge-to-jobs.jobs", claims: submitClaims() },
    present: {
      keyId: "edge-to-jobs.jobs",
      expected: submitExpectation({ idempotencyKeyHeader: "retry-key-2" }),
      nowS: IAT,
    },
    expect: { reject: "idempotency_key" },
  },

  // ── Tampering ─────────────────────────────────────────────────────────────
  {
    name: "a flipped signature character",
    why: "the signature is verified constant-time over the exact header and payload bytes",
    sign: { typ: TYP.edgeToJobs, keyId: "edge-to-jobs.jobs", claims: submitClaims() },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    transform: "flip-signature-char",
    expect: { reject: "signature" },
  },
  {
    name: "an altered payload fails the signature",
    why: "changing any signed byte — here a claim — invalidates the MAC; there is no verify-then-trust",
    sign: { typ: TYP.edgeToJobs, keyId: "edge-to-jobs.jobs", claims: submitClaims() },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    transform: "flip-payload-char",
    expect: { reject: "signature" },
  },
  {
    name: "a fourth segment fails the compact form",
    why: "an instruction is exactly three segments — anything else is not this profile",
    sign: { typ: TYP.edgeToJobs, keyId: "edge-to-jobs.jobs", claims: submitClaims() },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    transform: "append-segment",
    expect: { reject: "malformed" },
  },
  {
    name: "an empty signature segment fails",
    why: "a token without a signature is not an instruction, however well-formed the rest looks",
    sign: { typ: TYP.edgeToJobs, keyId: "edge-to-jobs.jobs", claims: submitClaims() },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    transform: "empty-signature-segment",
    expect: { reject: "malformed" },
  },

  // ── Lifetime and tolerance boundaries ─────────────────────────────────────
  {
    name: "one second past the maximum lifetime fails",
    why: "exp − iat may equal 30 s and never exceed it — the excess is refused even while still fresh",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: submitClaims({ exp: IAT + 31 }),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "lifetime" },
  },
  {
    name: "double the maximum lifetime fails",
    why: "no configuration mints longer instructions — the bound is the contract's",
    sign: {
      typ: TYP.edgeToJobs,
      keyId: "edge-to-jobs.jobs",
      claims: submitClaims({ exp: IAT + 60 }),
    },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT },
    expect: { reject: "lifetime" },
  },
  {
    name: "one second past the expiry tolerance fails",
    why: "the validity window closes at exp + 5 — the boundary is inclusive, past it the token is expired",
    sign: { typ: TYP.edgeToJobs, keyId: "edge-to-jobs.jobs", claims: submitClaims() },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT + 36 },
    expect: { reject: "expired" },
  },
  {
    name: "one second before the validity window opens fails",
    why: "the window opens at iat − 5 — earlier, the token is not yet valid",
    sign: { typ: TYP.edgeToJobs, keyId: "edge-to-jobs.jobs", claims: submitClaims() },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: IAT - 6 },
    expect: { reject: "not_yet_valid" },
  },
  {
    name: "a receiver clock that cannot complete the comparisons refuses the instruction",
    why: "a NaN clock makes every freshness comparison answer false — the gate must deny with the conservative verdict, never skip",
    sign: { typ: TYP.edgeToJobs, keyId: "edge-to-jobs.jobs", claims: submitClaims() },
    present: { keyId: "edge-to-jobs.jobs", expected: submitExpectation(), nowS: Number.NaN },
    expect: { reject: "expired" },
  },
];

/**
 * Run the whole vector corpus against a harness. Every acceptance must be
 * accepted and every rejection must fail with the named reason — the runner
 * throws naming each mismatch, so a receiver's suite fails with the vector
 * evidence in the message. A harness fault is the same kind of evidence
 * however it arrives: each of the three callbacks is wrapped, and the verdict
 * is judged under the same guard — a mirror that throws on one token form,
 * or whose `verify` resolves to a shape the judgment cannot read, gets a
 * named failure for that vector and the rest of the corpus still runs — a
 * bare exception would name no vector and strand every unexecuted judgment
 * behind it.
 */
export async function runJobsSigningVectors(harness: JobsSigningVectorHarness): Promise<void> {
  const failures: string[] = [];
  const faultDetail = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
  const resolvedShape = (value: string): string =>
    value === undefined ? "undefined" : value === null ? "null" : `a value of type ${typeof value}`;
  for (const vector of JOBS_SIGNING_VECTORS) {
    // A callback that resolves to nothing hands the next stage a token that
    // does not exist; the crash would surface in the CONSUMING callback's
    // wrap and point the operator at the wrong seam. Each resolution is
    // therefore shape-guarded at the seam that produced it — the fault is
    // named for the callback that resolved.
    let token: string;
    try {
      token = await harness.sign(vector.sign);
    } catch (error) {
      failures.push(
        `vector "${vector.name}": the harness could not sign — ${faultDetail(error)} — ${vector.why}`,
      );
      continue;
    }
    if (typeof token !== "string") {
      failures.push(
        `vector "${vector.name}": the harness could not sign — it resolved to ${resolvedShape(token)}, not a token — ${vector.why}`,
      );
      continue;
    }
    if (vector.transform) {
      try {
        token = harness.transform(token, vector.transform);
      } catch (error) {
        failures.push(
          `vector "${vector.name}": the harness could not transform — ${faultDetail(error)} — ${vector.why}`,
        );
        continue;
      }
      if (typeof token !== "string") {
        failures.push(
          `vector "${vector.name}": the harness could not transform — it resolved to ${resolvedShape(token)}, not a token — ${vector.why}`,
        );
        continue;
      }
    }
    // The judgment is guarded with the call: a verdict whose SHAPE the read
    // cannot survive — a resolved null, or an `ok` getter that throws — is
    // the mirror's fault, the same class as a thrown one, arriving by
    // resolution instead of by throw. Named, collected, and the corpus keeps
    // running.
    try {
      const verdict = await harness.verify({
        token,
        keyId: vector.present.keyId,
        expected: vector.present.expected,
        nowS: vector.present.nowS,
      });
      const expectedOk = vector.expect === "accept";
      const reasonMatches = expectedOk || verdict.reason === vector.expect.reject;
      if (verdict.ok !== expectedOk || !reasonMatches) {
        const detail = verdict.ok
          ? "the instruction verified"
          : `it failed with reason "${verdict.reason ?? "none"}"`;
        const wanted = expectedOk
          ? "acceptance"
          : `rejection with reason "${vector.expect.reject}"`;
        failures.push(`vector "${vector.name}" expected ${wanted} — ${detail} — ${vector.why}`);
      }
    } catch (error) {
      failures.push(
        `vector "${vector.name}": the harness could not verify — ${faultDetail(error)} — ${vector.why}`,
      );
      continue;
    }
  }
  if (failures.length > 0) {
    throw new Error(`jobs signing vectors failed:\n${failures.join("\n")}`);
  }
}

// ── Golden tokens: the recorded wire evidence ────────────────────────────────

/**
 * A recorded compact instruction token, minted once at authoring time over the
 * recorded root — the literal bytes on the wire, presented verbatim.
 */
export interface JobsGoldenTokenVector {
  readonly name: string;
  readonly why: string;
  readonly token: string;
  /** The root the token was derived and signed over. */
  readonly keyId: string;
  readonly expected: JobsInstructionExpectation;
  /** The verification clock, in seconds. */
  readonly nowS: number;
  readonly expect: "accept" | { readonly reject: JobsInstructionRejectReason };
}

/**
 * The golden tokens exist because the minted corpus proves self-agreement,
 * not conformance: a harness that mints and verifies through one
 * implementation accepts any consistently wrong value of the signing-domain
 * constants. A recorded token pins the whole chain literally — the HKDF info
 * the receiver must derive with, the protected-header profile, the claim JSON
 * encoding — in both directions: a mirror that implements the ADR's literal
 * table is accepted, and this package's own constants cannot drift away from
 * the recorded derivation without going red here first. Each token's claims
 * are the shared fixed world (the same identities, bodies and clock the
 * minted corpus uses); the `jti` values are the ones drawn at authoring time.
 */
export const JOBS_GOLDEN_TOKEN_VECTORS: readonly JobsGoldenTokenVector[] = [
  {
    name: "the golden edge→jobs submit instruction verifies",
    why: "the recorded bytes pin the edge→jobs derivation info, header profile and claim encoding literally",
    token:
      "eyJhbGciOiJIUzI1NiIsInR5cCI6ImhlbGl4LWVkZ2Utam9icytqd3QifQ.eyJpc3MiOiJoZWxpeC1lZGdlIiwiYXVkIjoiaGVsaXgtam9iczpqb2JzIiwianRpIjoiZ29sZGVuLXN1Ym1pdC1qdGkiLCJpYXQiOjE4MDAwMDAwMDAsImV4cCI6MTgwMDAwMDAzMCwic2VydmVyIjoiam9icyIsIm9wZXJhdGlvbiI6InN1Ym1pdCIsIm1ldGhvZCI6IlBPU1QiLCJyZXNvdXJjZSI6Ii9pbnRlcm5hbC9qb2JzL3YxL2pvYnMiLCJib2R5U2hhMjU2IjoiYjZjN2I1ZDVjNDY2YjQ3NjIzNmI0NWNjODQ5NGU4NmMwOTI5ZWI2YTRiYWIyODMzZmU3NjcxYWZjNTcyODE1MSIsImFwcElkIjoiMGI5ZThjM2UtNmYyYS00YzliLTllMWYtMmE0YjZjOGQwZTJmIiwiZW52IjoicHJvZCIsIm93bmVyS2luZCI6InVzZXIiLCJvd25lck9pZCI6IjRmN2EyYjNjLTlkMWUtNGE1Yi04YzZkLTBlMmY0YTZiOGMwZCIsImFsbG93ZWRUeXBlcyI6WyJqb2JzOmZldGNoIl0sInR5cGUiOiJqb2JzOmZldGNoIiwiZ2VuZXJhdGlvbiI6IjciLCJpZGVtcG90ZW5jeUtleSI6bnVsbH0.dUEqgoMYdesn59PQNsQc4Aqma-hVELC0KzPnpuVOBIA",
    keyId: "edge-to-jobs.jobs",
    expected: submitExpectation({ idempotencyKeyHeader: null }),
    nowS: IAT,
    expect: "accept",
  },
  {
    name: "the golden fetch callback instruction verifies",
    why: "the recorded bytes pin the jobs→edge derivation info, header profile and claim encoding literally",
    token:
      "eyJhbGciOiJIUzI1NiIsInR5cCI6ImhlbGl4LWpvYnMtZWRnZStqd3QifQ.eyJpc3MiOiJoZWxpeC1qb2JzOmpvYnMiLCJhdWQiOiJoZWxpeC1lZGdlLWpvYnMtY2FsbGJhY2s6am9icyIsImp0aSI6ImdvbGRlbi1mZXRjaC1qdGkiLCJpYXQiOjE4MDAwMDAwMDAsImV4cCI6MTgwMDAwMDAzMCwic2VydmVyIjoiam9icyIsIm9wZXJhdGlvbiI6ImZldGNoIiwibWV0aG9kIjoiUE9TVCIsInJlc291cmNlIjoiL2ludGVybmFsL2pvYnMvdjEvZmV0Y2giLCJib2R5U2hhMjU2IjoiYjZjN2I1ZDVjNDY2YjQ3NjIzNmI0NWNjODQ5NGU4NmMwOTI5ZWI2YTRiYWIyODMzZmU3NjcxYWZjNTcyODE1MSIsImFwcElkIjoiMGI5ZThjM2UtNmYyYS00YzliLTllMWYtMmE0YjZjOGQwZTJmIiwiZW52IjoicHJvZCIsIm93bmVyS2luZCI6InVzZXIiLCJvd25lck9pZCI6IjRmN2EyYjNjLTlkMWUtNGE1Yi04YzZkLTBlMmY0YTZiOGMwZCIsInR5cGUiOiJqb2JzOmZldGNoIiwiam9iSWQiOiJ3OVFaemFCcDRYa1IzdFltMDE3YzMiLCJnZW5lcmF0aW9uIjoiNyJ9.Czh-TH-Qsln-hsDF3ijIi3DE8cE4BB_2AxVhWBPoa-s",
    keyId: "jobs-to-edge.jobs",
    expected: fetchExpectation(),
    nowS: IAT,
    expect: "accept",
  },
  {
    name: "the golden lifecycle delivery instruction verifies",
    why: "the recorded bytes pin the portal→jobs derivation info, header profile and claim encoding literally",
    token:
      "eyJhbGciOiJIUzI1NiIsInR5cCI6ImhlbGl4LXBvcnRhbC1qb2JzK2p3dCJ9.eyJpc3MiOiJoZWxpeC1wb3J0YWwiLCJhdWQiOiJoZWxpeC1qb2JzLWxpZmVjeWNsZTpqb2JzIiwianRpIjoiZ29sZGVuLXBvcnRhbC10by1qb2JzIiwiaWF0IjoxODAwMDAwMDAwLCJleHAiOjE4MDAwMDAwMzAsInNlcnZlciI6ImpvYnMiLCJvcGVyYXRpb24iOiJsaWZlY3ljbGUiLCJtZXRob2QiOiJQT1NUIiwicmVzb3VyY2UiOiIvaW50ZXJuYWwvam9icy92MS9saWZlY3ljbGUvMGI5ZThjM2UtNmYyYS00YzliLTllMWYtMmE0YjZjOGQwZTJmIiwiYm9keVNoYTI1NiI6IjFmY2Q2ZWM3MDA0NzMwNTU2YzA2YjllNDBmODJlZmIwYTgxYjAwNmFhYmEwN2QwNDg1ZDQwZjI5ZWUxY2RhZjEifQ.VnNfUTHqeGh8QSWIhCVmJ-byVS0fhb71uAnybbQqZu0",
    keyId: "portal-to-jobs.jobs",
    expected: lifecycleExpectation(),
    nowS: IAT,
    expect: "accept",
  },
  {
    name: "a golden token is refused under another direction's root",
    why: "the recorded derivation is keyed — the same bytes never verify through a different direction's HKDF info",
    token:
      "eyJhbGciOiJIUzI1NiIsInR5cCI6ImhlbGl4LWVkZ2Utam9icytqd3QifQ.eyJpc3MiOiJoZWxpeC1lZGdlIiwiYXVkIjoiaGVsaXgtam9iczpqb2JzIiwianRpIjoiZ29sZGVuLXN1Ym1pdC1qdGkiLCJpYXQiOjE4MDAwMDAwMDAsImV4cCI6MTgwMDAwMDAzMCwic2VydmVyIjoiam9icyIsIm9wZXJhdGlvbiI6InN1Ym1pdCIsIm1ldGhvZCI6IlBPU1QiLCJyZXNvdXJjZSI6Ii9pbnRlcm5hbC9qb2JzL3YxL2pvYnMiLCJib2R5U2hhMjU2IjoiYjZjN2I1ZDVjNDY2YjQ3NjIzNmI0NWNjODQ5NGU4NmMwOTI5ZWI2YTRiYWIyODMzZmU3NjcxYWZjNTcyODE1MSIsImFwcElkIjoiMGI5ZThjM2UtNmYyYS00YzliLTllMWYtMmE0YjZjOGQwZTJmIiwiZW52IjoicHJvZCIsIm93bmVyS2luZCI6InVzZXIiLCJvd25lck9pZCI6IjRmN2EyYjNjLTlkMWUtNGE1Yi04YzZkLTBlMmY0YTZiOGMwZCIsImFsbG93ZWRUeXBlcyI6WyJqb2JzOmZldGNoIl0sInR5cGUiOiJqb2JzOmZldGNoIiwiZ2VuZXJhdGlvbiI6IjciLCJpZGVtcG90ZW5jeUtleSI6bnVsbH0.dUEqgoMYdesn59PQNsQc4Aqma-hVELC0KzPnpuVOBIA",
    keyId: "jobs-to-edge.jobs",
    expected: submitExpectation(),
    nowS: IAT,
    expect: { reject: "signature" },
  },
];

/**
 * Run the golden tokens against a verifier — the same verify seam the minted
 * corpus uses, handed the recorded bytes verbatim. Every acceptance must be
 * accepted and every rejection must fail with the named reason; the runner
 * throws naming each mismatch.
 */
export async function runJobsGoldenTokenVectors(
  verify: (input: {
    token: string;
    keyId: string;
    expected: JobsInstructionExpectation;
    nowS: number;
  }) => Promise<JobsVectorVerdict>,
): Promise<void> {
  const failures: string[] = [];
  for (const vector of JOBS_GOLDEN_TOKEN_VECTORS) {
    try {
      const verdict = await verify({
        token: vector.token,
        keyId: vector.keyId,
        expected: vector.expected,
        nowS: vector.nowS,
      });
      const expectedOk = vector.expect === "accept";
      const reasonMatches = expectedOk || verdict.reason === vector.expect.reject;
      if (verdict.ok !== expectedOk || !reasonMatches) {
        const detail = verdict.ok
          ? "the instruction verified"
          : `it failed with reason "${verdict.reason ?? "none"}"`;
        const wanted = expectedOk
          ? "acceptance"
          : `rejection with reason "${vector.expect.reject}"`;
        failures.push(`vector "${vector.name}" expected ${wanted} — ${detail} — ${vector.why}`);
      }
    } catch (error) {
      failures.push(
        `vector "${vector.name}": the harness could not verify — ${
          error instanceof Error ? error.message : String(error)
        } — ${vector.why}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(`jobs golden-token vectors failed:\n${failures.join("\n")}`);
  }
}
