import { z } from "zod";

import { AppSchema } from "./app.js";
import { EnvSchema } from "./env.js";

/**
 * The background-jobs wire contract — the single definition producers and
 * consumers share for a job reference, identity, input, snapshot and error.
 * Maintained behavior lives in `docs/design/background-jobs-plane.md`
 * (§1 identity and routing, §4 retry identity, §7 responses). Every schema here
 * is strict: a field a plane does not know fails its parse instead of silently
 * disappearing, so a version skew is visible at the boundary rather than
 * laundered through it. Schemas never coerce — an identifier that arrives as a
 * number is a malformed identifier, not a string to repair.
 *
 * Message prose is owned once, by {@link JobErrorMessages}; callers branch on
 * the code, never the wording. Existing serving/caller/session gate responses
 * and the shared edge framework error envelope are deliberately **outside**
 * this module — the jobs error schema covers jobs-operation errors after those
 * gates and the signed internal protocol, and never normalizes them.
 *
 * The `JobsProtocolV1` aggregate over this module and the deployment
 * configuration (`./jobsDeployment.ts`) lives in `./jobsProtocol.ts` — the
 * layering is one-way: wire contract ← deployment configuration ← aggregate.
 */

// ── Identifier syntax (background-jobs-plane design §1) ──────────────────────

/**
 * A server id / local job type token: 1–63 lowercase ASCII letters, digits and
 * hyphens, starting with a letter and ending with a letter or digit. A server
 * is a stable logical namespace (`jobs` initially); a local type is the part
 * after the colon of a qualified type. The two share one syntax by decision.
 */
const JOBS_NAME_TOKEN_PATTERN = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;

function isValidJobsNameToken(value: string): boolean {
  return value.length >= 1 && value.length <= 63 && JOBS_NAME_TOKEN_PATTERN.test(value);
}

/** Server id — the namespace half of every job reference and qualified type. */
export function isValidJobsServerId(value: string): boolean {
  return isValidJobsNameToken(value);
}

/** Local job type — the type half of a qualified type (same syntax as a server id). */
export function isValidJobsLocalType(value: string): boolean {
  return isValidJobsNameToken(value);
}

const JOBS_NAME_TOKEN_RULE =
  "must be 1–63 lowercase ASCII letters, digits or hyphens, starting with a letter and ending with a letter or digit";

/**
 * Job id — opaque and local to one server (1–128 ASCII letters/digits/
 * underscore/hyphen). A UUID is one valid form, never a requirement: equality
 * and routing use the whole `{server, jobId}` pair, so an id's shape must
 * never be parsed for meaning.
 */
