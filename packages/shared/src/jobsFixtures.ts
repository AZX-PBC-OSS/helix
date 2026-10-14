import type { JobsProtocolContractName } from "./jobsProtocol.js";
import { JobErrorMessages, JOBS_MAX_RESULT_BYTES } from "./jobs.js";

/**
 * The `JobsProtocolV1` conformance fixtures — the positive and negative wire
 * examples every producer and consumer must agree on. The list is data on
 * purpose: a future non-TypeScript server implements the same names and is
 * judged against these same examples, without coercion, before adoption.
 *
 * Each fixture presents one wire example, exactly as it travels, to exactly
 * one contract schema, and states whether that schema must accept or reject
 * it. `why` is for the reader of a fixture failure. Messages inside examples
 * are built from {@link JobErrorMessages} — the fixture pins "message equals
 * the catalogue entry for the code", not a second copy of the prose.
 */
export interface JobsProtocolFixture {
  /** The schema the example is presented to — a member of `JobsProtocolV1`. */
  contract: JobsProtocolContractName;
  name: string;
  example: unknown;
  valid: boolean;
  why: string;
}

const QUEUED_SNAPSHOT = {
  server: "jobs",
  jobId: "w9QZzaBp4XkR3tYm017c3",
  type: "jobs:fetch",
  status: "queued",
  attempt: null,
  progress: null,
  cancellationRequested: false,
  resultExpiresAt: null,
  recordExpiresAt: null,
  error: null,
} as const;

// A wire-legal result at the inclusive cap: 32,766 nested arrays total
// 65,536 bytes, and JSON.parse produces the value from those wire bytes
// without complaint. Judging it must return a verdict — a recursive
// validator cannot, and the fixture run of a mirror that crashes here must
// go red rather than pass green.
const DEEP_RESULT: unknown = JSON.parse(
  "[".repeat((JOBS_MAX_RESULT_BYTES - 4) / 2) +
    "null" +
    "]".repeat((JOBS_MAX_RESULT_BYTES - 4) / 2),
);

// Fixed public test roots for the deployment-configuration fixtures: the
// canonical base64 encodings of 32 bytes each, distinct per direction. Never
// real credentials — the roots are syntax examples, like every fixture value.
const JOBS_DEPLOYMENT_FIXTURE_ROOTS = {
  edgeToJobs: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
  jobsToEdge: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
  portalToJobs: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=",
} as const;

/** One complete deployment-map entry, overridable field by field for the negative examples. */
function deploymentServerEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    server: "jobs",
    endpoint: "https://jobs.internal.helix",
    state: "serving",
    accepting: true,
    types: ["jobs:fetch"],
    databaseUrl: "postgresql://jobs@db.internal.helix/jobs",
    edgeProdCallbackUrl: "https://edge.internal.helix",
    edgeDevCallbackUrl: "https://edge.internal.helix/dev",
    roots: { ...JOBS_DEPLOYMENT_FIXTURE_ROOTS },
    ...overrides,
  };
}

