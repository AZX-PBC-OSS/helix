import { createHash, hkdfSync, randomUUID } from "node:crypto";

import { compactVerify, SignJWT } from "jose";
import { z } from "zod";

import { AppSchema } from "./app.js";
import { EnvSchema } from "./env.js";
import {
  assertParsesAgainstWireSchema,
  type JobOwnerKind,
  JobOwnerKindSchema,
  JobRetryKeySchema,
  JobServerIdSchema,
  JobIdSchema,
  JobsGenerationSchema,
  isValidJobsRootSecret,
  qualifiedTypeMatchesServer,
  QualifiedJobTypeSchema,
  strictWireObject,
} from "./jobs.js";

/**
 * The signed internal instruction contract for the background-jobs hops
 * (background-jobs-plane design §3) — the single definition of
 * the operation matrix, the per-direction signing domains, the instruction
 * claim schemas, and a reference mint/verify implementation every signer and
 * receiver shares.
 *
 * Three independently keyed directions connect the planes: the edge submits
 * and operates on jobs (edge→jobs), an executing job calls its fetch callback
 * on the edge (jobs→edge), and the portal delivers app lifecycle changes
 * (portal→jobs). Each instruction is a short-lived HS256 JWT whose claims bind
 * the exact operation, method, resource and body bytes it authorizes, plus the
 * server it is addressed to — a receiver rejects a token minted for another
 * server, another direction, or another resource even when its shape is valid.
 * Instructions travel in the same header as the existing egress instruction
 * (`INSTRUCTION_HEADER` from `@azx-pbc/shared` — `x-helix-instruction`, per
 * ADR-0013); the `typ` header, the server-scoped audience and the
 * independently generated per-server roots are what keep the families
 * unredeemable as each other.
 *
 * This module is the engine, not the enforcement: the durable `jti` burns that
 * stop transport replay belong to each receiver's store (jobs keeps its own;
 * the edge's callback burns live in the platform database). Receivers burn the
 * `jti` before any side effect, with retention of at least
 * {@link JOBS_INSTRUCTION_BURN_RETENTION_SECONDS}; a legitimate retry mints a
 * fresh instruction carrying the original retry identity. The executable
 * positive/negative vectors for all of this live in `./jobsSigningVectors.ts`.
 *
 * Unlike the other internal-token seams — whose mint and verify halves live
 * in each plane (`apps/egress/src/instruction.ts` verifies what
 * `apps/edge/src/gateway/egressProvider.ts` mints; each plane holds an
 * `internalJwt.ts` for the payload-free edge↔portal and portal↔egress
 * directions) — the implementation is shared here on purpose: these tokens
 * carry a rich per-operation claim contract enforced at six call sites
 * (three directions, both ends), and one enforcement point is what keeps the
 * binding rules from drifting between receivers. Only the receivers' own
 * state — the burns — and their route wiring stay per plane.
 *
 * This module is deliberately **not** re-exported from the browser barrel: it
 * imports `node:crypto` and `jose`. Server code imports
 * `@azx-pbc/shared/jobsSigning` directly.
 */

/** The three signed internal directions, named by the minter→receiver pair. */
export type JobsSigningDirection = "edgeToJobs" | "jobsToEdge" | "portalToJobs";

/**
 * The per-direction signing domains (background-jobs-plane design §3). Each
 * entry names the configuration key holding that server+direction's
 * independently generated
 * root, the JWT `typ` header, the audience prefix completed with the server
 * id, and the HKDF info string that domain-separates the derived key. The
 * roots are fields of each server's entry in the deployment configuration —
 * never singleton shared secrets — so one server's roots authorize nothing at
 * another server or in another direction.
 */