export function isValidJobsJobId(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

/**
 * Is this a signing root secret — the canonical standard-base64 encoding of
 * exactly 32 bytes? One root is independently generated per server and per
 * direction (background-jobs-plane design §3); this predicate is the syntax
 * both the deployment configuration and the key derivation enforce, so a
 * malformed root fails at parse/boot time rather than deriving a key the two
 * ends cannot agree on. The round-trip refuses everything but the canonical
 * encoding: a base64url spelling, padded differently, or carrying whitespace
 * decodes to the same bytes but is not the one wire form.
 */
export function isValidJobsRootSecret(value: string): boolean {
  try {
    const decoded = atob(value);
    return decoded.length === 32 && btoa(decoded) === value;
  } catch {
    return false;
  }
}

/**
 * Qualified job type — exactly `<server>:<localType>`. Grants match the
 * complete string; there is no bare-type alias, wildcard, or default server,
 * so `jobs:fetch` never authorizes `fetch` on another server.
 */
export function isQualifiedJobType(value: string): boolean {
  const colon = value.indexOf(":");
  if (colon <= 0 || value.indexOf(":", colon + 1) !== -1) return false;
  return isValidJobsServerId(value.slice(0, colon)) && isValidJobsLocalType(value.slice(colon + 1));
}

/**
 * Does this qualified type belong to `server`? Both arguments must already be
 * syntax-validated — this is the cross-agreement check between two validated
 * values, not a parser.
 */
export function qualifiedTypeMatchesServer(qualifiedType: string, server: string): boolean {
  return qualifiedType.startsWith(`${server}:`);
}

// ── The strict-object boundary ───────────────────────────────────────────────

/**
 * Screens the RAW input of every wire object before its schema parses it.
 * zod's strict catchall skips one key name before its unrecognized-key check —
 * the skip keeps the result object's prototype unpolluted, but its side effect
 * is that an own `__proto__` key is shed instead of failing the parse, and
 * JSON.parse materializes `__proto__` as an own property, so a request body
 * can carry one to every schema here. The screen is the refusal: a strict
 * parse of this contract never sheds a field, not even that one. It runs on
 * the raw input because a parsed output no longer carries the key.
 */
export const RawInputKeyScreen = z.unknown().superRefine((value, ctx) => {
  if (typeof value !== "object" || value === null) return;
  if (!Object.getOwnPropertyNames(value).includes("__proto__")) return;
  ctx.addIssue({
    code: "custom",
    path: ["__proto__"],
    message: "an own __proto__ key is rejected — this parse refuses fields it does not carry",
  });
});

/**
 * A strict object parse of this contract: unknown keys fail, an own `__proto__`
 * key included. Exported for the sibling contracts — the signed-instruction
 * engine (`./jobsSigning.ts`) and the deployment configuration
 * (`./jobsDeployment.ts`) — whose claim payloads and operator documents are
 * held to the same one strict-parse mechanism.
 */
export function strictWireObject<Shape extends z.core.$ZodLooseShape>(shape: Shape) {
  return RawInputKeyScreen.pipe(z.strictObject(shape));
}

/**
 * A strict record parse of this contract: every key is validated against the
 * key schema — an own `__proto__` key included, which zod's record iteration
 * otherwise sheds exactly where {@link strictWireObject}'s screen refuses it.
 * A shed key in a map of named things is silent corruption of the operator's
 * or caller's intent; the screen is the refusal. Exported for the sibling
 * contracts on the same terms.
 */
export function strictWireRecord<Key extends z.core.$ZodRecordKey, Value extends z.core.$ZodType>(
  key: Key,
  value: Value,
) {
  return RawInputKeyScreen.pipe(z.record(key, value));
}

export const JobServerIdSchema = z
  .string()
  .refine(isValidJobsServerId, { message: `server id ${JOBS_NAME_TOKEN_RULE}` });
export const JobLocalTypeSchema = z
  .string()
  .refine(isValidJobsLocalType, { message: `local type ${JOBS_NAME_TOKEN_RULE}` });
export const QualifiedJobTypeSchema = z.string().refine(isQualifiedJobType, {
  message: "a qualified job type is exactly <server>:<localType>, both lowercase identifiers",
});
export const JobIdSchema = z.string().refine(isValidJobsJobId, {
  message: "job id must be 1–128 ASCII letters, digits, underscores or hyphens",
});

/**
 * Every external job reference carries both halves wherever it is stored or
 * transmitted — a bare job id is not routable, and equal ids on different
 * servers are different jobs. Strict: a reference that grows a field fails
 * older consumers loudly instead of shedding it.
 */
export const JobReferenceSchema = strictWireObject({
  server: JobServerIdSchema,
  jobId: JobIdSchema,
});
export type JobReference = z.infer<typeof JobReferenceSchema>;

// ── Identity and ownership ───────────────────────────────────────────────────

/**
 * The principal kinds that may own and operate jobs. Deliberately narrower
 * than the full `PRINCIPAL_KINDS` vocabulary: an anonymous or shared-password
 * caller is refused at the jobs authorization check — a job must survive its
 * owner's session, and only an authenticated user or a dev-token developer
 * has an identity worth attributing work to.
 */
export const JOB_OWNER_KINDS = ["user", "dev"] as const;
export const JobOwnerKindSchema = z.enum(JOB_OWNER_KINDS);
export type JobOwnerKind = z.infer<typeof JobOwnerKindSchema>;

/**
 * The immutable attribution of one job. Every field is a trusted platform
 * value captured by the edge caller resolver — never caller-supplied input:
 * `env` comes from the serving surface (a preview is not a third environment;
 * production and development are the only tiers), and `type` is qualified with
 * its server prefix so the identity cannot be re-pointed at another server's
 * namespace.
 */
export const JobIdentitySchema = strictWireObject({
  server: JobServerIdSchema,
  /** The registry app id the job runs with authority for — the existing app-id schema. */
  appId: AppSchema.shape.id,
  env: EnvSchema,
  ownerKind: JobOwnerKindSchema,
  /** Canonical principal id captured at submission (ADR-0048) — never a display name or email. */
  ownerOid: z.string().min(1),
  type: QualifiedJobTypeSchema,
}).superRefine((identity, ctx) => {
  if (!qualifiedTypeMatchesServer(identity.type, identity.server)) {
    ctx.addIssue({
      code: "custom",
      path: ["type"],
      message: "the qualified type's server prefix must equal the identity's server",
    });
  }
});
export type JobIdentity = z.infer<typeof JobIdentitySchema>;

// ── Statuses, progress and expiry ────────────────────────────────────────────

/**
 * The public statuses. `queued` includes waiting to retry; `crashed` is
 * execution lost to a platform interruption with no attempt left — distinct
 * from `failed`, which the job reported; `expired` applies only to a formerly
 * successful result whose lifetime ended, never to timed-out or failed work.
 */
export const JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "crashed",
  "cancelled",
  "expired",
] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** The statuses a job never leaves. Cancellation of a terminal job is a 409, not a state change. */
export const JOB_TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "crashed",
  "cancelled",
  "expired",
] as const;

