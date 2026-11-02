import { describe, expect, it } from "vitest";

import {
  JOB_ERROR_CODES,
  JOB_OWNER_KINDS,
  JOB_REQUEST_ERROR_CODES,
  JOB_STATEFUL_ERROR_CODES,
  JOB_STATUSES,
  JOB_TERMINAL_STATUSES,
  JOB_TYPE_CATALOGUE,
  JobAcceptedSchema,
  JobCancellationAcceptedSchema,
  JobErrorMessages,
  JobErrorSchema,
  JobIdSchema,
  JobIdentitySchema,
  JobReferenceSchema,
  JobRequestErrorSchema,
  JobRetryKeySchema,
  JobServerIdSchema,
  JobSnapshotSchema,
  JobStatusSchema,
  JOBS_FETCH_QUALIFIED_TYPE,
  JOBS_MAX_INPUT_BYTES,
  JOBS_MAX_RESULT_BYTES,
  JOBS_PROGRESS_MAX_TOTAL,
  JobProgressSchema,
  JobTypeCatalogueEntrySchema,
  QualifiedJobTypeSchema,
  FetchJobInputSchema,
  FetchJobResultSchema,
  IDEMPOTENCY_KEY_HEADER,
  JobsGenerationSchema,
  JOBS_SERVER_NAME,
  isQualifiedJobType,
  isValidJobsJobId,
  isValidJobsLocalType,
  isValidJobsRetryKey,
  isValidJobsServerId,
  jobError,
  jobRequestError,
  qualifiedTypeMatchesServer,
  stringifyJsonValue,
} from "./jobs.js";
import { JobsProtocolV1 } from "./jobsProtocol.js";

const ALL_CODES = JOB_REQUEST_ERROR_CODES as readonly string[];

describe("identifier syntax", () => {
  it.each(["jobs", "a", "ml-jobs2", "generate-report"])("accepts the server id %s", (server) => {
    expect(isValidJobsServerId(server)).toBe(true);
    expect(JobServerIdSchema.safeParse(server).success).toBe(true);
  });

  it("accepts a server id at the 63-character cap and refuses 64", () => {
    expect(isValidJobsServerId(`a${"a".repeat(61)}b`)).toBe(true);
    expect(isValidJobsServerId("a".repeat(64))).toBe(false);
  });

  it("anchors the token to a letter start and letter/digit end", () => {
    expect(isValidJobsServerId("1jobs")).toBe(false);
    expect(isValidJobsServerId("-jobs")).toBe(false);
    expect(isValidJobsServerId("jobs-")).toBe(false);
    expect(isValidJobsServerId("jobs1")).toBe(true);
    expect(isValidJobsServerId("j")).toBe(true);
    expect(isValidJobsServerId("")).toBe(false);
  });

  it("a local type shares the server-id syntax", () => {
    expect(isValidJobsLocalType("fetch")).toBe(true);
    expect(isValidJobsLocalType("generate-report2")).toBe(true);
    expect(isValidJobsLocalType("Generate")).toBe(false);
    expect(isValidJobsLocalType("")).toBe(false);
  });

  it("a job id is 1–128 charset characters, case-inclusive", () => {
    expect(isValidJobsJobId("w9QZzaBp4XkR3tYm017c3")).toBe(true);
    expect(isValidJobsJobId("A-B_c")).toBe(true);
    expect(isValidJobsJobId("a".repeat(128))).toBe(true);
    expect(isValidJobsJobId("a".repeat(129))).toBe(false);
    expect(isValidJobsJobId("")).toBe(false);
    expect(isValidJobsJobId("with space")).toBe(false);
    expect(JobIdSchema.safeParse(12345).success).toBe(false);
  });

  it("a qualified type is exactly one server prefix, one colon, one local type", () => {
    expect(isQualifiedJobType("jobs:fetch")).toBe(true);
    expect(isQualifiedJobType("ml-jobs:generate-report")).toBe(true);
    expect(isQualifiedJobType("fetch")).toBe(false);
    expect(isQualifiedJobType("jobs:")).toBe(false);
    expect(isQualifiedJobType(":fetch")).toBe(false);
    expect(isQualifiedJobType("jobs:fetch:v2")).toBe(false);
    expect(isQualifiedJobType("jobs::fetch")).toBe(false);
    expect(QualifiedJobTypeSchema.safeParse("jobs:fetch").success).toBe(true);
    expect(QualifiedJobTypeSchema.safeParse("jobs:fetch:v2").success).toBe(false);
  });

  it("the cross-server agreement is a prefix match on the colon boundary", () => {
    expect(qualifiedTypeMatchesServer("jobs:fetch", "jobs")).toBe(true);
    expect(qualifiedTypeMatchesServer("other:fetch", "jobs")).toBe(false);
    expect(qualifiedTypeMatchesServer("job:fetch", "job")).toBe(true);
    expect(qualifiedTypeMatchesServer("jobs:fetch", "job")).toBe(false);
  });

  it("the initial production type derives from its server and local halves", () => {
    expect(JOBS_FETCH_QUALIFIED_TYPE).toBe("jobs:fetch");
  });
});