export const JobsSigningDomains = {
  edgeToJobs: {
    secretEnvVar: "JOBS_EDGE_TO_JOBS_SECRET",
    jwtTyp: "helix-edge-jobs+jwt",
    audiencePrefix: "helix-jobs:",
    hkdfInfo: "helix-edge-jobs-v1",
    /** The edge mints; its issuer is the plane, not a server namespace. */
    issuer: "helix-edge",
  },
  jobsToEdge: {
    secretEnvVar: "JOBS_JOBS_TO_EDGE_SECRET",
    jwtTyp: "helix-jobs-edge+jwt",
    audiencePrefix: "helix-edge-jobs-callback:",
    hkdfInfo: "helix-jobs-edge-v1",
    /** Jobs mints; its issuer names the server the instruction comes from. */
    issuerPrefix: "helix-jobs:",
  },
  portalToJobs: {
    secretEnvVar: "JOBS_PORTAL_TO_JOBS_SECRET",
    jwtTyp: "helix-portal-jobs+jwt",
    audiencePrefix: "helix-jobs-lifecycle:",
    hkdfInfo: "helix-portal-jobs-v1",
    issuer: "helix-portal",
  },
} as const;

/** The audience a direction's instruction carries for `server` — server and direction in one value. */
function jobsSigningAudience(direction: JobsSigningDirection, server: string): string {
  return `${JobsSigningDomains[direction].audiencePrefix}${server}`;
}

/** The issuer a direction's instruction carries for `server`. */
function jobsSigningIssuer(direction: JobsSigningDirection, server: string): string {
  const domain = JobsSigningDomains[direction];
  return "issuer" in domain ? domain.issuer : `${domain.issuerPrefix}${server}`;
}

/**
 * The internal operation matrix (background-jobs-plane design §3). The
 * operation name fixes the
 * direction, HTTP method and resource template; signers and receivers derive
 * all three from here instead of restating them, so a route and its signed
 * binding cannot drift. Paths are the deployed internal routes, registered
 * verbatim by the jobs listener and the edge callback.
 */
export const JobsOperations = {
  submit: { direction: "edgeToJobs", method: "POST", path: "/internal/jobs/v1/jobs" },
  snapshot: { direction: "edgeToJobs", method: "GET", path: "/internal/jobs/v1/jobs/:jobId" },
  result: {
    direction: "edgeToJobs",
    method: "GET",
    path: "/internal/jobs/v1/jobs/:jobId/result",
  },
  cancel: { direction: "edgeToJobs", method: "DELETE", path: "/internal/jobs/v1/jobs/:jobId" },
  fetch: { direction: "jobsToEdge", method: "POST", path: "/internal/jobs/v1/fetch" },
  lifecycle: {
    direction: "portalToJobs",
    method: "POST",
    path: "/internal/jobs/v1/lifecycle/:appId",
  },
} as const;

export type JobsOperationName = keyof typeof JobsOperations;

/**
 * The concrete internal resource an instruction binds: the operation's path
 * template with its parameters filled from the route. Signers build it from
 * the operation's parameters; receivers rebuild it from their route params and
 * compare against the signed claim, so both ends derive the string from this
 * one template. Path parameters are schema-validated before substitution — a
 * job id or app id that fails its syntax is a construction error, not a
 * resource to sign.
 */
export function buildJobsInternalResource(
  operation: JobsOperationName,
  params: { readonly jobId?: string; readonly appId?: string } = {},
): string {
  const template = JobsOperations[operation].path;
  let resource: string = template;
  if (template.includes(":jobId")) {
    const jobId = params.jobId;
    if (jobId === undefined || !JobIdSchema.safeParse(jobId).success) {
      throw new Error(
        `the ${operation} instruction binds a job id, and "${String(jobId)}" is not one`,
      );
    }
    resource = resource.replace(":jobId", jobId);
  }
  if (template.includes(":appId")) {
    const appId = params.appId;
    if (appId === undefined || !AppSchema.shape.id.safeParse(appId).success) {
      throw new Error(
        `the ${operation} instruction binds an app id, and "${String(appId)}" is not one`,
      );
    }
    resource = resource.replace(":appId", appId);
  }
  return resource;
}

// ── Freshness and burn bounds ────────────────────────────────────────────────