/**
 * Progress bound for the platform-authored `of` total. Progress is written by
 * trusted job types, not apps — the bound keeps a buggy producer off the wire;
 * the initial fetch type uses a total of 1.
 */
export const JOBS_PROGRESS_MAX_TOTAL = 10_000;
/** Platform-authored progress label cap, in UTF-8 bytes (not characters). */
export const JOBS_PROGRESS_LABEL_MAX_BYTES = 128;

const utf8 = new TextEncoder();
function utf8ByteLength(value: string): number {
  return utf8.encode(value).length;
}

/**
 * Progress of the current execution attempt: `0 <= step <= of`, with a
 * positive bounded total and a platform-authored label. Null on the wire means
 * no progress exists (nothing has executed yet, or the type has none).
 */
export const JobProgressSchema = strictWireObject({
  step: z.int().min(0),
  of: z.int().positive().max(JOBS_PROGRESS_MAX_TOTAL),
  label: z.string().refine((label) => utf8ByteLength(label) <= JOBS_PROGRESS_LABEL_MAX_BYTES, {
    message: `progress label must be at most ${JOBS_PROGRESS_LABEL_MAX_BYTES} UTF-8 bytes`,
  }),
}).superRefine((progress, ctx) => {
  if (progress.step > progress.of) {
    ctx.addIssue({
      code: "custom",
      path: ["step"],
      message: "completed step must be between zero and the total",
    });
  }
});
export type JobProgress = z.infer<typeof JobProgressSchema>;

// ── Error vocabulary ─────────────────────────────────────────────────────────

/**
 * Why a job or its result failed — the execution-side reasons a snapshot's
 * `error` may carry. Distinct codes so callers never match message text:
 * pre-acceptance input rejection (`payload_invalid`) is separate from the
 * version-skew terminal failure (`execution_input_invalid`), outbound policy
 * refusal from quota, upstream failure from an unparsable or oversized result,
 * and platform failure from all of them.
 */