describe("retry keys", () => {
  it("accepts a key at the 128-byte cap counted in UTF-8 bytes", () => {
    expect(isValidJobsRetryKey("é".repeat(64))).toBe(true);
    expect(isValidJobsRetryKey("é".repeat(64) + "a")).toBe(false);
    expect(JobRetryKeySchema.safeParse("a".repeat(128)).success).toBe(true);
    expect(JobRetryKeySchema.safeParse("a".repeat(129)).success).toBe(false);
  });

  it("refuses empty and whitespace-only keys", () => {
    expect(isValidJobsRetryKey("")).toBe(false);
    expect(isValidJobsRetryKey("   ")).toBe(false);
    expect(isValidJobsRetryKey("\t\n")).toBe(false);
  });

  it("accepts keys with leading/trailing whitespace — they are neither empty nor whitespace-only", () => {
    expect(isValidJobsRetryKey(" retry-1 ")).toBe(true);
  });
});

describe("owner vocabulary", () => {
  it("carries exactly the two principal kinds that may own jobs", () => {
    // The schema derives from this array, so a widened kind would reach the
    // wire without this pin — the identity tests only refuse the kinds known
    // today, not a kind added tomorrow.
    expect(JOB_OWNER_KINDS).toEqual(["user", "dev"]);
  });
});

describe("status vocabulary", () => {
  it("carries exactly the seven public statuses, in order", () => {
    expect(JOB_STATUSES).toEqual([
      "queued",
      "running",
      "succeeded",
      "failed",
      "crashed",
      "cancelled",
      "expired",
    ]);
  });

  it("the terminal set is the five statuses a job never leaves", () => {
    expect(JOB_TERMINAL_STATUSES).toEqual([
      "succeeded",
      "failed",
      "crashed",
      "cancelled",
      "expired",
    ]);
    for (const status of JOB_STATUSES) {
      expect((JOB_TERMINAL_STATUSES as readonly string[]).includes(status)).toBe(
        !["queued", "running"].includes(status),
      );
    }
  });

  it("parses each status and rejects invented ones", () => {
    for (const status of JOB_STATUSES) {
      expect(JobStatusSchema.parse(status)).toBe(status);
    }
    expect(JobStatusSchema.safeParse("pending").success).toBe(false);
    expect(JobStatusSchema.safeParse("queued ").success).toBe(false);
  });
});

describe("progress bounds", () => {
  it("the platform-authored total is bounded at JOBS_PROGRESS_MAX_TOTAL", () => {
    expect(JOBS_PROGRESS_MAX_TOTAL).toBe(10_000);
    const atBound = { step: JOBS_PROGRESS_MAX_TOTAL, of: JOBS_PROGRESS_MAX_TOTAL, label: "Done" };
    expect(JobProgressSchema.parse(atBound).of).toBe(10_000);
    expect(
      JobProgressSchema.safeParse({ ...atBound, of: JOBS_PROGRESS_MAX_TOTAL + 1 }).success,
    ).toBe(false);
  });

  it("a negative completed step is malformed", () => {
    expect(JobProgressSchema.safeParse({ step: -1, of: 1, label: "Fetching" }).success).toBe(false);
  });
});

describe("error catalogue", () => {
  it("carries the execution vocabulary, in order", () => {
    expect(JOB_ERROR_CODES).toEqual([
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
    ]);
  });

  it("the request vocabulary is the execution vocabulary plus fourteen request-only codes", () => {
    expect(JOB_REQUEST_ERROR_CODES).toEqual([
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
    ]);
    expect(new Set(ALL_CODES).size).toBe(JOB_REQUEST_ERROR_CODES.length);
  });

  it("every code has a non-empty fixed message", () => {
    for (const code of JOB_REQUEST_ERROR_CODES) {
      expect(JobErrorMessages[code], code).toBeTruthy();
    }
  });

  it("the stateful set names only 409 codes from the request vocabulary", () => {
    expect(JOB_STATEFUL_ERROR_CODES).toEqual([
      "idempotency_conflict",
      "job_not_ready",
      "job_terminal",
    ]);
    for (const code of JOB_STATEFUL_ERROR_CODES) {
      expect(ALL_CODES).toContain(code);
    }
  });
});