/** Maximum instruction lifetime: `exp - iat` may equal but never exceed this. */
export const JOBS_INSTRUCTION_MAX_LIFETIME_SECONDS = 30;
/** Clock tolerance applied on both sides of the validity window. */
export const JOBS_INSTRUCTION_CLOCK_TOLERANCE_SECONDS = 5;
/**
 * Minimum burn retention for a consumed `jti`. A token is verifiable from
 * `iat - tolerance` to `exp + tolerance`; burned at its first valid
 * presentation, it can still verify — against a replica that has not seen the
 * burn, or after a receiver restart — for at most `tolerance + maxLifetime +
 * tolerance` = 40 s after that burn. Retention below this accepts replays.
 */
export const JOBS_INSTRUCTION_BURN_RETENTION_SECONDS = 60;

/** The exact body bytes of a bodyless operation (snapshot, result, cancel): SHA-256 of empty. */
export const JOBS_EMPTY_BODY: Uint8Array = new Uint8Array(0);

/** Lowercase SHA-256 hex of the exact request body bytes — the body-binding claim's value. */
export function sha256BodyDigest(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

// ── Instruction claim schemas ────────────────────────────────────────────────

/**
 * The signed claims of one instruction, minus the registered JWT claims
 * (`iss`, `aud`, `iat`, `exp`, `jti`) which the verifier handles itself and
 * strips before this strict parse. Unknown claims fail — a future claim rolls
 * receivers first, and the superseded admission machinery (`admissionId`,
 * `admissionDay`, `admissionDeadline`) stays unrepresentable. There is no
 * default owner or environment: every identity field is mandatory and
 * explicit, on every operation that carries identity at all.
 */
const INSTRUCTION_METHOD_SCHEMA = z.enum(["GET", "POST", "DELETE"]);
const INSTRUCTION_RESOURCE_SCHEMA = z
  .string()
  .refine(
    (resource) => resource.startsWith("/") && !resource.includes("?") && !resource.includes("#"),
    "the bound resource is the concrete internal path — no query strings or fragments",
  );
const INSTRUCTION_BODY_DIGEST_SCHEMA = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "a lowercase SHA-256 hex digest");

const INSTRUCTION_COMMON_SHAPE = {
  /** The server the instruction is addressed to — the receiver's own id, rechecked on every verify. */
  server: JobServerIdSchema,
  method: INSTRUCTION_METHOD_SCHEMA,
  resource: INSTRUCTION_RESOURCE_SCHEMA,
  bodySha256: INSTRUCTION_BODY_DIGEST_SCHEMA,
};

/** The identity claims every user operation binds (design §3), on top of the common server binding. */
const USER_OPERATION_IDENTITY_SHAPE = {
  appId: AppSchema.shape.id,
  env: EnvSchema,
  ownerKind: JobOwnerKindSchema,
  ownerOid: z.string().min(1),
  allowedTypes: z.array(QualifiedJobTypeSchema),
};

/**
 * Submission claims: the user-operation identity plus the selected qualified
 * type, the app's current lifecycle generation and the optional retry key —
 * explicit `null` when the submission carried none, so an unsigned
 * `Idempotency-Key` header can never override or supplement the signed one.
 */
export const JobsSubmitClaimsSchema = strictWireObject({
  ...INSTRUCTION_COMMON_SHAPE,
  operation: z.literal("submit"),
  ...USER_OPERATION_IDENTITY_SHAPE,
  type: QualifiedJobTypeSchema,
  generation: JobsGenerationSchema,
  idempotencyKey: JobRetryKeySchema.nullable(),
}).superRefine((claims, ctx) => {
  if (!qualifiedTypeMatchesServer(claims.type, claims.server)) {
    ctx.addIssue({
      code: "custom",
      path: ["type"],
      message: "the qualified type's server prefix must equal the instruction's server",
    });
  }
  if (claims.allowedTypes.some((t) => !qualifiedTypeMatchesServer(t, claims.server))) {
    ctx.addIssue({
      code: "custom",
      path: ["allowedTypes"],
      message: "every allowed type must be qualified for the instruction's server",
    });
  }
});
export type JobsSubmitClaims = z.infer<typeof JobsSubmitClaimsSchema>;