export const JOB_ERROR_CODES = [
  "payload_invalid",
  "execution_input_invalid",
  "timeout",
  "cancelled",
  "attempts_exhausted",
  "outbound_forbidden",
  "outbound_quota_exceeded",
  "delegated_unattended",
  "upstream_error",
  "result_invalid",
  "result_too_large",
  "platform_error",
] as const;
export const JobErrorCodeSchema = z.enum(JOB_ERROR_CODES);
export type JobErrorCode = z.infer<typeof JobErrorCodeSchema>;

/**
 * Request-error codes: the full catalogue above plus the codes only a jobs
 * operation can answer with. Independent of the portal's error enum — the
 * existing serving/caller gates keep their own responses, unwrapped.
 *
 * HTTP status mapping is route behavior (spec acceptance criteria): malformed
 * retry keys 400, unknown submission server 400, oversized input 413, missing
 * internal authentication 401, fully disabled jobs 503.
 */
export const JOB_REQUEST_ERROR_CODES = [
  ...JOB_ERROR_CODES,
  "unauthorized",
  "forbidden",
  "job_not_found",
  "idempotency_conflict",
  "idempotency_key_invalid",
  "payload_too_large",
  "job_not_ready",
  "job_terminal",
  "result_expired",
  "rate_limited",
  "jobs_capacity_exceeded",
  "job_server_unknown",
  "jobs_disabled",
  "jobs_unavailable",
] as const;
export const JobRequestErrorCodeSchema = z.enum(JOB_REQUEST_ERROR_CODES);
export type JobRequestErrorCode = z.infer<typeof JobRequestErrorCodeSchema>;

/**
 * The request-error codes whose 409 responses describe the conflicting job's
 * state: those carry `status` (the job's public status) and nullable `error`
 * alongside the code, and no other jobs error carries them.
 */
export const JOB_STATEFUL_ERROR_CODES = [
  "idempotency_conflict",
  "job_not_ready",
  "job_terminal",
] as const;
export type JobStatefulErrorCode = (typeof JOB_STATEFUL_ERROR_CODES)[number];

/**
 * The fixed, sanitized message for every code in the catalogue. Never supplied
 * input, raw upstream responses, credentials or exception text — a caller who
 * needs the reason branches on the code. The schemas enforce that an error's
 * message equals this table's entry, so an echoed input is unrepresentable.
 */
export const JobErrorMessages = {
  payload_invalid: "The job input is not valid for this job type.",
  execution_input_invalid: "The accepted job's input failed validation during execution.",
  timeout: "The job exceeded its execution deadline.",
  cancelled: "The job was cancelled.",
  attempts_exhausted: "The job's attempts were exhausted before it succeeded.",
  outbound_forbidden: "The outbound request was refused by policy.",
  outbound_quota_exceeded: "The outbound request exceeded the app's fetch budget.",
  delegated_unattended:
    "The outbound origin requires a delegated user connection, which background jobs cannot use.",
  upstream_error: "The upstream request failed.",
  result_invalid: "The job did not produce a valid JSON result.",
  result_too_large: "The job's result exceeded the size limit.",
  platform_error: "The job failed because of a platform error.",
  unauthorized: "The internal request is not authenticated.",
  forbidden: "Background jobs are not available to this caller.",
  job_not_found: "No job matching this reference is available.",
  idempotency_conflict: "The retry key was already used with different input.",
  idempotency_key_invalid: "The Idempotency-Key header is not valid.",
  payload_too_large: "The job input exceeds the size limit.",
  job_not_ready: "The job has not finished and has no result yet.",
  job_terminal: "The job has already finished.",
  result_expired: "The job's result has expired.",
  rate_limited: "Too many requests; back off and retry.",
  jobs_capacity_exceeded: "No capacity is available to accept this job.",
  job_server_unknown: "No job server with this name is configured.",
  jobs_disabled: "Background jobs are not enabled on this deployment.",
  jobs_unavailable: "The job service is temporarily unavailable.",
} satisfies Record<JobRequestErrorCode, string>;