export const JOBS_PROTOCOL_FIXTURES: readonly JobsProtocolFixture[] = [
  // ── References: opaque ids, both halves always ──────────────────────────────
  {
    contract: "JobReferenceSchema",
    name: "opaque non-UUID job id",
    example: { server: "jobs", jobId: "w9QZzaBp4XkR3tYm017c3" },
    valid: true,
    why: "a job id is opaque and server-local; a UUID is one valid form, not a requirement",
  },
  {
    contract: "JobReferenceSchema",
    name: "UUID job id",
    example: { server: "jobs", jobId: "0b9e8c3e-6f2a-4c9b-9e1f-2a4b6c8d0e2f" },
    valid: true,
    why: "a UUID satisfies the opaque-id charset",
  },
  {
    contract: "JobReferenceSchema",
    name: "job id with a path separator",
    example: { server: "jobs", jobId: "abc/123" },
    valid: false,
    why: "the id charset is ASCII letters, digits, underscore and hyphen only",
  },
  {
    contract: "JobReferenceSchema",
    name: "numeric job id",
    example: { server: "jobs", jobId: 12345 },
    valid: false,
    why: "identifiers are never coerced — a number is malformed, not a string to repair",
  },
  {
    contract: "JobReferenceSchema",
    name: "an own __proto__ key in the body",
    example: JSON.parse('{"server":"jobs","jobId":"abc","__proto__":{"polluted":true}}'),
    valid: false,
    why: "JSON.parse materializes __proto__ as an own key; a strict parse refuses it instead of shedding it",
  },
  {
    contract: "JobReferenceSchema",
    name: "uppercase server",
    example: { server: "Jobs", jobId: "abc" },
    valid: false,
    why: "server ids are lowercase",
  },
  {
    contract: "JobIdSchema",
    name: "an opaque server-local id",
    example: "w9QZzaBp4XkR3tYm017c3",
    valid: true,
    why: "the id charset is ASCII letters, digits, underscore and hyphen — a UUID is one valid form, never a requirement",
  },
  {
    contract: "JobIdSchema",
    name: "an id over 128 characters",
    example: "a".repeat(129),
    valid: false,
    why: "job ids are bounded at 128 characters",
  },
  {
    contract: "JobServerIdSchema",
    name: "the initial server id",
    example: "jobs",
    valid: true,
    why: "the initial server is a stable logical namespace, not a library name",
  },
  {
    contract: "JobServerIdSchema",
    name: "a server id with an inner hyphen and a trailing digit",
    example: "ml-jobs2",
    valid: true,
    why: "hyphens sit inside the token and a digit may end it — only the first character must be a letter",
  },
  {
    contract: "JobServerIdSchema",
    name: "underscore in a server id",
    example: "my_server",
    valid: false,
    why: "the server/token charset is letters, digits and hyphens — underscore is the job-id charset, not this one",
  },
  {
    contract: "JobLocalTypeSchema",
    name: "the fetch local type",
    example: "fetch",
    valid: true,
    why: "a local type shares the server-id syntax",
  },
  {
    contract: "JobLocalTypeSchema",
    name: "uppercase local type",
    example: "Fetch",
    valid: false,
    why: "the token charset is lowercase",
  },
  {
    contract: "QualifiedJobTypeSchema",
    name: "the fetch qualified type",
    example: "jobs:fetch",
    valid: true,
    why: "exactly <server>:<localType>",
  },
  {
    contract: "QualifiedJobTypeSchema",
    name: "trailing colon",
    example: "jobs:",
    valid: false,
    why: "both halves are required — there is no empty local type",
  },
  {
    contract: "JobOwnerKindSchema",
    name: "the dev owner kind",
    example: "dev",
    valid: true,
    why: "dev-token developers own jobs on the development surface",
  },
  {
    contract: "JobOwnerKindSchema",
    name: "the anonymous principal kind",
    example: "anon",
    valid: false,
    why: "only user and dev principals can own jobs",
  },
  {
    contract: "JobStatusSchema",
    name: "the running status",
    example: "running",
    valid: true,
    why: "one of the seven public statuses",
  },
  {
    contract: "JobStatusSchema",
    name: "a status outside the public contract",
    example: "pending",
    valid: false,
    why: "statuses are exactly the seven public values — no native runner state leaks through",
  },

  // ── Acknowledgements: distinct contracts, no invented fields ───────────────
  {
    contract: "JobAcceptedSchema",
    name: "accepted, still queued",
    example: { server: "jobs", jobId: "w9QZzaBp4XkR3tYm017c3", status: "queued" },
    valid: true,
    why: "202 means a durable job exists; acceptance is not execution success",
  },
  {
    contract: "JobAcceptedSchema",
    name: "replay arriving after a terminal outcome",
    example: { server: "jobs", jobId: "w9QZzaBp4XkR3tYm017c3", status: "succeeded" },
    valid: true,
    why: "a keyed replay can already carry a terminal status when its response arrives",
  },
  {
    contract: "JobAcceptedSchema",
    name: "invented type field",
    example: { server: "jobs", jobId: "abc", status: "queued", type: "jobs:fetch" },
    valid: false,
    why: "the caller selected the type on submission — an acknowledgement invents no type field",
  },
  {
    contract: "JobAcceptedSchema",
    name: "status outside the seven-value contract",
    example: { server: "jobs", jobId: "abc", status: "pending" },
    valid: false,
    why: "statuses are exactly the seven public values",
  },
  {
    contract: "JobCancellationAcceptedSchema",
    name: "acknowledged cancellation request",
    example: { server: "jobs", jobId: "abc", cancellationRequested: true },
    valid: true,
    why: "the acknowledgement confirms durable intent, not a cancelled job",
  },
  {
    contract: "JobCancellationAcceptedSchema",
    name: "cancellationRequested false",
    example: { server: "jobs", jobId: "abc", cancellationRequested: false },
    valid: false,
    why: "the response exists only for accepted requests — false is not a representable answer",
  },

  // ── Snapshots: explicit nulls, qualified type agreement, bounded progress ──
  {
    contract: "JobSnapshotSchema",
    name: "queued before execution, everything unavailable explicitly null",
    example: QUEUED_SNAPSHOT,
    valid: true,
    why: "one fixed shape for every status — unavailable values travel as explicit nulls, never absent keys",
  },
  {
    contract: "JobSnapshotSchema",
    name: "running with progress",
    example: {
      ...QUEUED_SNAPSHOT,
      status: "running",
      attempt: 1,
      progress: { step: 0, of: 1, label: "Fetching" },
    },
    valid: true,
    why: "progress describes the current attempt; fetch has one unit and no intermediate percentage",
  },
  {
    contract: "JobSnapshotSchema",
    name: "succeeded with result and record expiry",
    example: {
      ...QUEUED_SNAPSHOT,
      status: "succeeded",
      attempt: 1,
      progress: { step: 1, of: 1, label: "Fetched" },
      resultExpiresAt: "2026-10-20T12:00:00.000Z",
      recordExpiresAt: "2026-11-12T12:00:00.000Z",
    },
    valid: true,
    why: "timestamps are UTC ISO strings; error stays explicitly null on success",
  },
  {
    contract: "JobSnapshotSchema",
    name: "failed with an execution error",
    example: {
      ...QUEUED_SNAPSHOT,
      status: "failed",
      attempt: 1,
      error: { code: "upstream_error", message: JobErrorMessages.upstream_error },
    },
    valid: true,
    why: "a failed job carries a code from the execution vocabulary plus its fixed message",
  },
  {
    contract: "JobSnapshotSchema",
    name: "cancelled, intent recorded and won",
    example: {
      ...QUEUED_SNAPSHOT,
      status: "cancelled",
      cancellationRequested: true,
      error: { code: "cancelled", message: JobErrorMessages.cancelled },
    },
    valid: true,
    why: "terminal cancellation keeps the intent flag true and describes the outcome in error",
  },
  {
    contract: "JobSnapshotSchema",
    name: "expired successful result",
    example: {
      ...QUEUED_SNAPSHOT,
      status: "expired",
      attempt: 1,
      resultExpiresAt: "2026-10-20T12:00:00.000Z",
      recordExpiresAt: "2026-11-12T12:00:00.000Z",
    },
    valid: true,
    why: "expired applies only to a formerly successful result past its lifetime — error stays null",
  },
  {
    contract: "JobSnapshotSchema",
    name: "waiting to retry with previous-attempt progress",
    example: {
      ...QUEUED_SNAPSHOT,
      status: "queued",
      attempt: 2,
      progress: { step: 1, of: 3, label: "Previous attempt" },
    },
    valid: true,
    why: "queued includes waiting to retry; the snapshot identifies the attempt the progress describes",
  },
  {
    contract: "JobSnapshotSchema",
    name: "another server's namespace",
    example: {
      server: "ml-jobs",
      jobId: "gen_001",
      type: "ml-jobs:generate-report",
      status: "queued",
      attempt: null,
      progress: null,
      cancellationRequested: false,
      resultExpiresAt: null,
      recordExpiresAt: null,
      error: null,
    },
    valid: true,
    why: "the contract is server-agnostic — any valid server id pairs with its own qualified types",
  },
  {
    contract: "JobSnapshotSchema",
    name: "cross-server type prefix",
    example: { ...QUEUED_SNAPSHOT, type: "other:fetch" },
    valid: false,
    why: "the qualified type's prefix must equal the reference's server — no cross-server aliasing",
  },
  {
    contract: "JobSnapshotSchema",
    name: "bare type without a server prefix",
    example: { ...QUEUED_SNAPSHOT, type: "fetch" },
    valid: false,
    why: "there is no bare-type alias or implicit default server",
  },
  {
    contract: "JobSnapshotSchema",
    name: "absent nullable field",
    example: {
      server: "jobs",
      jobId: "w9QZzaBp4XkR3tYm017c3",
      type: "jobs:fetch",
      status: "queued",
      attempt: null,
      progress: null,
      cancellationRequested: false,
      resultExpiresAt: null,
      recordExpiresAt: null,
    },
    valid: false,
    why: "unavailable values must travel as explicit nulls — a missing key is malformed, not empty",
  },
  {
    contract: "JobSnapshotSchema",
    name: "zero attempt",
    example: { ...QUEUED_SNAPSHOT, status: "running", attempt: 0 },
    valid: false,
    why: "attempt is a positive integer or null — no invented attempt zero before execution",
  },
  {
    contract: "JobSnapshotSchema",
    name: "progress beyond its total",
    example: { ...QUEUED_SNAPSHOT, progress: { step: 2, of: 1, label: "Fetching" } },
    valid: false,
    why: "completed step is between zero and the total",
  },
  {
    contract: "JobSnapshotSchema",
    name: "zero progress total",
    example: { ...QUEUED_SNAPSHOT, progress: { step: 0, of: 0, label: "Fetching" } },
    valid: false,
    why: "the total is positive",
  },
  {
    contract: "JobSnapshotSchema",
    name: "label over 128 bytes",
    example: { ...QUEUED_SNAPSHOT, progress: { step: 0, of: 1, label: "a".repeat(129) } },
    valid: false,
    why: "platform-authored labels are bounded at 128 UTF-8 bytes",
  },
  {
    contract: "JobSnapshotSchema",
    name: "progress label exactly 128 UTF-8 bytes via multibyte characters",
    example: { ...QUEUED_SNAPSHOT, progress: { step: 0, of: 1, label: "é".repeat(64) } },
    valid: true,
    why: "the bound counts UTF-8 bytes, not characters — 64 two-byte characters fit",
  },
  {
    contract: "JobSnapshotSchema",
    name: "non-ISO expiry timestamp",
    example: { ...QUEUED_SNAPSHOT, status: "succeeded", resultExpiresAt: "10/13/2026" },
    valid: false,
    why: "expiry boundaries are UTC ISO strings",
  },
  {
    contract: "JobSnapshotSchema",
    name: "an impossible calendar date",
    example: { ...QUEUED_SNAPSHOT, status: "succeeded", resultExpiresAt: "2026-02-30T12:00:00Z" },
    valid: false,
    why: "the ISO grammar fits but no calendar day exists — an expiry read with new Date() would be NaN",
  },
  {
    contract: "JobSnapshotSchema",
    name: "retired progress-sequence field",
    example: { ...QUEUED_SNAPSHOT, progressSeq: "7" },
    valid: false,
    why: "the observation contract is complete snapshots with no event cursor — a retired field must fail, not shed",
  },

  // ── Fetch input and result ──────────────────────────────────────────────────
  {
    contract: "FetchJobInputSchema",
    name: "the whole input",
    example: { url: "https://example.com/data.json" },
    valid: true,
    why: "the fetch job takes a target URL and nothing else",
  },
  {
    contract: "FetchJobInputSchema",
    name: "caller-selected method",
    example: { url: "https://example.com/data.json", method: "POST" },
    valid: false,
    why: "the job makes one GET; no caller-selected method is representable",
  },
  {
    contract: "FetchJobInputSchema",
    name: "connection name",
    example: { url: "https://example.com/data.json", connection: "vendor" },
    valid: false,
    why: "credentials are not input — the job uses the app's existing fetch permissions",
  },
  {
    contract: "FetchJobInputSchema",
    name: "non-http scheme",
    example: { url: "ftp://example.com/data.json" },
    valid: false,
    why: "the job performs one http(s) GET",
  },
  {
    contract: "FetchJobInputSchema",
    name: "relative url",
    example: { url: "/data.json" },
    valid: false,
    why: "the target must be an absolute URL",
  },
  {
    contract: "FetchJobInputSchema",
    name: "a padded url",
    example: { url: "  https://example.com/x  " },
    valid: false,
    why: "the WHATWG parser strips padding before it parses — the validated value would not be the value fetched, so it is refused",
  },
  {
    contract: "FetchJobInputSchema",
    name: "a control character inside the url",
    example: { url: "https://example.com/x?y=a\tb" },
    valid: false,
    why: "tab and newline are forbidden by the URL grammar yet stripped by the parser — refused, not parsed past",
  },
  {
    contract: "FetchJobResultSchema",
    name: "raw JSON null result",
    example: null,
    valid: true,
    why: "JSON null is a successful result and stays distinguishable from expiry",
  },
  {
    contract: "FetchJobResultSchema",
    name: "scalar result",
    example: "fetched",
    valid: true,
    why: "the result is the upstream JSON value itself — scalars included",
  },
  {
    contract: "FetchJobResultSchema",
    name: "composite result",
    example: { items: [1, "two", null, { nested: true }], total: 3 },
    valid: true,
    why: "objects and arrays travel without an envelope",
  },
  {
    contract: "FetchJobResultSchema",
    name: "a result nested to the byte cap",
    example: DEEP_RESULT,
    valid: true,
    why: "a wire-legal result nests ~32k deep within the inclusive cap — judging it must return a verdict, never a stack overflow",
  },
  {
    contract: "FetchJobResultSchema",
    name: "an undefined result",
    example: undefined,
    valid: false,
    why: "a result is a JSON value — result absence is carried by the snapshot's status, never by an undefined body",
  },
  {
    contract: "FetchJobResultSchema",
    name: "a non-JSON number nested in the result",
    example: { deep: NaN },
    valid: false,
    why: "JSON has no NaN — a NaN in a result means producer or storage drift, and the parse must refuse it at any depth",
  },

  // ── Errors: catalogue codes, fixed messages, state-dependent fields ────────
  {
    contract: "JobErrorSchema",
    name: "timeout error",
    example: { code: "timeout", message: JobErrorMessages.timeout },
    valid: true,
    why: "a snapshot error is a catalogue code plus its fixed message",
  },
  {
    contract: "JobErrorSchema",
    name: "request-only code as an execution error",
    example: { code: "job_not_found", message: JobErrorMessages.job_not_found },
    valid: false,
    why: "a snapshot error uses the execution vocabulary; job_not_found answers a request, not an execution",
  },
  {
    contract: "JobRequestErrorSchema",
    name: "throttled",
    example: { code: "rate_limited", message: JobErrorMessages.rate_limited },
    valid: true,
    why: "the basic shape is code plus fixed message",
  },
  {
    contract: "JobRequestErrorSchema",
    name: "code outside the catalogue",
    example: { code: "unknown_reason", message: "anything" },
    valid: false,
    why: "callers branch on the code — an invented code is not in the contract",
  },
  {
    contract: "JobRequestErrorSchema",
    name: "echoed input as message",
    example: {
      code: "rate_limited",
      message: "the url https://secret.example.internal/?token=x is rate limited",
    },
    valid: false,
    why: "messages are fixed platform prose — submitted values never reach an error body",
  },
  {
    contract: "JobRequestErrorSchema",
    name: "result read while unfinished",
    example: {
      code: "job_not_ready",
      message: JobErrorMessages.job_not_ready,
      status: "running",
      error: null,
    },
    valid: true,
    why: "the job-state-dependent 409 carries the job's status and a nullable error",
  },
  {
    contract: "JobRequestErrorSchema",
    name: "cancellation against a terminal job",
    example: {
      code: "job_terminal",
      message: JobErrorMessages.job_terminal,
      status: "succeeded",
      error: null,
    },
    valid: true,
    why: "the 409 shows the outcome that won, with no execution error to report",
  },
  {
    contract: "JobRequestErrorSchema",
    name: "conflict carrying the retained job's state",
    example: {
      code: "idempotency_conflict",
      message: JobErrorMessages.idempotency_conflict,
      status: "running",
      error: null,
    },
    valid: true,
    why: "idempotency_conflict is a job-state-dependent 409 code",
  },
  {
    contract: "JobRequestErrorSchema",
    name: "state fields on a non-stateful code",
    example: {
      code: "rate_limited",
      message: JobErrorMessages.rate_limited,
      status: "running",
      error: null,
    },
    valid: false,
    why: "only the job-state-dependent 409 codes carry status and error",
  },
  {
    contract: "JobRequestErrorSchema",
    name: "a stateful 409 code without its state — conflict",
    example: { code: "idempotency_conflict", message: JobErrorMessages.idempotency_conflict },
    valid: false,
    why: "the job's status and error are required on a job-state-dependent 409, not optional",
  },
  {
    contract: "JobRequestErrorSchema",
    name: "a stateful 409 code without its state — unfinished job",
    example: { code: "job_not_ready", message: JobErrorMessages.job_not_ready },
    valid: false,
    why: "the 409 arrives with the job's status; a bare body strips exactly the field a client needs to recover",
  },
  {
    contract: "JobRequestErrorSchema",
    name: "a stateful 409 code without its state — terminal job",
    example: { code: "job_terminal", message: JobErrorMessages.job_terminal },
    valid: false,
    why: "the 409 shows the outcome that won; without the status field it cannot",
  },
  {
    contract: "JobRequestErrorSchema",
    name: "nested error code outside the execution vocabulary",
    example: {
      code: "job_not_ready",
      message: JobErrorMessages.job_not_ready,
      status: "failed",
      error: { code: "job_not_found", message: JobErrorMessages.job_not_found },
    },
    valid: false,
    why: "the nested error describes execution — the request-only codes do not belong there",
  },

  // ── Identity: trusted values, restricted vocabularies ──────────────────────
  {
    contract: "JobIdentitySchema",
    name: "user-owned production job",
    example: {
      server: "jobs",
      appId: "0b9e8c3e-6f2a-4c9b-9e1f-2a4b6c8d0e2f",
      env: "prod",
      ownerKind: "user",
      ownerOid: "4f7a2b3c-9d1e-4a5b-8c6d-0e2f4a6b8c0d",
      type: "jobs:fetch",
    },
    valid: true,
    why: "attribution is captured by the platform and immutable for the job's life",
  },
  {
    contract: "JobIdentitySchema",
    name: "dev-token job on the development surface",
    example: {
      server: "jobs",
      appId: "0b9e8c3e-6f2a-4c9b-9e1f-2a4b6c8d0e2f",
      env: "dev",
      ownerKind: "dev",
      ownerOid: "4f7a2b3c-9d1e-4a5b-8c6d-0e2f4a6b8c0d",
      type: "jobs:fetch",
    },
    valid: true,
    why: "the dev gateway serves the same contract with the dev environment",
  },
  {
    contract: "JobIdentitySchema",
    name: "shared-password owner",
    example: {
      server: "jobs",
      appId: "0b9e8c3e-6f2a-4c9b-9e1f-2a4b6c8d0e2f",
      env: "prod",
      ownerKind: "password",
      ownerOid: "pw_abc123def456",
      type: "jobs:fetch",
    },
    valid: false,
    why: "only user and dev principals can own jobs — anonymous and shared-password callers are refused",
  },
  {
    contract: "JobIdentitySchema",
    name: "preview as a third environment",
    example: {
      server: "jobs",
      appId: "0b9e8c3e-6f2a-4c9b-9e1f-2a4b6c8d0e2f",
      env: "preview",
      ownerKind: "user",
      ownerOid: "4f7a2b3c-9d1e-4a5b-8c6d-0e2f4a6b8c0d",
      type: "jobs:fetch",
    },
    valid: false,
    why: "production and development are the only environments; preview is not a third one",
  },
  {
    contract: "JobIdentitySchema",
    name: "type on another server",
    example: {
      server: "jobs",
      appId: "0b9e8c3e-6f2a-4c9b-9e1f-2a4b6c8d0e2f",
      env: "prod",
      ownerKind: "user",
      ownerOid: "4f7a2b3c-9d1e-4a5b-8c6d-0e2f4a6b8c0d",
      type: "ml-jobs:generate-report",
    },
    valid: false,
    why: "the qualified type's prefix must equal the identity's server",
  },

  // ── Progress, retry key and catalogue ──────────────────────────────────────
  {
    contract: "JobProgressSchema",
    name: "one completed unit of one",
    example: { step: 1, of: 1, label: "Fetched" },
    valid: true,
    why: "progress is a bounded completed/total pair with a platform label",
  },
  {
    contract: "JobProgressSchema",
    name: "completed step beyond the total",
    example: { step: 2, of: 1, label: "Fetched" },
    valid: false,
    why: "completed step is between zero and the total",
  },
  {
    contract: "JobRetryKeySchema",
    name: "key at the 128-byte cap",
    example: "é".repeat(64),
    valid: true,
    why: "the cap counts UTF-8 bytes — 64 two-byte characters fit exactly",
  },
  {
    contract: "JobRetryKeySchema",
    name: "key one byte over the cap",
    example: `${"é".repeat(64)}a`,
    valid: false,
    why: "129 UTF-8 bytes exceeds the 128-byte cap",
  },
  {
    contract: "JobRetryKeySchema",
    name: "empty key",
    example: "",
    valid: false,
    why: "empty keys are invalid",
  },
  {
    contract: "JobRetryKeySchema",
    name: "whitespace-only key",
    example: "  \t",
    valid: false,
    why: "whitespace-only keys are invalid",
  },
  {
    contract: "JobTypeCatalogueEntrySchema",
    name: "the fetch catalogue entry",
    example: { id: "jobs:fetch", displayName: "Outbound fetch job" },
    valid: true,
    why: "the production catalogue advertises the qualified id and a display name",
  },
  {
    contract: "JobTypeCatalogueEntrySchema",
    name: "a bare type in the catalogue",
    example: { id: "fetch", displayName: "Fetch" },
    valid: false,
    why: "catalogue ids are qualified types — there is no bare-type alias to advertise",
  },
  {
    contract: "JobTypeCatalogueEntrySchema",
    name: "a catalogue entry without a display name",
    example: { id: "jobs:fetch", displayName: "" },
    valid: false,
    why: "the portal shows this name for the type; an empty label is not a name",
  },

  // ── Lifecycle generations and delivery (design §5) ──────────────────────────
  {
    contract: "JobsGenerationSchema",
    name: "the initial generation",
    example: "1",
    valid: true,
    why: "generations are decimal strings; the first is 1",
  },
  {
    contract: "JobsGenerationSchema",
    name: "a generation with a leading zero",
    example: "007",
    valid: false,
    why: "one value, one wire form — a zero-padded copy would compare unequal as a string and equal numerically",
  },
  {
    contract: "JobsGenerationSchema",
    name: "a numeric generation",
    example: 7,
    valid: false,
    why: "identifiers are never coerced — the generation is a decimal string on the wire",
  },
  {
    contract: "JobsGenerationSchema",
    name: "a negative generation",
    example: "-1",
    valid: false,
    why: "generations count forward from 1; a minus sign is not decimal syntax",
  },
  {
    contract: "JobsLifecycleUpdateSchema",
    name: "archive delivery",
    example: { generation: "8", archived: true },
    valid: true,
    why: "archiving closes the app's current generation on every lifecycle target",
  },
  {
    contract: "JobsLifecycleUpdateSchema",
    name: "unarchive delivery opening a new generation",
    example: { generation: "9", archived: false },
    valid: true,
    why: "unarchive opens a new generation and never resumes a cancelled one",
  },
  {
    contract: "JobsLifecycleUpdateSchema",
    name: "update without the archived flag",
    example: { generation: "8" },
    valid: false,
    why: "open/close is the payload's one decision — a missing flag is malformed, not a default",
  },
  {
    contract: "JobsLifecycleUpdateSchema",
    name: "update carrying an app id",
    example: { generation: "8", archived: true, appId: "0b9e8c3e-6f2a-4c9b-9e1f-2a4b6c8d0e2f" },
    valid: false,
    why: "the target app is bound in the signed instruction's resource, not the body — an extra field fails the strict parse",
  },
  {
    contract: "JobsLifecycleUpdateAckSchema",
    name: "acknowledging an applied generation",
    example: { appliedGeneration: "8" },
    valid: true,
    why: "the ack names the generation durably applied before acknowledgement",
  },
  {
    contract: "JobsLifecycleUpdateAckSchema",
    name: "acknowledgement with a numeric generation",
    example: { appliedGeneration: 8 },
    valid: false,
    why: "generations are decimal strings — a number is malformed, not a string to repair",
  },
  {
    contract: "JobsLifecycleUpdateAckSchema",
    name: "acknowledgement replaying a lower delivery with invented state",
    example: { appliedGeneration: "8", cancelled: true },
    valid: false,
    why: "the ack carries only the applied generation — cancellation state is never echoed back",
  },

  // ── Deployment configuration (design §§1, 4, 8; ADR-0007/0008) ──────────────
  // Each example is one operator document exactly as the map travels after its
  // environment serialization is decoded. The roots are fixed public test
  // literals — canonical base64 of 32 bytes — never real credentials.
  {
    contract: "JobsDeploymentConfigSchema",
    name: "the initial serving deployment",
    example: {
      servers: {
        jobs: deploymentServerEntry(),
      },
    },
    valid: true,
    why: "one serving entry with its private destination, installed production type and three distinct roots",
  },
  {
    contract: "JobsDeploymentConfigSchema",
    name: "a fully disabled installation — an empty map",
    example: { servers: {} },
    valid: true,
    why: "an install without jobs carries no servers, no credentials and no limits tuning at all",
  },
  {
    contract: "JobsDeploymentConfigSchema",
    name: "a serving server with intake temporarily closed",
    example: {
      servers: { jobs: deploymentServerEntry({ accepting: false }) },
    },
    valid: true,
    why: "disabling an active installation closes intake while recovery, reads and cancellation stay available",
  },
  {
    contract: "JobsDeploymentConfigSchema",
    name: "an all-retiring deployment",
    example: {
      servers: {
        jobs: deploymentServerEntry({ state: "retiring", accepting: false, types: [] }),
      },
    },
    valid: true,
    why: "retirement keeps routing, credentials and recovery for retained records — with an empty advertised type list",
  },
  {
    contract: "JobsDeploymentConfigSchema",
    name: "an operator limits override",
    example: {
      servers: { jobs: deploymentServerEntry() },
      limits: {
        submissionAttemptsPerAppEnv: 10,
        submissionAttemptsDeployment: 100,
        submissionWindowSeconds: 60,
        unfinishedPerAppEnv: 20,
        unfinishedPerServer: 200,
        retainedPerAppEnv: 1_000,
        retainedPerServer: 10_000,
        runningPerAppEnv: 2,
        runningPerWorker: 8,
      },
    },
    valid: true,
    why: "operator configuration tunes finite positive limits after sizing",
  },
  {
    contract: "JobsDeploymentConfigSchema",
    name: "a retiring server still admitting work",
    example: {
      servers: { jobs: deploymentServerEntry({ state: "retiring" }) },
    },
    valid: false,
    why: "retirement closes new intake — a retiring entry never admits submissions",
  },
  {
    contract: "JobsDeploymentConfigSchema",
    name: "an installed type belonging to another server",
    example: {
      servers: {
        jobs: deploymentServerEntry({ types: ["ml-jobs:generate-report"] }),
      },
    },
    valid: false,
    why: "an installed type's qualified prefix must equal the entry's server — no cross-server registration",
  },
  {
    contract: "JobsDeploymentConfigSchema",
    name: "a type no platform code implements",
    example: {
      servers: {
        jobs: deploymentServerEntry({ types: ["jobs:synthetic-actor"] }),
      },
    },
    valid: false,
    why: "configuration cannot install a type outside the production catalogue — synthetic actors stay test fixtures",
  },
  {
    contract: "JobsDeploymentConfigSchema",
    name: "a duplicated installed type",
    example: {
      servers: { jobs: deploymentServerEntry({ types: ["jobs:fetch", "jobs:fetch"] }) },
    },
    valid: false,
    why: "the installed list is a set — a repeated type is a malformed map, not a second install",
  },
  {
    contract: "JobsDeploymentConfigSchema",
    name: "one root shared between two directions of a server",
    example: {
      servers: {
        jobs: deploymentServerEntry({
          roots: {
            edgeToJobs: JOBS_DEPLOYMENT_FIXTURE_ROOTS.edgeToJobs,
            jobsToEdge: JOBS_DEPLOYMENT_FIXTURE_ROOTS.edgeToJobs,
            portalToJobs: JOBS_DEPLOYMENT_FIXTURE_ROOTS.portalToJobs,
          },
        }),
      },
    },
    valid: false,
    why: "each direction holds an independently generated root — one secret never serves two directions",
  },
  {
    contract: "JobsDeploymentConfigSchema",
    name: "one root shared across two servers",
    example: {
      servers: {
        jobs: deploymentServerEntry(),
        "ml-jobs": deploymentServerEntry({
          server: "ml-jobs",
          types: [],
          databaseUrl: "postgresql://jobs@db.internal.helix/ml_jobs",
          roots: JOBS_DEPLOYMENT_FIXTURE_ROOTS,
        }),
      },
    },
    valid: false,
    why: "roots are never shared between servers — a valid token for one must not verify at another",
  },
  {
    contract: "JobsDeploymentConfigSchema",
    name: "one private database shared across two servers",
    example: {
      servers: {
        jobs: deploymentServerEntry(),
        "ml-jobs": deploymentServerEntry({
          server: "ml-jobs",
          types: [],
          roots: {
            edgeToJobs: "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=",
            jobsToEdge: "BQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
            portalToJobs: "BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY=",
          },
        }),
      },
    },
    valid: false,
    why: "each server keeps its own database — two names on one store is namespace aliasing, not sharing",
  },
  {
    contract: "JobsDeploymentConfigSchema",
    name: "a root that is not the canonical base64 of 32 bytes",
    example: {
      servers: {
        jobs: deploymentServerEntry({
          roots: {
            edgeToJobs: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
            jobsToEdge: "AQEBAQEBAQEBAQ==",
            portalToJobs: JOBS_DEPLOYMENT_FIXTURE_ROOTS.portalToJobs,
          },
        }),
      },
    },
    valid: false,
    why: "a root decodes to exactly 32 bytes in its canonical encoding — anything else is a boot error, never a weaker key",
  },
  {
    contract: "JobsDeploymentConfigSchema",
    name: "an entry that disagrees with its map key",
    example: {
      servers: { jobs: deploymentServerEntry({ server: "ml-jobs", types: [] }) },
    },
    valid: false,
    why: "the map key is the routing truth — an entry naming another server is malformed, not a rename",
  },
  {
    contract: "JobsDeploymentConfigSchema",
    name: "an own __proto__ key inside the server map",
    example: JSON.parse('{"servers":{"__proto__":{}}}'),
    valid: false,
    why: "the map refuses fields it does not carry — a shed key would silently parse as a fully disabled deployment",
  },
  {
    contract: "JobsDeploymentConfigSchema",
    name: "a limit of zero",
    example: {
      servers: { jobs: deploymentServerEntry() },
      limits: { unfinishedPerAppEnv: 0 },
    },
    valid: false,
    why: "a zero limit is not a capacity — zero/negative settings are refused",
  },
  {
    contract: "JobsDeploymentConfigSchema",
    name: "an unbounded limit",
    example: {
      servers: { jobs: deploymentServerEntry() },
      limits: { unfinishedPerAppEnv: Infinity },
    },
    valid: false,
    why: "limits are finite — a non-finite setting bounds nothing and is refused",
  },
  {
    contract: "JobsDeploymentConfigSchema",
    name: "an unknown limits key",
    example: {
      servers: { jobs: deploymentServerEntry() },
      limits: { jobsPerDay: 500 },
    },
    valid: false,
    why: "there is no per-day jobs budget — and an unknown key must fail, never silently leave the default in force",
  },
  {
    contract: "JobsDeploymentConfigSchema",
    name: "a database url on the wrong protocol",
    example: {
      servers: {
        jobs: deploymentServerEntry({ databaseUrl: "mysql://jobs@db.internal/jobs" }),
      },
    },
    valid: false,
    why: "each server's private store is Postgres — a typo'd protocol is a boot error, not a runtime surprise",
  },
  {
    contract: "JobsDeploymentConfigSchema",
    name: "an endpoint carrying a query string",
    example: {
      servers: {
        jobs: deploymentServerEntry({ endpoint: "https://jobs.internal.helix/?tls=1" }),
      },
    },
    valid: false,
    why: "the destination is a base URL routes are appended to — a query would be silently dropped by URL composition",
  },
  {
    contract: "JobsDeploymentConfigSchema",
    name: "a configured server missing a credential",
    example: {
      servers: {
        jobs: deploymentServerEntry({
          roots: {
            edgeToJobs: JOBS_DEPLOYMENT_FIXTURE_ROOTS.edgeToJobs,
            portalToJobs: JOBS_DEPLOYMENT_FIXTURE_ROOTS.portalToJobs,
          },
        }),
      },
    },
    valid: false,
    why: "once any server is configured, all three of its roots are required — no partially credentialed server",
  },
];