/**
 * The claims of the operations on an existing job record — status, result and
 * cancellation. The record's type is not claimed: the receiver resolves it
 * from the addressed job and checks it against the signed `allowedTypes`
 * (the edge's current grants) after the record-ownership comparison.
 */
function jobRecordOperationClaimsSchema<Operation extends "snapshot" | "result" | "cancel">(
  operation: Operation,
) {
  return strictWireObject({
    ...INSTRUCTION_COMMON_SHAPE,
    operation: z.literal(operation),
    ...USER_OPERATION_IDENTITY_SHAPE,
  }).superRefine((claims, ctx) => {
    if (claims.allowedTypes.some((t) => !qualifiedTypeMatchesServer(t, claims.server))) {
      ctx.addIssue({
        code: "custom",
        path: ["allowedTypes"],
        message: "every allowed type must be qualified for the instruction's server",
      });
    }
  });
}

export const JobsSnapshotClaimsSchema = jobRecordOperationClaimsSchema("snapshot");
export type JobsSnapshotClaims = z.infer<typeof JobsSnapshotClaimsSchema>;

export const JobsResultClaimsSchema = jobRecordOperationClaimsSchema("result");
export type JobsResultClaims = z.infer<typeof JobsResultClaimsSchema>;

export const JobsCancelClaimsSchema = jobRecordOperationClaimsSchema("cancel");
export type JobsCancelClaims = z.infer<typeof JobsCancelClaimsSchema>;

/**
 * The fetch-callback claims: the job's immutable identity plus its
 * server-local id and the lifecycle generation it was admitted under, bound to
 * the `{url}` body by digest. The receiving edge refuses the opposite
 * environment tier and rechecks the claimed generation against its current
 * registry generation before dispatch (background-jobs-plane design §2).
 */
export const JobsFetchCallbackClaimsSchema = strictWireObject({
  ...INSTRUCTION_COMMON_SHAPE,
  operation: z.literal("fetch"),
  appId: AppSchema.shape.id,
  env: EnvSchema,
  ownerKind: JobOwnerKindSchema,
  ownerOid: z.string().min(1),
  type: QualifiedJobTypeSchema,
  jobId: JobIdSchema,
  generation: JobsGenerationSchema,
}).superRefine((claims, ctx) => {
  if (!qualifiedTypeMatchesServer(claims.type, claims.server)) {
    ctx.addIssue({
      code: "custom",
      path: ["type"],
      message: "the qualified type's server prefix must equal the instruction's server",
    });
  }
});
export type JobsFetchCallbackClaims = z.infer<typeof JobsFetchCallbackClaimsSchema>;

/**
 * The lifecycle-delivery claims. The target app is bound by the resource path
 * (`/internal/jobs/v1/lifecycle/:appId`); the change itself travels in the
 * `{generation, archived}` body bound by digest. No identity claims: lifecycle
 * authority is the portal's alone and authorizes nothing about any user
 * operation or callback.
 */
export const JobsLifecycleClaimsSchema = strictWireObject({
  ...INSTRUCTION_COMMON_SHAPE,
  operation: z.literal("lifecycle"),
});
export type JobsLifecycleClaims = z.infer<typeof JobsLifecycleClaimsSchema>;

/** The instruction claims for one operation, discriminated by `operation`. */
export type JobsInstructionClaims =
  | JobsSubmitClaims
  | JobsSnapshotClaims
  | JobsResultClaims
  | JobsCancelClaims
  | JobsFetchCallbackClaims
  | JobsLifecycleClaims;

const INSTRUCTION_CLAIM_SCHEMAS = {
  submit: JobsSubmitClaimsSchema,
  snapshot: JobsSnapshotClaimsSchema,
  result: JobsResultClaimsSchema,
  cancel: JobsCancelClaimsSchema,
  fetch: JobsFetchCallbackClaimsSchema,
  lifecycle: JobsLifecycleClaimsSchema,
};

// ── Key derivation ───────────────────────────────────────────────────────────