function messageIsFixed(code: string, message: string): boolean {
  return (JobErrorMessages as Record<string, string | undefined>)[code] === message;
}

const MESSAGE_RULE = "the message must be the fixed platform message for the code";

/**
 * A job's execution error as it appears in a snapshot: a code from the
 * execution vocabulary plus its fixed message. Describes execution, never a
 * failed observation.
 */
export const JobErrorSchema = strictWireObject({
  code: JobErrorCodeSchema,
  message: z.string(),
}).superRefine((error, ctx) => {
  if (!messageIsFixed(error.code, error.message)) {
    ctx.addIssue({ code: "custom", path: ["message"], message: MESSAGE_RULE });
  }
});
export type JobError = z.infer<typeof JobErrorSchema>;

const JobRequestErrorBaseSchema = z.strictObject({
  code: JobRequestErrorCodeSchema,
  message: z.string(),
});

/**
 * A jobs-operation or signed internal-protocol error: `{code, message}` — or,
 * for the job-state-dependent 409s, the same two fields plus the conflicting
 * job's `status` and a nullable `error`, which that row of the contract makes
 * REQUIRED: a stateful code without its state is as malformed as state on a
 * code that cannot carry it, and the refine below enforces both directions.
 * The schemas do not normalize the existing serving/caller gate envelopes
 * into this shape.
 */
export const JobRequestErrorSchema = RawInputKeyScreen.pipe(
  z.union([
    JobRequestErrorBaseSchema,
    JobRequestErrorBaseSchema.extend({
      status: JobStatusSchema,
      error: JobErrorSchema.nullable(),
    }),
  ]),
).superRefine((error, ctx) => {
  if (!messageIsFixed(error.code, error.message)) {
    ctx.addIssue({ code: "custom", path: ["message"], message: MESSAGE_RULE });
    return;
  }
  const statefulCode = (JOB_STATEFUL_ERROR_CODES as readonly string[]).includes(error.code);
  if (statefulCode !== "status" in error) {
    ctx.addIssue({
      code: "custom",
      path: ["code"],
      message: statefulCode
        ? "a job-state-dependent 409 error carries the job's status and error — the bare shape is not valid for it"
        : "only a job-state-dependent 409 code carries status and error",
    });
  }
});
export type JobRequestError = z.infer<typeof JobRequestErrorSchema>;

/**
 * The constructors' last-resort runtime guard: a body this module's own wire
 * schema refuses is never returned. A caller that bypassed the types — a null
 * or field-less state, a non-catalogue code — gets a loud throw naming the
 * broken construction, not a plausible-looking body the boundary would reject
 * downstream (or worse, one it accepts while a field silently went missing —
 * a bare `{...base, ...state}` spread of such a state is the bare body the
 * stateful row forbids).
 */
export function assertParsesAgainstWireSchema<B>(
  schema: { safeParse(value: unknown): { success: boolean; error?: { message: string } } },
  body: B,
): B {
  const verdict = schema.safeParse(body);
  if (!verdict.success) {
    throw new Error(
      `the constructed body does not parse against its own wire schema — ${verdict.error?.message ?? "no detail"}`,
    );
  }
  return body;
}

/**
 * Build a snapshot error. The single constructor producers use, so the
 * fixed-message rule is a property of the mechanism rather than of discipline.
 */
export function jobError(code: JobErrorCode): JobError {
  return assertParsesAgainstWireSchema(JobErrorSchema, {
    code,
    message: JobErrorMessages[code],
  });
}