describe("the error constructors", () => {
  it("jobError supplies the fixed message for the code", () => {
    expect(jobError("timeout")).toEqual({
      code: "timeout",
      message: JobErrorMessages.timeout,
    });
  });

  it("jobRequestError builds the basic shape by default", () => {
    expect(jobRequestError("rate_limited")).toEqual({
      code: "rate_limited",
      message: JobErrorMessages.rate_limited,
    });
  });

  it("jobRequestError attaches the job's status and nullable error for the stateful codes", () => {
    const error = jobError("cancelled");
    expect(jobRequestError("job_terminal", { status: "succeeded", error: null })).toEqual({
      code: "job_terminal",
      message: JobErrorMessages.job_terminal,
      status: "succeeded",
      error: null,
    });
    expect(jobRequestError("job_not_ready", { status: "failed", error })).toEqual({
      code: "job_not_ready",
      message: JobErrorMessages.job_not_ready,
      status: "failed",
      error,
    });
  });

  it("jobRequestError refuses job state on a code that cannot carry it", () => {
    // The two-call overload already makes this a compile error; the runtime
    // guard is for a caller that bypassed the types.
    const bypassed = jobRequestError as (
      code: string,
      state?: { status: "running"; error: null },
    ) => unknown;
    expect(() => bypassed("rate_limited", { status: "running", error: null })).toThrow(
      /does not carry job state/,
    );
  });

  it("the stateful guard refuses every state-shaped bypass, not only absent state", () => {
    // `{...base, ...state}` spreads null, a primitive, and a field-less object
    // all to the bare body the stateful row forbids — so the guard must refuse
    // each of them the same way it refuses absent state, and a mistyped status
    // must never leave the constructor as a body the wire schema rejects.
    const bypassed = jobRequestError as (code: string, state?: unknown) => unknown;
    expect(() => bypassed("job_not_ready", null)).toThrow(/requires the job's status and error/);
    expect(() => bypassed("job_not_ready", {})).toThrow(/requires the job's status and error/);
    expect(() => bypassed("job_not_ready", 42)).toThrow(/requires the job's status and error/);
    expect(() => bypassed("job_not_ready", { status: "bogus", error: null })).toThrow(
      /does not parse against its own wire schema/,
    );
    expect(() => bypassed("rate_limited", null)).toThrow(/does not carry job state/);
  });

  it("jobError refuses a code outside the catalogue", () => {
    // Same bypass class: the catalogue lookup yields no message, and a body
    // the wire schema refuses must throw here rather than surface downstream.
    const bypassed = jobError as (code: string) => unknown;
    expect(() => bypassed("unknown_reason")).toThrow(/does not parse against its own wire schema/);
  });
});

describe("JobErrorSchema", () => {
  it("parses a code with its fixed message", () => {
    expect(JobErrorSchema.parse(jobError("upstream_error"))).toEqual(jobError("upstream_error"));
  });

  it("rejects a message that is not the catalogue entry for the code", () => {
    expect(
      JobErrorSchema.safeParse({ code: "upstream_error", message: "HTTP 502 from 10.0.0.7" })
        .success,
    ).toBe(false);
    expect(JobErrorSchema.safeParse({ code: "timeout", message: "" }).success).toBe(false);
  });

  it("rejects a code from the request-only vocabulary", () => {
    expect(
      JobErrorSchema.safeParse({
        code: "job_not_found",
        message: JobErrorMessages.job_not_found,
      }).success,
    ).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(
      JobErrorSchema.safeParse({ ...jobError("timeout"), details: { input: "x" } }).success,
    ).toBe(false);
  });
});

describe("JobRequestErrorSchema", () => {
  it("parses the basic shape", () => {
    expect(JobRequestErrorSchema.parse(jobRequestError("forbidden"))).toEqual(
      jobRequestError("forbidden"),
    );
  });

  it("parses the stateful 409 shape with a nested execution error", () => {
    const body = jobRequestError("job_not_ready", { status: "running", error: null });
    expect(JobRequestErrorSchema.parse(body)).toEqual(body);
    const withError = jobRequestError("job_terminal", {
      status: "cancelled",
      error: jobError("cancelled"),
    });
    expect(JobRequestErrorSchema.parse(withError)).toEqual(withError);
  });

  it("rejects state fields on a code that is not job-state-dependent", () => {
    // A raw literal, not the constructor: the constructor itself refuses this
    // shape, and this test pins the schema's rejection of one a caller
    // hand-rolled anyway.
    expect(
      JobRequestErrorSchema.safeParse({
        code: "rate_limited",
        message: JobErrorMessages.rate_limited,
        status: "running",
        error: null,
      }).success,
    ).toBe(false);
  });

  it("rejects an invented code and a non-catalogue message", () => {
    expect(
      JobRequestErrorSchema.safeParse({ code: "unknown_reason", message: "anything" }).success,
    ).toBe(false);
    expect(JobRequestErrorSchema.safeParse(jobError("timeout")).success).toBe(true);
    expect(
      JobRequestErrorSchema.safeParse({
        code: "timeout",
        message: "the job timed out after 5 minutes for input xyz",
      }).success,
    ).toBe(false);
  });

  it("jobRequestError refuses to build the bare shape of a stateful code", () => {
    // The contract REQUIRES the job's status and error on a job-state-dependent
    // 409, so the constructor refuses the bare form the same way it refuses
    // state on a code that cannot carry it. The cast bypasses the overload that
    // already makes this a compile error; the runtime guard is for a caller
    // that bypassed the types too.
    const bypassed = jobRequestError as (code: string) => unknown;
    expect(() => bypassed("job_not_ready")).toThrow(/requires the job's status and error/);
  });

  it.each(JOB_STATEFUL_ERROR_CODES)(
    "a stateful 409 code must carry the job's status and error — ADR-0001 (%s)",
    (code) => {
      // architecture.md ADR-0001 (JobRequestError row): "with `status` and
      // nullable `error: JobError` REQUIRED for job-state-dependent 409
      // responses"; spec criteria 34/46 promise the 409 arrives "with the
      // job's status". A body naming one of the three stateful codes but
      // omitting the state is therefore malformed on the wire and the schema
      // must refuse it.
      expect(
        JobRequestErrorSchema.safeParse({ code, message: JobErrorMessages[code] }).success,
      ).toBe(false);
    },
  );

  it("the stateful form rejects a truly unknown field, not only a mistyped known one", () => {
    // The stateful union member is built by `.extend()` on the strict base;
    // this pins that the extension preserves strictness against a key neither
    // member knows. The "rejects unknown fields" test above exercises only a
    // known key with a wrong type (`status: 403`), which both members refuse
    // for reasons that never reach the unrecognized-key check.
    expect(
      JobRequestErrorSchema.safeParse({
        code: "job_terminal",
        message: JobErrorMessages.job_terminal,
        status: "succeeded",
        error: null,
        detail: { extra: true },
      }).success,
    ).toBe(false);
  });

  it("the stateful form rejects a status outside the public vocabulary", () => {
    expect(
      JobRequestErrorSchema.safeParse({
        code: "job_not_ready",
        message: JobErrorMessages.job_not_ready,
        status: "pending",
        error: null,
      }).success,
    ).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(
      JobRequestErrorSchema.safeParse({ ...jobRequestError("forbidden"), status: 403 }).success,
    ).toBe(false);
  });
});

describe("JobReferenceSchema", () => {
  it("parses both halves and keeps them required", () => {
    expect(JobReferenceSchema.parse({ server: "jobs", jobId: "abc_1" })).toEqual({
      server: "jobs",
      jobId: "abc_1",
    });
    expect(JobReferenceSchema.safeParse({ server: "jobs" }).success).toBe(false);
    expect(JobReferenceSchema.safeParse({ jobId: "abc" }).success).toBe(false);
  });

  it("rejects an extra field", () => {
    expect(
      JobReferenceSchema.safeParse({ server: "jobs", jobId: "abc", type: "jobs:fetch" }).success,
    ).toBe(false);
  });
});

describe("JobAcceptedSchema", () => {
  it("parses the three-field acknowledgement without a type", () => {
    const body = { server: "jobs", jobId: "w9QZzaBp4XkR3tYm017c3", status: "queued" };
    expect(JobAcceptedSchema.parse(body)).toEqual(body);
  });

  it("rejects an invented type field", () => {
    expect(
      JobAcceptedSchema.safeParse({
        server: "jobs",
        jobId: "abc",
        status: "queued",
        type: "jobs:fetch",
      }).success,
    ).toBe(false);
  });

  it("rejects a status outside the seven-value contract", () => {
    expect(
      JobAcceptedSchema.safeParse({ server: "jobs", jobId: "abc", status: "pending" }).success,
    ).toBe(false);
  });
});

describe("JobCancellationAcceptedSchema", () => {
  it("parses the acknowledgement", () => {
    expect(
      JobCancellationAcceptedSchema.parse({
        server: "jobs",
        jobId: "abc",
        cancellationRequested: true,
      }),
    ).toEqual({ server: "jobs", jobId: "abc", cancellationRequested: true });
  });

  it("rejects a false flag and extra fields", () => {
    expect(
      JobCancellationAcceptedSchema.safeParse({
        server: "jobs",
        jobId: "abc",
        cancellationRequested: false,
      }).success,
    ).toBe(false);
    expect(
      JobCancellationAcceptedSchema.safeParse({
        server: "jobs",
        jobId: "abc",
        cancellationRequested: true,
        status: "running",
      }).success,
    ).toBe(false);
  });
});

describe("JobSnapshotSchema", () => {
  const snapshot = {
    server: "jobs",
    jobId: "w9QZzaBp4XkR3tYm017c3",
    type: "jobs:fetch",
    status: "succeeded",
    attempt: 1,
    progress: { step: 1, of: 1, label: "Fetched" },
    cancellationRequested: false,
    resultExpiresAt: "2026-10-20T12:00:00.000Z",
    recordExpiresAt: "2026-11-12T12:00:00.000Z",
    error: null,
  };

  it("parses a complete snapshot and preserves every field", () => {
    expect(JobSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("requires every field — unavailable values travel as explicit nulls", () => {
    for (const key of Object.keys(snapshot)) {
      const absent = { ...snapshot };
      delete (absent as Record<string, unknown>)[key];
      expect(JobSnapshotSchema.safeParse(absent).success, key).toBe(false);
    }
  });

  it("rejects a type prefix that does not match the server", () => {
    expect(JobSnapshotSchema.safeParse({ ...snapshot, type: "other:fetch" }).success).toBe(false);
    expect(JobSnapshotSchema.safeParse({ ...snapshot, type: "fetch" }).success).toBe(false);
  });

  it("rejects out-of-bound progress and attempts", () => {
    expect(JobSnapshotSchema.safeParse({ ...snapshot, attempt: 0 }).success).toBe(false);
    expect(
      JobSnapshotSchema.safeParse({ ...snapshot, progress: { step: 2, of: 1, label: "x" } })
        .success,
    ).toBe(false);
    expect(
      JobSnapshotSchema.safeParse({ ...snapshot, progress: { step: 0, of: 0, label: "x" } })
        .success,
    ).toBe(false);
    expect(
      JobSnapshotSchema.safeParse({
        ...snapshot,
        progress: { step: 0, of: 1, label: "a".repeat(129) },
      }).success,
    ).toBe(false);
  });

  it("parses a progress label of exactly 128 UTF-8 bytes", () => {
    const parsed = JobSnapshotSchema.parse({
      ...snapshot,
      progress: { step: 0, of: 1, label: "é".repeat(64) },
    });
    expect(parsed.progress?.label).toBe("é".repeat(64));
  });

  it("rejects non-ISO timestamps and unknown statuses", () => {
    expect(
      JobSnapshotSchema.safeParse({ ...snapshot, resultExpiresAt: "10/13/2026" }).success,
    ).toBe(false);
    expect(JobSnapshotSchema.safeParse({ ...snapshot, status: "pending" }).success).toBe(false);
  });

  it("expiry timestamps must be UTC — an offset or zoneless time is malformed", () => {
    expect(
      JobSnapshotSchema.safeParse({ ...snapshot, resultExpiresAt: "2026-10-20T14:00:00+02:00" })
        .success,
    ).toBe(false);
    expect(
      JobSnapshotSchema.safeParse({ ...snapshot, resultExpiresAt: "2026-10-20T12:00:00" }).success,
    ).toBe(false);
    expect(
      JobSnapshotSchema.safeParse({ ...snapshot, recordExpiresAt: "2026-11-12T12:00:00Z" }).success,
    ).toBe(true);
  });

  it("rejects unknown fields, including the retired progress sequence", () => {
    expect(JobSnapshotSchema.safeParse({ ...snapshot, progressSeq: "7" }).success).toBe(false);
  });
});

describe("JobIdentitySchema", () => {
  const identity = {
    server: "jobs",
    appId: "0b9e8c3e-6f2a-4c9b-9e1f-2a4b6c8d0e2f",
    env: "prod",
    ownerKind: "user",
    ownerOid: "4f7a2b3c-9d1e-4a5b-8c6d-0e2f4a6b8c0d",
    type: "jobs:fetch",
  };

  it("parses a full identity for each eligible owner kind and environment", () => {
    expect(JobIdentitySchema.parse(identity)).toEqual(identity);
    expect(JobIdentitySchema.parse({ ...identity, env: "dev", ownerKind: "dev" })).toEqual({
      ...identity,
      env: "dev",
      ownerKind: "dev",
    });
  });

  it("rejects the principal kinds jobs never attributes work to", () => {
    expect(JobIdentitySchema.safeParse({ ...identity, ownerKind: "password" }).success).toBe(false);
    expect(JobIdentitySchema.safeParse({ ...identity, ownerKind: "anon" }).success).toBe(false);
  });

  it("rejects a third environment", () => {
    expect(JobIdentitySchema.safeParse({ ...identity, env: "preview" }).success).toBe(false);
  });

  it("rejects a type on another server", () => {
    expect(
      JobIdentitySchema.safeParse({ ...identity, type: "ml-jobs:generate-report" }).success,
    ).toBe(false);
  });

  it("an empty ownerOid is malformed", () => {
    expect(JobIdentitySchema.safeParse({ ...identity, ownerOid: "" }).success).toBe(false);
  });

  it("a malformed appId is malformed — the shape derives from the registry's app id", () => {
    // appId is the one identity field whose schema is derived from another
    // module (`AppSchema.shape.id`); this pin keeps the derivation strict —
    // a loosening there must surface here rather than widen the jobs
    // attribution silently.
    expect(JobIdentitySchema.safeParse({ ...identity, appId: "not-a-uuid" }).success).toBe(false);
    expect(JobIdentitySchema.safeParse({ ...identity, appId: 12345 }).success).toBe(false);
  });
});

describe("fetch input and result", () => {
  it("the input is one http(s) URL and nothing else", () => {
    expect(FetchJobInputSchema.parse({ url: "https://example.com/data.json" })).toEqual({
      url: "https://example.com/data.json",
    });
    expect(FetchJobInputSchema.safeParse({ url: "http://example.com/x" }).success).toBe(true);
    expect(
      FetchJobInputSchema.safeParse({ url: "https://example.com/x", method: "POST" }).success,
    ).toBe(false);
    expect(
      FetchJobInputSchema.safeParse({ url: "https://example.com/x", connection: "vendor" }).success,
    ).toBe(false);
    expect(FetchJobInputSchema.safeParse({ url: "ftp://example.com/x" }).success).toBe(false);
    expect(FetchJobInputSchema.safeParse({ url: "/data.json" }).success).toBe(false);
    expect(FetchJobInputSchema.safeParse({ url: "not a url" }).success).toBe(false);
  });

  it("the result is any JSON value, including null", () => {
    expect(FetchJobResultSchema.parse(null)).toBe(null);
    expect(FetchJobResultSchema.parse("fetched")).toBe("fetched");
    expect(FetchJobResultSchema.parse(3.14)).toBe(3.14);
    expect(FetchJobResultSchema.parse(true)).toBe(true);
    expect(FetchJobResultSchema.parse({ items: [1, null, { a: "b" }] })).toEqual({
      items: [1, null, { a: "b" }],
    });
  });

  it("the result rejects values that are not JSON, at any depth", () => {
    expect(FetchJobResultSchema.safeParse(undefined).success).toBe(false);
    expect(FetchJobResultSchema.safeParse(NaN).success).toBe(false);
    expect(FetchJobResultSchema.safeParse(Infinity).success).toBe(false);
    expect(FetchJobResultSchema.safeParse(10n).success).toBe(false);
    expect(FetchJobResultSchema.safeParse(new Date()).success).toBe(false);
    expect(FetchJobResultSchema.safeParse(() => 1).success).toBe(false);
    expect(FetchJobResultSchema.safeParse({ items: [1n] }).success).toBe(false);
    expect(FetchJobResultSchema.safeParse({ nested: { when: new Date() } }).success).toBe(false);
  });
});

describe("the production catalogue", () => {
  it("carries exactly the fetch type with its display name", () => {
    expect(JOB_TYPE_CATALOGUE).toEqual([{ id: "jobs:fetch", displayName: "Outbound fetch job" }]);
  });

  it("a catalogue entry carries a qualified id and a non-empty display name", () => {
    expect(
      JobTypeCatalogueEntrySchema.safeParse({ id: "fetch", displayName: "Fetch" }).success,
    ).toBe(false);
    expect(
      JobTypeCatalogueEntrySchema.safeParse({ id: "jobs:fetch", displayName: "" }).success,
    ).toBe(false);
    expect(
      JobTypeCatalogueEntrySchema.safeParse({ id: "jobs:fetch", displayName: "X", types: [] })
        .success,
    ).toBe(false);
  });
});

describe("lifecycle generations", () => {
  it("parses the canonical decimal forms, including zero", () => {
    expect(JobsGenerationSchema.parse("1")).toBe("1");
    // The grammar admits "0" as its own branch — pinning it keeps a future
    // tightening of that branch a conscious contract decision, not a silent one.
    expect(JobsGenerationSchema.parse("0")).toBe("0");
  });

  it("refuses every non-canonical spelling of a valid value", () => {
    // One value, one wire form: padded, signed, spaced and fractional copies
    // of 7 are malformed, so receivers compare generations as plain strings
    // without canonicalizing first. The fixture corpus pins the zero-padded
    // form; these are the spellings it does not carry.
    expect(JobsGenerationSchema.safeParse("00").success).toBe(false);
    expect(JobsGenerationSchema.safeParse(" 7").success).toBe(false);
    expect(JobsGenerationSchema.safeParse("7 ").success).toBe(false);
    expect(JobsGenerationSchema.safeParse("+7").success).toBe(false);
    expect(JobsGenerationSchema.safeParse("7.0").success).toBe(false);
  });
});

describe("wire limits and header", () => {
  it("carries the byte caps, header name and initial server the submission routes enforce", () => {
    expect(JOBS_MAX_INPUT_BYTES).toBe(65_536);
    expect(JOBS_MAX_RESULT_BYTES).toBe(65_536);
    expect(IDEMPOTENCY_KEY_HEADER).toBe("idempotency-key");
    expect(JOBS_SERVER_NAME).toBe("jobs");
  });
});

describe("JobsProtocolV1", () => {
  it("exposes a safeParse for every contract name", () => {
    for (const [name, schema] of Object.entries(JobsProtocolV1)) {
      expect(typeof (schema as { safeParse?: unknown }).safeParse, name).toBe("function");
    }
  });
});

describe("the value contract's serialization half", () => {
  it("the canonical text is byte-identical to JSON.stringify's for every value both can reach", () => {
    // The walk's text is what the result column stores and what the result
    // projection will later serve; its canonical-form claim — key order,
    // string escaping, number formatting — is the property that lets any
    // JSON reader consume the stored bytes. Every shape here is one where a
    // hand-rolled walk plausibly drifts from the engine's answer.
    const deep = (() => {
      let node: unknown = "floor";
      for (let i = 0; i < 500; i++) node = [node];
      return node;
    })();
    const wireLegal: unknown[] = [
      null,
      true,
      false,
      0,
      -0,
      -1.5,
      0.1,
      1e21,
      -1e-7,
      Number.MAX_SAFE_INTEGER,
      "",
      "text",
      "é 𝄞 汉字 🐙",
      "line\nbreak\ttab",
      'quote"backslash\\slash/',
      "null\u0000text\u0001\u001fcontrol",
      "lone surrogate \uD800 pair 𝄞",
      [],
      [1, 2, 3],
      [null, "x", true, [1, [2, [3]]]],
      deep,
      {},
      { a: 1 },
      { a: { b: [1, "x", null] } },
      { b: 1, a: 2 },
      { 3: "c", 1: "a", 2: "b" },
      { 2: "b", 0: "c", x: "a" },
      { "ké\t y": 1 },
      JSON.parse('{"__proto__":1,"ok":true}'),
    ];
    for (const value of wireLegal) {
      expect(stringifyJsonValue(value), JSON.stringify(value).slice(0, 40)).toBe(
        JSON.stringify(value),
      );
    }
  });

  it("each refusal names its rule and never the value's content", () => {
    // The refusal's text can reach logs (the projection logs the wrapped
    // cause), and the value is untrusted input — so every refusal is the
    // fixed prefix plus a bounded kind phrase and nothing else: no marker of
    // the value itself may ride the message. The markers below are
    // distinctive enough that a quoting implementation fails.
    const distinctiveFunction = function distinctiveHandlerName(): void {};
    const cyclesAt = { "secret-token": 1 } as Record<string, unknown>;
    cyclesAt["self"] = cyclesAt;
    const refusals: Array<{ value: unknown; kind: RegExp; never?: RegExp }> = [
      { value: cyclesAt, kind: /a cycle/, never: /secret-token/ },
      {
        value: (() => {
          const list: unknown[] = ["distinctive-member"];
          list.push(list);
          return list;
        })(),
        kind: /a cycle/,
        never: /distinctive-member/,
      },
      { value: { nested: { deep: NaN } }, kind: /a non-finite number/ },
      { value: Infinity, kind: /a non-finite number/, never: /Infinity/ },
      {
        value: 123456789012345678901234567890n,
        kind: /a bigint member/,
        never: /123456789/,
      },
      {
        value: Symbol("distinctive-symbol"),
        kind: /a symbol member/,
        never: /distinctive-symbol/,
      },
      {
        value: distinctiveFunction,
        kind: /a function member/,
        never: /distinctiveHandlerName/,
      },
      {
        value: { toJSON: () => "distinctive-tojson" },
        kind: /a function member/,
        never: /distinctive-tojson/,
      },
      { value: undefined, kind: /undefined member/ },
      { value: [1, undefined, 3], kind: /undefined member/ },
      {
        value: (() => {
          const hole: unknown[] = [1, 2, 3];
          delete hole[1]; // a true hole, not an undefined member
          return hole;
        })(),
        kind: /undefined member/,
      },
      {
        value: new Date(0),
        kind: /a non-plain-object prototype/,
        never: /1970/,
      },
      {
        value: new Map([[1, 2]]),
        kind: /a non-plain-object prototype/,
      },
    ];
    for (const { value, kind, never } of refusals) {
      let message = "";
      try {
        stringifyJsonValue(value);
        expect.unreachable(`the refusal for ${kind} must throw`);
      } catch (error) {
        message = (error as Error).message;
      }
      // The whole message is the prefix plus the kind — a bounded, lowercase
      // phrase. Anything quoting the value fails here before the `never`
      // checks below are even reached.
      expect(message, `refusal shape for ${kind}`).toMatch(
        /^the value is not a complete JSON value \([a-z][a-z -]*\)$/,
      );
      expect(message, `refusal kind for ${kind}`).toMatch(kind);
      if (never) expect(message, `refusal for ${kind}`).not.toMatch(never);
    }
  });

  it("the canonical text survives the engine's number and key boundaries — the walk's number half is its own serializer", () => {
    // The shape fuzz above samples the plausible drift sites; the number half
    // is the one place the walk genuinely runs a DIFFERENT engine path
    // (`String`) from the one it is claimed to match (`JSON.stringify`'s own
    // number serializer), so the boundaries where ToString changes format —
    // the sign of zero, the denormal floor, the float ceiling, the
    // exact-integer cliff, and the switchover to exponential — are attacked
    // directly rather than trusted to the spec's say-so. Keys get the escape
    // shapes an own name can carry (quote, backslash, control, line
    // separators, a lone surrogate) and the integer-like look-alikes that
    // must NOT reorder.
    const numbers = [
      0,
      -0,
      1,
      -1,
      2 ** 31,
      2 ** 53,
      2 ** 53 + 1,
      -(2 ** 53) - 1,
      Number.MAX_SAFE_INTEGER,
      Number.MIN_SAFE_INTEGER,
      Number.EPSILON,
      Number.MIN_VALUE,
      5e-324,
      0.1,
      1 / 3,
      0.30000000000000004,
      1.7976931348623157e308,
      Number.MAX_VALUE,
      1e-7,
      9.999999e-7,
      1e20,
      1e21,
      1e22,
      -1e21,
      1.2345678901234568e29, // the nearest double to 123456789012345678901234567890 — written as the double, not a precision-losing literal
    ];
    for (const n of numbers) {
      expect(Number.isFinite(n), `fixture ${n} stays finite`).toBe(true);
      expect(stringifyJsonValue(n), `number ${n}`).toBe(JSON.stringify(n));
    }
    const awkwardKeys = {
      'quote"key': 1,
      "backslash\\key": 2,
      "newline\nkey": 3,
      "del\u007fkey": 4,
      "line\u2028sep\u2029key": 5,
      "lone\uD800surrogate": 6,
      "-1": 7,
      "1.5": 8,
      "": 9,
    };
    expect(stringifyJsonValue(awkwardKeys)).toBe(JSON.stringify(awkwardKeys));
  });

  it("a shared subvalue serializes twice, byte-identically — the open-set bookkeeping's output, not just its verdict", () => {
    // Sharing is accepted (the contract's adversarial suite pins the verdict);
    // the OUTPUT for a shared value is its own risk. The walk registers a
    // container on open and deregisters it on close, so a shared subvalue is
    // walked twice — a bookkeeping slip (a deletion that lands early, a close
    // bracket dropped on the second pass) breaks only this shape, and no
    // byte-identity shape above exercises it. The cyclic form next door stays
    // refused.
    const shared = { a: [1, "x"] };
    const root = { p: shared, q: shared, r: [shared, shared] };
    expect(stringifyJsonValue(root)).toBe(JSON.stringify(root));
    const cyclic: Record<string, unknown> = { ok: true };
    cyclic["self"] = cyclic;
    expect(() => stringifyJsonValue(cyclic)).toThrow(/a cycle/);
  });
});