/**
 * Derive one direction's HS256 signing key from its root secret: HKDF-SHA-256
 * over the decoded 32-byte root, empty salt, 32 output bytes, keyed by the
 * direction's info string (background-jobs-plane design §3). Both ends of a
 * direction derive identically; different directions derive unrelated keys,
 * and different servers hold independently generated roots. The root must
 * decode from standard base64 to exactly 32 bytes — anything else is a
 * boot-time configuration error, never a weaker key.
 */
export function deriveJobsInstructionKey(
  rootBase64: string,
  direction: JobsSigningDirection,
): Uint8Array {
  const domain = JobsSigningDomains[direction];
  if (!isValidJobsRootSecret(rootBase64)) {
    throw new Error(`${domain.secretEnvVar} must be a base64-encoded 32-byte root secret`);
  }
  const root = Buffer.from(rootBase64, "base64");
  return new Uint8Array(hkdfSync("sha256", root, Buffer.alloc(0), domain.hkdfInfo, 32));
}

// ── Signing ──────────────────────────────────────────────────────────────────

/**
 * Serialize and sign one instruction token from a raw payload bag under the
 * HS256 compact-JWT profile: protected header exactly `{alg: "HS256", typ}`,
 * payload exactly the given claims. This is the profile's one signing
 * primitive — the production minter below builds contract-valid bags and
 * delegates here, and the signing-vector harness uses it directly to mint the
 * deliberate violations. It signs whatever it is given; claims discipline
 * belongs to the minter's spec and the verifier's parse.
 */
export async function signJobsInstructionClaims(
  typ: string,
  claims: Record<string, unknown>,
  key: Uint8Array,
): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256", typ }).sign(key);
}

/** The identity claims a user-operation instruction carries, as the minter accepts them. */
export interface JobsUserOperationIdentity {
  readonly appId: string;
  readonly env: z.infer<typeof EnvSchema>;
  readonly ownerKind: JobOwnerKind;
  readonly ownerOid: string;
  readonly allowedTypes: readonly string[];
}

/** The identity claims the fetch-callback instruction carries: the job's own attribution. */
export interface JobsCallbackIdentity {
  readonly appId: string;
  readonly env: z.infer<typeof EnvSchema>;
  readonly ownerKind: JobOwnerKind;
  readonly ownerOid: string;
  readonly type: string;
}

/**
 * What one production instruction authorizes, discriminated by operation. The
 * direction, method, resource and registered claims are derived, never
 * specified: the operation fixes the direction and method through
 * {@link JobsOperations}, the resource is built from the operation's own
 * parameters, the lifetime is the platform maximum, and the `jti` is fresh per
 * mint. A body-carrying operation binds the exact bytes given; operations on
 * an existing job record are bodyless and bind the empty digest.
 */
export type JobsInstructionMintSpec =
  | {
      operation: "submit";
      server: string;
      identity: JobsUserOperationIdentity;
      type: string;
      generation: string;
      idempotencyKey: string | null;
      body: Uint8Array;
      iatS: number;
    }
  | {
      operation: "snapshot" | "result" | "cancel";
      server: string;
      identity: JobsUserOperationIdentity;
      jobId: string;
      iatS: number;
    }
  | {
      operation: "fetch";
      server: string;
      identity: JobsCallbackIdentity;
      jobId: string;
      generation: string;
      body: Uint8Array;
      iatS: number;
    }
  | { operation: "lifecycle"; server: string; appId: string; body: Uint8Array; iatS: number };

/**
 * Mint one instruction. The built claim set is checked against the operation's
 * own claim schema before signing, so a spec that violates the contract — a
 * type prefixed for another server, a non-canonical generation, a malformed
 * retry key — throws here instead of producing a token no receiver may accept.
 * The issue timestamp is held to the same discipline before anything is built:
 * a fractional or non-finite `iatS` would stamp an `iat`/`exp` the verifier
 * always refuses (a NaN serializes as `null`), and above the double-
 * precision boundary the stamped `exp` — `iatS +` the maximum lifetime — can
 * round one second past the true sum, a lifetime no receiver accepts at its
 * clock-independent lifetime check. Both throw here, at the one component
 * that can catch a clock-integration bug.
 */