/**
 * Build a request error — basic, or stateful for the 409 codes that carry the
 * job's status and error. The overloads make both directions a compile error
 * (state on a code that cannot carry it; a stateful code built without its
 * state, which the contract requires), the runtime checks keep the same rule
 * for callers that bypass the types — `state` must actually carry both fields,
 * so null or a field-less object cannot spread its way to the bare body — and
 * the self-check refuses any body the wire schema rejects.
 */
export function jobRequestError(
  code: Exclude<JobRequestErrorCode, JobStatefulErrorCode>,
): JobRequestError;
export function jobRequestError(
  code: JobStatefulErrorCode,
  state: { status: JobStatus; error: JobError | null },
): JobRequestError;
export function jobRequestError(
  code: JobRequestErrorCode,
  state?: { status: JobStatus; error: JobError | null },
): JobRequestError {
  const statefulCode = (JOB_STATEFUL_ERROR_CODES as readonly string[]).includes(code);
  if (!statefulCode && state !== undefined) {
    throw new Error(
      `a ${code} error does not carry job state — only the job-state-dependent 409 codes do`,
    );
  }
  if (
    statefulCode &&
    (state === undefined ||
      state === null ||
      typeof state !== "object" ||
      !("status" in state) ||
      !("error" in state))
  ) {
    throw new Error(
      `a ${code} error requires the job's status and error — the contract makes them mandatory on a job-state-dependent 409`,
    );
  }
  const base = { code, message: JobErrorMessages[code] };
  const body = state === undefined ? base : { ...base, ...state };
  return assertParsesAgainstWireSchema(JobRequestErrorSchema, body);
}

// ── Responses ────────────────────────────────────────────────────────────────

/**
 * 202 body for an accepted submission, including an accepted keyed replay. The
 * status may already be terminal when the reply arrives. No `type` field: the
 * caller selected the type on submission, and the reference routes everything
 * afterwards — an acknowledged response invents nothing.
 */
export const JobAcceptedSchema = strictWireObject({
  server: JobServerIdSchema,
  jobId: JobIdSchema,
  status: JobStatusSchema,
});
export type JobAccepted = z.infer<typeof JobAcceptedSchema>;

/**
 * 202 body for an accepted cancellation request. Confirms durable intent, not
 * a cancelled job — a competing terminal outcome may still win the race.
 * `cancellationRequested` is a literal: the acknowledgement exists only for
 * requests that were accepted, so `false` is not a representable answer.
 */
export const JobCancellationAcceptedSchema = strictWireObject({
  server: JobServerIdSchema,
  jobId: JobIdSchema,
  cancellationRequested: z.literal(true),
});
export type JobCancellationAccepted = z.infer<typeof JobCancellationAcceptedSchema>;

/**
 * The complete latest state of one job — the entire observation contract.
 * One fixed camelCase shape for every status: unavailable values are explicit
 * nulls on the wire, never absent keys, so a client parses one shape and a
 * missing key is malformed data. `attempt` is the current execution attempt's
 * number (null before anything executed); `resultExpiresAt`/`recordExpiresAt`
 * are the public readability boundaries in UTC, independent of physical
 * cleanup timing.
 */
export const JobSnapshotSchema = strictWireObject({
  server: JobServerIdSchema,
  jobId: JobIdSchema,
  type: QualifiedJobTypeSchema,
  status: JobStatusSchema,
  attempt: z.int().positive().nullable(),
  progress: JobProgressSchema.nullable(),
  cancellationRequested: z.boolean(),
  resultExpiresAt: z.iso.datetime().nullable(),
  recordExpiresAt: z.iso.datetime().nullable(),
  error: JobErrorSchema.nullable(),
}).superRefine((snapshot, ctx) => {
  if (!qualifiedTypeMatchesServer(snapshot.type, snapshot.server)) {
    ctx.addIssue({
      code: "custom",
      path: ["type"],
      message: "the qualified type's server prefix must equal the snapshot's server",
    });
  }
});
export type JobSnapshot = z.infer<typeof JobSnapshotSchema>;