/**
 * A parser a fixture run can present examples to — the shape of a zod schema's
 * `safeParse`, stated structurally so the fixtures bind to any implementation
 * of the contract, not only this package's zod schemas.
 */
export interface JobsProtocolContractParser {
  safeParse(value: unknown): { success: boolean; error?: { message: string } };
}

/**
 * Run the whole fixture list against the given contract schemas. Every
 * positive example must parse and every negative example must be rejected —
 * the runner throws naming each mismatch, so a consumer's test suite fails
 * with the fixture evidence in the message.
 */
export function runJobsProtocolFixtures(
  schemas: Record<JobsProtocolContractName, JobsProtocolContractParser>,
): void {
  const failures: string[] = [];
  for (const fixture of JOBS_PROTOCOL_FIXTURES) {
    // The parse and its judgment share one guard: a parser that throws, or
    // resolves to a shape the read cannot survive, is the consuming
    // implementation's fault — named for its fixture, collected, and the
    // corpus keeps running, the same report every other fault gets. A bare
    // exception would name no fixture and strand the unexecuted judgments
    // behind it.
    let result: ReturnType<JobsProtocolContractParser["safeParse"]>;
    try {
      result = schemas[fixture.contract].safeParse(fixture.example);
    } catch (error) {
      failures.push(
        `fixture "${fixture.name}" (${fixture.contract}) — the parser could not judge the example: ${
          error instanceof Error ? error.message : String(error)
        } — ${fixture.why}`,
      );
      continue;
    }
    if (result === null || result === undefined) {
      failures.push(
        `fixture "${fixture.name}" (${fixture.contract}) — the parser resolved to nothing, judging nothing — ${fixture.why}`,
      );
      continue;
    }
    if (result.success !== fixture.valid) {
      const detail = result.success
        ? "the example parsed"
        : `the parse failed with: ${result.error?.message ?? "no detail"}`;
      failures.push(
        `fixture "${fixture.name}" (${fixture.contract}) expected ` +
          `${fixture.valid ? "acceptance" : "rejection"} — ${detail} — ${fixture.why}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(`JobsProtocolV1 conformance fixtures failed:\n${failures.join("\n")}`);
  }
}