export async function mintJobsInstruction(
  spec: JobsInstructionMintSpec,
  key: Uint8Array,
): Promise<string> {
  const { operation, server, iatS } = spec;
  if (
    !Number.isInteger(iatS) ||
    iatS > Number.MAX_SAFE_INTEGER - JOBS_INSTRUCTION_MAX_LIFETIME_SECONDS
  ) {
    throw new Error(
      `the ${operation} instruction's iatS must be a whole number of seconds small enough that the stamped exp is exactly representable — ${String(
        iatS,
      )} would mint a token no receiver may accept`,
    );
  }
  const direction = JobsOperations[operation].direction;

  let claims: Record<string, unknown>;
  let body: Uint8Array;
  switch (operation) {
    case "submit":
      claims = {
        server,
        operation,
        ...spec.identity,
        type: spec.type,
        generation: spec.generation,
        idempotencyKey: spec.idempotencyKey,
      };
      body = spec.body;
      break;
    case "snapshot":
    case "result":
    case "cancel":
      claims = { server, operation, ...spec.identity };
      body = JOBS_EMPTY_BODY;
      break;
    case "fetch":
      claims = {
        server,
        operation,
        ...spec.identity,
        jobId: spec.jobId,
        generation: spec.generation,
      };
      body = spec.body;
      break;
    case "lifecycle":
      claims = { server, operation };
      body = spec.body;
      break;
  }
  claims.method = JobsOperations[operation].method;
  claims.resource = buildJobsInternalResource(
    operation,
    "jobId" in spec ? { jobId: spec.jobId } : "appId" in spec ? { appId: spec.appId } : {},
  );
  claims.bodySha256 = sha256BodyDigest(body);

  assertParsesAgainstWireSchema(INSTRUCTION_CLAIM_SCHEMAS[operation], claims);

  return signJobsInstructionClaims(
    JobsSigningDomains[direction].jwtTyp,
    {
      iss: jobsSigningIssuer(direction, server),
      aud: jobsSigningAudience(direction, server),
      jti: randomUUID(),
      iat: iatS,
      exp: iatS + JOBS_INSTRUCTION_MAX_LIFETIME_SECONDS,
      ...claims,
    },
    key,
  );
}

// ── Verification ─────────────────────────────────────────────────────────────

/** Why an instruction failed verification — bounded structural classes, safe for logs and audit. */
export const JOBS_INSTRUCTION_REJECT_REASONS = [
  "malformed",
  "signature",
  "token_type",
  "claims",
  "issuer",
  "audience",
  "server",
  "lifetime",
  "expired",
  "not_yet_valid",
  "method",
  "resource",
  "body",
  "idempotency_key",
] as const;
export type JobsInstructionRejectReason = (typeof JOBS_INSTRUCTION_REJECT_REASONS)[number];

/**
 * What the receiver is serving: the operation this token must have been minted
 * for (which fixes the direction and its signing domain), the receiver's own
 * server id, and the exact request the token arrived on — method, concrete
 * resource path (built by {@link buildJobsInternalResource} from the route
 * params), and body bytes (empty for the bodyless operations). The optional
 * header value applies to submit only, where the signed `idempotencyKey`
 * claim is the only retry identity a receiver may honor.
 */
export interface JobsInstructionExpectation {
  readonly server: string;
  readonly operation: JobsOperationName;
  readonly method: string;
  readonly resource: string;
  readonly body: Uint8Array;
  readonly idempotencyKeyHeader?: string | null;
}

export type JobsInstructionVerifyResult =
  | { ok: true; claims: JobsInstructionClaims; jti: string }
  | { ok: false; reason: JobsInstructionRejectReason };

/**
 * Verify one instruction against what the receiver is serving — fail closed,
 * never throw: a malformed token is a verdict, not a crash. The order is
 * deterministic for the vectors: structure, signature (the one cryptographic
 * gate, via `compactVerify` — every claim rule below is this contract's own),
 * the protected-header profile, the claim shapes, issuer, audience, server,
 * the token's own timestamp discipline, lifetime, the receiver's clock
 * discipline, freshness, then the method/resource/body/idempotency bindings.
 * On success the verdict carries the validated `jti` alongside the claims:
 * the receiver burns it before any side effect, and the strict claim schemas
 * deliberately do not carry it among the job claims.
 */