// ── The initial production job type ──────────────────────────────────────────

/** The initial (and only) job server — a stable logical namespace, not a library name. */
export const JOBS_SERVER_NAME = "jobs";
/** The initial production type's local half, and its qualified form. */
export const JOBS_FETCH_LOCAL_TYPE = "fetch";
export const JOBS_FETCH_QUALIFIED_TYPE = `${JOBS_SERVER_NAME}:${JOBS_FETCH_LOCAL_TYPE}`;
/** Display name the portal shows for the type (experience design, Background jobs card). */
export const JOBS_FETCH_DISPLAY_NAME = "Outbound fetch job";

/** One installed job type as the catalogue advertises it: qualified id + display name. */
export const JobTypeCatalogueEntrySchema = strictWireObject({
  id: QualifiedJobTypeSchema,
  displayName: z.string().min(1),
});
export type JobTypeCatalogueEntry = z.infer<typeof JobTypeCatalogueEntrySchema>;

/**
 * The production catalogue — the types installed in this deployment. Synthetic
 * development/test fixtures are deliberately absent: they have no production
 * grant and are rejected on production submission.
 */
export const JOB_TYPE_CATALOGUE: readonly JobTypeCatalogueEntry[] = [
  { id: JOBS_FETCH_QUALIFIED_TYPE, displayName: JOBS_FETCH_DISPLAY_NAME },
];

// ── Input and result of the fetch type ───────────────────────────────────────

/** Job input body limit in bytes, inclusive (65,536 is allowed). */
export const JOBS_MAX_INPUT_BYTES = 65_536;
/** Successful result limit in bytes, inclusive; the oversized response is stopped, never stored partially. */
export const JOBS_MAX_RESULT_BYTES = 65_536;
/** Retry-key cap in UTF-8 bytes. */
export const JOBS_RETRY_KEY_MAX_BYTES = 128;
/** Header carrying the optional retry key on submission. */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/**
 * Is this a valid retry key? At most {@link JOBS_RETRY_KEY_MAX_BYTES} UTF-8
 * bytes; empty and whitespace-only keys are invalid (a blank label cannot
 * identify an intent). A key is a label for one intended job — never a
 * credential, never logged.
 */
export function isValidJobsRetryKey(value: string): boolean {
  return value.trim().length > 0 && utf8ByteLength(value) <= JOBS_RETRY_KEY_MAX_BYTES;
}

export const JobRetryKeySchema = z.string().refine(isValidJobsRetryKey, {
  message: `retry key must be 1–${JOBS_RETRY_KEY_MAX_BYTES} UTF-8 bytes and not empty or whitespace-only`,
});

/**
 * Is this a fetch target URL exactly as submitted? Beyond the absolute-http(s)
 * grammar, two fidelity rules the WHATWG parser would otherwise launder —
 * leading/trailing whitespace is stripped before parsing, and tab/LF/CR are
 * removed from anywhere in the input — so a schema built on the parser alone
 * validates one URL and forwards another. Both are rejected here instead.
 * After these refusals the validated value IS the value an executor fetches:
 * the parser's remaining normalizations (host case, percent-encoding) are
 * deterministic and shared by validator and fetcher alike.
 */
export function isValidFetchTargetUrl(raw: string): boolean {
  if (raw !== raw.trim()) return false;
  if (hasControlCharacter(raw)) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Does the value carry a C0 control character or DEL? Forbidden anywhere in a
 * URL by its grammar — spelled as a scan rather than a regex, because a
 * pattern whose entire subject is control characters trips the
 * `no-control-regex` guardrail for exactly the wrong reason.
 */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * The outbound fetch job's whole input: one target URL. No caller-selected
 * method, headers, connection name, retry policy or executable code is
 * representable — the job makes one GET under the app's existing fetch
 * permissions, and the origin must be http(s), the only schemes a GET can
 * target through the platform's fetch path.
 */
export const FetchJobInputSchema = strictWireObject({
  url: z.string().refine(isValidFetchTargetUrl, {
    message: "url must be an absolute http(s) URL with no padding or control characters",
  }),
});
export type FetchJobInput = z.infer<typeof FetchJobInputSchema>;

/**
 * Any value JSON could have produced — the shape `z.json()` asserts — judged
 * iteratively. A recursive walk cannot judge this contract: a result at the
 * inclusive 64-KiB byte cap legally nests ~32,000 deep (JSON.parse produces
 * it from wire bytes without complaint), past the engine's recursion limit,
 * where a recursive validator answers a stack overflow instead of a verdict —
 * and `safeParse` returning a verdict is the seam every consumer binds to.
 * Objects must be plain (nothing JSON.parse produces has another prototype),
 * numbers must be finite, and a cycle is refused rather than walked forever.
 */
class SubtreeComplete {
  constructor(readonly container: object) {}
}

function isJsonValue(value: unknown): boolean {
  try {
    const stack: unknown[] = [value];
    const open = new Set<object>();
    while (stack.length > 0) {
      const current = stack.pop();
      if (current instanceof SubtreeComplete) {
        open.delete(current.container);
        continue;
      }
      if (current === null) continue;
      const kind = typeof current;
      if (kind === "string" || kind === "boolean") continue;
      if (kind === "number") {
        if (!Number.isFinite(current)) return false;
        continue;
      }
      if (kind !== "object") return false;
      const container = current as object;
      if (open.has(container)) return false;
      open.add(container);
      stack.push(new SubtreeComplete(container));
      if (Array.isArray(container)) {
        for (let i = container.length - 1; i >= 0; i--) stack.push(container[i]);
      } else {
        if (
          Object.getPrototypeOf(container) !== Object.prototype &&
          Object.getPrototypeOf(container) !== null
        ) {
          return false;
        }
        const values = Object.values(container);
        for (let i = values.length - 1; i >= 0; i--) stack.push(values[i]);
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * A successful fetch result is the upstream JSON value itself — objects,
 * arrays, scalars, and JSON `null`. JSON null is a successful result and must
 * stay distinguishable from expiry; no HTTP status or headers travel with it.
 */
export type FetchJobResult =
  | string
  | number
  | boolean
  | null
  | FetchJobResult[]
  | { [key: string]: FetchJobResult };

export const FetchJobResultSchema = z.custom<FetchJobResult>(isJsonValue);

// ── Lifecycle generations and delivery (background-jobs-plane design §5) ──────

/**
 * A jobs lifecycle generation — a canonical decimal string ("1", never "01").
 * The portal app model owns the value; every wire appearance (signed submit and
 * callback claims, lifecycle delivery, acknowledgement) shares this one schema,
 * so a generation has exactly one wire form and receivers compare/merge them
 * numerically without first canonicalizing.
 */
export const JobsGenerationSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)$/, "a generation is a decimal string without leading zeros");

/**
 * The lifecycle change the portal delivers to each server:
 * `archived` closes the app's current generation (queued/running work is
 * cancelled); `false` opens a new one. Delivered by the separately signed
 * portal→jobs instruction (`./jobsSigning.ts`); the body binds by digest.
 */
export const JobsLifecycleUpdateSchema = strictWireObject({
  generation: JobsGenerationSchema,
  archived: z.boolean(),
});
export type JobsLifecycleUpdate = z.infer<typeof JobsLifecycleUpdateSchema>;

/**
 * The lifecycle acknowledgement: the generation the server has durably applied.
 * Lower deliveries cannot decrease it — a replayed older update acknowledges
 * the highest applied generation, never the delivered one.
 */
export const JobsLifecycleUpdateAckSchema = strictWireObject({
  appliedGeneration: JobsGenerationSchema,
});
export type JobsLifecycleUpdateAck = z.infer<typeof JobsLifecycleUpdateAckSchema>;