export async function verifyJobsInstruction(
  token: string,
  key: Uint8Array,
  expected: JobsInstructionExpectation,
  nowS: number,
): Promise<JobsInstructionVerifyResult> {
  const segments = token.split(".");
  if (
    segments.length !== 3 ||
    segments.some((segment) => segment.length === 0 || !/^[A-Za-z0-9_-]*$/.test(segment))
  ) {
    return { ok: false, reason: "malformed" };
  }

  let verified: Awaited<ReturnType<typeof compactVerify>>;
  try {
    verified = await compactVerify(token, key, { algorithms: ["HS256"] });
  } catch {
    return { ok: false, reason: "signature" };
  }

  const direction = JobsOperations[expected.operation].direction;
  const domain = JobsSigningDomains[direction];
  const header = verified.protectedHeader;
  const headerKeys = Object.keys(header).sort();
  if (
    header.alg !== "HS256" ||
    header.typ !== domain.jwtTyp ||
    headerKeys.length !== 2 ||
    headerKeys[0] !== "alg" ||
    headerKeys[1] !== "typ"
  ) {
    return { ok: false, reason: "token_type" };
  }

  let bag: unknown;
  try {
    bag = JSON.parse(new TextDecoder().decode(verified.payload));
  } catch {
    return { ok: false, reason: "claims" };
  }
  if (typeof bag !== "object" || bag === null || Array.isArray(bag)) {
    return { ok: false, reason: "claims" };
  }
  const { iss, aud, iat, exp, jti, ...jobsClaims } = bag as Record<string, unknown>;

  const parsed = INSTRUCTION_CLAIM_SCHEMAS[expected.operation].safeParse(jobsClaims);
  if (!parsed.success) return { ok: false, reason: "claims" };
  const claims = parsed.data as JobsInstructionClaims;

  if (iss !== jobsSigningIssuer(direction, expected.server)) {
    return { ok: false, reason: "issuer" };
  }
  if (aud !== jobsSigningAudience(direction, expected.server)) {
    return { ok: false, reason: "audience" };
  }
  if (claims.server !== expected.server) return { ok: false, reason: "server" };

  if (
    typeof iat !== "number" ||
    typeof exp !== "number" ||
    !Number.isInteger(iat) ||
    !Number.isInteger(exp)
  ) {
    return { ok: false, reason: "claims" };
  }
  if (exp - iat > JOBS_INSTRUCTION_MAX_LIFETIME_SECONDS) {
    return { ok: false, reason: "lifetime" };
  }
  // The receiver's clock gets the same discipline as the token's own
  // timestamps: a clock that cannot complete the freshness comparisons denies
  // the instruction instead of letting both comparisons answer false and skip
  // the gate. With no usable reading the token cannot be placed in time, so
  // the verdict is the conservative one — the validity moment is treated as
  // passed — for any token, whichever side of its window it would occupy.
  if (!Number.isFinite(nowS)) {
    return { ok: false, reason: "expired" };
  }
  if (nowS < iat - JOBS_INSTRUCTION_CLOCK_TOLERANCE_SECONDS) {
    return { ok: false, reason: "not_yet_valid" };
  }
  if (nowS > exp + JOBS_INSTRUCTION_CLOCK_TOLERANCE_SECONDS) {
    return { ok: false, reason: "expired" };
  }
  if (typeof jti !== "string" || jti.length < 1 || jti.length > 128) {
    return { ok: false, reason: "claims" };
  }

  if (claims.method !== expected.method) return { ok: false, reason: "method" };
  if (claims.resource !== expected.resource) return { ok: false, reason: "resource" };
  if (claims.bodySha256 !== sha256BodyDigest(expected.body)) {
    return { ok: false, reason: "body" };
  }
  if (claims.operation === "submit") {
    if (claims.idempotencyKey !== (expected.idempotencyKeyHeader ?? null)) {
      return { ok: false, reason: "idempotency_key" };
    }
  }

  return { ok: true, claims, jti };
}
